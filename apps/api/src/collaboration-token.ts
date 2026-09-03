import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.js';

export type CollaborationClaims = { userId: string; projectId: string; fileId: string; expiresAt: number };

const encode = (value: string) => Buffer.from(value).toString('base64url');

export function signCollaborationToken(secret: string, claims: CollaborationClaims): string {
  const payload = encode(JSON.stringify(claims));
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyCollaborationToken(secret: string, token: string): CollaborationClaims {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) throw new HttpError(401, 'Invalid collaboration token');
  const expected = createHmac('sha256', secret).update(payload).digest();
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64url'); } catch { throw new HttpError(401, 'Invalid collaboration token'); }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new HttpError(401, 'Invalid collaboration token');
  let claims: CollaborationClaims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CollaborationClaims; } catch { throw new HttpError(401, 'Invalid collaboration token'); }
  if (!claims.userId || !claims.projectId || !claims.fileId || claims.expiresAt < Date.now()) throw new HttpError(401, 'Expired collaboration token');
  return claims;
}

