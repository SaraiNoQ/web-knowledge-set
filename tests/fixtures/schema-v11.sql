-- Frozen v0.4.0 delta. Apply after schema-v9.sql.
ALTER TABLE documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0
  CHECK (favorite IN (0, 1));
ALTER TABLE documents ADD COLUMN archived_at TEXT;
ALTER TABLE documents ADD COLUMN source_note TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN author_edited INTEGER NOT NULL DEFAULT 0
  CHECK (author_edited IN (0, 1));
ALTER TABLE documents ADD COLUMN published_at_edited INTEGER NOT NULL DEFAULT 0
  CHECK (published_at_edited IN (0, 1));
CREATE INDEX documents_archive_favorite_updated
  ON documents(deleted_at, archived_at, favorite, updated_at DESC);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE document_collections (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, collection_id)
);
CREATE INDEX document_collections_collection
  ON document_collections(collection_id, document_id);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL
);

INSERT INTO schema_migrations(version, applied_at) VALUES
  (10, '2026-08-10T00:00:00.010Z'),
  (11, '2026-08-10T00:00:00.011Z');
