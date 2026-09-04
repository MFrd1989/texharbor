CREATE TABLE comment_threads (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  anchor jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open',
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comment_threads_status_check CHECK (status IN ('open', 'resolved'))
);
CREATE INDEX comment_threads_project_idx ON comment_threads(project_id, status, updated_at DESC);
CREATE INDEX comment_threads_file_idx ON comment_threads(file_id, updated_at DESC);

CREATE TABLE comments (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id),
  parent_comment_id uuid REFERENCES comments(id),
  body varchar(10000) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comments_thread_idx ON comments(thread_id, created_at);
