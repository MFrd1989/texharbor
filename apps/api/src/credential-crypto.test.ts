import { describe, expect, it } from 'vitest';
import { openCredential, sealCredential } from './credential-crypto.js';

describe('cloud credential encryption', () => {
  it('round trips without storing plaintext', () => {
    const secret = 'a-session-secret-that-is-long-enough-for-tests';
    const sealed = sealCredential('refresh-token', secret);
    expect(sealed).not.toContain('refresh-token');
    expect(openCredential(sealed, secret)).toBe('refresh-token');
  });

  it('rejects tampering and the wrong key', () => {
    const sealed = sealCredential('refresh-token', 'first-long-enough-secret-for-encryption');
    expect(() => openCredential(`${sealed}x`, 'first-long-enough-secret-for-encryption')).toThrow();
    expect(() => openCredential(sealed, 'second-long-enough-secret-for-encryption')).toThrow();
  });
});
