-- Frozen v0.5.0 delta. Apply after schema-v11.sql.
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('urls', 'bookmarks', 'markdown')),
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied')),
  strategy TEXT CHECK (strategy IS NULL OR strategy IN ('skip', 'copy', 'update')),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  source_url TEXT,
  preview_status TEXT NOT NULL CHECK (preview_status IN ('valid', 'duplicate', 'invalid')),
  existing_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  expected_revision INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  payload_json TEXT NOT NULL,
  result_status TEXT CHECK (result_status IS NULL OR result_status IN ('created', 'updated', 'skipped', 'conflict', 'failed')),
  result_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  result_error TEXT,
  UNIQUE(batch_id, item_index)
);
CREATE INDEX import_items_batch ON import_items(batch_id, item_index);

ALTER TABLE import_items RENAME TO import_items_v12;
ALTER TABLE import_batches RENAME TO import_batches_v12;
DROP INDEX import_items_batch;

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('urls', 'bookmarks', 'markdown', 'bundle')),
  status TEXT NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied')),
  strategy TEXT CHECK (strategy IS NULL OR strategy IN ('skip', 'copy', 'update')),
  staging_path TEXT,
  asset_count INTEGER NOT NULL DEFAULT 0 CHECK (asset_count >= 0),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  source_url TEXT,
  preview_status TEXT NOT NULL CHECK (preview_status IN ('valid', 'duplicate', 'invalid')),
  existing_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  expected_revision INTEGER,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  payload_json TEXT NOT NULL,
  result_status TEXT CHECK (result_status IS NULL OR result_status IN ('created', 'updated', 'skipped', 'conflict', 'failed')),
  result_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  result_error TEXT,
  UNIQUE(batch_id, item_index)
);

INSERT INTO import_batches(id, kind, status, strategy, created_at, applied_at)
  SELECT id, kind, status, strategy, created_at, applied_at FROM import_batches_v12;
INSERT INTO import_items SELECT * FROM import_items_v12;
DROP TABLE import_items_v12;
DROP TABLE import_batches_v12;
CREATE INDEX import_items_batch ON import_items(batch_id, item_index);

INSERT INTO schema_migrations(version, applied_at) VALUES
  (12, '2026-08-10T00:00:00.012Z'),
  (13, '2026-08-10T00:00:00.013Z');
