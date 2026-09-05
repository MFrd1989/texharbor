import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export type PdfPoint = { page: number; x: number; y: number };

function PdfPage({ document, pageNumber, zoom, onSync, register }: {
  document: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  onSync: (point: PdfPoint) => void;
  register: (page: number, element: HTMLElement | null) => void;
}) {
  const pageRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const viewportRef = useRef<{ width: number; height: number; scale: number } | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [nearViewport, setNearViewport] = useState(pageNumber <= 2);
  const [size, setSize] = useState({ width: 520, height: 700 });

  useEffect(() => {
    const element = pageRef.current;
    register(pageNumber, element);
    if (!element || nearViewport) return () => register(pageNumber, null);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNearViewport(true);
    }, { rootMargin: '800px 0px' });
    observer.observe(element);
    return () => { observer.disconnect(); register(pageNumber, null); };
  }, [nearViewport, pageNumber, register]);

  useEffect(() => {
    let disposed = false;
    void document.getPage(pageNumber).then((value) => {
      if (disposed) return;
      const viewport = value.getViewport({ scale: zoom });
      setPage(value); setSize({ width: viewport.width, height: viewport.height });
    });
    return () => { disposed = true; };
  }, [document, pageNumber, zoom]);

  useEffect(() => {
    if (!page || !nearViewport || !canvasRef.current) return;
    let disposed = false;
    const viewport = page.getViewport({ scale: zoom });
    viewportRef.current = { width: viewport.width, height: viewport.height, scale: zoom };
    const canvas = canvasRef.current;
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    renderTaskRef.current?.cancel();
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
    });
    renderTaskRef.current = task;
    void task.promise.catch((cause) => {
      if (!disposed && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) throw cause;
    }).finally(() => { if (renderTaskRef.current === task) renderTaskRef.current = null; });
    return () => { disposed = true; task.cancel(); };
  }, [nearViewport, page, zoom]);

  const sync = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) * viewport.width / bounds.width) / viewport.scale;
    const y = ((event.clientY - bounds.top) * viewport.height / bounds.height) / viewport.scale;
    onSync({ page: pageNumber, x: Math.max(0, x), y: Math.max(0, y) });
  };

  return <article className="pdf-page" data-page={pageNumber} ref={pageRef} style={{ width: size.width, minHeight: size.height }}>
    <canvas ref={canvasRef} onClick={sync} aria-label={`PDF page ${pageNumber}. Click to open source.`} />
    {!nearViewport && <span>Page {pageNumber}</span>}
  </article>;
}

export function PdfViewer({ src, onSync }: { src: string; onSync: (point: PdfPoint) => void }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageElements = useRef(new Map<number, HTMLElement>());
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(0.85);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setDocument(null); setCurrentPage(1); setLoading(true); setError(''); pageElements.current.clear();
    // The legacy build includes the polyfills PDF.js needs on browsers that do
    // not yet implement newer Map APIs such as getOrInsertComputed.
    void import('pdfjs-dist/legacy/build/pdf.mjs').then(({ getDocument, GlobalWorkerOptions }) => {
      GlobalWorkerOptions.workerSrc = workerUrl;
      const task = getDocument({ url: src, withCredentials: true });
      loadingTask = task;
      return task.promise;
    }).then((pdf) => {
      if (disposed) void loadingTask?.destroy();
      else { setDocument(pdf); setLoading(false); }
    }).catch((cause) => {
      if (!disposed) { setError(cause instanceof Error ? cause.message : 'Could not load PDF'); setLoading(false); }
    });
    return () => { disposed = true; if (loadingTask) void loadingTask.destroy(); };
  }, [src]);

  const register = useCallback((page: number, element: HTMLElement | null) => {
    if (element) pageElements.current.set(page, element); else pageElements.current.delete(page);
  }, []);
  const goToPage = (page: number) => {
    const target = Math.min(document?.numPages || 1, Math.max(1, page));
    setCurrentPage(target);
    pageElements.current.get(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const trackCurrentPage = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.getBoundingClientRect().top + 12;
    let closest = currentPage; let distance = Number.POSITIVE_INFINITY;
    for (const [page, element] of pageElements.current) {
      const nextDistance = Math.abs(element.getBoundingClientRect().top - top);
      if (nextDistance < distance) { closest = page; distance = nextDistance; }
    }
    if (closest !== currentPage) setCurrentPage(closest);
  };

  return <div className="pdf-document-viewer" aria-busy={loading}>
    <div className="pdf-toolbar">
      <button aria-label="Previous PDF page" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>←</button>
      <span>Page <input aria-label="PDF page" type="number" min={1} max={document?.numPages || 1} value={currentPage} onChange={(event) => goToPage(Number(event.target.value) || 1)} /> / {document?.numPages || '—'}</span>
      <button aria-label="Next PDF page" disabled={!document || currentPage >= document.numPages} onClick={() => goToPage(currentPage + 1)}>→</button>
      <button aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.15).toFixed(2))))}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button aria-label="Zoom in" disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, Number((value + 0.15).toFixed(2))))}>＋</button>
      <a className="button" href={src} download>Download</a>
    </div>
    <p className="pdf-sync-hint">Scroll continuously. Click any page to open its source line.</p>
    <div className="pdf-canvas-scroll" ref={scrollerRef} onScroll={trackCurrentPage}>
      {loading && <div className="pdf-loading">Loading PDF…</div>}
      {error && <p className="error" role="alert">{error}</p>}
      {document && Array.from({ length: document.numPages }, (_, index) => <PdfPage key={index + 1} document={document} pageNumber={index + 1} zoom={zoom} onSync={onSync} register={register} />)}
    </div>
  </div>;
}
