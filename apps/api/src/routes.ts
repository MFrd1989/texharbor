import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient, DatabasePool } from '@texlyre/database';
import { transaction } from '@texlyre/database';
import {
  createFileSchema,
  createProjectSchema,
  loginSchema,
  registerSchema,
  updateFileSchema,
  updateProjectSchema,
  type ProjectRole,
} from '@texlyre/contracts';
import { authenticateUser, createSession, currentUser, destroySession, registerUser, requireUser } from './auth.js';
import type { Config } from './config.js';
import { HttpError, parseBody } from './http.js';
import { mimeTypeFor, normalizeProjectPath } from './paths.js';
import { readSourceArchive } from './zip.js';

type Queryable = Pick<DatabasePool, 'query'> | Pick<DatabaseClient, 'query'>;
type Access = { id: string; role: ProjectRole; deleted_at: Date | null };

async function requireProject(queryable: Queryable, projectId: string, userId: string, includeDeleted = false): Promise<Access> {
  const result = await queryable.query<Access>(`SELECT p.id, pm.role, p.deleted_at
    FROM projects p JOIN project_members pm ON pm.project_id = p.id
    WHERE p.id = $1 AND pm.user_id = $2`, [projectId, userId]);
  const access = result.rows[0];
  if (!access || (!includeDeleted && access.deleted_at)) throw new HttpError(404, 'Project not found');
  return access;
}

function requireEdit(role: ProjectRole): void {
  if (role === 'viewer') throw new HttpError(403, 'Viewer access is read-only');
}

