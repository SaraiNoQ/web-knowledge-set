-- deployment: compatible
CREATE TABLE cloud_tweet_video_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT UNIQUE NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  source_url TEXT NOT NULL,
  max_bytes INTEGER NOT NULL CHECK(max_bytes BETWEEN 1000000 AND 100000000),
  status TEXT NOT NULL CHECK(status IN ('queued','processing','ready','skipped','failed')),
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  uploaded_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(uploaded_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cloud_tweet_video_jobs_pending ON cloud_tweet_video_jobs(status, lease_until, created_at);
