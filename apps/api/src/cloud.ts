import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { backupScheduleSchema, createBackupSchema, type BackupDestination, type BackupProvider } from '@texharbor/contracts';
import type { DatabasePool, DatabaseClient } from '@texharbor/database';
import { transaction } from '@texharbor/database';
import { requireUser } from './auth.js';
import type { CollaborationServer } from './collaboration.js';
import type { Config } from './config.js';
import { openCredential, sealCredential } from './credential-crypto.js';
import { HttpError, parseBody } from './http.js';
import { readProjectSnapshot, createProjectDeltaBackup, createFullProjectBackup, newFileId, readProjectBackup, type ProjectBackupSnapshot } from './project-backup.js';
import { requireProject } from './routes.js';

const googleProvider = 'google_drive';
const driveScope = 'https://www.googleapis.com/auth/drive.file';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const callbackPath = '/api/cloud/google/callback';
const backupFields = 'id, provider, kind, storage_format AS "storageFormat", parent_id AS "parentId", file_name AS "fileName", source_hash AS "sourceHash", size, created_at AS "createdAt"';
const backupRecordFields = `${backupFields}, provider_file_id`;
type BackupDatabase = Pick<DatabasePool, 'query'>;
const pendingUploads = new WeakMap<BackupDatabase, Array<{ userId: string; fileId: string }>>();

type ConnectionRow = {
  encrypted_refresh_token: string;
  account_email: string | null;
  account_name: string | null;
  provider_folder_id: string | null;
  updated_at: Date;
};

type BackupSnapshot = Awaited<ReturnType<typeof readProjectSnapshot>>;
type BackupRecord = {
  id: string;
  provider: BackupProvider;
  provider_file_id: string | null;
  fileName: string;
  sourceHash: string | null;
  parentId: string | null;
  storageFormat: 'full' | 'delta';
};

type ScheduleRow = {
  projectId: string;
  createdBy: string;
  destination: BackupDestination;
  intervalHours: number;
  retentionCount: number;
};

export function providersForDestination(destination: BackupDestination): BackupProvider[] {
  if (destination === 'both') return ['local', 'google_drive'];
  return [destination];
}

function isConfigured(config: Config): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

function requireGoogleConfig(config: Config): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, 'Google Drive backup is not configured on this server');
  return { clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: `${config.publicOrigin.replace(/\/$/, '')}${callbackPath}` };
}

async function exchangeToken(config: Config, values: Record<string, string>): Promise<Record<string, unknown>> {
  const { clientId, clientSecret, redirectUri } = requireGoogleConfig(config);
  const parameters = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...values });
  if (values.grant_type === 'authorization_code') parameters.set('redirect_uri', redirectUri);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: parameters,
  });
  if (!response.ok) throw new HttpError(502, 'Google authorization could not be completed');
  return response.json() as Promise<Record<string, unknown>>;
}

async function accessToken(pool: BackupDatabase, config: Config, userId: string): Promise<{ token: string; connection: ConnectionRow }> {
  const connectionResult = await pool.query<ConnectionRow>('SELECT encrypted_refresh_token, account_email, account_name, provider_folder_id, updated_at FROM cloud_connections WHERE user_id = $1 AND provider = $2', [userId, googleProvider]);
  const connection = connectionResult.rows[0];
  if (!connection) throw new HttpError(409, 'Connect Google Drive before creating a cloud backup');
  const tokens = await exchangeToken(config, { refresh_token: openCredential(connection.encrypted_refresh_token, config.sessionSecret), grant_type: 'refresh_token' });
  if (typeof tokens.access_token !== 'string') throw new HttpError(502, 'Google authorization has expired; reconnect Google Drive');
  return { token: tokens.access_token, connection };
}

async function googleRequest(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new HttpError(409, 'Google Drive access was revoked; reconnect your account');
    throw new HttpError(502, `Google Drive request failed (${response.status})`);
  }
  return response;
}

