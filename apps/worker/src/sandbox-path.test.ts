import { describe, expect, it } from 'vitest';
import { safeTarget } from './sandbox-path.js';

describe('compiler staging paths', () => {
  it('resolves a nested project path inside its job directory', () => {
    expect(safeTarget('/data/jobs/id', '/chapters/intro.tex')).toBe('/data/jobs/id/chapters/intro.tex');
  });

  it.each(['/../secret', '/chapters/../../secret', '/'])('rejects escaping path %s', (candidate) => {
    expect(() => safeTarget('/data/jobs/id', candidate)).toThrow('Unsafe project path');
  });
});
