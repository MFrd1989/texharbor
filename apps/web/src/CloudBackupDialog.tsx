import { useCallback, useEffect, useState } from 'react';
import type { ProjectDto } from '@texharbor/contracts';
import { api } from './api';

type CloudStatus = { configured: boolean; connected: boolean; accountEmail: string | null; accountName: string | null };
type Backup = { id: string; provider: string; fileName: string; sourceHash: string; size: number; createdAt: string };
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function CloudBackupDialog({ projects, initialProjectId, onClose }: { projects: ProjectDto[]; initialProjectId?: string | undefined; onClose: () => void }) {
  const ownedProjects = projects.filter((project) => project.role === 'owner' && !project.deletedAt);
  const [projectId, setProjectId] = useState(initialProjectId || ownedProjects[0]?.id || '');
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const loadStatus = useCallback(async () => { try { setStatus(await api<CloudStatus>('/api/cloud/google')); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load cloud status'); } }, []);
  const loadBackups = useCallback(async () => { if (!projectId) { setBackups([]); return; } try { setBackups((await api<{ backups: Backup[] }>(`/api/projects/${projectId}/backups`)).backups); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load backups'); } }, [projectId]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => { void loadBackups(); }, [loadBackups]);
  const connect = async () => { setBusy(true); setError(''); try { window.location.assign((await api<{ url: string }>('/api/cloud/google/connect', { method: 'POST' })).url); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start Google authorization'); setBusy(false); } };
  const disconnect = async () => { if (!confirm('Disconnect Google Drive? Existing files stay in Drive, but TeXHarbor cannot restore them until you reconnect.')) return; setBusy(true); setError(''); try { await api('/api/cloud/google', { method: 'DELETE' }); setMessage('Google Drive disconnected.'); await loadStatus(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not disconnect Google Drive'); } finally { setBusy(false); } };
  const backupNow = async () => { if (!projectId) return; setBusy(true); setError(''); setMessage(''); try { const result = await api<{ unchanged: boolean }>(`/api/projects/${projectId}/backups`, { method: 'POST' }); setMessage(result.unchanged ? 'No changes since the latest backup.' : 'Backup uploaded to Google Drive.'); await loadBackups(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Backup failed'); } finally { setBusy(false); } };
  const restore = async (backup: Backup) => { if (!confirm(`Restore ${backup.fileName}? Current project files will be checkpointed first, then replaced with this backup.`)) return; setBusy(true); setError(''); setMessage(''); try { await api(`/api/projects/${projectId}/backups/${backup.id}/restore`, { method: 'POST' }); setMessage('Backup restored. Reopen the project to load the restored files.'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Restore failed'); } finally { setBusy(false); } };
  return <div className="dialog-backdrop" role="presentation"><section className="dialog cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-title">
    <header><div><p className="eyebrow">CLOUD SAFETY</p><h2 id="cloud-title">Google Drive backups</h2></div><button type="button" aria-label="Close cloud backups" onClick={onClose}>×</button></header>
    {!status ? <p>Checking Google Drive…</p> : !status.configured ? <div className="cloud-unavailable"><strong>Google Drive is not configured</strong><p>The server operator must set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, with this OAuth redirect URI:</p><code>{`${window.location.origin}/api/cloud/google/callback`}</code></div> : !status.connected ? <div className="cloud-connect"><p>Connect Drive to store private, restorable ZIP snapshots in a dedicated <strong>TeXHarbor Backups</strong> folder.</p><button className="primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Opening Google…' : 'Connect Google Drive'}</button><small>Only the <code>drive.file</code> scope is requested. TeXHarbor cannot access other Drive files.</small></div> : <>
      <div className="cloud-account"><span>G</span><div><strong>{status.accountName || 'Google Drive connected'}</strong><small>{status.accountEmail || 'Connected account'}</small></div><button className="compact" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></div>
      {ownedProjects.length ? <div className="cloud-project"><label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{ownedProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><button className="primary" disabled={busy || !projectId} onClick={() => void backupNow()}>{busy ? 'Working…' : 'Back up now'}</button></div> : <p className="cloud-unavailable">Create or own a project before making a backup.</p>}
      <section className="backup-history"><h3>Backup history</h3>{backups.length ? backups.map((backup) => <article key={backup.id}><div><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>{backup.fileName} · {formatSize(Number(backup.size))}</small></div><button className="compact" disabled={busy} onClick={() => void restore(backup)}>Restore</button></article>) : <p>No backups for this project yet.</p>}</section>
    </>}
    {message && <p className="success" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
  </section></div>;
}