async function ensureBackupFolder(pool: BackupDatabase, userId: string, token: string, connection: ConnectionRow): Promise<string> {
  if (connection.provider_folder_id) return connection.provider_folder_id;
  const response = await googleRequest(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'TeXHarbor Backups', mimeType: 'application/vnd.google-apps.folder', appProperties: { texharbor: 'backups-v1' } }),
  });
  const folder = await response.json() as { id?: string };
  if (!folder.id) throw new HttpError(502, 'Google Drive did not return the backup folder');
  await pool.query('UPDATE cloud_connections SET provider_folder_id = $3, updated_at = now() WHERE user_id = $1 AND provider = $2', [userId, googleProvider, folder.id]);
  return folder.id;
}

async function uploadBackup(token: string, folderId: string, backupId: string, projectId: string, fileName: string, archive: Buffer): Promise<{ id: string; name: string }> {
  const boundary = `texharbor_${randomUUID()}`;
  const metadata = { name: fileName, mimeType: 'application/zip', parents: [folderId], appProperties: { texharborBackupId: backupId, texharborProjectId: projectId, schema: fileName.endsWith('.delta.zip') ? '2' : '1' } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`),
    archive,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const response = await googleRequest(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
  });
  const uploaded = await response.json() as { id?: string; name?: string };
  if (!uploaded.id) throw new HttpError(502, 'Google Drive did not return the uploaded backup');
  return { id: uploaded.id, name: uploaded.name || fileName };
}

async function createBackupCopy(
  pool: BackupDatabase,
  config: Config,
  projectId: string,
  userId: string,
  provider: BackupProvider,
  kind: 'manual' | 'scheduled' | 'pre_restore',
  snapshot: BackupSnapshot,
): Promise<{ backup: Record<string, unknown>; unchanged: boolean }> {
  const latest = await pool.query<BackupRecord & Record<string, unknown>>(`SELECT ${backupRecordFields} FROM backup_records
    WHERE project_id = $1 AND provider = $2 ORDER BY version_sequence DESC LIMIT 1`, [projectId, provider]);
  if (latest.rows[0]?.sourceHash === snapshot.manifest.sourceHash) {
    const { provider_file_id: _providerFileId, ...existing } = latest.rows[0];
    return { backup: existing, unchanged: true };
  }
  const parent = latest.rows[0];
  const backup = parent
    ? await createProjectDeltaBackup(snapshot, await readBackupSnapshot(pool, config, projectId, userId, parent), parent.id)
    : { ...snapshot, archive: await createFullProjectBackup(snapshot) };

  const backupId = randomUUID();
  let providerFileId: string | null = null;
  let archive: Buffer | null = backup.archive;
  let fileName = backup.fileName;
  if (provider === 'google_drive') {
    const authorization = await accessToken(pool, config, userId);
    const folderId = await ensureBackupFolder(pool, userId, authorization.token, authorization.connection);
    const uploaded = await uploadBackup(authorization.token, folderId, backupId, projectId, backup.fileName, backup.archive);
    pendingUploads.get(pool)?.push({ userId, fileId: uploaded.id });
    providerFileId = uploaded.id;
    archive = null;
    fileName = uploaded.name;
  }
  const inserted = await pool.query<Record<string, unknown>>(`INSERT INTO backup_records
    (id, project_id, created_by, provider, provider_file_id, file_name, source_hash, size, archive, kind, storage_format, parent_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp()) RETURNING ${backupFields}`,
  [backupId, projectId, userId, provider, providerFileId, fileName, backup.manifest.sourceHash, backup.archive.byteLength, archive, kind, parent ? 'delta' : 'full', parent?.id || null]);
  await pool.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'backup.created', 'backup', $3, $4)", [projectId, userId, backupId, { provider, fileName, kind }]);
  return { backup: inserted.rows[0]!, unchanged: false };
}

async function readBackupArchive(pool: BackupDatabase, projectId: string, record: BackupRecord, token?: string): Promise<Buffer> {
  if (record.provider === 'local') {
    const result = await pool.query<{ archive: Buffer | null }>('SELECT archive FROM backup_records WHERE id = $1 AND project_id = $2', [record.id, projectId]);
    const archive = result.rows[0]?.archive;
    if (!archive) throw new HttpError(422, 'Local backup data is missing');
    return archive;
  }
  if (!record.provider_file_id || !token) throw new HttpError(422, 'Google Drive backup reference is missing');
  const response = await googleRequest(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.provider_file_id)}?alt=media`);
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(422, 'Google Drive backup data is missing');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > 100 * 1024 * 1024) throw new HttpError(422, 'Backup is larger than 100 MB');
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel(); }
}

