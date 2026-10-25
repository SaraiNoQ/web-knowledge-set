-- deployment: compatible
CREATE TABLE reading_annotations (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,
 source_revision INTEGER NOT NULL, anchor_json TEXT NOT NULL CHECK(json_valid(anchor_json)),
 note TEXT NOT NULL, translation TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX reading_annotations_document ON reading_annotations(document_id, created_at);
CREATE TABLE document_connections (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE, note TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(source_id < target_id), UNIQUE(source_id, target_id)
);
CREATE INDEX document_connections_target ON document_connections(target_id);
