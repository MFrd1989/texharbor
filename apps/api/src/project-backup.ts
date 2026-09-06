import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import type { DatabasePool } from '@texharbor/database';
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

type BackupFile = {
  path: string;
  kind: 'file' | 'directory';
  mimeType: string | null;
  size: number;
  isBinary: boolean;
  sha256: string | null;
  content: Buffer | null;
};

type BackupManifest = {
  format: typeof format;
  version: 1;
  exportedAt: string;
  sourceHash: string;
  project: { id: string; name: string; description: string; mainFilePath: string; compiler: string };
  files: Array<Omit<BackupFile, 'content'>>;
};

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export async function createProjectBackup(pool: DatabasePool, projectId: string): Promise<{ archive: Buffer; manifest: BackupManifest; fileName: string }> {
  const projectResult = await pool.query<{ id: string; name: string; description: string; main_file_path: string; compiler: string }>(
    'SELECT id, name, description, main_file_path, compiler FROM projects WHERE id = $1 AND deleted_at IS NULL', [projectId],
  );
  const project = projectResult.rows[0];
  if (!project) throw new HttpError(404, 'Project not found');
  const fileResult = await pool.query<StoredFile>('SELECT id, path, kind, mime_type, content, size, is_binary FROM project_files WHERE project_id = $1 ORDER BY path', [projectId]);
  const files: BackupFile[] = fileResult.rows.map((file) => ({
    path: file.path,
    kind: file.kind,
    mimeType: file.mime_type,
    size: Number(file.size),
    isBinary: file.is_binary,
    sha256: file.kind === 'file' ? sha256(file.content || Buffer.alloc(0)) : null,
    content: file.content,
  }));
  const sourceHash = sha256(JSON.stringify({
    name: project.name,
    description: project.description,
    mainFilePath: project.main_file_path,
    compiler: project.compiler,
    files: files.map(({ content: _content, ...file }) => file),
  }));
  const manifest: BackupManifest = {
    format,
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceHash,
    project: { id: project.id, name: project.name, description: project.description, mainFilePath: project.main_file_path, compiler: project.compiler },
    files: files.map(({ content: _content, ...file }) => file),
  };
  const zip = new JSZip();
  zip.file('texharbor.json', JSON.stringify(manifest, null, 2));
  for (const file of files) {
    const archivePath = `project${file.path}`;
    if (file.kind === 'directory') zip.folder(archivePath);
    else zip.file(archivePath, file.content || Buffer.alloc(0));
  }
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (archive.byteLength > maxArchiveBytes) throw new HttpError(413, 'Project backup is larger than 100 MB');
  const safeName = project.name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'project';
  return { archive, manifest, fileName: `${safeName}-${manifest.exportedAt.replace(/[:.]/g, '-')}.texharbor.zip` };
}

export async function readProjectBackup(archive: Buffer, expectedProjectId: string): Promise<{ manifest: BackupManifest; files: BackupFile[] }> {
  if (!archive.length || archive.byteLength > maxArchiveBytes) throw new HttpError(422, 'Backup must be between 1 byte and 100 MB');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(archive); }
  catch { throw new HttpError(422, 'Backup is not a readable ZIP archive'); }
  const manifestEntry = zip.file('texharbor.json');
  if (!manifestEntry) throw new HttpError(422, 'Backup is missing texharbor.json');
  let manifest: BackupManifest;
  try { manifest = JSON.parse(await manifestEntry.async('string')) as BackupManifest; }
  catch { throw new HttpError(422, 'Backup manifest is invalid'); }
  if (manifest.format !== format || manifest.version !== 1) throw new HttpError(422, 'Backup format is not supported');
  if (manifest.project?.id !== expectedProjectId) throw new HttpError(422, 'Backup does not belong to this project');
  if (!Array.isArray(manifest.files) || manifest.files.length > maxEntries) throw new HttpError(422, 'Backup contains too many files');
  if (!['pdflatex', 'xelatex', 'lualatex'].includes(manifest.project.compiler)) throw new HttpError(422, 'Backup contains an invalid compiler');
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
    const entry = zip.file(`project${projectPath}`);
    if (!entry) throw new HttpError(422, `Backup is missing ${projectPath}`);
    const content = Buffer.from(await entry.async('uint8array'));
    expandedBytes += content.byteLength;
    if (expandedBytes > maxExpandedBytes) throw new HttpError(422, 'Expanded backup is larger than 200 MB');
    if (content.byteLength !== metadata.size || sha256(content) !== metadata.sha256) throw new HttpError(422, `Backup integrity check failed for ${projectPath}`);
    files.push({ ...metadata, path: projectPath, content });
  }
  if (!seen.has(manifest.project.mainFilePath)) throw new HttpError(422, 'Backup main document is missing');
  return { manifest, files };
}

export function newFileId(): string { return randomUUID(); }
