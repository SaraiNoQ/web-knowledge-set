CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO app_settings (key, value) VALUES
  ('data_epoch', 'cloud-1'),
  ('onboarding', '{"completed":true}'),
  ('recent_filters', '[]');
