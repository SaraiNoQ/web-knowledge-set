-- deployment: compatible

CREATE TABLE study_topics(id TEXT PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE study_topic_documents(topic_id TEXT NOT NULL REFERENCES study_topics(id) ON DELETE CASCADE,document_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,PRIMARY KEY(topic_id,document_id));
CREATE INDEX study_topic_documents_document ON study_topic_documents(document_id);
CREATE TABLE study_topic_annotations(topic_id TEXT NOT NULL REFERENCES study_topics(id) ON DELETE CASCADE,annotation_id TEXT NOT NULL REFERENCES reading_annotations(id) ON DELETE CASCADE,PRIMARY KEY(topic_id,annotation_id));
CREATE TABLE study_progress(document_id TEXT PRIMARY KEY REFERENCES cloud_documents(id) ON DELETE CASCADE,document_revision INTEGER NOT NULL,revision INTEGER NOT NULL,fraction REAL NOT NULL CHECK(fraction>=0 AND fraction<=1),anchor_json TEXT CHECK(anchor_json IS NULL OR json_valid(anchor_json)),is_read INTEGER NOT NULL CHECK(is_read IN (0,1)),updated_at TEXT NOT NULL);
CREATE TABLE study_reviews(annotation_id TEXT PRIMARY KEY REFERENCES reading_annotations(id) ON DELETE CASCADE,due_at TEXT NOT NULL,interval_days INTEGER NOT NULL DEFAULT 0,repetitions INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE study_document_tags(document_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(document_id,tag));
CREATE TABLE study_source_checks(document_id TEXT PRIMARY KEY REFERENCES cloud_documents(id) ON DELETE CASCADE,source_revision INTEGER NOT NULL,url TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,checked_at TEXT NOT NULL,message TEXT NOT NULL);
CREATE TABLE study_merge_history(id TEXT PRIMARY KEY,keep_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,source_id TEXT NOT NULL REFERENCES cloud_documents(id) ON DELETE CASCADE,before_keep_json TEXT NOT NULL CHECK(json_valid(before_keep_json)),before_source_json TEXT NOT NULL CHECK(json_valid(before_source_json)),after_keep_revision INTEGER NOT NULL,after_source_revision INTEGER NOT NULL,undone INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE study_fingerprints(document_id TEXT PRIMARY KEY REFERENCES cloud_documents(id) ON DELETE CASCADE,source_revision INTEGER NOT NULL,fingerprint_json TEXT NOT NULL CHECK(json_valid(fingerprint_json)));
CREATE TABLE reading_connection_evidence (
 connection_id TEXT PRIMARY KEY REFERENCES document_connections(id) ON DELETE CASCADE,
 source_annotation_id TEXT REFERENCES reading_annotations(id) ON DELETE SET NULL,
 target_annotation_id TEXT REFERENCES reading_annotations(id) ON DELETE SET NULL,
 relation_type TEXT NOT NULL CHECK(relation_type IN ('manual','citation')),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
