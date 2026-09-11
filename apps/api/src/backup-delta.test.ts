import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyByteDelta, createByteDelta } from './backup-delta.js';

describe('byte deltas', () => {
  it('stores only insertions and copy ranges for distant edits in a large file', () => {
    const before = randomBytes(1024 * 1024);
    const after = Buffer.concat([before.subarray(0, 100), Buffer.from('first edit'), before.subarray(110, 800000), Buffer.from('second edit'), before.subarray(800005)]);
    const delta = createByteDelta(before, after);
    expect(delta.length).toBeLessThan(1000);
    expect(applyByteDelta(before, delta, after.length).equals(after)).toBe(true);
  });

  it('round trips insertions, deletions, replacements, empty files, Unicode and binary bytes', () => {
    const values = [Buffer.alloc(0), Buffer.from('TeX αβ🙂\n'.repeat(200)), randomBytes(16000), Buffer.alloc(9000, 97)];
    for (const before of values) {
      for (const after of [Buffer.alloc(0), before, Buffer.concat([before.subarray(0, 17), Buffer.from([0, 255, 128]), before.subarray(65)]), ...values]) {
        expect(applyByteDelta(before, createByteDelta(before, after), after.length).equals(after)).toBe(true);
      }
    }
  });

  it('rejects malformed copy ranges, literals and expansion beyond declared size', () => {
    const base = Buffer.from('base');
    for (const invalid of ['[[4,1]]', '[[-1,2]]', '[[0,0]]', '["???"]', '{}', '[[0,4],[0,4]]']) {
      expect(() => applyByteDelta(base, Buffer.from(invalid), 4)).toThrow();
    }
  });
});