async function readBackupSnapshot(pool: BackupDatabase, config: Config, projectId: string, userId: string, record: BackupRecord): Promise<ProjectBackupSnapshot> {
  const chain: BackupRecord[] = [];
  const seen = new Set<string>();
  let current: BackupRecord | undefined = record;
  while (current) {
    if (seen.has(current.id)) throw new HttpError(422, 'Backup history contains a cycle');
    seen.add(current.id);
    chain.push(current);
    if (!current.parentId) break;
    const parent: { rows: BackupRecord[] } = await pool.query<BackupRecord>(`SELECT ${backupRecordFields} FROM backup_records WHERE id = $1 AND project_id = $2 AND provider = $3`, [current.parentId, projectId, record.provider]);
    current = parent.rows[0];
    if (!current) throw new HttpError(422, 'Backup history is missing a parent version');
  }
  let snapshot: ProjectBackupSnapshot | undefined;
  const token = record.provider === 'google_drive' ? (await accessToken(pool, config, userId)).token : undefined;
  for (const version of chain.reverse()) {
    snapshot = await readProjectBackup(await readBackupArchive(pool, projectId, version, token), projectId, snapshot, version.parentId || undefined);
    if ((snapshot.manifest.version === 2) !== (version.storageFormat === 'delta') || (version.sourceHash && snapshot.manifest.sourceHash !== version.sourceHash)) throw new HttpError(422, 'Backup history integrity check failed');
  }
  return snapshot!;
}

async function withBackupLock<T>(pool: DatabasePool, projectId: string, run: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const uploads: Array<{ userId: string; fileId: string }> = [];
  const busy = Symbol('busy');
  try {
    for (let attempt = 0; attempt < 600; attempt++) {
      const result = await transaction(pool, async (client) => {
        const lock = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended('backup:' || $1, 0)) AS acquired", [projectId]);
        if (!lock.rows[0]?.acquired) return busy;
        pendingUploads.set(client, uploads);
        try { return await run(client); }
        finally { pendingUploads.delete(client); }
      });
      if (result !== busy) return result as T;
      // Release the pooled connection while waiting so collaboration can flush.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new HttpError(409, 'Project history is busy; try again shortly');
  } catch (error) {
    // A failed transaction must not leave newly uploaded, unreferenced archives.
    for (const upload of uploads) await queueRemoteDeletion(pool, upload.userId, upload.fileId);
    throw error;
  }
}

async function deleteGoogleFile(token: string, fileId: string): Promise<void> {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  if (response.ok || response.status === 404) return;
  if (response.status === 401 || response.status === 403) throw new HttpError(409, 'Google Drive access was revoked; reconnect your account');
  throw new HttpError(502, `Google Drive request failed (${response.status})`);
}

