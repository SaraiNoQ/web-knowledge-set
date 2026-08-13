CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL UNIQUE,
  canonical_url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  markdown TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued', 'fetching', 'extracting', 'ready', 'failed')),
  warning TEXT,
  error_code TEXT,
  error_message TEXT,
  capture_mode TEXT CHECK (capture_mode IS NULL OR capture_mode IN ('http', 'browser')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title_edited INTEGER NOT NULL DEFAULT 0 CHECK (title_edited IN (0, 1)),
  markdown_edited INTEGER NOT NULL DEFAULT 0 CHECK (markdown_edited IN (0, 1)),
  final_url TEXT
);

CREATE TABLE captures (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetching', 'extracting', 'ready', 'failed')),
  mode TEXT CHECK (mode IS NULL OR mode IN ('http', 'browser')),
  http_status INTEGER,
  snapshot_path TEXT,
  warning TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  request_url TEXT,
  final_url TEXT,
  extracted_title TEXT,
  extracted_author TEXT,
  extracted_published_at TEXT,
  extracted_canonical_url TEXT,
  extracted_markdown TEXT
);

CREATE TABLE capture_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX capture_jobs_one_active
  ON capture_jobs(document_id) WHERE status IN ('queued', 'running');
CREATE INDEX capture_jobs_next ON capture_jobs(status, available_at, id);
CREATE INDEX captures_document ON captures(document_id, started_at DESC);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE
);

CREATE TABLE document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);
CREATE INDEX document_tags_tag ON document_tags(tag_id, document_id);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  markdown,
  source_url,
  content='documents',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, markdown, source_url)
  VALUES (new.rowid, new.title, new.markdown, new.source_url);
END;
CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, markdown, source_url)
  VALUES ('delete', old.rowid, old.title, old.markdown, old.source_url);
END;
CREATE TRIGGER documents_fts_update AFTER UPDATE OF title, markdown, source_url ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, markdown, source_url)
  VALUES ('delete', old.rowid, old.title, old.markdown, old.source_url);
  INSERT INTO documents_fts(rowid, title, markdown, source_url)
  VALUES (new.rowid, new.title, new.markdown, new.source_url);
END;

INSERT INTO schema_migrations(version, applied_at) VALUES
  (1, '2026-08-01T00:00:00.000Z'),
  (2, '2026-08-01T00:00:01.000Z'),
  (3, '2026-08-01T00:00:02.000Z');

INSERT INTO documents(
  id, source_url, title, markdown, status, capture_mode, revision,
  created_at, updated_at, markdown_edited, final_url
) VALUES (
  'legacy-document', 'https://example.com/from-v3', 'Legacy title',
  'Legacy edited body', 'ready', 'http', 3,
  '2026-08-01T01:02:03.000Z', '2026-08-01T02:03:04.000Z', 1,
  'https://example.com/from-v3'
);

INSERT INTO capture_jobs(
  id, document_id, status, attempts, available_at, created_at, updated_at
) VALUES (
  1, 'legacy-document', 'done', 1,
  '2026-08-01T01:02:03.000Z', '2026-08-01T01:02:03.000Z', '2026-08-01T01:02:04.000Z'
);

INSERT INTO captures(
  id, document_id, job_id, status, mode, http_status, started_at, finished_at,
  request_url, final_url, extracted_title, extracted_markdown
) VALUES (
  'legacy-capture', 'legacy-document', 1, 'ready', 'http', 200,
  '2026-08-01T01:02:03.000Z', '2026-08-01T01:02:04.000Z',
  'https://example.com/from-v3', 'https://example.com/from-v3',
  'Legacy title', 'Legacy captured body'
);

INSERT INTO tags(id, name) VALUES (1, 'Legacy');
INSERT INTO document_tags(document_id, tag_id) VALUES ('legacy-document', 1);
