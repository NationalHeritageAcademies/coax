-- App-wide key/value settings.
--
-- This is intentionally a flat key/value table rather than a typed schema
-- per setting: app-wide settings are small in number, evolve fast, and we
-- want to add new keys without paying the migration tax. Reads and writes
-- go through the AppSettings repo, which provides typed accessors per key.

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

UPDATE schema_version SET version = 5;
