import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import pg from 'pg';
import { migrate } from '@texharbor/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCloudRoutes, runDueBackups } from '../../apps/api/src/cloud.js';
import { sendError } from '../../apps/api/src/http.js';
import { sealCredential } from '../../apps/api/src/credential-crypto.js';
import type { CollaborationServer } from '../../apps/api/src/collaboration.js';
import type { Config } from '../../apps/api/src/config.js';

// Run only against an explicitly supplied disposable database, in a private schema.
const databaseUrl = process.env.BACKUP_TEST_DATABASE_URL;
const schema = `backup_test_${randomUUID().replaceAll('-', '')}`;
describe.skipIf(!databaseUrl)('incremental history API and PostgreSQL', () => {
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const app = Fastify();
  const config = { sessionSecret: 'backup-test-session-secret-with-32-characters', googleClientId: 'test-client', googleClientSecret: 'test-secret', publicOrigin: 'http://localhost' } as Config;
  const collaboration = { persistProject: vi.fn(async () => undefined), resetProject: vi.fn(async () => undefined) } as unknown as CollaborationServer;
  let projectId: string;
  let ownerId: string;
  let ownerToken: string;
  let editorToken: string;
  let viewerToken: string;
  const initial = randomBytes(64 * 1024).toString('hex');
  const asset = randomBytes(128 * 1024);
  const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', suffix = '/backups', payload?: unknown, token = ownerToken) => app.inject({
    method, url: `/api/projects/${projectId}${suffix}`, cookies: token ? { texharbor_session: token } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const history = async () => (await request('GET')).json().backups as Array<{ id: string; storageFormat: string; parentId: string | null; kind: string; size: string; sourceHash: string }>;
  const edit = async (text: string) => pool.query("UPDATE project_files SET content = $2, size = $3 WHERE project_id = $1 AND path = '/main.tex'", [projectId, Buffer.from(text), Buffer.byteLength(text)]);
  const content = async () => (await pool.query("SELECT content FROM project_files WHERE project_id = $1 AND path = '/main.tex'", [projectId])).rows[0].content.toString();
  const save = async (provider = 'local') => {
    const response = await request('POST', '/backups', { provider });
    expect([200, 201], response.body).toContain(response.statusCode);
    return response.json();
  };
  const due = async () => {
    await pool.query("UPDATE backup_schedules SET next_run_at = now() - interval '1 minute' WHERE project_id = $1", [projectId]);
    await runDueBackups(pool, config, collaboration);
    expect((await pool.query('SELECT last_error FROM backup_schedules WHERE project_id = $1', [projectId])).rows[0].last_error).toBeNull();
  };

  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.endsWith('_backup_test')) throw new Error('Use a disposable database whose name ends in _backup_test');
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool, fileURLToPath(new URL('../../packages/database/migrations', import.meta.url)));
    await app.register(cookie);
    app.setErrorHandler((error, _request, reply) => sendError(reply, error));
    await registerCloudRoutes(app, pool, config, collaboration);
    await app.ready();
  });
  beforeEach(async () => {
    await pool.query('UPDATE backup_schedules SET enabled = false, next_run_at = NULL');
    ownerId = randomUUID();
    projectId = randomUUID();
    const users = [ownerId, randomUUID(), randomUUID()];
    const tokens = users.map(() => randomUUID());
    [ownerToken, editorToken, viewerToken] = tokens as [string, string, string];
    for (const [index, id] of users.entries()) {
      await pool.query('INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)', [id, 'Test', `${id}@test.invalid`, 'unused']);
      await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')", [createHash('sha256').update(tokens[index]!).digest('hex'), id]);
    }
    await pool.query('INSERT INTO projects (id, owner_id, name) VALUES ($1, $2, $3)', [projectId, ownerId, 'Incremental test']);
    for (const [index, id] of users.entries()) await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [projectId, id, ['owner', 'editor', 'viewer'][index]]);
    await pool.query("INSERT INTO project_files (id, project_id, path, kind, content, size) VALUES ($1, $2, '/main.tex', 'file', $3, $4)", [randomUUID(), projectId, Buffer.from(initial), initial.length]);
    await pool.query("INSERT INTO project_files (id, project_id, path, kind, content, size, is_binary) VALUES ($1, $2, '/asset.bin', 'file', $3, $4, true)", [randomUUID(), projectId, asset, asset.length]);
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await app.close();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('serializes concurrent saves, stores a small diff and restores both states without duplicate safety data', async () => {
    const responses = await Promise.all([save(), save(), save()]);
    expect(responses.filter((result) => !result.unchanged)).toHaveLength(1);
    const base = (await history())[0]!;
    expect(base.storageFormat).toBe('full');
    await edit(`${initial.slice(0, 500)}inserted sentence${initial.slice(500)}`);
    const changed = (await save()).backup;
    expect(changed.storageFormat).toBe('delta');
    expect(changed.parentId).toBe(base.id);
    expect(Number(changed.size)).toBeLessThan(Number(base.size) / 100);
    expect((await request('POST', `/backups/${base.id}/restore`)).statusCode).toBe(200);
    expect(await content()).toBe(initial);
    expect(await history()).toHaveLength(2);
    expect((await request('POST', `/backups/${changed.id}/restore`)).statusCode).toBe(200);
    expect(await content()).toContain('inserted sentence');
    expect((await pool.query("SELECT content FROM project_files WHERE project_id = $1 AND path = '/asset.bin'", [projectId])).rows[0].content.equals(asset)).toBe(true);
  });

  it('deletes a middle version and then a base while preserving descendants', async () => {
    const base = (await save()).backup;
    await edit(`${initial}one`);
    const middle = (await save()).backup;
    await edit(`${initial}two`);
    const latest = (await save()).backup;
    expect((await request('DELETE', `/backups/${middle.id}`)).statusCode).toBe(204);
    expect((await history())[0]!.storageFormat).toBe('delta');
    expect((await history())[0]!.parentId).toBe(base.id);
    expect((await request('DELETE', `/backups/${base.id}`)).statusCode).toBe(204);
    expect((await history())[0]!.storageFormat).toBe('full');
    await edit('unsaved third state');
    expect((await request('POST', `/backups/${latest.id}/restore`)).statusCode).toBe(200);
    expect(await content()).toBe(`${initial}two`);
    expect((await history())[0]!.kind).toBe('pre_restore');
  });

  it('creates an immediate scheduled base, skips unchanged runs, and prunes to a restorable boundary', async () => {
    const enabled = await request('PUT', '/backup-schedule', { enabled: true, destination: 'local', intervalHours: 1, retentionCount: 2 });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(await history()).toHaveLength(1);
    await due();
    expect(await history()).toHaveLength(1);
    for (const version of ['one', 'two', 'three']) { await edit(`${initial}${version}`); await due(); }
    const versions = await history();
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.storageFormat)).toEqual(['delta', 'full']);
    expect((await request('POST', `/backups/${versions[1]!.id}/restore`)).statusCode).toBe(200);
    expect(await content()).toBe(`${initial}two`);
    expect((await history())[0]!.kind).toBe('pre_restore');
  });

  it('refuses corrupt deltas before changing the project or creating safety history', async () => {
    await save();
    await edit(`${initial}new`);
    const latest = (await save()).backup;
    await pool.query('UPDATE backup_records SET archive = $2 WHERE id = $1', [latest.id, Buffer.from('not zip')]);
    await edit('current work');
    expect((await request('POST', `/backups/${latest.id}/restore`)).statusCode).toBe(422);
    expect(await content()).toBe('current work');
    expect(await history()).toHaveLength(2);
  });

  it('keeps manual versions incremental when scheduled versions between them expire', async () => {
    const base = (await save()).backup;
    await request('PUT', '/backup-schedule', { enabled: true, destination: 'local', intervalHours: 1, retentionCount: 2 });
    await edit(`${initial}scheduled one`);
    await due();
    await edit(`${initial}manual`);
    const manual = (await save()).backup;
    for (const version of ['two', 'three', 'four']) { await edit(`${initial}scheduled ${version}`); await due(); }
    const versions = await history();
    expect(versions).toHaveLength(4);
    expect(versions.filter((version) => version.storageFormat === 'full').map((version) => version.id)).toEqual([base.id]);
    expect(versions.find((version) => version.id === manual.id)?.parentId).toBe(base.id);
    expect((await request('POST', `/backups/${manual.id}/restore`)).statusCode).toBe(200);
    expect(await content()).toBe(`${initial}manual`);
  });

  it('rejects editors, viewers and unauthenticated users on every history endpoint', async () => {
    const base = (await save()).backup;
    const endpoints = [
      ['GET', '/backups'], ['POST', '/backups', { provider: 'local' }],
      ['DELETE', `/backups/${base.id}`], ['POST', `/backups/${base.id}/restore`],
      ['GET', '/backup-schedule'], ['PUT', '/backup-schedule', { enabled: true, destination: 'local', intervalHours: 1, retentionCount: 2 }],
    ] as const;
    for (const token of [editorToken, viewerToken, '']) {
      for (const [method, suffix, payload] of endpoints) {
        const response = await request(method, suffix, payload, token);
        expect(response.statusCode, `${method} ${suffix}: ${response.body}`).toBe(token ? 403 : 401);
      }
    }
    expect(await history()).toHaveLength(1);
  });

  it('migrates existing full archives without rewriting them or losing timestamp order', async () => {
    const legacySchema = `${schema}_legacy`;
    await admin.query(`CREATE SCHEMA ${legacySchema}`);
    const legacy = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${legacySchema},public` });
    try {
      const directory = fileURLToPath(new URL('../../packages/database/migrations', import.meta.url));
      for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql') && name < '010').sort()) {
        await legacy.query(await readFile(path.join(directory, name), 'utf8'));
      }
      await legacy.query('INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)', [ownerId, 'Legacy', 'legacy@test.invalid', 'unused']);
      await legacy.query('INSERT INTO projects (id, owner_id, name) VALUES ($1, $2, $3)', [projectId, ownerId, 'Legacy']);
      const newerId = randomUUID();
      const olderId = randomUUID();
      for (const [id, date] of [[newerId, '2026-09-02'], [olderId, '2026-09-01']]) {
        await legacy.query("INSERT INTO backup_records (id, project_id, created_by, provider, file_name, size, archive, created_at) VALUES ($1, $2, $3, 'local', 'legacy.zip', 6, $4, $5)", [id, projectId, ownerId, Buffer.from('legacy'), date]);
      }
      await legacy.query(await readFile(path.join(directory, '010_incremental_backup_history.sql'), 'utf8'));
      const versions = await legacy.query('SELECT id, storage_format, parent_id, archive FROM backup_records ORDER BY version_sequence DESC');
      expect(versions.rows.map((row) => row.id)).toEqual([newerId, olderId]);
      expect(versions.rows.every((row) => row.storage_format === 'full' && row.parent_id === null && row.archive.equals(Buffer.from('legacy')))).toBe(true);
    } finally {
      await legacy.end();
      await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`);
    }
  });

  it('uses incremental Drive files and defers deletion until surviving history is safe', async () => {
    const remote = new Map<string, Buffer>();
    const removed: string[] = [];
    let deletionOffline = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'fake-token' });
      if (url.includes('/upload/drive/')) {
        const body = Buffer.from(init!.body as Uint8Array);
        const boundary = new Headers(init!.headers).get('content-type')!.split('boundary=')[1]!;
        const marker = Buffer.from('Content-Type: application/zip\r\n\r\n');
        const start = body.indexOf(marker) + marker.length;
        const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
        const id = randomUUID();
        remote.set(id, body.subarray(start, end));
        return Response.json({ id });
      }
      const id = url.split('/files/')[1]?.split('?')[0]!;
      if (init?.method === 'DELETE') {
        if (deletionOffline) return new Response(null, { status: 503 });
        removed.push(id); remote.delete(id); return new Response(null, { status: 204 });
      }
      const archive = remote.get(id);
      return archive ? new Response(new Uint8Array(archive)) : new Response(null, { status: 404 });
    }));
    await pool.query("INSERT INTO cloud_connections (user_id, provider, encrypted_refresh_token, provider_folder_id) VALUES ($1, 'google_drive', $2, 'folder')", [ownerId, sealCredential('fake-refresh', config.sessionSecret)]);
    const base = (await save('google_drive')).backup;
    await edit(`${initial}Drive edit`);
    const latest = (await save('google_drive')).backup;
    expect(latest.storageFormat).toBe('delta');
    expect(Number(latest.size)).toBeLessThan(Number(base.size) / 100);
    expect((await save('google_drive')).unchanged).toBe(true);
    expect(remote.size).toBe(2);
    expect((await request('DELETE', `/backups/${base.id}`)).statusCode).toBe(204);
    expect(removed).toHaveLength(0);
    expect(remote.size).toBe(3); // New base is committed before obsolete remote files are removed.
    deletionOffline = true;
    await runDueBackups(pool, config, collaboration);
    expect(remote.size).toBe(3);
    expect((await pool.query('SELECT 1 FROM backup_remote_deletions')).rowCount).toBe(2);
    deletionOffline = false;
    await runDueBackups(pool, config, collaboration);
    expect(removed).toHaveLength(2);
    expect(remote.size).toBe(1);
    await edit('current work');
    expect((await request('POST', `/backups/${latest.id}/restore`)).statusCode).toBe(200);
    expect(await content()).toBe(`${initial}Drive edit`);

    // A remote upload followed by a database failure must be cleaned up too.
    await pool.query(`CREATE FUNCTION reject_drive_version() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF NEW.action = 'backup.created' AND NEW.metadata->>'provider' = 'google_drive' THEN
        RAISE EXCEPTION 'simulated commit failure'; END IF; RETURN NEW; END $body$`);
    await pool.query('CREATE TRIGGER reject_drive_version BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION reject_drive_version()');
    await edit(`${initial}failed upload state`);
    expect((await request('POST', '/backups', { provider: 'google_drive' })).statusCode).toBe(500);
    expect(remote.size).toBe(2);
    await pool.query('DROP TRIGGER reject_drive_version ON activity');
    await runDueBackups(pool, config, collaboration);
    expect(remote.size).toBe(1);
    expect((await history()).filter((version) => version.id === latest.id)).toHaveLength(1);
  });
});
