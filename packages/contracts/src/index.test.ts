import { describe, expect, it } from 'vitest';
import { createProjectSchema, registerSchema } from './index.js';

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

