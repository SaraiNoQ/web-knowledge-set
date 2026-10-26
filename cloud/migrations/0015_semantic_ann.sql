-- deployment: compatible

CREATE TABLE cloud_semantic_ann (
 document_id TEXT PRIMARY KEY REFERENCES cloud_semantic_indexes(document_id) ON DELETE CASCADE,
 source_hash TEXT NOT NULL,model TEXT NOT NULL,format_version TEXT NOT NULL,
 ann_version TEXT NOT NULL,dimension INTEGER NOT NULL,signature TEXT NOT NULL,quantized TEXT NOT NULL
);
