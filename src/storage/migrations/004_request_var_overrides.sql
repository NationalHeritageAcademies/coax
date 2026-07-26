-- Per-request variable overrides. Mirrors the `variables` table's secret
-- handling: plaintext rows have value_plain set; secret rows have an
-- encrypted blob in value_secret_blob. Each (request_id, key) is unique.

BEGIN;

CREATE TABLE request_var_overrides (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_plain TEXT,
  value_secret_blob BLOB,
  is_secret INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(request_id, key)
);

CREATE INDEX idx_request_var_overrides_request_id
  ON request_var_overrides(request_id);

UPDATE schema_version SET version = 4;

COMMIT;
