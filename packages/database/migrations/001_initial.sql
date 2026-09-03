CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  name varchar(100) NOT NULL,
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  name varchar(200) NOT NULL,
  description varchar(2000) NOT NULL DEFAULT '',
  main_file_path varchar(1000) NOT NULL DEFAULT '/main.tex',
  compiler varchar(30) NOT NULL DEFAULT 'pdflatex',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT projects_compiler_check CHECK (compiler IN ('pdflatex', 'xelatex', 'lualatex', 'typst'))
);
CREATE INDEX projects_owner_id_idx ON projects(owner_id);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_members_role_check CHECK (role IN ('owner', 'editor', 'viewer'))
);
CREATE INDEX project_members_user_id_idx ON project_members(user_id);

CREATE TABLE project_files (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path varchar(1000) NOT NULL,
  kind varchar(20) NOT NULL,
  mime_type varchar(255),
  content bytea,
  size bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path),
  CONSTRAINT project_files_kind_check CHECK (kind IN ('file', 'directory')),
  CONSTRAINT project_files_content_check CHECK ((kind = 'directory' AND content IS NULL) OR kind = 'file')
);
CREATE INDEX project_files_project_id_idx ON project_files(project_id);

CREATE TABLE activity (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  action varchar(80) NOT NULL,
  target_type varchar(40),
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_project_created_idx ON activity(project_id, created_at DESC);

