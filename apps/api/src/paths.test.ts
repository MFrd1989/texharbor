import { describe, expect, it } from 'vitest';
import { normalizeProjectPath } from './paths.js';

describe('normalizeProjectPath', () => {
  it('normalizes a nested project path', () => {
    expect(normalizeProjectPath('chapters/introduction.tex')).toBe('/chapters/introduction.tex');
  });

  it.each(['../secret', 'chapters/../../secret', '/tmp/../secret', '.', '/', ''])('rejects unsafe path %s', (value) => {
    expect(() => normalizeProjectPath(value)).toThrow('Invalid project path');
  });
});

