CREATE TABLE cloud_backups (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'pre-restore')),
  status TEXT NOT NULL CHECK (status IN ('verified', 'invalid', 'missing')),
  created_at TEXT NOT NULL,
  verified_at TEXT,
  total_bytes INTEGER,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  error_code TEXT
);

CREATE INDEX cloud_backups_created ON cloud_backups(created_at DESC);
