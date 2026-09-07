ALTER TABLE backup_records DROP CONSTRAINT backup_records_provider_check;
ALTER TABLE backup_records ALTER COLUMN provider_file_id DROP NOT NULL;
ALTER TABLE backup_records ALTER COLUMN source_hash DROP NOT NULL;
ALTER TABLE backup_records ADD COLUMN archive bytea;
ALTER TABLE backup_records ADD COLUMN kind varchar(30) NOT NULL DEFAULT 'manual';

ALTER TABLE backup_records
  ADD CONSTRAINT backup_records_provider_check CHECK (provider IN ('local', 'google_drive')),
  ADD CONSTRAINT backup_records_kind_check CHECK (kind IN ('manual', 'scheduled', 'pre_restore')),
  ADD CONSTRAINT backup_records_payload_check CHECK (
    (provider = 'local' AND provider_file_id IS NULL AND archive IS NOT NULL)
    OR (provider = 'google_drive' AND provider_file_id IS NOT NULL AND archive IS NULL)
  );

INSERT INTO backup_records (
  id, project_id, created_by, provider, provider_file_id, file_name,
  source_hash, size, created_at, archive, kind
)
SELECT
  id, project_id, created_by, 'local', NULL,
  'Safety checkpoint ' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC.texharbor.zip',
  NULL, octet_length(archive), created_at, archive, 'pre_restore'
FROM project_versions
ON CONFLICT (id) DO NOTHING;

DROP TABLE project_versions;

CREATE TABLE backup_schedules (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  enabled boolean NOT NULL DEFAULT false,
  destination varchar(30) NOT NULL DEFAULT 'local',
  interval_hours integer NOT NULL DEFAULT 24,
  retention_count integer NOT NULL DEFAULT 20,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_schedules_destination_check CHECK (destination IN ('local', 'google_drive', 'both')),
  CONSTRAINT backup_schedules_interval_check CHECK (interval_hours IN (1, 6, 12, 24, 168)),
  CONSTRAINT backup_schedules_retention_check CHECK (retention_count BETWEEN 2 AND 100),
  CONSTRAINT backup_schedules_next_run_check CHECK ((enabled AND next_run_at IS NOT NULL) OR (NOT enabled AND next_run_at IS NULL))
);

CREATE INDEX backup_schedules_due_idx ON backup_schedules(next_run_at) WHERE enabled;
CREATE INDEX backup_records_retention_idx ON backup_records(project_id, provider, kind, created_at DESC);
