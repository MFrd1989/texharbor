import { useCallback, useEffect, useState } from 'react';
import type { CompileJobDto, Compiler, FileDto, ProjectRole } from '@texlyre/contracts';
import { api } from './api';

type ProjectSettings = { compiler: Compiler; mainFilePath: string; role: ProjectRole };

export function BuildPanel({ projectId, project, files, onSettings }: { projectId: string; project: ProjectSettings; files: FileDto[]; onSettings: (settings: Partial<ProjectSettings>) => void }) {
  const [job, setJob] = useState<CompileJobDto | null>(null);
  const [tab, setTab] = useState<'pdf' | 'logs'>('pdf');
  const [error, setError] = useState('');
  const editable = project.role !== 'viewer';
  const texFiles = files.filter((file) => file.kind === 'file' && !file.isBinary && file.path.toLowerCase().endsWith('.tex'));

  const loadLatest = useCallback(async () => {
    try { const result = await api<{ jobs: CompileJobDto[] }>(`/api/projects/${projectId}/compile`); setJob(result.jobs[0] || null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load builds'); }
  }, [projectId]);
  useEffect(() => { void loadLatest(); }, [loadLatest]);
  useEffect(() => {
    if (!job || !['queued', 'running'].includes(job.status)) return;
    const timer = window.setTimeout(() => {
      void api<{ job: CompileJobDto }>(`/api/projects/${projectId}/compile/${job.id}`).then((result) => { setJob(result.job); if (result.job.status === 'failed') setTab('logs'); }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not refresh build'));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [job, projectId]);

  const compile = async () => {
    setError('');
    try { const result = await api<{ job: CompileJobDto }>(`/api/projects/${projectId}/compile`, { method: 'POST' }); setJob(result.job); setTab('pdf'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start compilation'); await loadLatest(); }
  };

  const updateSetting = async (setting: { compiler?: Compiler; mainFilePath?: string }) => {
    setError('');
    try { const result = await api<{ project: Partial<ProjectSettings> }>(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(setting) }); onSettings(result.project); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update compile settings'); }
  };

  const busy = job?.status === 'queued' || job?.status === 'running';
  return <aside className="build-panel" aria-label="Build and PDF">
    <header><div className="build-tabs"><button className={tab === 'pdf' ? 'active' : ''} onClick={() => setTab('pdf')}>PDF</button><button className={tab === 'logs' ? 'active' : ''} onClick={() => setTab('logs')}>Logs</button></div><button className="primary compile-button" disabled={!editable || busy} onClick={() => void compile()}>{busy ? job.status === 'queued' ? 'Queued…' : 'Compiling…' : 'Compile'}</button></header>
    <div className="build-settings"><label>Compiler<select aria-label="Compiler" value={project.compiler} disabled={project.role !== 'owner'} onChange={(event) => void updateSetting({ compiler: event.target.value as Compiler })}><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></label><label>Main document<select aria-label="Main document" value={project.mainFilePath} disabled={project.role !== 'owner'} onChange={(event) => void updateSetting({ mainFilePath: event.target.value })}>{texFiles.map((file) => <option value={file.path} key={file.id}>{file.path}</option>)}</select></label></div>
    {error && <p className="error build-error" role="alert">{error}</p>}
    <div className="build-status">{job ? <><span className={`job-state ${job.status}`}>{job.status.replaceAll('_', ' ')}</span><small>{job.compiler} · {new Date(job.queuedAt).toLocaleString()}</small></> : <small>Compile the project to generate a PDF.</small>}</div>
    {tab === 'pdf' ? <div className="pdf-viewer">{job?.hasPdf ? <iframe title="Compiled PDF" src={`/api/projects/${projectId}/compile/${job.id}/pdf`} /> : <div><strong>{busy ? 'Compilation in progress' : job?.status === 'failed' ? 'Compilation failed' : 'No PDF yet'}</strong><p>{job?.status === 'failed' ? 'Open Logs to inspect the LaTeX error.' : 'The generated PDF will appear here.'}</p></div>}</div> : <pre className="build-log">{job?.log || (busy ? 'Waiting for compiler output…' : 'No build log available.')}</pre>}
  </aside>;
}
