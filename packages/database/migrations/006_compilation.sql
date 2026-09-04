CREATE TABLE compile_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  status varchar(20) NOT NULL DEFAULT 'queued',
  compiler varchar(30) NOT NULL,
  main_file_path varchar(1000) NOT NULL,
  source_hash char(64) NOT NULL,
  exit_code integer,
  log text,
  artifact_path text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT compile_jobs_status_check CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT compile_jobs_compiler_check CHECK (compiler IN ('pdflatex', 'xelatex', 'lualatex'))
);
CREATE INDEX compile_jobs_project_idx ON compile_jobs(project_id, queued_at DESC);
CREATE INDEX compile_jobs_queue_idx ON compile_jobs(status, queued_at) WHERE status IN ('queued', 'running');

CREATE TABLE compile_job_files (
  job_id uuid NOT NULL REFERENCES compile_jobs(id) ON DELETE CASCADE,
  path varchar(1000) NOT NULL,
  content bytea NOT NULL,
  is_binary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (job_id, path)
);