async function removeBackupRecords(pool: BackupDatabase, config: Config, projectId: string, userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  // Rebase surviving boundaries onto retained ancestors; only a root needs a full base.
  const children = await pool.query<BackupRecord>(`SELECT ${backupRecordFields} FROM backup_records
    WHERE project_id = $1 AND parent_id = ANY($2::uuid[]) AND NOT (id = ANY($2::uuid[]))`, [projectId, ids]);
  for (const child of children.rows) {
    const snapshot = await readBackupSnapshot(pool, config, projectId, userId, child);
    let parentId = child.parentId;
    let retainedParent: BackupRecord | undefined;
    const seen = new Set<string>();
    while (parentId) {
      if (seen.has(parentId)) throw new HttpError(422, 'Backup history contains a cycle');
      seen.add(parentId);
      const result: { rows: BackupRecord[] } = await pool.query<BackupRecord>(`SELECT ${backupRecordFields} FROM backup_records WHERE id = $1 AND project_id = $2 AND provider = $3`, [parentId, projectId, child.provider]);
      const parent = result.rows[0];
      if (!parent) throw new HttpError(422, 'Backup history is missing a parent version');
      if (!ids.includes(parentId)) { retainedParent = parent; break; }
      parentId = parent.parentId;
    }
    let fileName = child.fileName.replace(/\.delta\.zip$/, '.zip');
    let archive: Buffer;
    if (retainedParent) {
      const rebased = await createProjectDeltaBackup({ ...snapshot, fileName }, await readBackupSnapshot(pool, config, projectId, userId, retainedParent), retainedParent.id);
      archive = rebased.archive;
      fileName = rebased.fileName;
    } else archive = await createFullProjectBackup(snapshot);
    let providerFileId: string | null = null;
    if (child.provider === 'google_drive') {
      const authorization = await accessToken(pool, config, userId);
      const folderId = await ensureBackupFolder(pool, userId, authorization.token, authorization.connection);
      const uploaded = await uploadBackup(authorization.token, folderId, child.id, projectId, fileName, archive);
      pendingUploads.get(pool)?.push({ userId, fileId: uploaded.id });
      providerFileId = uploaded.id;
      if (child.provider_file_id) await queueRemoteDeletion(pool, userId, child.provider_file_id);
    }
    await pool.query(`UPDATE backup_records SET archive = $2, provider_file_id = $3, size = $4, file_name = $5,
      parent_id = $6, storage_format = $7 WHERE id = $1`, [child.id, child.provider === 'local' ? archive : null, providerFileId, archive.length, fileName, retainedParent?.id || null, retainedParent ? 'delta' : 'full']);
  }
  const removed = await pool.query<{ provider_file_id: string | null }>('DELETE FROM backup_records WHERE project_id = $1 AND id = ANY($2::uuid[]) RETURNING provider_file_id', [projectId, ids]);
  for (const record of removed.rows) if (record.provider_file_id) await queueRemoteDeletion(pool, userId, record.provider_file_id);
}

async function queueRemoteDeletion(pool: BackupDatabase, userId: string, fileId: string): Promise<void> {
  await pool.query('INSERT INTO backup_remote_deletions (provider_file_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fileId, userId]);
}

async function flushRemoteDeletions(pool: DatabasePool, config: Config): Promise<void> {
  const pending = await pool.query<{ user_id: string; provider_file_id: string }>('SELECT user_id, provider_file_id FROM backup_remote_deletions ORDER BY created_at LIMIT 50');
  for (const record of pending.rows) {
    try {
      const authorization = await accessToken(pool, config, record.user_id);
      await deleteGoogleFile(authorization.token, record.provider_file_id);
      await pool.query('DELETE FROM backup_remote_deletions WHERE provider_file_id = $1', [record.provider_file_id]);
    } catch { /* Keep the durable queue entry for the next scheduler poll. */ }
  }
}

async function enforceRetention(pool: BackupDatabase, config: Config, projectId: string, userId: string, provider: BackupProvider, retentionCount: number): Promise<void> {
  const stale = await pool.query<{ id: string }>(`SELECT id FROM backup_records
    WHERE project_id = $1 AND provider = $2 AND kind = 'scheduled' ORDER BY version_sequence DESC OFFSET $3`, [projectId, provider, retentionCount]);
  await removeBackupRecords(pool, config, projectId, userId, stale.rows.map((record) => record.id));
}

async function runScheduledBackup(pool: DatabasePool, config: Config, collaboration: CollaborationServer, schedule: ScheduleRow): Promise<void> {
  try {
    await collaboration.persistProject(schedule.projectId);
    for (const provider of providersForDestination(schedule.destination)) {
      await withBackupLock(pool, schedule.projectId, async (client) => {
        const archive = await readProjectSnapshot(client, schedule.projectId);
        await createBackupCopy(client, config, schedule.projectId, schedule.createdBy, provider, 'scheduled', archive);
        await enforceRetention(client, config, schedule.projectId, schedule.createdBy, provider, schedule.retentionCount);
      });
    }
    await pool.query('UPDATE backup_schedules SET last_success_at = now(), last_error = NULL, updated_at = now() WHERE project_id = $1', [schedule.projectId]);
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'Scheduled backup failed').slice(0, 1000);
    await pool.query('UPDATE backup_schedules SET last_error = $2, updated_at = now() WHERE project_id = $1', [schedule.projectId, message]);
  }
}

