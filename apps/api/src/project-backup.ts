import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import { z } from 'zod';
import type { DatabasePool } from '@texharbor/database';
import { applyByteDelta, createByteDelta } from './backup-delta.js';
import { HttpError } from './http.js';
import { normalizeProjectPath } from './paths.js';

const format = 'texharbor-project-backup';
const maxArchiveBytes = 100 * 1024 * 1024;
const maxExpandedBytes = 200 * 1024 * 1024;
const maxEntries = 2_000;

type StoredFile = {
  id: string;
  path: string;
  kind: 'file' | 'directory';
  mime_type: string | null;
  content: Buffer | null;
  size: string;
  is_binary: boolean;
};

export type BackupFile = {
  path: string;
  kind: 'file' | 'directory';
  mimeType: string | null;
  size: number;
  isBinary: boolean;
  sha256: string | null;
  content: Buffer | null;
};

const fileSchema = z.object({
  path: z.string().min(1).max(1000),
  kind: z.enum(['file', 'directory']),
  mimeType: z.string().max(255).nullable(),
  size: z.number().int().min(0).max(maxExpandedBytes),
  isBinary: z.boolean(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  encoding: z.enum(['copy', 'delta', 'full']).optional(),
  basePath: z.string().max(1000).optional(),
});
const manifestSchema = z.object({
  format: z.literal(format),
  version: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.string().datetime(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  parentSourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  parentBackupId: z.string().uuid().optional(),
  project: z.object({
    id: z.string().uuid(), name: z.string().max(200), description: z.string().max(2000),
    mainFilePath: z.string().max(1000), compiler: z.enum(['pdflatex', 'xelatex', 'lualatex', 'typst']),
  }),
  files: z.array(fileSchema).max(maxEntries),
});
export type BackupManifest = z.infer<typeof manifestSchema>;
export type ProjectBackupSnapshot = { manifest: BackupManifest; files: BackupFile[] };
export type ProjectBackupArchive = ProjectBackupSnapshot & { archive: Buffer; fileName: string };

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

const metadataForFile = (file: BackupFile) => ({ path: file.path, kind: file.kind, mimeType: file.mimeType, size: file.size, isBinary: file.isBinary, sha256: file.sha256 });
const sourceHashFor = (project: BackupManifest['project'], files: BackupFile[]) => sha256(JSON.stringify({
  name: project.name, description: project.description, mainFilePath: project.mainFilePath, compiler: project.compiler,
  files: files.map(metadataForFile),
}));

async function finishArchive(zip: JSZip): Promise<Buffer> {
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (archive.byteLength > maxArchiveBytes) throw new HttpError(413, 'Project backup is larger than 100 MB');
  return archive;
}

export async function readProjectSnapshot(pool: Pick<DatabasePool, 'query'>, projectId: string): Promise<ProjectBackupSnapshot & { fileName: string }> {
  // One statement gives settings and files the same PostgreSQL snapshot, even
  // when an editor is renaming a main document concurrently.
  const projectResult = await pool.query<StoredFile & { file_id: string | null; name: string; description: string; main_file_path: string; compiler: BackupManifest['project']['compiler'] }>(
    `SELECT p.id, p.name, p.description, p.main_file_path, p.compiler,
      f.id AS file_id, f.path, f.kind, f.mime_type, f.content, f.size, f.is_binary
      FROM projects p LEFT JOIN project_files f ON f.project_id = p.id
      WHERE p.id = $1 AND p.deleted_at IS NULL ORDER BY f.path`, [projectId]);
  const project = projectResult.rows[0];
  if (!project) throw new HttpError(404, 'Project not found');
  const files: BackupFile[] = projectResult.rows.filter((file) => file.file_id !== null).map((file) => ({
    path: file.path,
    kind: file.kind,
    mimeType: file.mime_type,
    size: file.kind === 'file' ? (file.content?.length || 0) : 0,
    isBinary: file.is_binary,
    sha256: file.kind === 'file' ? sha256(file.content || Buffer.alloc(0)) : null,
    content: file.content,
  }));
  if (files.length > maxEntries || files.reduce((total, file) => total + file.size, 0) > maxExpandedBytes) throw new HttpError(413, 'Project is too large to back up');
  const projectMetadata = { id: project.id, name: project.name, description: project.description, mainFilePath: project.main_file_path, compiler: project.compiler };
  const sourceHash = sourceHashFor(projectMetadata, files);
  const manifest: BackupManifest = {
    format,
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceHash,
    project: projectMetadata,
    files: files.map(metadataForFile),
  };
  const safeName = project.name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'project';
  return { manifest, files, fileName: `${safeName}-${manifest.exportedAt.replace(/[:.]/g, '-')}.texharbor.zip` };
}

export async function createProjectBackup(pool: Pick<DatabasePool, 'query'>, projectId: string): Promise<ProjectBackupArchive> {
  const snapshot = await readProjectSnapshot(pool, projectId);
  return { ...snapshot, archive: await createFullProjectBackup(snapshot) };
}

export async function createFullProjectBackup(snapshot: ProjectBackupSnapshot): Promise<Buffer> {
  const manifest: BackupManifest = { ...snapshot.manifest, version: 1, files: snapshot.files.map(metadataForFile) };
  delete manifest.parentSourceHash;
  delete manifest.parentBackupId;
  const zip = new JSZip();
  zip.file('texharbor.json', JSON.stringify(manifest, null, 2));
  for (const file of snapshot.files) {
    const archivePath = `project${file.path}`;
    if (file.kind === 'directory') zip.folder(archivePath);
    else zip.file(archivePath, file.content || Buffer.alloc(0));
  }
  return finishArchive(zip);
}

export async function createProjectDeltaBackup(current: ProjectBackupSnapshot & { fileName: string }, parent: ProjectBackupSnapshot, parentBackupId: string): Promise<ProjectBackupArchive> {
  const byPath = new Map(parent.files.map((file) => [file.path, file]));
  const byHash = new Map(parent.files.filter((file) => file.kind === 'file').map((file) => [file.sha256, file]));
  const zip = new JSZip();
  const files: BackupManifest['files'] = current.files.map((file) => {
    const metadata = metadataForFile(file);
    if (file.kind === 'directory') return metadata;
    const base = byHash.get(file.sha256) || byPath.get(file.path);
    if (base?.kind === 'file' && base.sha256 === file.sha256) return { ...metadata, encoding: 'copy', basePath: base.path };
    const content = file.content || Buffer.alloc(0);
    if (base?.kind === 'file') {
      const delta = createByteDelta(base.content || Buffer.alloc(0), content);
      if (delta.length < content.length) {
        zip.file(`delta${file.path}`, delta);
        return { ...metadata, encoding: 'delta', basePath: base.path };
      }
    }
    zip.file(`project${file.path}`, content);
    return { ...metadata, encoding: 'full' };
  });
  const manifest: BackupManifest = { ...current.manifest, version: 2, parentSourceHash: parent.manifest.sourceHash, parentBackupId, files };
  zip.file('texharbor.json', JSON.stringify(manifest));
  return { ...current, manifest, archive: await finishArchive(zip), fileName: current.fileName.replace(/\.texharbor\.zip$/, '.texharbor.delta.zip') };
}

async function readEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = entry.nodeStream('nodebuffer') as Readable;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        reject(new HttpError(422, 'Expanded backup exceeds its size limit'));
      } else chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks, size)));
  });
}

