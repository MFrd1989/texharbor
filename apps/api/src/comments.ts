import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabasePool } from '@texharbor/database';
import { transaction } from '@texharbor/database';
import { createCommentReplySchema, createCommentThreadSchema, updateCommentThreadSchema } from '@texharbor/contracts';
import { requireUser } from './auth.js';
import { HttpError, parseBody } from './http.js';
import { requireProject } from './routes.js';

type ThreadRow = {
  id: string;
  projectId: string;
  fileId: string;
  filePath: string;
  createdBy: string;
  anchor: { start: string; end: string; quote: string };
  status: 'open' | 'resolved';
  resolvedAt: Date | null;
  resolvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function registerCommentRoutes(app: FastifyInstance, pool: DatabasePool): Promise<void> {
  app.get('/api/projects/:projectId/comments', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(pool, projectId, user.id);
    const threads = await pool.query<ThreadRow>(`SELECT t.id, t.project_id AS "projectId", t.file_id AS "fileId", f.path AS "filePath",
      t.created_by AS "createdBy", t.anchor, t.status, t.resolved_at AS "resolvedAt", t.resolved_by AS "resolvedBy",
      t.created_at AS "createdAt", t.updated_at AS "updatedAt"
      FROM comment_threads t JOIN project_files f ON f.id = t.file_id
      WHERE t.project_id = $1 ORDER BY (t.status = 'resolved'), t.updated_at DESC`, [projectId]);
    const ids = threads.rows.map((thread) => thread.id);
    const messages = ids.length ? await pool.query<{ id: string; threadId: string; authorId: string; authorName: string; parentCommentId: string | null; body: string; createdAt: Date; updatedAt: Date; deletedAt: Date | null }>(`SELECT c.id, c.thread_id AS "threadId", c.author_id AS "authorId", u.name AS "authorName",
      c.parent_comment_id AS "parentCommentId", c.body, c.created_at AS "createdAt", c.updated_at AS "updatedAt", c.deleted_at AS "deletedAt"
      FROM comments c JOIN users u ON u.id = c.author_id WHERE c.thread_id = ANY($1::uuid[]) ORDER BY c.created_at`, [ids]) : { rows: [] };
    return { threads: threads.rows.map((thread) => ({ ...thread, comments: messages.rows.filter((comment) => comment.threadId === thread.id) })) };
  });

  app.post('/api/projects/:projectId/comments', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId } = request.params as { projectId: string };
    await requireProject(pool, projectId, user.id);
    const input = parseBody(createCommentThreadSchema, request.body);
    const file = await pool.query('SELECT 1 FROM project_files WHERE id = $1 AND project_id = $2 AND kind = \'file\' AND NOT is_binary', [input.fileId, projectId]);
    if (!file.rowCount) throw new HttpError(404, 'Comment source file not found');
    const threadId = randomUUID(); const commentId = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO comment_threads (id, project_id, file_id, created_by, anchor) VALUES ($1, $2, $3, $4, $5)', [threadId, projectId, input.fileId, user.id, input.anchor]);
      await client.query('INSERT INTO comments (id, thread_id, author_id, body) VALUES ($1, $2, $3, $4)', [commentId, threadId, user.id, input.body]);
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'comment.created', 'comment_thread', $3, $4)", [projectId, user.id, threadId, { fileId: input.fileId }]);
    });
    return reply.code(201).send({ threadId, commentId });
  });

  app.post('/api/projects/:projectId/comments/:threadId/replies', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId, threadId } = request.params as { projectId: string; threadId: string };
    await requireProject(pool, projectId, user.id);
    const input = parseBody(createCommentReplySchema, request.body);
    const thread = await pool.query('SELECT 1 FROM comment_threads WHERE id = $1 AND project_id = $2', [threadId, projectId]);
    if (!thread.rowCount) throw new HttpError(404, 'Comment thread not found');
    if (input.parentCommentId) {
      const parent = await pool.query('SELECT 1 FROM comments WHERE id = $1 AND thread_id = $2', [input.parentCommentId, threadId]);
      if (!parent.rowCount) throw new HttpError(400, 'Reply parent is not in this thread');
    }
    const id = randomUUID();
    await transaction(pool, async (client) => {
      await client.query('INSERT INTO comments (id, thread_id, author_id, parent_comment_id, body) VALUES ($1, $2, $3, $4, $5)', [id, threadId, user.id, input.parentCommentId || null, input.body]);
      await client.query('UPDATE comment_threads SET updated_at = now() WHERE id = $1', [threadId]);
      await client.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'comment.replied', 'comment_thread', $3)", [projectId, user.id, threadId]);
    });
    return reply.code(201).send({ commentId: id });
  });

  app.patch('/api/projects/:projectId/comments/:threadId', async (request) => {
    const user = await requireUser(pool, request);
    const { projectId, threadId } = request.params as { projectId: string; threadId: string };
    await requireProject(pool, projectId, user.id);
    const input = parseBody(updateCommentThreadSchema, request.body);
    const result = await pool.query(`UPDATE comment_threads SET status = $3::varchar,
      resolved_at = CASE WHEN $3::varchar = 'resolved' THEN now() ELSE NULL END,
      resolved_by = CASE WHEN $3::varchar = 'resolved' THEN $4::uuid ELSE NULL END, updated_at = now()
      WHERE id = $1 AND project_id = $2 RETURNING id`, [threadId, projectId, input.status, user.id]);
    if (!result.rowCount) throw new HttpError(404, 'Comment thread not found');
    await pool.query('INSERT INTO activity (project_id, actor_id, action, target_type, target_id) VALUES ($1, $2, $3, \'comment_thread\', $4)', [projectId, user.id, input.status === 'resolved' ? 'comment.resolved' : 'comment.reopened', threadId]);
    return { status: input.status };
  });

  app.delete('/api/projects/:projectId/comments/:threadId', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId, threadId } = request.params as { projectId: string; threadId: string };
    const access = await requireProject(pool, projectId, user.id);
    const thread = await pool.query<{ created_by: string }>('SELECT created_by FROM comment_threads WHERE id = $1 AND project_id = $2', [threadId, projectId]);
    if (!thread.rows[0]) throw new HttpError(404, 'Comment thread not found');
    if (access.role !== 'owner' && thread.rows[0].created_by !== user.id) throw new HttpError(403, 'Only the thread author or project owner can delete this thread');
    await pool.query('DELETE FROM comment_threads WHERE id = $1 AND project_id = $2', [threadId, projectId]);
    await pool.query("INSERT INTO activity (project_id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'comment.deleted', 'comment_thread', $3)", [projectId, user.id, threadId]);
    return reply.code(204).send();
  });

  app.delete('/api/projects/:projectId/comments/:threadId/replies/:commentId', async (request, reply) => {
    const user = await requireUser(pool, request);
    const { projectId, threadId, commentId } = request.params as { projectId: string; threadId: string; commentId: string };
    const access = await requireProject(pool, projectId, user.id);
    const comment = await pool.query<{ author_id: string }>(`SELECT c.author_id FROM comments c JOIN comment_threads t ON t.id = c.thread_id
      WHERE c.id = $1 AND c.thread_id = $2 AND t.project_id = $3`, [commentId, threadId, projectId]);
    if (!comment.rows[0]) throw new HttpError(404, 'Comment not found');
    if (access.role !== 'owner' && comment.rows[0].author_id !== user.id) throw new HttpError(403, 'Only the comment author or project owner can delete this comment');
    const replies = await pool.query('SELECT 1 FROM comments WHERE parent_comment_id = $1 LIMIT 1', [commentId]);
    if (replies.rowCount) await pool.query("UPDATE comments SET body = '[deleted]', deleted_at = now(), updated_at = now() WHERE id = $1", [commentId]);
    else await pool.query('DELETE FROM comments WHERE id = $1', [commentId]);
    return reply.code(204).send();
  });
}
