import { describe, expect, it } from 'vitest';
import { backupScheduleSchema, createBackupSchema, createCommentThreadSchema, createProjectSchema, registerSchema } from './index.js';

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

describe('backup contracts', () => {
  it('accepts supported local and scheduled backup policies', () => {
    expect(createBackupSchema.parse({ provider: 'local' })).toEqual({ provider: 'local' });
    expect(backupScheduleSchema.parse({ enabled: true, destination: 'both', intervalHours: 24, retentionCount: 20 }).destination).toBe('both');
  });

  it('rejects unbounded or overly frequent schedules', () => {
    expect(backupScheduleSchema.safeParse({ enabled: true, destination: 'local', intervalHours: 0, retentionCount: 20 }).success).toBe(false);
    expect(backupScheduleSchema.safeParse({ enabled: true, destination: 'local', intervalHours: 24, retentionCount: 101 }).success).toBe(false);
  });
});
