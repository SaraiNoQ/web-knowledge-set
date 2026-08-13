-- Frozen v0.6.0 delta. Apply after schema-v13.sql.
CREATE TABLE derived_results (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('summary', 'outline', 'keywords', 'tag-suggestions')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  endpoint_id TEXT NOT NULL CHECK (length(endpoint_id) BETWEEN 1 AND 100),
  prompt_version TEXT NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 100),
  input_hash TEXT NOT NULL
    CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  output TEXT NOT NULL CHECK (length(output) BETWEEN 1 AND 2097152),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 86400000),
  usage_json TEXT CHECK (
    usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')
  ),
  source_chars INTEGER NOT NULL CHECK (source_chars BETWEEN 1 AND 10485760),
  sent_chars INTEGER NOT NULL CHECK (sent_chars BETWEEN 1 AND source_chars),
  truncated INTEGER NOT NULL CHECK (
    (truncated = 0 AND sent_chars = source_chars) OR
    (truncated = 1 AND sent_chars < source_chars)
  ),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (
    pinned IN (0, 1) AND (pinned = 0 OR type = 'summary')
  ),
  created_at TEXT NOT NULL,
  UNIQUE(document_id, type, model, endpoint_id, prompt_version, input_hash)
);
CREATE INDEX derived_results_document_created
  ON derived_results(document_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX derived_results_one_pinned_summary
  ON derived_results(document_id) WHERE type = 'summary' AND pinned = 1;

CREATE TRIGGER derived_results_immutable
BEFORE UPDATE OF id, document_id, type, model, endpoint_id, prompt_version,
                 input_hash, output, duration_ms, usage_json, source_chars,
                 sent_chars, truncated, created_at
ON derived_results BEGIN
  SELECT RAISE(ABORT, 'derived results are immutable');
END;

INSERT INTO schema_migrations(version, applied_at)
VALUES (14, '2026-08-10T00:00:00.014Z');
