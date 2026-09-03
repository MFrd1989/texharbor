import { describe, expect, it } from 'vitest';
import { signCollaborationToken, verifyCollaborationToken } from './collaboration-token.js';

const secret = 'test-secret-with-at-least-thirty-two-characters';

describe('collaboration tokens', () => {
  it('round trips signed claims', () => {
    const claims = { userId: 'user', projectId: 'project', fileId: 'file', expiresAt: Date.now() + 1000 };
    expect(verifyCollaborationToken(secret, signCollaborationToken(secret, claims))).toEqual(claims);
  });

  it('rejects tampering and expiry', () => {
    const token = signCollaborationToken(secret, { userId: 'user', projectId: 'project', fileId: 'file', expiresAt: Date.now() - 1 });
    expect(() => verifyCollaborationToken(secret, `${token}x`)).toThrow('Invalid');
    expect(() => verifyCollaborationToken(secret, token)).toThrow('Expired');
  });
});

