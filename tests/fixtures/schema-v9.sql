-- Frozen v0.3.0 delta. Apply after schema-v7.sql.
ALTER TABLE captures ADD COLUMN extractor_version TEXT;

CREATE TABLE assets (
  hash TEXT PRIMARY KEY
    CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  mime TEXT NOT NULL
    CHECK (mime IN ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif')),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE document_assets (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'ready', 'failed')),
  asset_hash TEXT REFERENCES assets(hash) ON DELETE RESTRICT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, source_url),
  CHECK ((status = 'ready' AND asset_hash IS NOT NULL) OR
         (status <> 'ready' AND asset_hash IS NULL))
);
CREATE INDEX document_assets_status ON document_assets(status, updated_at);
CREATE INDEX document_assets_hash ON document_assets(asset_hash)
  WHERE asset_hash IS NOT NULL;

CREATE TABLE asset_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  max_asset_bytes INTEGER NOT NULL DEFAULT 10485760
    CHECK (max_asset_bytes BETWEEN 1 AND 10485760),
  max_assets_per_document INTEGER NOT NULL DEFAULT 100
    CHECK (max_assets_per_document BETWEEN 1 AND 100),
  max_document_asset_bytes INTEGER NOT NULL DEFAULT 104857600
    CHECK (max_document_asset_bytes BETWEEN 1 AND 104857600),
  concurrency INTEGER NOT NULL DEFAULT 3 CHECK (concurrency BETWEEN 1 AND 3)
);
INSERT INTO asset_settings(
  id, max_asset_bytes, max_assets_per_document, max_document_asset_bytes, concurrency
) VALUES (1, 10485760, 100, 104857600, 3);

INSERT INTO schema_migrations(version, applied_at) VALUES
  (8, '2026-08-10T00:00:00.008Z'),
  (9, '2026-08-10T00:00:00.009Z');