export async function runDueBackups(pool: DatabasePool, config: Config, collaboration: CollaborationServer): Promise<void> {
  const due = await pool.query<ScheduleRow>(`WITH due AS (
      SELECT bs.project_id FROM backup_schedules bs JOIN projects p ON p.id = bs.project_id
      WHERE bs.enabled AND bs.next_run_at <= now() AND p.deleted_at IS NULL
      ORDER BY bs.next_run_at LIMIT 5 FOR UPDATE OF bs SKIP LOCKED
    )
    UPDATE backup_schedules bs SET
      next_run_at = now() + make_interval(hours => bs.interval_hours), last_run_at = now(), last_error = NULL, updated_at = now()
    FROM due WHERE bs.project_id = due.project_id
    RETURNING bs.project_id AS "projectId", bs.created_by AS "createdBy", bs.destination, bs.interval_hours AS "intervalHours", bs.retention_count AS "retentionCount"`);
  for (const schedule of due.rows) await runScheduledBackup(pool, config, collaboration, schedule);
  await flushRemoteDeletions(pool, config);
}

export function startBackupScheduler(pool: DatabasePool, config: Config, collaboration: CollaborationServer): { destroy: () => Promise<void> } {
  let stopped = false;
  let active: Promise<void> | null = null;
  const poll = () => {
    if (stopped || active) return;
    active = runDueBackups(pool, config, collaboration)
      .catch((error) => console.error('Scheduled backup poll failed', error))
      .finally(() => { active = null; });
  };
  const timer = setInterval(poll, 60_000);
  timer.unref();
  poll();
  return { destroy: async () => { stopped = true; clearInterval(timer); await active; } };
}

