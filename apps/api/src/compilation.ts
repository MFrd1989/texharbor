import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '@texlyre/database';
import { transaction } from '@texlyre/database';
import { requireUser } from './auth.js';
import type { CollaborationServer } from './collaboration.js';
import type { Config } from './config.js';
import { HttpError } from './http.js';
import { requireProject } from './routes.js';

type JobRow = {
  id: string; projectId: string; status: 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed'; compiler: string;
  mainFilePath: string; sourceHash: string; exitCode: number | null; log: string | null; artifactPath: string | null;
  queuedAt: Date; startedAt: Date | null; completedAt: Date | null;
};

const jobColumns = `j.id, j.project_id AS "projectId", j.status, j.compiler, j.main_file_path AS "mainFilePath",
  j.source_hash AS "sourceHash", j.exit_code AS "exitCode", j.log, j.artifact_path AS "artifactPath",
  j.queued_at AS "queuedAt", j.started_at AS "startedAt", j.completed_at AS "completedAt"`;
const toJob = (job: JobRow) => ({ ...job, hasPdf: Boolean(job.artifactPath), artifactPath: undefined });

export async function registerCompilationRoutes(app: FastifyInstance, pool: DatabasePool, collaboration: CollaborationServer, config: Config): Promise<void> {
  app.post('/api/projects/:projectId/compile', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    const access = await requireProject(pool, projectId, user.id);
    if (access.role === 'viewer') throw new HttpError(403, 'Viewer access cannot compile projects');
    const active = await pool.query('SELECT 1 FROM compile_jobs WHERE project_id = $1 AND status IN (\'queued\', \'running\') LIMIT 1', [projectId]);
    if (active.rowCount) throw new HttpError(409, 'A compilation is already queued or running');
    await collaboration.persistProject(projectId);
    const project = await pool.query<{ compiler: string; main_file_path: string }>('SELECT compiler, main_file_path FROM projects WHERE id = $1', [projectId]);
    const settings = project.rows[0]!;
    if (!['pdflatex', 'xelatex', 'lualatex'].includes(settings.compiler)) throw new HttpError(400, 'The selected compiler is not available');
    const files = await pool.query<{ path: string; content: Buffer | null; is_binary: boolean }>(`SELECT path, content, is_binary FROM project_files
      WHERE project_id = $1 AND kind = 'file' ORDER BY path`, [projectId]);
    const main = files.rows.find((file) => file.path === settings.main_file_path);
    if (!main || main.is_binary || !settings.main_file_path.toLowerCase().endsWith('.tex')) throw new HttpError(400, 'Select a valid LaTeX main document');
    const hash = createHash('sha256');
    for (const file of files.rows) { hash.update(file.path); hash.update('\0'); hash.update(file.content || Buffer.alloc(0)); }
    const id = randomUUID(); const sourceHash = hash.digest('hex');
    await transaction(pool, async (client) => {
      await client.query(`INSERT INTO compile_jobs (id, project_id, requested_by, compiler, main_file_path, source_hash)
        VALUES ($1, $2, $3, $4, $5, $6)`, [id, projectId, user.id, settings.compiler, settings.main_file_path, sourceHash]);
      for (const file of files.rows) await client.query('INSERT INTO compile_job_files (job_id, path, content, is_binary) VALUES ($1, $2, $3, $4)', [id, file.path, file.content || Buffer.alloc(0), file.is_binary]);
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'compile.queued', 'compile_job', $3, $4)", [projectId, user.id, id, { compiler: settings.compiler, sourceHash }]);
    });
    const result = await pool.query<JobRow>(`SELECT ${jobColumns} FROM compile_jobs j WHERE j.id = $1`, [id]);
    return reply.code(202).send({ job: toJob(result.rows[0]!) });
  });

  app.get('/api/projects/:projectId/compile', async (request) => {
    const user = await requireUser(pool, request); const { projectId } = request.params as { projectId: string };
    await requireProject(pool, projectId, user.id);
    const result = await pool.query<JobRow>(`SELECT ${jobColumns} FROM compile_jobs j WHERE j.project_id = $1 ORDER BY j.queued_at DESC LIMIT 20`, [projectId]);
    return { jobs: result.rows.map(toJob) };
  });

  app.get('/api/projects/:projectId/compile/:jobId', async (request) => {
    const user = await requireUser(pool, request); const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    await requireProject(pool, projectId, user.id);
    const result = await pool.query<JobRow>(`SELECT ${jobColumns} FROM compile_jobs j WHERE j.id = $1 AND j.project_id = $2`, [jobId, projectId]);
    if (!result.rows[0]) throw new HttpError(404, 'Compilation not found');
    return { job: toJob(result.rows[0]) };
  });

  app.get('/api/projects/:projectId/compile/:jobId/pdf', async (request, reply) => {
    const user = await requireUser(pool, request); const { projectId, jobId } = request.params as { projectId: string; jobId: string };
    await requireProject(pool, projectId, user.id);
    const result = await pool.query<{ artifact_path: string | null }>("SELECT artifact_path FROM compile_jobs WHERE id = $1 AND project_id = $2 AND status IN ('completed', 'completed_with_errors')", [jobId, projectId]);
    const artifact = result.rows[0]?.artifact_path;
    if (!artifact) throw new HttpError(404, 'Compiled PDF not found');
    const root = path.resolve(config.storageRoot); const target = path.resolve(root, artifact);
    if (!target.startsWith(`${root}${path.sep}`)) throw new HttpError(500, 'Invalid compilation artifact');
    try { return reply.type('application/pdf').header('cache-control', 'private, no-store').send(await readFile(target)); }
    catch { throw new HttpError(404, 'Compiled PDF not found'); }
  });
}
