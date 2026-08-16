CREATE TABLE browser_extension_pairing_code (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  expires_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0 AND failures <= 5)
);

CREATE TABLE browser_extension_pairings (
  id TEXT PRIMARY KEY NOT NULL,
  browser TEXT NOT NULL CHECK (browser IN ('chrome', 'firefox')),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at TEXT NOT NULL
);

CREATE TABLE cloud_documents (
  id TEXT PRIMARY KEY NOT NULL,
  source_url TEXT NOT NULL,
  final_url TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  author TEXT,
  published_at TEXT,
  markdown TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'ready'),
  source_note TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX cloud_documents_updated ON cloud_documents(updated_at DESC);