export async function registerCloudRoutes(app: FastifyInstance, pool: DatabasePool, config: Config, collaboration: CollaborationServer): Promise<void> {
  app.get('/api/cloud/google', async (request) => {
    const user = await requireUser(pool, request);
    const result = await pool.query<ConnectionRow>('SELECT encrypted_refresh_token, account_email, account_name, provider_folder_id, updated_at FROM cloud_connections WHERE user_id = $1 AND provider = $2', [user.id, googleProvider]);
    const connection = result.rows[0];
    return { configured: isConfigured(config), connected: Boolean(connection), accountEmail: connection?.account_email || null, accountName: connection?.account_name || null, updatedAt: connection?.updated_at || null };
  });

  app.post('/api/cloud/google/connect', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
    const user = await requireUser(pool, request);
    const { clientId, redirectUri } = requireGoogleConfig(config);
    const state = randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM oauth_states WHERE expires_at <= now()');
    await pool.query('INSERT INTO oauth_states (state_hash, user_id, provider, expires_at) VALUES ($1, $2, $3, now() + interval \'10 minutes\')', [hash(state), user.id, googleProvider]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: driveScope, access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent', state }).toString();
    return { url: url.toString() };
  });

  app.get(callbackPath, async (request, reply) => {
    const query = request.query as { state?: string; code?: string; error?: string };
    const target = new URL('/', config.publicOrigin);
    try {
      const user = await requireUser(pool, request);
      if (!query.state || query.state.length > 256) throw new HttpError(400, 'Invalid Google authorization state');
      const stateResult = await pool.query<{ user_id: string }>('DELETE FROM oauth_states WHERE state_hash = $1 AND provider = $2 AND expires_at > now() RETURNING user_id', [hash(query.state), googleProvider]);
      if (stateResult.rows[0]?.user_id !== user.id) throw new HttpError(400, 'Google authorization state expired; try connecting again');
      if (query.error) throw new HttpError(400, 'Google Drive access was not granted');
      if (!query.code || query.code.length > 4096) throw new HttpError(400, 'Google did not return an authorization code');
      const tokens = await exchangeToken(config, { code: query.code, grant_type: 'authorization_code' });
      if (typeof tokens.access_token !== 'string') throw new HttpError(502, 'Google did not return a usable authorization');
      const existing = await pool.query<{ encrypted_refresh_token: string }>('SELECT encrypted_refresh_token FROM cloud_connections WHERE user_id = $1 AND provider = $2', [user.id, googleProvider]);
      const encryptedRefreshToken = typeof tokens.refresh_token === 'string' ? sealCredential(tokens.refresh_token, config.sessionSecret) : existing.rows[0]?.encrypted_refresh_token;
      if (!encryptedRefreshToken) throw new HttpError(409, 'Google did not issue offline access; revoke TeXHarbor access in Google and connect again');
      const aboutResponse = await googleRequest(tokens.access_token, 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)');
      const about = await aboutResponse.json() as { user?: { displayName?: string; emailAddress?: string } };
      await pool.query(`INSERT INTO cloud_connections (user_id, provider, encrypted_refresh_token, account_email, account_name)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        account_email = EXCLUDED.account_email, account_name = EXCLUDED.account_name, updated_at = now()`, [user.id, googleProvider, encryptedRefreshToken, about.user?.emailAddress || null, about.user?.displayName || null]);
      target.searchParams.set('cloud', 'connected');
    } catch (error) {
      target.searchParams.set('cloud', 'error');
      target.searchParams.set('message', error instanceof Error ? error.message : 'Google Drive connection failed');
    }
    return reply.redirect(target.toString());
  });

  app.delete('/api/cloud/google', async (request, reply) => {
    const user = await requireUser(pool, request);
    const result = await pool.query<ConnectionRow>('DELETE FROM cloud_connections WHERE user_id = $1 AND provider = $2 RETURNING encrypted_refresh_token, account_email, account_name, provider_folder_id, updated_at', [user.id, googleProvider]);
    const connection = result.rows[0];
    if (connection) {
      const token = openCredential(connection.encrypted_refresh_token, config.sessionSecret);
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }).catch(() => undefined);
    }
    return reply.code(204).send();
  });

  app.get('/api/projects/:projectId/backups', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can view project backups');
    const result = await pool.query(`SELECT ${backupFields} FROM backup_records WHERE project_id = $1 ORDER BY version_sequence DESC LIMIT 100`, [projectId]);
    return { backups: result.rows };
  });

  app.post('/api/projects/:projectId/backups', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can back up this project');
    const input = parseBody(createBackupSchema, request.body);
    const result = await withBackupLock(pool, projectId, async (client) => {
      await collaboration.persistProject(projectId);
      return createBackupCopy(client, config, projectId, user.id, input.provider, 'manual', await readProjectSnapshot(client, projectId));
    });
    return reply.code(result.unchanged ? 200 : 201).send(result);
  });

  app.delete('/api/projects/:projectId/backups/:backupId', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId, backupId } = request.params as { projectId: string; backupId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can delete project backups');
    await withBackupLock(pool, projectId, async (client) => {
      const result = await client.query<BackupRecord>(`SELECT ${backupRecordFields} FROM backup_records WHERE id = $1 AND project_id = $2`, [backupId, projectId]);
      const record = result.rows[0];
      if (!record) throw new HttpError(404, 'Backup not found');
      if (record.provider === 'google_drive') await accessToken(client, config, user.id);
      await removeBackupRecords(client, config, projectId, user.id, [backupId]);
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'backup.deleted', 'backup', $3, $4)", [projectId, user.id, backupId, { provider: record.provider, fileName: record.fileName }]);
    });
    return reply.code(204).send();
  });

  app.post('/api/projects/:projectId/backups/:backupId/restore', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const user = await requireUser(pool, request);
    const { projectId, backupId } = request.params as { projectId: string; backupId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can restore project backups');
    const versionId = await withBackupLock(pool, projectId, async (client) => {
      const recordResult = await client.query<BackupRecord>(`SELECT ${backupRecordFields} FROM backup_records WHERE id = $1 AND project_id = $2`, [backupId, projectId]);
      const record = recordResult.rows[0];
      if (!record) throw new HttpError(404, 'Backup not found');
      const restored = await readBackupSnapshot(client, config, projectId, user.id, record);
      await collaboration.persistProject(projectId);
      await collaboration.resetProject(projectId);
      const safety = await readProjectSnapshot(client, projectId);
      safety.fileName = `Before restore - ${safety.fileName}`;
      const saved = await createBackupCopy(client, config, projectId, user.id, 'local', 'pre_restore', safety);
      const safetyVersionId = saved.backup.id as string;
      // Reuse identical content, but keep its safety checkpoint out of scheduled pruning.
      await client.query("UPDATE backup_records SET kind = 'pre_restore' WHERE id = $1 AND kind = 'scheduled'", [safetyVersionId]);
      const existingFiles = await client.query<{ id: string; path: string }>('SELECT id, path FROM project_files WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM collaboration_documents WHERE project_id = $1', [projectId]);
      await client.query("UPDATE project_files SET path = '/.restore-' || id::text WHERE project_id = $1", [projectId]);
      const newFileIds = new Map<string, string>();
      for (const file of restored.files) {
        const fileId = newFileId();
        if (file.kind === 'file') newFileIds.set(file.path, fileId);
        await client.query(`INSERT INTO project_files (id, project_id, path, kind, mime_type, content, size, is_binary)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [fileId, projectId, file.path, file.kind, file.mimeType, file.content, file.size, file.isBinary]);
      }
      for (const oldFile of existingFiles.rows) {
        const replacementId = newFileIds.get(oldFile.path);
        if (replacementId) await client.query('UPDATE comment_threads SET file_id = $2 WHERE file_id = $1', [oldFile.id, replacementId]);
      }
      if (existingFiles.rowCount) await client.query('DELETE FROM project_files WHERE id = ANY($1::uuid[])', [existingFiles.rows.map((file) => file.id)]);
      await client.query('UPDATE projects SET name = $2, description = $3, main_file_path = $4, compiler = $5, updated_at = now() WHERE id = $1', [projectId, restored.manifest.project.name.slice(0, 200), restored.manifest.project.description.slice(0, 2000), restored.manifest.project.mainFilePath, restored.manifest.project.compiler]);
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'backup.restored', 'backup', $3, $4)", [projectId, user.id, backupId, { provider: record.provider, safetyVersionId }]);
      return safetyVersionId;
    });
    await collaboration.resetProject(projectId);
    return { restored: true, safetyVersionId: versionId };
  });

  app.get('/api/projects/:projectId/backup-schedule', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can view the backup schedule');
    const result = await pool.query(`SELECT enabled, destination, interval_hours AS "intervalHours", retention_count AS "retentionCount",
      next_run_at AS "nextRunAt", last_run_at AS "lastRunAt", last_success_at AS "lastSuccessAt", last_error AS "lastError"
      FROM backup_schedules WHERE project_id = $1`, [projectId]);
    return { schedule: result.rows[0] || { enabled: false, destination: 'local', intervalHours: 24, retentionCount: 20, nextRunAt: null, lastRunAt: null, lastSuccessAt: null, lastError: null } };
  });

  app.put('/api/projects/:projectId/backup-schedule', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can change the backup schedule');
    const input = parseBody(backupScheduleSchema, request.body);
    if (input.enabled && input.destination !== 'local') {
      requireGoogleConfig(config);
      const connection = await pool.query('SELECT 1 FROM cloud_connections WHERE user_id = $1 AND provider = $2', [user.id, googleProvider]);
      if (!connection.rowCount) throw new HttpError(409, 'Connect Google Drive before enabling this schedule');
    }
    const result = await withBackupLock(pool, projectId, async (client) => {
      if (input.enabled) {
        await collaboration.persistProject(projectId);
        const initial = await readProjectSnapshot(client, projectId);
        for (const provider of providersForDestination(input.destination)) {
          await createBackupCopy(client, config, projectId, user.id, provider, 'scheduled', initial);
          await enforceRetention(client, config, projectId, user.id, provider, input.retentionCount);
        }
      }
      return client.query(`INSERT INTO backup_schedules
      (project_id, created_by, enabled, destination, interval_hours, retention_count, next_run_at)
      VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 THEN now() + make_interval(hours => $5) ELSE NULL END)
      ON CONFLICT (project_id) DO UPDATE SET created_by = EXCLUDED.created_by, enabled = EXCLUDED.enabled,
        destination = EXCLUDED.destination, interval_hours = EXCLUDED.interval_hours, retention_count = EXCLUDED.retention_count,
        next_run_at = EXCLUDED.next_run_at, last_error = NULL, updated_at = now()
      RETURNING enabled, destination, interval_hours AS "intervalHours", retention_count AS "retentionCount",
        next_run_at AS "nextRunAt", last_run_at AS "lastRunAt", last_success_at AS "lastSuccessAt", last_error AS "lastError"`,
      [projectId, user.id, input.enabled, input.destination, input.intervalHours, input.retentionCount]);
    });
    await pool.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'backup.schedule.updated', 'project', $3, $4)", [projectId, user.id, projectId, input]);
    return { schedule: result.rows[0] };
  });
}
