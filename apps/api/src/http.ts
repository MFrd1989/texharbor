import type { FastifyReply } from 'fastify';
import type { ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message || 'Invalid request');
  return result.data;
}

export function sendError(reply: FastifyReply, error: unknown): void {
  if (error instanceof HttpError) {
    void reply.code(error.statusCode).send({ error: error.message });
    return;
  }
  const statusError = error as { statusCode?: number; message?: string };
  if (statusError?.statusCode && statusError.statusCode >= 400 && statusError.statusCode < 500) {
    void reply.code(statusError.statusCode).send({ error: statusError.message || 'Invalid request' });
    return;
  }
  const databaseError = error as { code?: string };
  if (databaseError?.code === '23505') {
    void reply.code(409).send({ error: 'That value is already in use' });
    return;
  }
  reply.log.error(error);
  void reply.code(500).send({ error: 'Internal server error' });
}
