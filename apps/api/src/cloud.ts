import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '@texharbor/database';
import { transaction } from '@texharbor/database';
import { requireUser } from './auth.js';
import type { CollaborationServer } from './collaboration.js';
import type { Config } from './config.js';
import { openCredential, sealCredential } from './credential-crypto.js';
import { HttpError } from './http.js';
import { createProjectBackup, newFileId, readProjectBackup } from './project-backup.js';
import { requireProject } from './routes.js';

const provider = 'google_drive';
const driveScope = 'https://www.googleapis.com/auth/drive.file';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const callbackPath = '/api/cloud/google/callback';

type ConnectionRow = {
  encrypted_refresh_token: string;
  account_email: string | null;
  account_name: string | null;
  provider_folder_id: string | null;
  updated_at: Date;
};

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

async function accessToken(pool: DatabasePool, config: Config, userId: string): Promise<{ token: string; connection: ConnectionRow }> {
  const connectionResult = await pool.query<ConnectionRow>('SELECT encrypted_refresh_token, account_email, account_name, provider_folder_id, updated_at FROM cloud_connections WHERE user_id = $1 AND provider = $2', [userId, provider]);
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

async function ensureBackupFolder(pool: DatabasePool, userId: string, token: string, connection: ConnectionRow): Promise<string> {
  if (connection.provider_folder_id) return connection.provider_folder_id;
  const response = await googleRequest(token, 'https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'TeXHarbor Backups', mimeType: 'application/vnd.google-apps.folder', appProperties: { texharbor: 'backups-v1' } }),
  });
  const folder = await response.json() as { id?: string };
  if (!folder.id) throw new HttpError(502, 'Google Drive did not return a backup folder');
  await pool.query('UPDATE cloud_connections SET provider_folder_id = $3, updated_at = now() WHERE user_id = $1 AND provider = $2', [userId, provider, folder.id]);
  return folder.id;
}

