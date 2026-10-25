-- Large objects (up to 100 MB) are stored as 1 MB chunks; storage_objects keeps only the metadata row.
ALTER TABLE storage_objects ADD COLUMN chunk_version TEXT;
CREATE TABLE IF NOT EXISTS storage_chunks (
  object_key TEXT NOT NULL,
  version TEXT NOT NULL,
  idx INTEGER NOT NULL,
  body BLOB NOT NULL,
  PRIMARY KEY (object_key, version, idx)
) WITHOUT ROWID;
