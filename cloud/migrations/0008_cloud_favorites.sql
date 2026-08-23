ALTER TABLE cloud_documents
  ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1));

CREATE INDEX cloud_documents_favorite_updated
  ON cloud_documents(deleted_at, favorite, updated_at DESC, id);
