CREATE TABLE collaboration_documents (
  document_name varchar(200) PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  state bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, file_id)
);