export async function registerRoutes(app: FastifyInstance, pool: DatabasePool, config: Config): Promise<void> {
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = parseBody(registerSchema, request.body);
    const user = await registerUser(pool, input);
    await createSession(pool, reply, user.id, config.isProduction);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = parseBody(loginSchema, request.body);
    const user = await authenticateUser(pool, input.email, input.password);
    await createSession(pool, reply, user.id, config.isProduction);
    return { user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await destroySession(pool, request, reply);
    return reply.code(204).send();
  });

  app.get('/api/me', async (request) => ({ user: await currentUser(pool, request) }));

  app.get('/api/projects', async (request) => {
    const user = await requireUser(pool, request);
    const query = request.query as { view?: string };
    const deleted = query.view === 'trash';
    const result = await pool.query(`SELECT p.id, p.name, p.description, pm.role,
      p.created_at AS "createdAt", p.updated_at AS "updatedAt", p.deleted_at AS "deletedAt"
      FROM projects p JOIN project_members pm ON pm.project_id = p.id
      WHERE pm.user_id = $1 AND p.deleted_at IS ${deleted ? 'NOT NULL' : 'NULL'}
      ORDER BY p.updated_at DESC`, [user.id]);
    return { projects: result.rows };
  });

  app.post('/api/projects', async (request, reply) => {
    const user = await requireUser(pool, request);
    const input = parseBody(createProjectSchema, request.body);
    const projectId = randomUUID();
    const fileId = randomUUID();
    const starter = '\\documentclass{article}\n\\begin{document}\n\nHello, world!\n\n\\end{document}\n';
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO projects (id, owner_id, name, description) VALUES ($1, $2, $3, $4)', [projectId, user.id, input.name, input.description]);
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [projectId, user.id]);
      await client.query(`INSERT INTO project_files (id, project_id, path, kind, mime_type, content, size)
        VALUES ($1, $2, '/main.tex', 'file', 'text/x-tex', $3, $4)`, [fileId, projectId, Buffer.from(starter), Buffer.byteLength(starter)]);
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'project.created', 'project', $3)", [projectId, user.id, projectId]);
    });
    return reply.code(201).send({ project: { id: projectId, name: input.name, description: input.description, role: 'owner' } });
  });

  app.post('/api/projects/import', async (request, reply) => {
    const user = await requireUser(pool, request);
    const upload = await request.file();
    if (!upload || !upload.filename.toLowerCase().endsWith('.zip')) throw new HttpError(400, 'Select a ZIP archive to import');
    const files = await readSourceArchive(await upload.toBuffer());
    const input = parseBody(createProjectSchema, { name: upload.filename.replace(/\.zip$/i, ''), description: `Imported from ${upload.filename}` });
    const projectId = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO projects (id, owner_id, name, description) VALUES ($1, $2, $3, $4)', [projectId, user.id, input.name, input.description]);
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [projectId, user.id]);
      for (const file of files) {
        await client.query(`INSERT INTO project_files (id, project_id, path, kind, mime_type, content, size, is_binary)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [file.id, projectId, file.path, file.kind, file.mimeType, file.content, file.size, file.isBinary]);
      }
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'project.imported', 'project', $3, $4)", [projectId, user.id, projectId, { filename: upload.filename, fileCount: files.filter((file) => file.kind === 'file').length }]);
    });
    return reply.code(201).send({ project: { id: projectId, name: input.name, description: input.description, role: 'owner' } });
  });

  app.post('/api/projects/:projectId/duplicate', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(pool, projectId, user.id);
    const newProjectId = randomUUID();
    await transaction(pool, async (client) => {
      const source = await client.query<{ name: string; description: string; main_file_path: string; compiler: string }>('SELECT name, description, main_file_path, compiler FROM projects WHERE id = $1', [projectId]);
      const project = source.rows[0];
      if (!project) throw new HttpError(404, 'Project not found');
      await client.query('INSERT INTO projects (id, owner_id, name, description, main_file_path, compiler) VALUES ($1, $2, $3, $4, $5, $6)', [newProjectId, user.id, `${project.name} (copy)`, project.description, project.main_file_path, project.compiler]);
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [newProjectId, user.id]);
      const files = await client.query<{ path: string; kind: string; mime_type: string | null; content: Buffer | null; size: string; is_binary: boolean }>('SELECT path, kind, mime_type, content, size, is_binary FROM project_files WHERE project_id = $1 ORDER BY path', [projectId]);
      for (const file of files.rows) {
        await client.query('INSERT INTO project_files (id, project_id, path, kind, mime_type, content, size, is_binary) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [randomUUID(), newProjectId, file.path, file.kind, file.mime_type, file.content, file.size, file.is_binary]);
      }
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'project.duplicated', 'project', $3, $4)", [newProjectId, user.id, newProjectId, { sourceProjectId: projectId }]);
    });
    return reply.code(201).send({ project: { id: newProjectId } });
  });

  app.get('/api/projects/:projectId', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(pool, projectId, user.id);
    const result = await pool.query(`SELECT p.id, p.name, p.description, p.main_file_path AS "mainFilePath", p.compiler,
      pm.role, p.created_at AS "createdAt", p.updated_at AS "updatedAt"
      FROM projects p JOIN project_members pm ON pm.project_id = p.id
      WHERE p.id = $1 AND pm.user_id = $2`, [projectId, user.id]);
    return { project: result.rows[0] };
  });

  app.patch('/api/projects/:projectId', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    requireEdit(access.role);
    const input = parseBody(updateProjectSchema, request.body);
    const result = await pool.query(`UPDATE projects SET
      name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now()
      WHERE id = $1 RETURNING id, name, description, updated_at AS "updatedAt"`, [projectId, input.name ?? null, input.description ?? null]);
    await pool.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'project.updated', 'project', $3)", [projectId, user.id, projectId]);
    return { project: result.rows[0] };
  });

  app.delete('/api/projects/:projectId', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const permanent = (request.query as { permanent?: string }).permanent === 'true';
    const access = await requireProject(pool, projectId, user.id, permanent);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can move a project to trash');
    if (permanent) {
      if (!access.deleted_at) throw new HttpError(400, 'Move the project to trash before deleting it permanently');
      await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
      return reply.code(204).send();
    }
    await pool.query('UPDATE projects SET deleted_at = now(), updated_at = now() WHERE id = $1', [projectId]);
    await pool.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'project.trashed', 'project', $3)", [projectId, user.id, projectId]);
    return reply.code(204).send();
  });

  app.post('/api/projects/:projectId/restore', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id, true);
    if (access.role !== 'owner') throw new HttpError(403, 'Only the owner can restore a project');
    await pool.query('UPDATE projects SET deleted_at = NULL, updated_at = now() WHERE id = $1', [projectId]);
    await pool.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'project.restored', 'project', $3)", [projectId, user.id, projectId]);
    return { restored: true };
  });

  app.get('/api/projects/:projectId/files', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(pool, projectId, user.id);
    const result = await pool.query(`SELECT id, path, kind, mime_type AS "mimeType", size, is_binary AS "isBinary", updated_at AS "updatedAt"
      FROM project_files WHERE project_id = $1 ORDER BY kind DESC, path`, [projectId]);
    return { files: result.rows };
  });

  app.post('/api/projects/:projectId/files', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    requireEdit(access.role);
    const input = parseBody(createFileSchema, request.body);
    const projectPath = normalizeProjectPath(input.path);
    const parent = path.posix.dirname(projectPath);
    if (parent !== '/') {
      const parentResult = await pool.query("SELECT 1 FROM project_files WHERE project_id = $1 AND path = $2 AND kind = 'directory'", [projectId, parent]);
      if (!parentResult.rowCount) throw new HttpError(400, 'Parent directory does not exist');
    }
    const id = randomUUID();
    const content = input.kind === 'file' ? Buffer.from(input.content) : null;
    await pool.query(`INSERT INTO project_files (id, project_id, path, kind, mime_type, content, size)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, projectId, projectPath, input.kind, input.kind === 'file' ? mimeTypeFor(projectPath) : null, content, content?.byteLength || 0]);
    await pool.query("UPDATE projects SET updated_at = now() WHERE id = $1", [projectId]);
    return reply.code(201).send({ file: { id, path: projectPath, kind: input.kind } });
  });

  app.get('/api/projects/:projectId/files/:fileId', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId, fileId } = request.params as { projectId: string; fileId: string };
    await requireProject(pool, projectId, user.id);
    const result = await pool.query<{ id: string; path: string; kind: string; mimeType: string | null; content: Buffer | null; isBinary: boolean; updatedAt: Date }>(`SELECT id, path, kind, mime_type AS "mimeType", content, is_binary AS "isBinary", updated_at AS "updatedAt"
      FROM project_files WHERE id = $1 AND project_id = $2`, [fileId, projectId]);
    const file = result.rows[0];
    if (!file) throw new HttpError(404, 'File not found');
    return { file: { ...file, content: file.isBinary ? null : file.content?.toString('utf8') ?? null } };
  });

  app.patch('/api/projects/:projectId/files/:fileId', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId, fileId } = request.params as { projectId: string; fileId: string };
    const access = await requireProject(pool, projectId, user.id);
    requireEdit(access.role);
    const input = parseBody(updateFileSchema, request.body);
    const existing = await pool.query<{ path: string; kind: string; is_binary: boolean }>('SELECT path, kind, is_binary FROM project_files WHERE id = $1 AND project_id = $2', [fileId, projectId]);
    const file = existing.rows[0];
    if (!file) throw new HttpError(404, 'File not found');
    if (file.kind === 'directory' && input.content !== undefined) throw new HttpError(400, 'Directories cannot contain text');
    if (file.is_binary && input.content !== undefined) throw new HttpError(400, 'Binary files cannot be edited as text');
    const nextPath = input.path === undefined ? null : normalizeProjectPath(input.path);
    const content = input.content === undefined ? null : Buffer.from(input.content);
    if (nextPath) {
      if (file.kind === 'directory' && nextPath.startsWith(`${file.path}/`)) throw new HttpError(400, 'A folder cannot be moved inside itself');
      const parent = path.posix.dirname(nextPath);
      if (parent !== '/') {
        const parentResult = await pool.query("SELECT 1 FROM project_files WHERE project_id = $1 AND path = $2 AND kind = 'directory'", [projectId, parent]);
        if (!parentResult.rowCount) throw new HttpError(400, 'Parent directory does not exist');
      }
    }
    await transaction(pool, async (client) => {
      if (nextPath && file.kind === 'directory') {
        await client.query(`UPDATE project_files SET path = $2 || substring(path from char_length($3) + 1), updated_at = now()
          WHERE project_id = $1 AND path LIKE $3 || '/%'`, [projectId, nextPath, file.path]);
      }
      await client.query(`UPDATE project_files SET path = COALESCE($3, path), mime_type = CASE WHEN $3 IS NULL THEN mime_type ELSE $4 END,
        content = CASE WHEN $5::bytea IS NULL THEN content ELSE $5 END, size = CASE WHEN $5::bytea IS NULL THEN size ELSE octet_length($5::bytea) END,
        updated_at = now() WHERE id = $1 AND project_id = $2`, [fileId, projectId, nextPath, nextPath ? mimeTypeFor(nextPath) : null, content]);
    });
    await pool.query('UPDATE projects SET updated_at = now() WHERE id = $1', [projectId]);
    return { saved: true, updatedAt: new Date().toISOString() };
  });

  app.delete('/api/projects/:projectId/files/:fileId', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId, fileId } = request.params as { projectId: string; fileId: string };
    const access = await requireProject(pool, projectId, user.id);
    requireEdit(access.role);
    const target = await pool.query<{ path: string; kind: string }>('SELECT path, kind FROM project_files WHERE id = $1 AND project_id = $2', [fileId, projectId]);
    const file = target.rows[0];
    if (!file) throw new HttpError(404, 'File not found');
    if (file.path === '/main.tex') throw new HttpError(400, 'The main document cannot be deleted');
    if (file.kind === 'directory') {
      await pool.query("DELETE FROM project_files WHERE project_id = $1 AND (path = $2 OR path LIKE $2 || '/%')", [projectId, file.path]);
    } else {
      await pool.query('DELETE FROM project_files WHERE id = $1 AND project_id = $2', [fileId, projectId]);
    }
    await pool.query('UPDATE projects SET updated_at = now() WHERE id = $1', [projectId]);
    return reply.code(204).send();
  });
}
