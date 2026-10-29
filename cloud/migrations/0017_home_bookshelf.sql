-- deployment: compatible

CREATE TABLE home_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE home_covers (hash TEXT PRIMARY KEY CHECK(length(hash)=64), mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>0));
CREATE TABLE home_presentations (
 document_id TEXT PRIMARY KEY REFERENCES cloud_documents(id) ON DELETE CASCADE,
 featured INTEGER NOT NULL CHECK(featured IN(0,1)), position INTEGER NOT NULL,
 cover_hash TEXT REFERENCES home_covers(hash), color TEXT NOT NULL, short_title TEXT NOT NULL,
 fit TEXT NOT NULL CHECK(fit IN('contain','cover'))
);
CREATE INDEX home_presentations_order ON home_presentations(featured,position,document_id);
