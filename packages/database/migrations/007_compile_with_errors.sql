ALTER TABLE compile_jobs DROP CONSTRAINT compile_jobs_status_check;
ALTER TABLE compile_jobs ALTER COLUMN status TYPE varchar(24);
ALTER TABLE compile_jobs ADD CONSTRAINT compile_jobs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'completed_with_errors', 'failed'));
