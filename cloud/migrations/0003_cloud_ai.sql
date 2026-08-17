INSERT INTO app_settings(key, value)
VALUES ('llm_settings', '{"enabled":false,"target":"remote","remote":{"endpointUrl":"https://api.openai.com/v1/chat/completions","model":""},"local":{"endpointUrl":"","model":"","trusted":false}}');

CREATE TABLE cloud_derived_results (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('summary', 'outline', 'keywords', 'translation')),
  target_language TEXT,
  model TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  usage_json TEXT,
  source_chars INTEGER NOT NULL,
  sent_chars INTEGER NOT NULL,
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  source_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX cloud_derived_results_document ON cloud_derived_results(document_id, created_at DESC);
