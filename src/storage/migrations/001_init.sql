PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE collections (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  parent_collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  sort_order           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE folders (
  id                TEXT PRIMARY KEY,
  collection_id     TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_folder_id  TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE requests (
  id            TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  method        TEXT NOT NULL,
  url           TEXT NOT NULL,
  headers_json  TEXT NOT NULL DEFAULT '[]',
  body_text     TEXT NOT NULL DEFAULT '',
  body_kind     TEXT NOT NULL DEFAULT 'none',
  auth_json     TEXT NOT NULL DEFAULT '{"kind":"none"}',
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','collection')),
  scope_id   TEXT,
  name       TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE variables (
  id                TEXT PRIMARY KEY,
  env_id            TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  value_plain       TEXT,
  value_secret_blob BLOB,
  is_secret         INTEGER NOT NULL DEFAULT 0,
  description       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE last_responses (
  request_id   TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  status       INTEGER,
  headers_json TEXT,
  body_blob    BLOB,
  ms           INTEGER,
  size_bytes   INTEGER,
  executed_at  TEXT,
  error_text   TEXT
);

CREATE TABLE open_tabs (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_pinned   INTEGER NOT NULL DEFAULT 0,
  is_dirty    INTEGER NOT NULL DEFAULT 0,
  draft_json  TEXT
);

CREATE TABLE http_files (
  id                TEXT PRIMARY KEY,
  collection_id     TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  path              TEXT NOT NULL,
  last_imported_at  TEXT NOT NULL,
  hash              TEXT NOT NULL
);

INSERT INTO schema_version (version) VALUES (1);
