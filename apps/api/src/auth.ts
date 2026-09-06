import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DatabasePool } from '@texharbor/database';
import type { UserDto } from '@texharbor/contracts';
import { HttpError } from './http.js';

const cookieName = 'texharbor_session';
const legacyCookieName = 'texlyre_session';
export const sessionLifetimeMs = 180 * 24 * 60 * 60 * 1000;
const sessionRenewalAgeMs = 24 * 60 * 60 * 1000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const sessionToken = (request: FastifyRequest) => {
  const token = request.cookies[cookieName];
  if (token) return { token, legacy: false };
  const legacyToken = request.cookies[legacyCookieName];
  return legacyToken ? { token: legacyToken, legacy: true } : null;
};

type UserRow = { id: string; name: string; email: string; created_at: Date };
const toUser = (row: UserRow): UserDto => ({
  id: row.id,
  name: row.name,
  email: row.email,
  createdAt: row.created_at.toISOString(),
});

export async function createSession(pool: DatabasePool, reply: FastifyReply, userId: string, secure: boolean): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [hashToken(token), userId, expiresAt]);
  reply.setCookie(cookieName, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    expires: expiresAt,
    maxAge: Math.floor(sessionLifetimeMs / 1000),
  });
}

export async function refreshSession(pool: DatabasePool, request: FastifyRequest, reply: FastifyReply, secure: boolean): Promise<void> {
  const session = sessionToken(request);
  if (!session) return;
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  const result = await pool.query(`UPDATE sessions SET expires_at = $2, last_seen_at = now()
    WHERE token_hash = $1 AND expires_at > now()
      AND ($3::boolean OR last_seen_at < now() - ($4::bigint * interval '1 millisecond'))
    RETURNING token_hash`, [hashToken(session.token), expiresAt, session.legacy, sessionRenewalAgeMs]);
  if (!result.rowCount) return;
  reply.setCookie(cookieName, session.token, { path: '/', httpOnly: true, secure, sameSite: 'lax', expires: expiresAt, maxAge: Math.floor(sessionLifetimeMs / 1000) });
  if (session.legacy) reply.clearCookie(legacyCookieName, { path: '/' });
}

export async function destroySession(pool: DatabasePool, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = sessionToken(request);
  if (session) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(session.token)]);
  reply.clearCookie(cookieName, { path: '/' });
  reply.clearCookie(legacyCookieName, { path: '/' });
}

export async function currentUser(pool: DatabasePool, request: FastifyRequest): Promise<UserDto | null> {
  const session = sessionToken(request);
  if (!session) return null;
  const result = await pool.query<UserRow>(`SELECT u.id, u.name, u.email, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now()`, [hashToken(session.token)]);
  const row = result.rows[0];
  if (!row) return null;
  return toUser(row);
}

export async function requireUser(pool: DatabasePool, request: FastifyRequest): Promise<UserDto> {
  const user = await currentUser(pool, request);
  if (!user) throw new HttpError(401, 'Authentication required');
  return user;
}

export async function registerUser(pool: DatabasePool, input: { name: string; email: string; password: string }): Promise<UserDto> {
  const id = randomUUID();
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const result = await pool.query<UserRow>(`INSERT INTO users (id, name, email, password_hash)
    VALUES ($1, $2, $3, $4) RETURNING id, name, email, created_at`, [id, input.name, input.email, passwordHash]);
  return toUser(result.rows[0]!);
}

export async function authenticateUser(pool: DatabasePool, email: string, password: string): Promise<UserDto> {
  const result = await pool.query<UserRow & { password_hash: string }>('SELECT id, name, email, created_at, password_hash FROM users WHERE email = $1', [email]);
  const row = result.rows[0];
  if (!row || !(await argon2.verify(row.password_hash, password))) throw new HttpError(401, 'Invalid email or password');
  return toUser(row);
}
