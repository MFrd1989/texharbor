import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { createPool, migrate } from '@texharbor/database';
import { refreshSession } from './auth.js';
import { loadConfig } from './config.js';
import { attachCollaborationServer } from './collaboration.js';
import { registerCommentRoutes } from './comments.js';
import { registerCompilationRoutes } from './compilation.js';
import { registerCloudRoutes } from './cloud.js';
import { HttpError, sendError } from './http.js';
import { registerRoutes } from './routes.js';

const config = loadConfig();
const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 6 * 1024 * 1024 });
const pool = createPool(config.databaseUrl);

await app.register(cookie);
await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
await app.register(rateLimit, { global: false });
await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024, fields: 5 } });

app.addHook('onRequest', async (request) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.origin;
  if (origin && origin !== config.publicOrigin) throw new HttpError(403, 'Request origin is not allowed');
});
app.addHook('onSend', async (request, reply, payload) => {
  try { await refreshSession(pool, request, reply, config.isProduction); }
  catch (error) { request.log.warn({ error }, 'Could not refresh session expiration'); }
  return payload;
});

app.setErrorHandler((error, _request, reply) => sendError(reply, error));

await migrate(pool, path.resolve(config.migrationsDirectory));
const collaboration = attachCollaborationServer(app.server, pool, config.sessionSecret);
await registerRoutes(app, pool, config, collaboration);
await registerCommentRoutes(app, pool);
await registerCompilationRoutes(app, pool, collaboration, config);
await registerCloudRoutes(app, pool, config, collaboration);

if (config.isProduction) {
  await app.register(fastifyStatic, { root: path.resolve(config.webDirectory), wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

const close = async () => {
  await collaboration.destroy();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ host: '0.0.0.0', port: config.port });
