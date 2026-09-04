import type { Server as HttpServer } from 'node:http';
import { Database } from '@hocuspocus/extension-database';
import { Hocuspocus, type WebSocketLike } from '@hocuspocus/server';
import type { DatabasePool } from '@texlyre/database';
import { transaction } from '@texlyre/database';
import crossws from 'crossws/adapters/node';
import * as Y from 'yjs';
import { verifyCollaborationToken } from './collaboration-token.js';

type CollaborationContext = { userId?: string; role?: 'owner' | 'editor' | 'viewer' };

function parseDocumentName(documentName: string): { projectId: string; fileId: string } {
  const match = /^([0-9a-f-]{36}):([0-9a-f-]{36})$/i.exec(documentName);
  if (!match?.[1] || !match[2]) throw new Error('Invalid collaboration document');
  return { projectId: match[1], fileId: match[2] };
}

export type CollaborationServer = {
  disconnectProject: (projectId: string) => Promise<void>;
  destroy: () => Promise<void>;
};

export function attachCollaborationServer(httpServer: HttpServer, pool: DatabasePool, secret: string): CollaborationServer {
  const hocuspocus = new Hocuspocus<CollaborationContext>({
    name: 'texlyre-collaboration',
    debounce: 1_000,
    maxDebounce: 5_000,
    unloadImmediately: false,
    maxUnauthenticatedQueueSize: 256 * 1024,
    maxUnauthenticatedQueueMessages: 100,
    maxPendingDocuments: 5,
    extensions: [new Database({
      fetch: async ({ documentName }) => {
        const stored = await pool.query<{ state: Buffer }>('SELECT state FROM collaboration_documents WHERE document_name = $1', [documentName]);
        if (stored.rows[0]) return new Uint8Array(stored.rows[0].state);
        const { projectId, fileId } = parseDocumentName(documentName);
        const file = await pool.query<{ content: Buffer | null }>(`SELECT f.content FROM project_files f JOIN projects p ON p.id = f.project_id
          WHERE f.id = $1 AND f.project_id = $2 AND f.kind = 'file' AND NOT f.is_binary AND p.deleted_at IS NULL`, [fileId, projectId]);
        if (!file.rows[0]) return null;
        const document = new Y.Doc();
        const content = file.rows[0].content?.toString('utf8') || '';
        if (content) document.getText('content').insert(0, content);
        const state = Y.encodeStateAsUpdate(document);
        document.destroy();
        return state;
      },
      store: async ({ documentName, state }) => {
        const { projectId, fileId } = parseDocumentName(documentName);
        const document = new Y.Doc();
        Y.applyUpdate(document, state);
        const content = document.getText('content').toString();
        document.destroy();
        await transaction(pool, async (client) => {
          await client.query(`INSERT INTO collaboration_documents (document_name, project_id, file_id, state, updated_at)
            VALUES ($1, $2, $3, $4, now()) ON CONFLICT (document_name) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [documentName, projectId, fileId, Buffer.from(state)]);
          await client.query('UPDATE project_files SET content = $3, size = octet_length($3::bytea), updated_at = now() WHERE id = $1 AND project_id = $2', [fileId, projectId, Buffer.from(content)]);
          await client.query('UPDATE projects SET updated_at = now() WHERE id = $1', [projectId]);
        });
      },
    })],
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const claims = verifyCollaborationToken(secret, token);
      if (`${claims.projectId}:${claims.fileId}` !== documentName) throw new Error('Collaboration token does not match this document');
      const access = await pool.query<{ role: 'owner' | 'editor' | 'viewer' }>(`SELECT pm.role FROM project_members pm
        JOIN projects p ON p.id = pm.project_id JOIN project_files f ON f.project_id = p.id
        WHERE pm.user_id = $1 AND p.id = $2 AND f.id = $3 AND f.kind = 'file' AND NOT f.is_binary AND p.deleted_at IS NULL`, [claims.userId, claims.projectId, claims.fileId]);
      const role = access.rows[0]?.role;
      if (!role) throw new Error('Not authorized for this document');
      connectionConfig.readOnly = role === 'viewer';
      return { userId: claims.userId, role };
    },
  });

  const websocket = crossws({
    hooks: {
      open(peer) {
        const connection = hocuspocus.handleConnection(peer.websocket as unknown as WebSocketLike, peer.request as Request, {});
        (peer as typeof peer & { hocuspocus?: typeof connection }).hocuspocus = connection;
      },
      message(peer, message) {
        (peer as typeof peer & { hocuspocus?: { handleMessage: (data: Uint8Array) => void } }).hocuspocus?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        (peer as typeof peer & { hocuspocus?: { handleClose: (event: { code: number; reason: string }) => void } }).hocuspocus?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? '' });
      },
      error(_peer, error) { console.error('Collaboration WebSocket error', error); },
    },
  });

  const upgrade = (request: Parameters<typeof websocket.handleUpgrade>[0], socket: Parameters<typeof websocket.handleUpgrade>[1], head: Parameters<typeof websocket.handleUpgrade>[2]) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname !== '/collaboration') { socket.destroy(); return; }
    websocket.handleUpgrade(request, socket, head);
  };
  httpServer.on('upgrade', upgrade);
  return {
    disconnectProject: async (projectId) => {
      hocuspocus.flushPendingStores();
      const files = await pool.query<{ document_name: string }>(`SELECT project_id::text || ':' || id::text AS document_name
        FROM project_files WHERE project_id = $1 AND kind = 'file' AND NOT is_binary`, [projectId]);
      for (const file of files.rows) hocuspocus.closeConnections(file.document_name);
    },
    destroy: async () => {
      httpServer.off('upgrade', upgrade);
      hocuspocus.flushPendingStores();
      hocuspocus.closeConnections();
    },
  };
}
