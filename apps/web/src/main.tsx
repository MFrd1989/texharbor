import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { CommentAnchorDto, CommentThreadDto, FileDto, ProjectDto, UserDto } from '@texlyre/contracts';
import { api } from './api';
import { CodeEditor, type Collaborator } from './CodeEditor';
import { CommentsPanel } from './CommentsPanel';
import { SharingDialog } from './SharingDialog';
import './styles.css';

type AuthResponse = { user: UserDto | null };

function AuthPage({ onAuthenticated }: { onAuthenticated: (user: UserDto) => void }) {
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const body = Object.fromEntries(form.entries());
      const result = await api<{ user: UserDto }>(`/api/auth/${registering ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(body) });
      onAuthenticated(result.user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Authentication failed'); }
    finally { setBusy(false); }
  };
  return <main className="auth-page">
    <section className="auth-brand"><div className="mark">T<span>X</span></div><p className="eyebrow">SELF-HOSTED LATEX</p><h1>Write together.<br />Own every draft.</h1><p>A focused research workspace for source, review, and publication.</p></section>
    <section className="auth-panel"><form onSubmit={submit} className="auth-card">
      <p className="eyebrow">{registering ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</p>
      <h2>{registering ? 'Start a workspace' : 'Sign in'}</h2>
      {registering && <label>Display name<input name="name" autoComplete="name" required maxLength={100} /></label>}
      <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} minLength={registering ? 10 : undefined} required /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary wide" disabled={busy}>{busy ? 'Please wait…' : registering ? 'Create account' : 'Sign in'}</button>
      <button type="button" className="text-button" onClick={() => { setRegistering(!registering); setError(''); }}>{registering ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
    </form></section>
  </main>;
}

function Dashboard({ user, onLogout }: { user: UserDto; onLogout: () => void }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [view, setView] = useState<'projects' | 'trash'>('projects');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try { setProjects((await api<{ projects: ProjectDto[] }>(`/api/projects${view === 'trash' ? '?view=trash' : ''}`)).projects); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load projects'); }
  }, [view]);
  useEffect(() => { void load(); }, [load]);
  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try { await api('/api/projects', { method: 'POST', body: JSON.stringify(Object.fromEntries(form.entries())) }); setShowCreate(false); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create project'); }
  };
  const trash = async (id: string) => { if (!confirm('Move this project to trash?')) return; await api(`/api/projects/${id}`, { method: 'DELETE' }); await load(); };
  const restore = async (id: string) => { await api(`/api/projects/${id}/restore`, { method: 'POST' }); await load(); };
  const permanentlyDelete = async (id: string) => { if (!confirm('Permanently delete this project and all of its files? This cannot be undone.')) return; await api(`/api/projects/${id}?permanent=true`, { method: 'DELETE' }); await load(); };
  const rename = async (project: ProjectDto) => { const name = prompt('New project name:', project.name)?.trim(); if (!name || name === project.name) return; try { await api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename project'); } };
  const duplicate = async (id: string) => { try { await api(`/api/projects/${id}/duplicate`, { method: 'POST' }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not duplicate project'); } };
  const importZip = async (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return; setImporting(true); setError(''); try { const form = new FormData(); form.append('archive', file); await api('/api/projects/import', { method: 'POST', body: form }); await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not import ZIP'); } finally { setImporting(false); } };
  return <div className="app-shell">
    <aside className="sidebar"><Link to="/" className="brand"><span className="mini-mark">TX</span><strong>LaTeX Workspace</strong></Link><nav>
      <button className={view === 'projects' ? 'active' : ''} onClick={() => setView('projects')}>▦ <span>My projects</span></button>
      <button className={view === 'trash' ? 'active' : ''} onClick={() => setView('trash')}>♲ <span>Trash</span></button>
    </nav><div className="sidebar-user"><span>{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.email}</small></div><button aria-label="Sign out" onClick={onLogout}>↪</button></div></aside>
    <main className="dashboard"><header><div><p className="eyebrow">WORKSPACE</p><h1>{view === 'trash' ? 'Trash' : 'My projects'}</h1></div>{view === 'projects' && <div className="header-actions"><input ref={importInput} type="file" accept=".zip,application/zip" hidden onChange={(event) => void importZip(event)} /><button onClick={() => importInput.current?.click()} disabled={importing}>{importing ? 'Importing…' : 'Import ZIP'}</button><button className="primary" onClick={() => setShowCreate(true)}>＋ New project</button></div>}</header>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="project-head"><span>PROJECT</span><span>ROLE</span><span>LAST UPDATED</span><span>ACTIONS</span></div>
      <section className="project-list">{projects.length === 0 ? <div className="empty"><div>∑</div><h2>{view === 'trash' ? 'Trash is empty' : 'No projects yet'}</h2><p>{view === 'trash' ? 'Deleted projects will appear here.' : 'Create a project and begin with main.tex.'}</p></div> : projects.map((project) => <article className="project-row" key={project.id}>
        <Link to={`/projects/${project.id}`} className="project-title"><span className="file-icon">T<sub>E</sub>X</span><div><strong>{project.name}</strong><small>{project.description || 'No description'}</small></div></Link><span className="role">{project.role}</span><time>{new Date(project.updatedAt).toLocaleString()}</time><div className="row-actions">{view === 'trash' ? <><button onClick={() => void restore(project.id)}>Restore</button><button className="danger" onClick={() => void permanentlyDelete(project.id)}>Delete</button></> : <><Link className="button" to={`/projects/${project.id}`}>Open</Link>{project.role === 'owner' && <><button onClick={() => void duplicate(project.id)}>Duplicate</button><button onClick={() => void rename(project)}>Rename</button><button className="danger" onClick={() => void trash(project.id)}>Trash</button></>}</>}</div>
      </article>)}</section>
    </main>
    {showCreate && <div className="dialog-backdrop" role="presentation"><form className="dialog" onSubmit={create}><h2>New project</h2><label>Project name<input name="name" defaultValue="Untitled paper" autoFocus required maxLength={200} /></label><label>Description<textarea name="description" rows={3} maxLength={2000} /></label><div><button type="button" onClick={() => setShowCreate(false)}>Cancel</button><button className="primary">Create project</button></div></form></div>}
  </div>;
}

type ProjectDetail = ProjectDto & { mainFilePath: string; compiler: string };
type FileContent = FileDto & { content: string | null };

function Workspace({ user }: { user: UserDto }) {
  const { projectId = '' } = useParams(); const navigate = useNavigate();
  const [project, setProject] = useState<ProjectDetail | null>(null); const [files, setFiles] = useState<FileDto[]>([]);
  const [selected, setSelected] = useState<FileContent | null>(null); const [status, setStatus] = useState('Connecting…'); const [error, setError] = useState('');
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [showSharing, setShowSharing] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [commentSelection, setCommentSelection] = useState<CommentAnchorDto | null>(null);
  const [jumpRequest, setJumpRequest] = useState<{ anchor: CommentAnchorDto; nonce: number } | null>(null);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const loadFiles = useCallback(async () => setFiles((await api<{ files: FileDto[] }>(`/api/projects/${projectId}/files`)).files), [projectId]);
  useEffect(() => { void Promise.all([api<{ project: ProjectDetail }>(`/api/projects/${projectId}`).then((r) => setProject(r.project)), loadFiles()]).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open project')); }, [projectId, loadFiles]);
  useEffect(() => { if (!selected && files.length) { const main = files.find((file) => file.path === project?.mainFilePath) || files.find((file) => file.kind === 'file'); if (main) void openFile(main); } }, [files, project, selected]);
  const openFile = async (file: FileDto) => { if (file.kind !== 'file') return; if (file.isBinary) { setSelected(null); setError(`${file.path} is a binary asset and cannot be edited as source.`); return; } try { setError(''); setSelected((await api<{ file: FileContent }>(`/api/projects/${projectId}/files/${file.id}`)).file); setStatus('Saved'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open file'); } };
  const createNode = async (kind: 'file' | 'directory') => { const name = prompt(`${kind === 'file' ? 'File' : 'Folder'} path, for example ${kind === 'file' ? '/chapters/introduction.tex' : '/figures'}:`); if (!name) return; try { await api(`/api/projects/${projectId}/files`, { method: 'POST', body: JSON.stringify({ path: name, kind, content: '' }) }); await loadFiles(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create item'); } };
  const renameNode = async (file: FileDto) => { const nextPath = prompt('New path:', file.path)?.trim(); if (!nextPath || nextPath === file.path) return; try { await api(`/api/projects/${projectId}/files/${file.id}`, { method: 'PATCH', body: JSON.stringify({ path: nextPath }) }); if (selected?.id === file.id) setSelected(null); await loadFiles(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename item'); } };
  const deleteNode = async (file: FileDto) => { if (!confirm(`Delete ${file.path}${file.kind === 'directory' ? ' and everything inside it' : ''}?`)) return; try { await api(`/api/projects/${projectId}/files/${file.id}`, { method: 'DELETE' }); if (selected?.id === file.id) setSelected(null); await loadFiles(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete item'); } };
  const jumpToComment = async (thread: CommentThreadDto) => { const file = files.find((item) => item.id === thread.fileId); if (!file) return; if (selected?.id !== file.id) await openFile(file); setJumpRequest({ anchor: thread.anchor, nonce: Date.now() }); };
  if (error && !project) return <main className="fatal"><h1>Could not open project</h1><p>{error}</p><button onClick={() => navigate('/')}>Back to projects</button></main>;
  return <div className={`workspace ${showComments ? 'comments-open' : ''}`}><header className="workspace-header"><button className="back" onClick={() => navigate('/')}>← Projects</button><div><strong>{project?.name || 'Loading…'}</strong><span>{project?.compiler}</span></div>{project && <button className="share-button" onClick={() => setShowSharing(true)}>{project.role === 'owner' ? 'Share' : 'Collaborators'}</button>}<button className="workspace-action" onClick={() => setShowComments((open) => !open)}>Comments</button><div className="presence" aria-label="Online collaborators">{collaborators.map((collaborator) => <span key={collaborator.clientId} title={`${collaborator.name} · online`} style={{ backgroundColor: collaborator.color }}>{collaborator.name.slice(0, 1).toUpperCase()}</span>)}</div><span className={`save-status ${['Access denied', 'Offline'].includes(status) ? 'failed' : ''}`}>● {status}</span></header>
    <aside className="file-panel"><div className="panel-title"><strong>Files</strong>{project?.role !== 'viewer' && <span><button title="New file" onClick={() => void createNode('file')}>＋</button><button title="New folder" onClick={() => void createNode('directory')}>▱</button></span>}</div><div className="file-tree">{files.map((file) => <div className="tree-row" key={file.id}><button className={selected?.id === file.id ? 'selected' : ''} style={{ paddingLeft: `${12 + (file.path.split('/').length - 2) * 16}px` }} onClick={() => void openFile(file)}>{file.kind === 'directory' ? '▸' : file.isBinary ? '◇' : '▤'} {file.path.split('/').at(-1)}</button>{project?.role !== 'viewer' && <span><button title={`Rename ${file.path}`} onClick={() => void renameNode(file)}>✎</button><button title={`Delete ${file.path}`} onClick={() => void deleteNode(file)}>×</button></span>}</div>)}</div></aside>
    <main className="source-panel"><div className="tabbar"><span>{selected?.path || 'Select a file'}</span>{error && <span className="inline-error">{error}</span>}</div>{selected ? <CodeEditor key={`${selected.id}:${connectionEpoch}`} projectId={projectId} fileId={selected.id} user={user} readOnly={project?.role === 'viewer'} onStatus={setStatus} onPresence={setCollaborators} onRole={(role) => setProject((current) => current && current.role !== role ? { ...current, role } : current)} onAccessLost={(message) => { setError(message); setProject(null); }} onConnectionReset={() => setConnectionEpoch((epoch) => epoch + 1)} onSelection={setCommentSelection} jumpRequest={jumpRequest} /> : <div className="editor-empty">Select a source file</div>}</main>
    {showComments && project && <CommentsPanel projectId={projectId} fileId={selected?.id || null} selection={commentSelection} user={user} role={project.role} onClose={() => setShowComments(false)} onJump={(thread) => void jumpToComment(thread)} />}
    {showSharing && project && <SharingDialog projectId={projectId} role={project.role} onClose={() => setShowSharing(false)} />}
  </div>;
}

type InvitationDetail = { projectName: string; inviterName: string; role: 'editor' | 'viewer'; expiresAt: string };

function InvitationPage({ user }: { user: UserDto }) {
  const { token = '' } = useParams(); const navigate = useNavigate();
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState<InvitationDetail | null>(null);
  useEffect(() => { void api<{ invitation: InvitationDetail }>(`/api/invitations/${encodeURIComponent(token)}`).then((result) => setInvitation(result.invitation)).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load invitation')); }, [token]);
  const accept = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<{ projectId: string }>(`/api/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' });
      navigate(`/projects/${result.projectId}`, { replace: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not accept invitation'); setBusy(false); }
  };
  const reject = async () => { setBusy(true); setError(''); try { await api(`/api/invitations/${encodeURIComponent(token)}/reject`, { method: 'POST' }); navigate('/', { replace: true }); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reject invitation'); setBusy(false); } };
  return <main className="invitation-page"><section className="invitation-card"><p className="eyebrow">PROJECT INVITATION</p><h1>{invitation ? `Join ${invitation.projectName}` : 'Join a shared project'}</h1>{invitation && <p><strong>{invitation.inviterName}</strong> invited you as {invitation.role === 'editor' ? 'an editor' : 'a viewer'}.</p>}<p>You are signed in as <strong>{user.email}</strong>. Invitations can only be accepted by the email address they were created for.</p>{error && <p className="error" role="alert">{error}</p>}<div><button disabled={busy || !invitation} onClick={() => void reject()}>Decline</button><button className="primary" disabled={busy || !invitation} onClick={() => void accept()}>{busy ? 'Please wait…' : 'Accept invitation'}</button></div></section></main>;
}

function App() {
  const [user, setUser] = useState<UserDto | null | undefined>(undefined);
  useEffect(() => { void api<AuthResponse>('/api/me').then((result) => setUser(result.user)).catch(() => setUser(null)); }, []);
  if (user === undefined) return <div className="loading">Loading workspace…</div>;
  if (!user) return <AuthPage onAuthenticated={setUser} />;
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }); setUser(null); };
  return <Routes><Route path="/" element={<Dashboard user={user} onLogout={() => void logout()} />} /><Route path="/projects/:projectId" element={<Workspace user={user} />} /><Route path="/invitations/:token" element={<InvitationPage user={user} />} /><Route path="*" element={<Navigate to="/" />} /></Routes>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
