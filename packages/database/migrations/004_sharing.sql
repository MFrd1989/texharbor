CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  inviter_id uuid NOT NULL REFERENCES users(id),
  email citext NOT NULL,
  role varchar(20) NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  CONSTRAINT invitations_role_check CHECK (role IN ('editor', 'viewer')),
  CONSTRAINT invitations_status_check CHECK (status IN ('pending', 'accepted', 'rejected', 'revoked', 'expired'))
);
CREATE UNIQUE INDEX invitations_pending_email_idx ON invitations(project_id, email) WHERE status = 'pending';
CREATE INDEX invitations_email_idx ON invitations(email, status);

