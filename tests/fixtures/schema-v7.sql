PRAGMA foreign_keys = ON;

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
  final_url TEXT,
  deleted_at TEXT
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

CREATE INDEX documents_deleted_updated ON documents(deleted_at, updated_at DESC);

CREATE TABLE document_revisions (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, revision)
);
CREATE INDEX document_revisions_document
  ON document_revisions(document_id, revision DESC);

CREATE TABLE file_deletions (
  path TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE document_drafts (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  draft_revision INTEGER NOT NULL CHECK (draft_revision >= 1),
  base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE backup_records (
  id TEXT PRIMARY KEY,
  directory_name TEXT UNIQUE,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'automatic', 'pre-migration', 'pre-restore')),
  status TEXT NOT NULL CHECK (status IN ('creating', 'verified', 'failed', 'invalid', 'missing')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  verified_at TEXT,
  total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
  schema_version INTEGER CHECK (schema_version IS NULL OR schema_version >= 1),
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX backup_records_created ON backup_records(created_at DESC, id DESC);

CREATE TABLE backup_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automatic_retention_count INTEGER NOT NULL DEFAULT 7
    CHECK (automatic_retention_count BETWEEN 1 AND 100)
);

INSERT INTO schema_migrations(version, applied_at) VALUES
  (1, '2026-08-10T00:00:00.001Z'),
  (2, '2026-08-10T00:00:00.002Z'),
  (3, '2026-08-10T00:00:00.003Z'),
  (4, '2026-08-10T00:00:00.004Z'),
  (5, '2026-08-10T00:00:00.005Z'),
  (6, '2026-08-10T00:00:00.006Z'),
  (7, '2026-08-10T00:00:00.007Z');

INSERT INTO backup_settings(id, automatic_retention_count) VALUES (1, 7);

INSERT INTO documents(
  id, source_url, canonical_url, title, author, markdown, status, capture_mode,
  revision, created_at, updated_at, title_edited, markdown_edited, final_url
) VALUES (
  'release-document', 'https://example.com/schema-v7', 'https://example.com/schema-v7',
  'Frozen v7 document', 'Fixture Author', 'Frozen release schema body.', 'ready', 'http',
  2, '2026-08-10T01:00:00.000Z', '2026-08-10T01:01:00.000Z', 1, 1,
  'https://example.com/schema-v7'
);

INSERT INTO tags(id, name) VALUES (1, 'Fixture');
INSERT INTO document_tags(document_id, tag_id) VALUES ('release-document', 1);
INSERT INTO document_revisions(document_id, revision, title, markdown, tags_json, created_at)
VALUES (
  'release-document', 2, 'Frozen v7 document', 'Frozen release schema body.',
  '["Fixture"]', '2026-08-10T01:01:00.000Z'
);
