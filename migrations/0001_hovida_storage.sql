-- HOVIDA D1 object store for the preview (no R2 dependency).
-- Note: D1 is not designed for large binary files; application upload limits
-- must be kept conservative and verified against Cloudflare D1 query limits.
CREATE TABLE IF NOT EXISTS storage_objects (
  object_key TEXT PRIMARY KEY NOT NULL,
  body BLOB NOT NULL,
  size_bytes INTEGER NOT NULL,
  etag TEXT NOT NULL,
  md5 TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_storage_objects_key ON storage_objects(object_key);
