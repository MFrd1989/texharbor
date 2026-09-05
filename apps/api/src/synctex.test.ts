import { describe, expect, it } from 'vitest';
import { parseSyncTexResult, projectPathFromSyncTexInput } from './synctex.js';

describe('SyncTeX results', () => {
  it('extracts a source location and normalizes compiler staging paths', () => {
    const output = `This is SyncTeX\nSyncTeX result begin\nOutput:output.pdf\nInput:/tmp/source/./chapters/results.tex\nLine:42\nColumn:-1\nOffset:0\nSyncTeX result end\n`;
    expect(parseSyncTexResult(output)).toEqual({ input: '/tmp/source/./chapters/results.tex', line: 42, column: 0 });
    expect(projectPathFromSyncTexInput('/tmp/source/./chapters/results.tex')).toBe('/chapters/results.tex');
  });

  it('rejects absent results and paths outside the project snapshot', () => {
    expect(parseSyncTexResult('SyncTeX: No result')).toBeNull();
    expect(projectPathFromSyncTexInput('/usr/share/texlive/article.cls')).toBeNull();
  });
});
