CREATE TABLE cloud_capture_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX cloud_capture_jobs_updated ON cloud_capture_jobs(updated_at DESC);
