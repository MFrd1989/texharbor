import { useCallback, useEffect, useState } from 'react';
import type { BackupDestination, BackupDto, BackupProvider, BackupScheduleDto, ProjectDto } from '@texharbor/contracts';
import { api } from './api';

type CloudStatus = { configured: boolean; connected: boolean; accountEmail: string | null; accountName: string | null };
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const providerName = (provider: BackupProvider) => provider === 'local' ? 'Local' : 'Google Drive';
const kindName = (kind: BackupDto['kind']) => kind === 'pre_restore' ? 'Safety checkpoint' : kind === 'scheduled' ? 'Scheduled' : 'Manual';

export function CloudBackupDialog({ projects, initialProjectId, onClose }: { projects: ProjectDto[]; initialProjectId?: string | undefined; onClose: () => void }) {
  const ownedProjects = projects.filter((project) => project.role === 'owner' && !project.deletedAt);
  const [projectId, setProjectId] = useState(initialProjectId || ownedProjects[0]?.id || '');
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [backups, setBackups] = useState<BackupDto[]>([]);
  const [schedule, setSchedule] = useState<BackupScheduleDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    try { setStatus(await api<CloudStatus>('/api/cloud/google')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load Google Drive status'); }
  }, []);
  const loadProjectBackups = useCallback(async () => {
    if (!projectId) { setBackups([]); setSchedule(null); return; }
    try {
      const [history, policy] = await Promise.all([
        api<{ backups: BackupDto[] }>(`/api/projects/${projectId}/backups`),
        api<{ schedule: BackupScheduleDto }>(`/api/projects/${projectId}/backup-schedule`),
      ]);
      setBackups(history.backups);
      setSchedule(policy.schedule);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load version history'); }
  }, [projectId]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => { setSchedule(null); void loadProjectBackups(); }, [loadProjectBackups]);

  const connect = async () => {
    setBusy(true); setError('');
    try { window.location.assign((await api<{ url: string }>('/api/cloud/google/connect', { method: 'POST' })).url); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start Google authorization'); setBusy(false); }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect Google Drive? Existing Drive versions remain there, but cannot be restored until you reconnect.')) return;
    setBusy(true); setError('');
    try { await api('/api/cloud/google', { method: 'DELETE' }); setMessage('Google Drive disconnected.'); await loadStatus(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not disconnect Google Drive'); }
    finally { setBusy(false); }
  };
  const backupNow = async (provider: BackupProvider) => {
    if (!projectId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ unchanged: boolean }>(`/api/projects/${projectId}/backups`, { method: 'POST', body: JSON.stringify({ provider }) });
      setMessage(result.unchanged ? `No changes since the latest ${providerName(provider)} version.` : `${providerName(provider)} version created.`);
      await loadProjectBackups();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Backup failed'); }
    finally { setBusy(false); }
  };
  const saveSchedule = async () => {
    if (!projectId || !schedule) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<{ schedule: BackupScheduleDto }>(`/api/projects/${projectId}/backup-schedule`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: schedule.enabled, destination: schedule.destination, intervalHours: schedule.intervalHours, retentionCount: schedule.retentionCount }),
      });
      setSchedule(result.schedule);
      await loadProjectBackups();
      setMessage(result.schedule.enabled ? 'Backup schedule enabled.' : 'Backup schedule disabled.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save backup schedule'); }
    finally { setBusy(false); }
  };
  const restore = async (backup: BackupDto) => {
    if (!confirm(`Restore the version from ${new Date(backup.createdAt).toLocaleString()}? Your current work will be kept in local history.`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/api/projects/${projectId}/backups/${backup.id}/restore`, { method: 'POST' });
      window.location.reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Restore failed'); }
    finally { setBusy(false); }
  };
  const remove = async (backup: BackupDto) => {
    if (!confirm(`Delete this ${providerName(backup.provider)} version?${backup.provider === 'google_drive' ? ' The file will also be removed from Drive.' : ''}`)) return;
    setBusy(true); setError(''); setMessage('');
    try { await api(`/api/projects/${projectId}/backups/${backup.id}`, { method: 'DELETE' }); setMessage('Version deleted.'); await loadProjectBackups(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete version'); }
    finally { setBusy(false); }
  };

  const needsGoogle = schedule?.destination !== 'local';
  return <div className="dialog-backdrop" role="presentation"><section className="dialog cloud-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-title">
    <header><div><p className="eyebrow">PROJECT HISTORY</p><h2 id="cloud-title">Backups &amp; versions</h2></div><button type="button" aria-label="Close backups and versions" onClick={onClose}>×</button></header>
    {ownedProjects.length ? <div className="cloud-project-picker"><label>Project<select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{ownedProjects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label></div> : <p className="cloud-unavailable">Create or own a project before saving versions.</p>}

    {projectId && <>
      <section className="backup-actions"><div><h3>Save a version now</h3><p>History starts with one full base. Later versions store compressed changes, reusing unchanged content.</p></div><div><button disabled={busy} onClick={() => void backupNow('local')}>Save locally</button><button className="primary" disabled={busy || !status?.connected} onClick={() => void backupNow('google_drive')}>Save to Drive</button></div></section>

      <section className="schedule-card"><div className="schedule-heading"><div><h3>Scheduled backups</h3><p>Enabling saves the initial state now. Each scheduled check saves only new changes.</p></div><label className="switch-label"><input type="checkbox" checked={schedule?.enabled || false} disabled={!schedule || busy} onChange={(event) => setSchedule((current) => current ? { ...current, enabled: event.target.checked } : current)} /> Enabled</label></div>
        {schedule && <div className="schedule-grid">
          <label>Destination<select value={schedule.destination} onChange={(event) => setSchedule({ ...schedule, destination: event.target.value as BackupDestination })}><option value="local">Local server</option><option value="google_drive">Google Drive</option><option value="both">Local + Google Drive</option></select></label>
          <label>Frequency<select value={schedule.intervalHours} onChange={(event) => setSchedule({ ...schedule, intervalHours: Number(event.target.value) as BackupScheduleDto['intervalHours'] })}><option value={1}>Every hour</option><option value={6}>Every 6 hours</option><option value={12}>Every 12 hours</option><option value={24}>Daily</option><option value={168}>Weekly</option></select></label>
          <label>Keep scheduled versions<select value={schedule.retentionCount} onChange={(event) => setSchedule({ ...schedule, retentionCount: Number(event.target.value) })}><option value={5}>5 per destination</option><option value={10}>10 per destination</option><option value={20}>20 per destination</option><option value={50}>50 per destination</option><option value={100}>100 per destination</option></select></label>
          <button className="compact" disabled={busy || (schedule.enabled && needsGoogle && !status?.connected)} onClick={() => void saveSchedule()}>Save schedule</button>
        </div>}
        {schedule?.enabled && <p className="schedule-status">{schedule.lastError ? <span className="schedule-failed">Last attempt failed: {schedule.lastError}</span> : schedule.nextRunAt ? <>Next run {new Date(schedule.nextRunAt).toLocaleString()}{schedule.lastSuccessAt && <> · Last success {new Date(schedule.lastSuccessAt).toLocaleString()}</>}</> : 'Schedule is enabled.'}</p>}
        <small>Retention removes older scheduled versions while keeping the remaining history restorable. Manual versions and safety checkpoints are kept. Drive cleanup may take a few minutes.</small>
      </section>

      <section className="drive-card"><h3>Google Drive</h3>{!status ? <p>Checking connection…</p> : !status.configured ? <div className="cloud-unavailable"><strong>Google Drive is not configured</strong><p>The server operator must set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, with this redirect URI:</p><code>{`${window.location.origin}/api/cloud/google/callback`}</code></div> : status.connected ? <div className="cloud-account"><span>G</span><div><strong>{status.accountName || 'Google Drive connected'}</strong><small>{status.accountEmail || 'Connected account'}</small></div><button className="compact" disabled={busy} onClick={() => void disconnect()}>Disconnect</button></div> : <div className="cloud-connect"><p>Connect Drive to create and restore off-server versions.</p><button className="primary" disabled={busy} onClick={() => void connect()}>{busy ? 'Opening Google…' : 'Connect Google Drive'}</button><small>Only the <code>drive.file</code> scope is requested.</small></div>}</section>

      <section className="backup-history"><h3>Version history</h3>{backups.length ? backups.map((backup) => {
        const unavailable = backup.provider === 'google_drive' && !status?.connected;
        return <article key={backup.id}><div className="backup-version"><div><span className={`backup-provider ${backup.provider}`}>{providerName(backup.provider)}</span><span className="backup-kind">{kindName(backup.kind)}</span><span className="backup-kind">{backup.storageFormat === 'delta' ? 'Changes only' : 'Full base'}</span></div><strong>{new Date(backup.createdAt).toLocaleString()}</strong><small>{formatSize(Number(backup.size))} stored{backup.sourceHash && <> · {backup.sourceHash.slice(0, 8)}</>}</small></div><div className="backup-version-actions"><button className="compact" disabled={busy || unavailable} onClick={() => void restore(backup)}>Restore</button><button className="compact danger" disabled={busy || unavailable} onClick={() => void remove(backup)}>Delete</button></div></article>;
      }) : <p>No saved versions for this project yet.</p>}</section>
    </>}
    {message && <p className="success" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
  </section></div>;
}
