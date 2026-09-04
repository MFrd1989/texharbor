import { describe, expect, it } from 'vitest';
import { createCommentThreadSchema, createProjectSchema, registerSchema } from './index.js';

describe('account contracts', () => {
  it('normalizes email addresses', () => {
    expect(registerSchema.parse({ name: 'Ada', email: ' ADA@EXAMPLE.COM ', password: 'long-password' }).email).toBe('ada@example.com');
  });

  it('rejects short passwords', () => {
    expect(registerSchema.safeParse({ name: 'Ada', email: 'ada@example.com', password: 'short' }).success).toBe(false);
  });
});

describe('project contracts', () => {
  it('trims project names and supplies a description', () => {
    expect(createProjectSchema.parse({ name: ' Paper ' })).toEqual({ name: 'Paper', description: '' });
  });
});

describe('comment contracts', () => {
  it('accepts a bounded Yjs source anchor', () => {
    const result = createCommentThreadSchema.parse({ fileId: '6f1d45a5-70f7-40e7-b76d-4be42edc7870', body: 'Needs a citation', anchor: { start: 'AQID', end: 'BAUG', quote: 'claim' } });
    expect(result.body).toBe('Needs a citation');
  });

  it('rejects malformed source anchors', () => {
    expect(createCommentThreadSchema.safeParse({ fileId: '6f1d45a5-70f7-40e7-b76d-4be42edc7870', body: 'Comment', anchor: { start: '<script>', end: 'AQID', quote: '' } }).success).toBe(false);
  });
});
