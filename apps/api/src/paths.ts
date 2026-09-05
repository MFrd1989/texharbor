import path from 'node:path';
import { HttpError } from './http.js';

export function normalizeProjectPath(input: string): string {
  const replaced = input.trim().replaceAll('\\', '/');
  const rawParts = replaced.split('/').filter(Boolean);
  if (rawParts.some((part) => part === '.' || part === '..')) throw new HttpError(400, 'Invalid project path');
  const normalized = path.posix.normalize(replaced.startsWith('/') ? replaced : `/${replaced}`);
  if (normalized === '/' || normalized.includes('\0') || normalized.startsWith('/../') || normalized === '/..') {
    throw new HttpError(400, 'Invalid project path');
  }
  const parts = normalized.slice(1).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 255)) throw new HttpError(400, 'Invalid project path');
  if (normalized.length > 1000) throw new HttpError(400, 'Project path is too long');
  return normalized;
}

export function mimeTypeFor(projectPath: string): string {
  const extension = path.posix.extname(projectPath).toLowerCase();
  return ({ '.tex': 'text/x-tex', '.bib': 'text/x-bibtex', '.sty': 'text/x-tex', '.cls': 'text/x-tex', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.svg': 'image/svg+xml', '.eps': 'application/postscript' } as Record<string, string>)[extension] || 'text/plain';
}
