CREATE TABLE cloud_semantic_indexes (
  document_id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  model TEXT NOT NULL,
  format_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'indexing', 'ready', 'failed')),
  chunk_total INTEGER NOT NULL DEFAULT 0 CHECK (chunk_total >= 0),
  chunk_done INTEGER NOT NULL DEFAULT 0 CHECK (chunk_done >= 0 AND chunk_done <= chunk_total),
  vector_json TEXT CHECK (vector_json IS NULL OR json_valid(vector_json)),
  lease_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX cloud_semantic_indexes_state ON cloud_semantic_indexes(state, updated_at, document_id);

CREATE TABLE cloud_semantic_chunks (
  document_id TEXT NOT NULL REFERENCES cloud_semantic_indexes(document_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  page_number INTEGER CHECK (page_number IS NULL OR page_number >= 1),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  text_hash TEXT NOT NULL CHECK (length(text_hash) = 64),
  vector_json TEXT NOT NULL CHECK (json_valid(vector_json)),
  PRIMARY KEY (document_id, chunk_index)
);

INSERT INTO app_settings(key, value, revision, updated_at)
VALUES ('semantic_settings', '{"enabled":false,"model":"BAAI/bge-m3"}', 1, CURRENT_TIMESTAMP);
