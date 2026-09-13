ALTER TABLE cloud_documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'article'
  CHECK (kind IN ('article', 'paper'));

CREATE TABLE cloud_paper_files (
  hash TEXT PRIMARY KEY NOT NULL CHECK (length(hash) = 64),
  mime TEXT NOT NULL CHECK (mime = 'application/pdf'),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE cloud_papers (
  id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('url', 'pdf')),
  source_url TEXT,
  original_file_name TEXT,
  source_hash TEXT NOT NULL REFERENCES cloud_paper_files(hash) ON DELETE RESTRICT,
  page_count INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued', 'extracting', 'ready', 'failed')),
  extraction_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cloud_paper_extractions (
  id TEXT PRIMARY KEY NOT NULL,
  paper_id TEXT NOT NULL REFERENCES cloud_papers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  model TEXT,
  endpoint_id TEXT,
  prompt_version TEXT,
  source_hash TEXT NOT NULL REFERENCES cloud_paper_files(hash) ON DELETE RESTRICT,
  page_count INTEGER,
  completed_pages INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX cloud_paper_extractions_paper ON cloud_paper_extractions(paper_id, created_at DESC);

CREATE TABLE cloud_paper_pages (
  paper_id TEXT NOT NULL REFERENCES cloud_papers(id) ON DELETE CASCADE,
  extraction_id TEXT NOT NULL REFERENCES cloud_paper_extractions(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  original_json TEXT NOT NULL,
  translation_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (extraction_id, page_number)
);

CREATE INDEX cloud_paper_pages_current ON cloud_paper_pages(paper_id, page_number);
