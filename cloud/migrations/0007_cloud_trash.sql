ALTER TABLE cloud_documents
  ADD COLUMN deleted_at TEXT;

ALTER TABLE cloud_capture_jobs
  ADD COLUMN deleted_at TEXT;

CREATE INDEX cloud_documents_trash_updated ON cloud_documents(deleted_at, updated_at DESC, id);
CREATE INDEX cloud_capture_jobs_trash_updated ON cloud_capture_jobs(deleted_at, updated_at DESC, id);
