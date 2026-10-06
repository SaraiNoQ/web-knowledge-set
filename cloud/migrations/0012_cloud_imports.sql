CREATE TABLE cloud_import_batches (
  id TEXT PRIMARY KEY NOT NULL,
  epoch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  strategy TEXT CHECK (strategy IN ('skip', 'copy', 'update')),
  expires_at INTEGER NOT NULL
);
CREATE TABLE cloud_import_items (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES cloud_import_batches(id) ON DELETE CASCADE,
  item_index INTEGER NOT NULL,
  label TEXT NOT NULL,
  source_url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  existing_id TEXT,
  existing_revision INTEGER,
  error TEXT,
  warnings_json TEXT NOT NULL,
  result_json TEXT
);
CREATE INDEX cloud_import_items_batch ON cloud_import_items(batch_id, item_index);
