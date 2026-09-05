import { randomUUID } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { HttpError } from './http.js';
import { mimeTypeFor, normalizeProjectPath } from './paths.js';

const maxArchiveBytes = 100 * 1024 * 1024;
const maxExpandedBytes = 200 * 1024 * 1024;
const maxEntries = 2_000;
const textExtensions = new Set(['.tex', '.bib', '.bst', '.sty', '.cls', '.clo', '.cfg', '.def', '.fd', '.bbx', '.cbx', '.lbx', '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.toml', '.svg', '.py', '.r', '.lua', '.sh', '.gnuplot', '.asy']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.eps', '.zip', '.gz', '.bz2', '.xz', '.ttf', '.otf', '.woff', '.woff2']);

export type ImportedFile = {
  id: string;
  path: string;
  kind: 'file' | 'directory';
  mimeType: string | null;
  content: Buffer | null;
  size: number;
  isBinary: boolean;
};

function isProbablyBinary(data: Uint8Array, projectPath: string): boolean {
  const extension = path.posix.extname(projectPath).toLowerCase();
  if (binaryExtensions.has(extension)) return true;
  if (textExtensions.has(extension)) return false;
  const sample = data.subarray(0, Math.min(data.length, 8_192));
  if (sample.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
  }
}

export async function readSourceArchive(buffer: Buffer): Promise<ImportedFile[]> {
  if (!buffer.length || buffer.length > maxArchiveBytes) throw new HttpError(400, 'ZIP files must be between 1 byte and 100 MB');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new HttpError(400, 'The uploaded file is not a readable ZIP archive');
  }

  const entries = Object.values(zip.files).filter((entry) => {
    const name = String(entry.unsafeOriginalName || entry.name).replaceAll('\\', '/');
    return !entry.dir && !name.startsWith('__MACOSX/') && !name.endsWith('/.DS_Store') && name !== '.DS_Store';
  });
  if (!entries.length) throw new HttpError(400, 'The ZIP archive does not contain project files');
  if (entries.length > maxEntries) throw new HttpError(400, `The ZIP archive contains more than ${maxEntries.toLocaleString()} files`);

  const unsafeNames = entries.map((entry) => String(entry.unsafeOriginalName || entry.name).replaceAll('\\', '/').replace(/^\.\//, ''));
  for (const name of unsafeNames) {
    if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) throw new HttpError(400, 'The ZIP archive contains an unsafe absolute path');
    normalizeProjectPath(name);
  }
  const firstSegments = unsafeNames.map((name) => name.split('/')[0]);
  const commonRoot = unsafeNames.every((name) => name.includes('/')) && new Set(firstSegments).size === 1 ? firstSegments[0] : null;
  const directories = new Set<string>();
  const files: ImportedFile[] = [];
  const seen = new Set<string>();
  let expandedBytes = 0;

  for (const entry of Object.values(zip.files).filter((candidate) => candidate.dir)) {
    const unsafeName = String(entry.unsafeOriginalName || entry.name).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!unsafeName || unsafeName.startsWith('__MACOSX/')) continue;
    if (unsafeName.startsWith('/') || /^[A-Za-z]:\//.test(unsafeName)) throw new HttpError(400, 'The ZIP archive contains an unsafe absolute path');
    const relativeName = commonRoot && (unsafeName === commonRoot || unsafeName.startsWith(`${commonRoot}/`)) ? unsafeName.slice(commonRoot.length + 1) : unsafeName;
    if (!relativeName) continue;
    const directory = normalizeProjectPath(relativeName);
    const segments = directory.slice(1).split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) directories.add(`/${segments.slice(0, depth).join('/')}`);
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const unsafeName = unsafeNames[index]!;
    const relativeName = commonRoot ? unsafeName.slice(commonRoot.length + 1) : unsafeName;
    const projectPath = normalizeProjectPath(relativeName);
    if (seen.has(projectPath)) throw new HttpError(400, `The ZIP archive contains a duplicate path: ${projectPath}`);
    seen.add(projectPath);

    const segments = projectPath.slice(1).split('/');
    for (let depth = 1; depth < segments.length; depth += 1) directories.add(`/${segments.slice(0, depth).join('/')}`);

    const data = await entry.async('uint8array');
    expandedBytes += data.byteLength;
    if (expandedBytes > maxExpandedBytes) throw new HttpError(400, 'The expanded ZIP archive is larger than 200 MB');
    const isBinary = isProbablyBinary(data, projectPath);
    files.push({ id: randomUUID(), path: projectPath, kind: 'file', mimeType: mimeTypeFor(projectPath), content: Buffer.from(data), size: data.byteLength, isBinary });
  }

  const directoryRows: ImportedFile[] = [...directories].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right)).map((directory) => ({
    id: randomUUID(), path: directory, kind: 'directory', mimeType: null, content: null, size: 0, isBinary: false,
  }));
  return [...directoryRows, ...files];
}
