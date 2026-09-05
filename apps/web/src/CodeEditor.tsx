import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { CommentAnchorDto, ProjectRole, UserDto } from '@texlyre/contracts';
import { yCollab } from 'y-codemirror.next';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { api } from './api';

export type Collaborator = { clientId: number; name: string; color: string };
export type SelectionActionPosition = { top: number; left: number };
type Props = {
  projectId: string;
  fileId: string;
  user: UserDto;
  readOnly: boolean;
  onStatus: (status: string) => void;
  onPresence: (collaborators: Collaborator[]) => void;
  onRole: (role: ProjectRole) => void;
  onAccessLost: (message: string) => void;
  onConnectionReset: () => void;
  onSelection: (anchor: CommentAnchorDto, actionPosition: SelectionActionPosition | null) => void;
  jumpRequest: { anchor: CommentAnchorDto; nonce: number } | null;
  sourceJumpRequest: { line: number; column: number; nonce: number } | null;
};

function colorFor(value: string): string {
  const colors = ['#29705a', '#9a4e3d', '#4f5fa8', '#986c22', '#7b4c91', '#2d7187'];
  let hash = 0;
  for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length]!;
}

function encodePosition(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodePosition(value: string): Y.RelativePosition {
  const binary = atob(value);
  return Y.decodeRelativePosition(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function jumpToAnchor(view: EditorView, document: Y.Doc, text: Y.Text, anchor: CommentAnchorDto): void {
  const start = Y.createAbsolutePositionFromRelativePosition(decodePosition(anchor.start), document);
  const end = Y.createAbsolutePositionFromRelativePosition(decodePosition(anchor.end), document);
  if (!start || !end || start.type !== text || end.type !== text) return;
  view.dispatch({ selection: { anchor: start.index, head: end.index }, effects: EditorView.scrollIntoView(start.index, { y: 'center' }) });
  view.focus();
}

function jumpToSourceLine(view: EditorView, lineNumber: number, column: number): void {
  const line = view.state.doc.line(Math.min(Math.max(1, lineNumber), view.state.doc.lines));
  const position = Math.min(line.to, line.from + Math.max(0, column));
  view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
  view.focus();
}

export function CodeEditor({ projectId, fileId, user, readOnly, onStatus, onPresence, onRole, onAccessLost, onConnectionReset, onSelection, jumpRequest, sourceJumpRequest }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const documentRef = useRef<Y.Doc | null>(null);
  const textRef = useRef<Y.Text | null>(null);
  const statusHandler = useRef(onStatus);
  const presenceHandler = useRef(onPresence);
  const roleHandler = useRef(onRole);
  const accessHandler = useRef(onAccessLost);
  const resetHandler = useRef(onConnectionReset);
  const selectionHandler = useRef(onSelection);
  statusHandler.current = onStatus;
  presenceHandler.current = onPresence;
  roleHandler.current = onRole;
  accessHandler.current = onAccessLost;
  resetHandler.current = onConnectionReset;
  selectionHandler.current = onSelection;

  useEffect(() => {
    const view = viewRef.current; const document = documentRef.current; const text = textRef.current;
    if (!jumpRequest || !view || !document || !text) return;
    try { jumpToAnchor(view, document, text, jumpRequest.anchor); }
    catch { statusHandler.current('Comment anchor unavailable'); }
  }, [jumpRequest]);

  useEffect(() => {
    const view = viewRef.current;
    if (!sourceJumpRequest || !view) return;
    jumpToSourceLine(view, sourceJumpRequest.line, sourceJumpRequest.column);
  }, [sourceJumpRequest]);

  useEffect(() => {
    if (!host.current) return;
    const document = new Y.Doc();
    const text = document.getText('content');
    documentRef.current = document; textRef.current = text;
    const persistence = new IndexeddbPersistence(`texlyre:${projectId}:${fileId}`, document);
    const websocketUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/collaboration`;
    const provider = new HocuspocusProvider({
      url: websocketUrl,
      name: `${projectId}:${fileId}`,
      document,
      token: async () => {
        try {
          const credentials = await api<{ token: string; role: ProjectRole }>(`/api/projects/${projectId}/files/${fileId}/collaboration-token`, { method: 'POST' });
          roleHandler.current(credentials.role);
          return credentials.token;
        } catch (cause) {
          accessHandler.current(cause instanceof Error ? cause.message : 'Project access was removed');
          throw cause;
        }
      },
      flushDelay: 120,
      onStatus: ({ status }) => statusHandler.current(status === 'connected' ? 'Syncing…' : status === 'connecting' ? 'Reconnecting…' : 'Offline'),
      onSynced: ({ state }) => { if (state) statusHandler.current('Saved'); },
      onUnsyncedChanges: ({ number }) => statusHandler.current(number === 0 ? 'Saved' : 'Syncing…'),
      onAuthenticationFailed: ({ reason }) => statusHandler.current(reason || 'Access denied'),
      onClose: ({ event }) => {
        if (event.reason !== 'Reset Connection') return;
        void api<{ project: { role: ProjectRole } }>(`/api/projects/${projectId}`).then(({ project }) => {
          roleHandler.current(project.role);
          resetHandler.current();
        }).catch((cause) => accessHandler.current(cause instanceof Error ? cause.message : 'Project access was removed'));
      },
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
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet && !update.docChanged) return;
            const range = update.state.selection.main;
            const anchor = {
              start: encodePosition(Y.createRelativePositionFromTypeIndex(text, range.from)),
              end: encodePosition(Y.createRelativePositionFromTypeIndex(text, range.to)),
              quote: update.state.doc.sliceString(range.from, range.to).slice(0, 1000),
            };
            const coordinates = range.empty ? null : update.view.coordsAtPos(range.to);
            const bounds = host.current?.getBoundingClientRect();
            const actionPosition = coordinates && bounds ? {
              top: Math.min(Math.max(8, coordinates.bottom - bounds.top + 6), Math.max(8, bounds.height - 38)),
              left: Math.min(Math.max(8, coordinates.left - bounds.left), Math.max(8, bounds.width - 190)),
            } : null;
            selectionHandler.current(anchor, actionPosition);
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (jumpRequest) {
      try { jumpToAnchor(view, document, text, jumpRequest.anchor); }
      catch { statusHandler.current('Comment anchor unavailable'); }
    }
    if (sourceJumpRequest) jumpToSourceLine(view, sourceJumpRequest.line, sourceJumpRequest.column);
    const range = view.state.selection.main;
    selectionHandler.current({ start: encodePosition(Y.createRelativePositionFromTypeIndex(text, range.from)), end: encodePosition(Y.createRelativePositionFromTypeIndex(text, range.to)), quote: '' }, null);
    return () => {
      viewRef.current = null; documentRef.current = null; textRef.current = null;
      view.destroy();
      provider.destroy();
      void persistence.destroy();
      document.destroy();
      presenceHandler.current([]);
    };
  }, [fileId, projectId, readOnly, user.id, user.name]);

  return <div className="editor-host" ref={host} />;
}
