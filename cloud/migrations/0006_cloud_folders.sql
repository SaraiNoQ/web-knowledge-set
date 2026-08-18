CREATE TABLE cloud_folders (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE cloud_documents
  ADD COLUMN folder_id TEXT REFERENCES cloud_folders(id) ON DELETE SET NULL;

ALTER TABLE cloud_capture_jobs
  ADD COLUMN folder_id TEXT REFERENCES cloud_folders(id) ON DELETE SET NULL;

ALTER TABLE cloud_capture_jobs
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE INDEX cloud_documents_folder_updated ON cloud_documents(folder_id, updated_at DESC, id);
CREATE INDEX cloud_capture_jobs_folder_updated ON cloud_capture_jobs(folder_id, updated_at DESC, id);
