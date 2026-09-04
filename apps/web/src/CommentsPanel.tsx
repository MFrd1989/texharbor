import { useCallback, useEffect, useState } from 'react';
import type { CommentAnchorDto, CommentThreadDto, ProjectRole, UserDto } from '@texlyre/contracts';
import { api } from './api';

type Props = {
  projectId: string;
  fileId: string | null;
  selection: CommentAnchorDto | null;
  user: UserDto;
  role: ProjectRole;
  onClose: () => void;
  onJump: (thread: CommentThreadDto) => void;
};

export function CommentsPanel({ projectId, fileId, selection, user, role, onClose, onJump }: Props) {
  const [threads, setThreads] = useState<CommentThreadDto[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setThreads((await api<{ threads: CommentThreadDto[] }>(`/api/projects/${projectId}/comments`)).threads); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load comments'); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!fileId || !selection) return;
    const body = String(new FormData(event.currentTarget).get('body') || '');
    try {
      await api(`/api/projects/${projectId}/comments`, { method: 'POST', body: JSON.stringify({ fileId, anchor: selection, body }) });
      setComposing(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create comment'); }
  };

  const reply = async (event: React.FormEvent<HTMLFormElement>, thread: CommentThreadDto) => {
    event.preventDefault(); const form = event.currentTarget;
    const body = String(new FormData(form).get('body') || '');
    const parentCommentId = thread.comments.at(-1)?.id;
    try { await api(`/api/projects/${projectId}/comments/${thread.id}/replies`, { method: 'POST', body: JSON.stringify({ body, parentCommentId }) }); form.reset(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reply'); }
  };

  const setStatus = async (thread: CommentThreadDto) => {
    const status = thread.status === 'open' ? 'resolved' : 'open';
    try { await api(`/api/projects/${projectId}/comments/${thread.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update thread'); }
  };

  const deleteThread = async (thread: CommentThreadDto) => {
    if (!confirm('Delete this comment thread?')) return;
    try { await api(`/api/projects/${projectId}/comments/${thread.id}`, { method: 'DELETE' }); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete thread'); }
  };

  const visible = threads.filter((thread) => showResolved || thread.status === 'open');
  return <aside className="comments-panel" aria-label="Comments">
    <header><div><strong>Comments</strong><small>{threads.filter((thread) => thread.status === 'open').length} open</small></div><button aria-label="Close comments" onClick={onClose}>×</button></header>
    <div className="comments-toolbar"><button className="primary" disabled={!fileId || !selection} onClick={() => setComposing(true)}>＋ New comment</button><label><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} /> Resolved</label><button aria-label="Refresh comments" onClick={() => void load()}>↻</button></div>
    {composing && <form className="comment-compose" onSubmit={create}>{selection?.quote && <blockquote>{selection.quote}</blockquote>}<textarea name="body" aria-label="Comment" rows={3} required maxLength={10000} autoFocus placeholder="Leave a comment on the current cursor or selection…" /><div><button type="button" onClick={() => setComposing(false)}>Cancel</button><button className="primary">Comment</button></div></form>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="thread-list">{visible.length === 0 ? <p className="comments-empty">No {showResolved ? '' : 'open '}comments.</p> : visible.map((thread) => <article className={`comment-thread ${thread.status}`} key={thread.id}>
      <header><button className="thread-location" onClick={() => onJump(thread)}>{thread.filePath}{thread.anchor.quote ? ` · “${thread.anchor.quote.slice(0, 50)}”` : ''}</button><span>{thread.status}</span></header>
      {thread.comments.map((comment) => <div className="comment-message" key={comment.id}><div><strong>{comment.authorName}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></div><p>{comment.body}</p></div>)}
      <form className="reply-form" onSubmit={(event) => void reply(event, thread)}><input name="body" aria-label={`Reply to comment in ${thread.filePath}`} required maxLength={10000} placeholder="Reply…" /><button>Send</button></form>
      <footer><button onClick={() => void setStatus(thread)}>{thread.status === 'open' ? 'Resolve' : 'Reopen'}</button>{(role === 'owner' || thread.createdBy === user.id) && <button className="danger" onClick={() => void deleteThread(thread)}>Delete thread</button>}</footer>
    </article>)}</div>
  </aside>;
}