async function uploadBackup(token: string, folderId: string, backupId: string, projectId: string, fileName: string, archive: Buffer): Promise<{ id: string; name: string }> {
  const boundary = `texharbor_${randomUUID()}`;
  const metadata = { name: fileName, mimeType: 'application/zip', parents: [folderId], appProperties: { texharborBackupId: backupId, texharborProjectId: projectId, schema: '1' } };
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

export async function registerCloudRoutes(app: FastifyInstance, pool: DatabasePool, config: Config, collaboration: CollaborationServer): Promise<void> {
  app.get('/api/cloud/google', async (request) => {
    const user = await requireUser(pool, request);
    const result = await pool.query<ConnectionRow>('SELECT encrypted_refresh_token, account_email, account_name, provider_folder_id, updated_at FROM cloud_connections WHERE user_id = $1 AND provider = $2', [user.id, provider]);
    const connection = result.rows[0];
    return { configured: isConfigured(config), connected: Boolean(connection), accountEmail: connection?.account_email || null, accountName: connection?.account_name || null, updatedAt: connection?.updated_at || null };
  });

  app.post('/api/cloud/google/connect', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
    const user = await requireUser(pool, request);
    const { clientId, redirectUri } = requireGoogleConfig(config);
    const state = randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM oauth_states WHERE expires_at <= now()');
    await pool.query('INSERT INTO oauth_states (state_hash, user_id, provider, expires_at) VALUES ($1, $2, $3, now() + interval \'10 minutes\')', [hash(state), user.id, provider]);
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
      const stateResult = await pool.query<{ user_id: string }>('DELETE FROM oauth_states WHERE state_hash = $1 AND provider = $2 AND expires_at > now() RETURNING user_id', [hash(query.state), provider]);
      if (stateResult.rows[0]?.user_id !== user.id) throw new HttpError(400, 'Google authorization state expired; try connecting again');
      if (query.error) throw new HttpError(400, 'Google Drive access was not granted');
      if (!query.code || query.code.length > 4096) throw new HttpError(400, 'Google did not return an authorization code');
      const tokens = await exchangeToken(config, { code: query.code, grant_type: 'authorization_code' });
      if (typeof tokens.access_token !== 'string') throw new HttpError(502, 'Google did not return a usable authorization');
      const existing = await pool.query<{ encrypted_refresh_token: string }>('SELECT encrypted_refresh_token FROM cloud_connections WHERE user_id = $1 AND provider = $2', [user.id, provider]);
      const encryptedRefreshToken = typeof tokens.refresh_token === 'string' ? sealCredential(tokens.refresh_token, config.sessionSecret) : existing.rows[0]?.encrypted_refresh_token;
      if (!encryptedRefreshToken) throw new HttpError(409, 'Google did not issue offline access; revoke TeXHarbor access in Google and connect again');
      const aboutResponse = await googleRequest(tokens.access_token, 'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)');
      const about = await aboutResponse.json() as { user?: { displayName?: string; emailAddress?: string } };
      await pool.query(`INSERT INTO cloud_connections (user_id, provider, encrypted_refresh_token, account_email, account_name)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        account_email = EXCLUDED.account_email, account_name = EXCLUDED.account_name, updated_at = now()`, [user.id, provider, encryptedRefreshToken, about.user?.emailAddress || null, about.user?.displayName || null]);
      target.searchParams.set('cloud', 'connected');
    } catch (error) {
      target.searchParams.set('cloud', 'error');
      target.searchParams.set('message', error instanceof Error ? error.message : 'Google Drive connection failed');
    }
    return reply.redirect(target.toString());
  });

  app.delete('/api/cloud/google', async (request, reply) => {
    const user = await requireUser(pool, request);
    const result = await pool.query<ConnectionRow>('DELETE FROM cloud_connections WHERE user_id = $1 AND provider = $2 RETURNING encrypted_refresh_token, account_email, account_name, provider_folder_id, updated_at', [user.id, provider]);
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
    const result = await pool.query(`SELECT id, provider, file_name AS "fileName", source_hash AS "sourceHash", size, created_at AS "createdAt"
      FROM backup_records WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [projectId]);
    return { backups: result.rows };
  });

  app.post('/api/projects/:projectId/backups', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can back up this project');
    await collaboration.persistProject(projectId);
    const backup = await createProjectBackup(pool, projectId);
    const latest = await pool.query<{ id: string; fileName: string; size: string; createdAt: Date }>(`SELECT id, file_name AS "fileName", size, created_at AS "createdAt" FROM backup_records
      WHERE project_id = $1 AND source_hash = $2 ORDER BY created_at DESC LIMIT 1`, [projectId, backup.manifest.sourceHash]);
    if (latest.rows[0]) return { backup: latest.rows[0], unchanged: true };
    const authorization = await accessToken(pool, config, user.id);
    const folderId = await ensureBackupFolder(pool, user.id, authorization.token, authorization.connection);
    const backupId = randomUUID();
    const uploaded = await uploadBackup(authorization.token, folderId, backupId, projectId, backup.fileName, backup.archive);
    const result = await pool.query(`INSERT INTO backup_records (id, project_id, created_by, provider, provider_file_id, file_name, source_hash, size)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, provider, file_name AS "fileName", source_hash AS "sourceHash", size, created_at AS "createdAt"`, [backupId, projectId, user.id, provider, uploaded.id, uploaded.name, backup.manifest.sourceHash, backup.archive.byteLength]);
    await pool.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'backup.created', 'backup', $3, $4)", [projectId, user.id, backupId, { provider, fileName: uploaded.name }]);
    return reply.code(201).send({ backup: result.rows[0], unchanged: false });
  });

  app.post('/api/projects/:projectId/backups/:backupId/restore', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const user = await requireUser(pool, request);
    const { projectId, backupId } = request.params as { projectId: string; backupId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can restore project backups');
    const record = await pool.query<{ provider_file_id: string }>('SELECT provider_file_id FROM backup_records WHERE id = $1 AND project_id = $2 AND provider = $3', [backupId, projectId, provider]);
    if (!record.rows[0]) throw new HttpError(404, 'Backup not found');
    const authorization = await accessToken(pool, config, user.id);
    const response = await googleRequest(authorization.token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(record.rows[0].provider_file_id)}?alt=media`);
    const archive = Buffer.from(await response.arrayBuffer());
    const restored = await readProjectBackup(archive, projectId);
    await collaboration.persistProject(projectId);
    const safety = await createProjectBackup(pool, projectId);
    await collaboration.resetProject(projectId);
    const paths = restored.files.map((file) => file.path);
    const versionId = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO project_versions (id, project_id, created_by, kind, archive) VALUES ($1, $2, $3, $4, $5)', [versionId, projectId, user.id, 'pre_backup_restore', safety.archive]);
      await client.query('DELETE FROM collaboration_documents WHERE project_id = $1', [projectId]);
      await client.query('DELETE FROM project_files WHERE project_id = $1 AND (NOT (path = ANY($2::text[])) OR kind <> (SELECT x.kind FROM jsonb_to_recordset($3::jsonb) AS x(path text, kind text) WHERE x.path = project_files.path))', [projectId, paths, JSON.stringify(restored.files.map((file) => ({ path: file.path, kind: file.kind })))]);
      for (const file of restored.files) {
        await client.query(`INSERT INTO project_files (id, project_id, path, kind, mime_type, content, size, is_binary)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (project_id, path) DO UPDATE SET mime_type = EXCLUDED.mime_type,
          content = EXCLUDED.content, size = EXCLUDED.size, is_binary = EXCLUDED.is_binary, updated_at = now()`, [newFileId(), projectId, file.path, file.kind, file.mimeType, file.content, file.size, file.isBinary]);
      }
      await client.query('UPDATE projects SET name = $2, description = $3, main_file_path = $4, compiler = $5, updated_at = now() WHERE id = $1', [projectId, restored.manifest.project.name.slice(0, 200), restored.manifest.project.description.slice(0, 2000), restored.manifest.project.mainFilePath, restored.manifest.project.compiler]);
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'backup.restored', 'backup', $3, $4)", [projectId, user.id, backupId, { provider, safetyVersionId: versionId }]);
    });
    return { restored: true, safetyVersionId: versionId };
  });
}
