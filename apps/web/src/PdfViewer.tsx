import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type PdfPoint = { page: number; x: number; y: number };

export function PdfViewer({ src, onSync }: { src: string; onSync: (point: PdfPoint) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const viewportRef = useRef<{ width: number; height: number; scale: number } | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(0.85);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setDocument(null); setPageNumber(1); setLoading(true); setError('');
    void import('pdfjs-dist').then(({ getDocument, GlobalWorkerOptions }) => {
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
    return () => { disposed = true; renderTaskRef.current?.cancel(); if (loadingTask) void loadingTask.destroy(); };
  }, [src]);

  useEffect(() => {
    if (!document || !canvasRef.current) return;
    let disposed = false;
    const render = async () => {
      const page = await document.getPage(pageNumber);
      if (disposed || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: zoom });
      viewportRef.current = { width: viewport.width, height: viewport.height, scale: zoom };
      const canvas = canvasRef.current;
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable');
      renderTaskRef.current?.cancel();
      const task = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });
      renderTaskRef.current = task;
      try { await task.promise; }
      catch (cause) { if (!disposed && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) throw cause; }
      finally { if (renderTaskRef.current === task) renderTaskRef.current = null; }
    };
    void render().catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not render PDF'); });
    return () => { disposed = true; renderTaskRef.current?.cancel(); };
  }, [document, pageNumber, zoom]);

  const sync = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const bounds = canvas.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) * viewport.width / bounds.width) / viewport.scale;
    const y = ((event.clientY - bounds.top) * viewport.height / bounds.height) / viewport.scale;
    onSync({ page: pageNumber, x: Math.max(0, x), y: Math.max(0, y) });
  };

  return <div className="pdf-document-viewer" aria-busy={loading}>
    <div className="pdf-toolbar">
      <button aria-label="Previous PDF page" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))}>←</button>
      <span>Page <input aria-label="PDF page" type="number" min={1} max={document?.numPages || 1} value={pageNumber} onChange={(event) => setPageNumber(Math.min(document?.numPages || 1, Math.max(1, Number(event.target.value) || 1)))} /> / {document?.numPages || '—'}</span>
      <button aria-label="Next PDF page" disabled={!document || pageNumber >= document.numPages} onClick={() => setPageNumber((page) => Math.min(document?.numPages || page, page + 1))}>→</button>
      <button aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.15).toFixed(2))))}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button aria-label="Zoom in" disabled={zoom >= 2.5} onClick={() => setZoom((value) => Math.min(2.5, Number((value + 0.15).toFixed(2))))}>＋</button>
      <a className="button" href={src} download>Download</a>
    </div>
    <p className="pdf-sync-hint">Click the PDF to open the corresponding source line.</p>
    <div className="pdf-canvas-scroll">
      {loading && <div className="pdf-loading">Loading PDF…</div>}
      {error && <p className="error" role="alert">{error}</p>}
      <canvas ref={canvasRef} onClick={sync} aria-label={`PDF page ${pageNumber}. Click to open source.`} />
    </div>
  </div>;
}
