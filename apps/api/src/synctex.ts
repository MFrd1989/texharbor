import path from 'node:path';
import { normalizeProjectPath } from './paths.js';

export type SyncTexResult = { input: string; line: number; column: number };

export function parseSyncTexResult(output: string): SyncTexResult | null {
  const block = output.match(/SyncTeX result begin\s+([\s\S]*?)SyncTeX result end/);
  if (!block?.[1]) return null;
  const input = block[1].match(/^Input:(.+)$/m)?.[1]?.trim();
  const line = Number(block[1].match(/^Line:(-?\d+)$/m)?.[1]);
  const column = Number(block[1].match(/^Column:(-?\d+)$/m)?.[1]);
  if (!input || !Number.isInteger(line) || line < 1) return null;
  return { input, line, column: Number.isInteger(column) ? Math.max(0, column) : 0 };
}

export function projectPathFromSyncTexInput(input: string): string | null {
  const sourceRoot = '/tmp/source';
  const resolved = path.posix.resolve(sourceRoot, input);
  if (!resolved.startsWith(`${sourceRoot}/`)) return null;
  return normalizeProjectPath(path.posix.relative(sourceRoot, resolved));
}
