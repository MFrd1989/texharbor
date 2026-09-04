import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Docker from 'dockerode';
import { createPool, transaction } from '@texlyre/database';
import { safeTarget } from './sandbox-path.js';

type ClaimedJob = { id: string; project_id: string; requested_by: string; compiler: 'pdflatex' | 'xelatex' | 'lualatex'; main_file_path: string };
type JobFile = { path: string; content: Buffer };
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const storageRoot = path.resolve(process.env.STORAGE_ROOT || '/data/projects');
const compilerImage = process.env.COMPILER_IMAGE || 'latex-workspace-compiler:latest';
const projectVolume = process.env.PROJECT_VOLUME || 'texlyre-cloud_project-storage';
const pool = createPool(databaseUrl);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });
let stopping = false;

async function claimJob(): Promise<ClaimedJob | null> {
  return transaction(pool, async (client) => {
    const result = await client.query<ClaimedJob>(`SELECT id, project_id, requested_by, compiler, main_file_path FROM compile_jobs
      WHERE status = 'queued' ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    const job = result.rows[0];
    if (!job) return null;
    await client.query("UPDATE compile_jobs SET status = 'running', started_at = now() WHERE id = $1", [job.id]);
    return job;
  });
}

type FinishedStatus = 'completed' | 'completed_with_errors' | 'failed';

async function finishJob(job: ClaimedJob, status: FinishedStatus, exitCode: number | null, log: string, artifactPath: string | null): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query(`UPDATE compile_jobs SET status = $2, exit_code = $3, log = $4, artifact_path = $5, completed_at = now()
      WHERE id = $1`, [job.id, status, exitCode, log.slice(0, 2_000_000), artifactPath]);
    const action = status === 'failed' ? 'compile.failed' : status === 'completed_with_errors' ? 'compile.completed_with_errors' : 'compile.completed';
    await client.query('INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, \'compile_job\', $4, $5)', [job.project_id, job.requested_by, action, job.id, { compiler: job.compiler, exitCode }]);
  });
}

async function executeJob(job: ClaimedJob, volumeMountpoint: string): Promise<void> {
  const stagingRelative = path.posix.join('compile-staging', job.id);
  const resultRelative = path.posix.join('compile-results', job.id);
  const staging = path.join(storageRoot, stagingRelative);
  const results = path.join(storageRoot, resultRelative);
  await mkdir(staging, { recursive: true }); await mkdir(results, { recursive: true });
  const files = await pool.query<JobFile>('SELECT path, content FROM compile_job_files WHERE job_id = $1 ORDER BY path', [job.id]);
  for (const file of files.rows) { const target = safeTarget(staging, file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, file.content); }
  const container = await docker.createContainer({
    Image: compilerImage,
    Cmd: ['/compiler/compile.sh', job.compiler, job.main_file_path.replace(/^\/+/, '')],
    WorkingDir: '/tmp',
    Env: ['HOME=/tmp', 'TEXMFVAR=/tmp/texmf-var', 'TEXMFCONFIG=/tmp/texmf-config', 'TEXMFCACHE=/tmp/texmf-cache'],
    Tty: true,
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Memory: 768 * 1024 * 1024, MemorySwap: 768 * 1024 * 1024, NanoCpus: 2_000_000_000, PidsLimit: 128,
      Binds: [`${path.join(volumeMountpoint, stagingRelative)}:/input:ro`, `${path.join(volumeMountpoint, resultRelative)}:/output:rw`],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=536870912' },
      Ulimits: [{ Name: 'fsize', Soft: 104_857_600, Hard: 104_857_600 }, { Name: 'nofile', Soft: 1024, Hard: 1024 }],
    },
  });
  let exitCode: number | null = null; let timedOut = false; let artifactPath: string | null = null;
  try {
    await container.start();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      container.wait().then((result) => ({ result })),
      new Promise<{ timeout: true }>((resolve) => { timeout = setTimeout(() => resolve({ timeout: true }), 120_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if ('timeout' in outcome) { timedOut = true; await container.kill(); exitCode = (await container.wait()).StatusCode; }
    else exitCode = outcome.result.StatusCode;
    let log = '';
    try { log = (await readFile(path.join(results, 'build.log'), 'utf8')).slice(0, 2_000_000); }
    catch { log = String(await container.logs({ stdout: true, stderr: true })).slice(0, 2_000_000); }
    if (timedOut) log = `Compilation exceeded the 120 second limit.\n${log}`;
    const pdf = path.join(results, 'output.pdf');
    try { const details = await stat(pdf); if (details.size > 50 * 1024 * 1024) throw new Error('Generated PDF exceeds 50 MB'); if (!timedOut) artifactPath = path.posix.join(resultRelative, 'output.pdf'); }
    catch (error) { if (exitCode === 0) { exitCode = 1; log = `${log}\n${error instanceof Error ? error.message : 'No PDF was generated.'}`; } }
    const status: FinishedStatus = !artifactPath ? 'failed' : exitCode === 0 ? 'completed' : 'completed_with_errors';
    await finishJob(job, status, exitCode, log, artifactPath);
  } catch (error) {
    await finishJob(job, 'failed', exitCode, error instanceof Error ? error.stack || error.message : String(error), null);
  } finally {
    try { await container.remove({ force: true }); } catch { /* already removed */ }
    await rm(staging, { recursive: true, force: true });
    if (!artifactPath) await rm(results, { recursive: true, force: true });
  }
}

async function waitForSchema(): Promise<void> {
  let announced = false;
  while (!stopping) {
    try {
      await pool.query('SELECT 1 FROM compile_jobs LIMIT 0');
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== '42P01') throw error;
      if (!announced) { console.log('Waiting for the API to apply compilation migrations'); announced = true; }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

async function run(): Promise<void> {
  await waitForSchema();
  if (stopping) return;
  await pool.query("UPDATE compile_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < now() - interval '10 minutes'");
  const volume = await docker.getVolume(projectVolume).inspect();
  if (!volume.Mountpoint) throw new Error(`Docker volume ${projectVolume} has no mountpoint`);
  await docker.getImage(compilerImage).inspect();
  console.log(`Compilation worker ready with ${compilerImage}`);
  while (!stopping) {
    const job = await claimJob();
    if (job) await executeJob(job, volume.Mountpoint);
    else await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; });
try { await run(); }
finally { await pool.end(); }
