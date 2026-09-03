import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { UserDto } from '@texlyre/contracts';
import { yCollab } from 'y-codemirror.next';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { api } from './api';

export type Collaborator = { clientId: number; name: string; color: string };
type Props = {
  projectId: string;
  fileId: string;
  user: UserDto;
  readOnly: boolean;
  onStatus: (status: string) => void;
  onPresence: (collaborators: Collaborator[]) => void;
};

function colorFor(value: string): string {
  const colors = ['#29705a', '#9a4e3d', '#4f5fa8', '#986c22', '#7b4c91', '#2d7187'];
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length]!;
}

export function CodeEditor({ projectId, fileId, user, readOnly, onStatus, onPresence }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const statusHandler = useRef(onStatus);
  const presenceHandler = useRef(onPresence);
  statusHandler.current = onStatus;
  presenceHandler.current = onPresence;

  useEffect(() => {
    if (!host.current) return;
    const document = new Y.Doc();
    const text = document.getText('content');
    const persistence = new IndexeddbPersistence(`texlyre:${projectId}:${fileId}`, document);
    const websocketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collaboration`;
    const provider = new HocuspocusProvider({
      url: websocketUrl,
      name: `${projectId}:${fileId}`,
      document,
      token: async () => (await api<{ token: string }>(`/api/projects/${projectId}/files/${fileId}/collaboration-token`, { method: 'POST' })).token,
      flushDelay: 120,
      onStatus: ({ status }) => statusHandler.current(status === 'connected' ? 'Syncing…' : status === 'connecting' ? 'Reconnecting…' : 'Offline'),
      onSynced: ({ state }) => { if (state) statusHandler.current('Saved'); },
      onUnsyncedChanges: ({ number }) => statusHandler.current(number === 0 ? 'Saved' : 'Syncing…'),
      onAuthenticationFailed: ({ reason }) => statusHandler.current(reason || 'Access denied'),
      onAwarenessChange: ({ states }) => {
        presenceHandler.current(states.map((state) => ({
          clientId: Number(state.clientId),
          name: String(state.user?.name || 'Collaborator').slice(0, 100),
          color: String(state.user?.color || '#60736a').slice(0, 20),
        })));
      },
    });
    provider.setAwarenessField('user', { id: user.id, name: user.name, color: colorFor(user.id) });
    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          EditorState.readOnly.of(readOnly),
          EditorView.lineWrapping,
          yCollab(text, provider.awareness, { undoManager }),
        ],
      }),
    });
    return () => {
      view.destroy();
      provider.destroy();
      void persistence.destroy();
      document.destroy();
      presenceHandler.current([]);
    };
  }, [fileId, projectId, readOnly, user.id, user.name]);

  return <div className="editor-host" ref={host} />;
}