export async function readProjectBackup(archive: Buffer, expectedProjectId: string, parent?: ProjectBackupSnapshot, parentBackupId?: string): Promise<ProjectBackupSnapshot> {
  if (!archive.length || archive.byteLength > maxArchiveBytes) throw new HttpError(422, 'Backup must be between 1 byte and 100 MB');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(archive); }
  catch { throw new HttpError(422, 'Backup is not a readable ZIP archive'); }
  const manifestEntry = zip.file('texharbor.json');
  if (!manifestEntry) throw new HttpError(422, 'Backup is missing texharbor.json');
  let manifest: BackupManifest;
  try { manifest = manifestSchema.parse(JSON.parse((await readEntry(manifestEntry, 4 * 1024 * 1024)).toString('utf8'))); }
  catch { throw new HttpError(422, 'Backup manifest is invalid'); }
  if (manifest.project?.id !== expectedProjectId) throw new HttpError(422, 'Backup does not belong to this project');
  if (manifest.version === 2 && (!parent || parent.manifest.project.id !== expectedProjectId || manifest.parentSourceHash !== parent.manifest.sourceHash || !manifest.parentBackupId || manifest.parentBackupId !== parentBackupId)) throw new HttpError(422, 'Incremental backup parent is missing or does not match');
  const parentFiles = new Map(parent?.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const files: BackupFile[] = [];
  let expandedBytes = 0;
  for (const metadata of manifest.files) {
    const projectPath = normalizeProjectPath(metadata.path);
    if (projectPath !== metadata.path || seen.has(projectPath) || !['file', 'directory'].includes(metadata.kind)) throw new HttpError(422, 'Backup contains an invalid or duplicate path');
    seen.add(projectPath);
    if (metadata.kind === 'directory') {
      files.push({ ...metadata, path: projectPath, size: 0, isBinary: false, sha256: null, content: null });
      continue;
    }
    if (expandedBytes + metadata.size > maxExpandedBytes) throw new HttpError(422, 'Expanded backup is larger than 200 MB');
    let content: Buffer;
    if (manifest.version === 2 && (metadata.encoding === 'copy' || metadata.encoding === 'delta')) {
      const base = parentFiles.get(metadata.basePath || '');
      if (base?.kind !== 'file' || !base.content) throw new HttpError(422, `Backup base file is missing for ${projectPath}`);
      if (metadata.encoding === 'copy') content = base.content;
      else {
        const entry = zip.file(`delta${projectPath}`);
        if (!entry) throw new HttpError(422, `Backup delta is missing for ${projectPath}`);
        content = applyByteDelta(base.content, await readEntry(entry, maxExpandedBytes), metadata.size);
      }
    } else {
      if (manifest.version === 2 && metadata.encoding !== 'full') throw new HttpError(422, 'Backup file encoding is invalid');
      const entry = zip.file(`project${projectPath}`);
      if (!entry) throw new HttpError(422, `Backup is missing ${projectPath}`);
      content = await readEntry(entry, maxExpandedBytes - expandedBytes);
    }
    expandedBytes += content.byteLength;
    if (expandedBytes > maxExpandedBytes) throw new HttpError(422, 'Expanded backup is larger than 200 MB');
    if (content.byteLength !== metadata.size || sha256(content) !== metadata.sha256) throw new HttpError(422, `Backup integrity check failed for ${projectPath}`);
    files.push({ ...metadataForFile({ ...metadata, content }), content });
  }
  if (!files.some((file) => file.path === manifest.project.mainFilePath && file.kind === 'file')) throw new HttpError(422, 'Backup main document is missing');
  if (manifest.version === 2 && sourceHashFor(manifest.project, files) !== manifest.sourceHash) throw new HttpError(422, 'Backup project integrity check failed');
  return { manifest, files };
}

export function newFileId(): string { return randomUUID(); }
