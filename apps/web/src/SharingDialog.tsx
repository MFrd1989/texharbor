import { useCallback, useEffect, useState } from 'react';
import type { CollaboratorDto, InvitationDto, ProjectRole } from '@texlyre/contracts';
import { api } from './api';

type CreatedInvitation = InvitationDto & { url: string };

export function SharingDialog({ projectId, role, onClose }: { projectId: string; role: ProjectRole; onClose: () => void }) {
  const [collaborators, setCollaborators] = useState<CollaboratorDto[]>([]);
  const [invitations, setInvitations] = useState<InvitationDto[]>([]);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const members = await api<{ collaborators: CollaboratorDto[] }>(`/api/projects/${projectId}/collaborators`);
      setCollaborators(members.collaborators);
      if (role === 'owner') {
        const pending = await api<{ invitations: InvitationDto[] }>(`/api/projects/${projectId}/invitations`);
        setInvitations(pending.invitations);
      }
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load collaborators');
    }
  }, [projectId, role]);

  useEffect(() => { void load(); }, [load]);

  const invite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true); setError(''); setCreated(null); setCopied(false);
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await api<{ invitation: CreatedInvitation }>(`/api/projects/${projectId}/invitations`, { method: 'POST', body: JSON.stringify(body) });
      setCreated(result.invitation);
      form.reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create invitation');
    } finally { setBusy(false); }
  };

  const changeRole = async (userId: string, nextRole: 'editor' | 'viewer') => {
    try {
      await api(`/api/projects/${projectId}/collaborators/${userId}`, { method: 'PATCH', body: JSON.stringify({ role: nextRole }) });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change role'); }
  };

  const remove = async (member: CollaboratorDto) => {
    if (!confirm(`Remove ${member.name} from this project?`)) return;
    try {
      await api(`/api/projects/${projectId}/collaborators/${member.id}`, { method: 'DELETE' });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove collaborator'); }
  };

  const revoke = async (invitationId: string) => {
    try {
      await api(`/api/projects/${projectId}/invitations/${invitationId}`, { method: 'DELETE' });
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not revoke invitation'); }
  };

  const copyLink = async () => {
    if (!created) return;
    try { await navigator.clipboard.writeText(created.url); setCopied(true); }
    catch { setError('Your browser blocked clipboard access. Select and copy the link manually.'); }
  };

  const pending = invitations.filter((invitation) => invitation.status === 'pending');
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <header><div><p className="eyebrow">PROJECT ACCESS</p><h2 id="share-title">Share project</h2></div><button aria-label="Close sharing" onClick={onClose}>×</button></header>
      {role === 'owner' && <form className="invite-form" onSubmit={invite}>
        <label>Email address<input name="email" type="email" required autoComplete="email" placeholder="collaborator@example.com" /></label>
        <label>Role<select name="role" defaultValue="editor"><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label>
        <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create invitation'}</button>
      </form>}
      {created && <div className="invite-link" role="status"><strong>Invitation created</strong><p>This link is shown once. Send it securely to {created.email}.</p><div><input aria-label="Invitation link" readOnly value={created.url} onFocus={(event) => event.currentTarget.select()} /><button onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy link'}</button></div></div>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="member-list"><h3>People with access</h3>{collaborators.map((member) => <article key={member.id}>
        <span className="member-avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}</strong><small>{member.email}</small></div>
        {role === 'owner' && member.role !== 'owner' ? <><select aria-label={`Role for ${member.name}`} value={member.role} onChange={(event) => void changeRole(member.id, event.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><button className="danger compact" onClick={() => void remove(member)}>Remove</button></> : <span className="member-role">{member.role}</span>}
      </article>)}</div>
      {role === 'owner' && pending.length > 0 && <div className="pending-list"><h3>Pending invitations</h3>{pending.map((invitation) => <article key={invitation.id}><div><strong>{invitation.email}</strong><small>{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleDateString()}</small></div><button className="danger compact" onClick={() => void revoke(invitation.id)}>Revoke</button></article>)}</div>}
    </section>
  </div>;
}
