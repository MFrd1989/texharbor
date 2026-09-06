CREATE TABLE cloud_connections (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(30) NOT NULL,
  encrypted_refresh_token text NOT NULL,
  account_email varchar(254),
  account_name varchar(200),
  provider_folder_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  CONSTRAINT cloud_connections_provider_check CHECK (provider IN ('google_drive'))
);

CREATE TABLE oauth_states (
  state_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider varchar(30) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oauth_states_provider_check CHECK (provider IN ('google_drive'))
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);

CREATE TABLE backup_records (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  provider varchar(30) NOT NULL,
  provider_file_id text NOT NULL,
  file_name varchar(255) NOT NULL,
  source_hash char(64) NOT NULL,
  size bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_records_provider_check CHECK (provider IN ('google_drive')),
  UNIQUE (provider, provider_file_id)
);
CREATE INDEX backup_records_project_idx ON backup_records(project_id, created_at DESC);

CREATE TABLE project_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  kind varchar(30) NOT NULL,
  archive bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_versions_kind_check CHECK (kind IN ('pre_backup_restore'))
);
CREATE INDEX project_versions_project_idx ON project_versions(project_id, created_at DESC);
