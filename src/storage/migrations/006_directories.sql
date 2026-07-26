-- Workspace directories. Promotes the on-disk directory structure to the
-- source of truth for collection grouping. Each workspace gets a root
-- directory (name=''); each subdirectory under the workspace root becomes a
-- directories row; each .http file becomes a collection whose directory_id
-- points at its containing directory.
--
-- Old shape: collections nest via `parent_collection_id`; file paths live
-- in `http_files.path`.
-- New shape: collections live IN a directory (directory_id); the on-disk
-- path is derived from `directory.path + collection.name + '.http'`, not
-- stored.
--
-- The structural promotion in this migration: every collection that had
-- children under the old model becomes its own directory (the collection's
-- own requests still live, but in a .http file inside that directory).
-- Disk-side file moves can't happen here — pure SQL has no filesystem
-- access — so we stash the old paths in `_migration_006_paths` for the
-- workspace bootstrap to consume and clear on first open under this schema.

BEGIN;

CREATE TABLE directories (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_directory_id   TEXT REFERENCES directories(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX directories_workspace_idx ON directories(workspace_id);
CREATE INDEX directories_parent_idx ON directories(parent_directory_id);

ALTER TABLE collections ADD COLUMN directory_id TEXT REFERENCES directories(id) ON DELETE SET NULL;

-- Env files (`.env.json`) now live in directories, not next to specific
-- `.http` files. An environment row can therefore attach to a folder
-- (collection-internal — for inline @vars at the top of a .http) OR to a
-- directory (the .env.json sitting next to one or more collections). Exactly
-- one of folder_id / directory_id is set per row; the cascade walker
-- consumes both. folder_id stays nullable from migration 003.
ALTER TABLE environments ADD COLUMN directory_id TEXT REFERENCES directories(id) ON DELETE CASCADE;

CREATE INDEX environments_directory_idx ON environments(directory_id);

-- Scratch table: carries (collection_id → old file path) across to the
-- bootstrap, which moves files on disk to match the new directory tree
-- and then DROPs this table. Presence of the table is itself the "disk
-- migration pending" flag.
CREATE TABLE _migration_006_paths (
  collection_id TEXT PRIMARY KEY,
  old_path      TEXT NOT NULL
);

INSERT INTO _migration_006_paths (collection_id, old_path)
SELECT collection_id, path FROM http_files;

-- 1. One root directory per workspace. Deterministic id so the bootstrap
-- code can find it without an extra query.
INSERT INTO directories (id, workspace_id, parent_directory_id, name, sort_order)
SELECT 'ws-root-' || id, id, NULL, '', 0
FROM workspaces;

-- 2. For every collection that has children (i.e., its id appears as
-- some other collection's parent_collection_id), create a directory. The
-- directory's name MUST match the slugged on-disk folder it'll back so
-- that subsequent workspace re-adoption finds the existing directory row
-- instead of creating a duplicate. The slug is the same `lower + collapse
-- non-alnum to hyphens + trim` rule used by paths.ts::slug, implemented
-- here in pure SQL via nested replace() calls covering the common chars
-- (space, underscore, dot, slash) plus a fallback collapse pass.
INSERT INTO directories (id, workspace_id, parent_directory_id, name, sort_order)
SELECT
  'dir-' || c.id,
  c.workspace_id,
  NULL,
  -- trim leading/trailing hyphens after collapsing common separators
  trim(
    replace(
      replace(
        replace(
          replace(
            replace(lower(c.name), ' ', '-'),
            '_', '-'),
          '.', '-'),
        '/', '-'),
      '--', '-'),
    '-'),
  c.sort_order
FROM collections c
WHERE EXISTS (SELECT 1 FROM collections c2 WHERE c2.parent_collection_id = c.id);

-- 3. Wire up parent_directory_id for each created "promoted" directory.
-- If the old collection had a parent_collection_id that itself became
-- a directory, point at that. Otherwise the directory lives at the
-- workspace root.
UPDATE directories
SET parent_directory_id = COALESCE(
  (SELECT 'dir-' || c.parent_collection_id
     FROM collections c
    WHERE 'dir-' || c.id = directories.id
      AND c.parent_collection_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM collections c3 WHERE c3.id = c.parent_collection_id)),
  'ws-root-' || directories.workspace_id
)
WHERE id LIKE 'dir-%' AND parent_directory_id IS NULL;

-- 4. Place every collection inside its containing directory.
--    Has children → lives in its own promoted directory.
--    Has a parent → lives in the parent's promoted directory.
--    Otherwise   → lives at the workspace root.
UPDATE collections
SET directory_id = CASE
  WHEN EXISTS (SELECT 1 FROM collections c2 WHERE c2.parent_collection_id = collections.id)
    THEN 'dir-' || collections.id
  WHEN collections.parent_collection_id IS NOT NULL
    THEN 'dir-' || collections.parent_collection_id
  ELSE 'ws-root-' || collections.workspace_id
END;

-- 5. Old columns gone. SQLite 3.45+ supports DROP COLUMN.
ALTER TABLE collections DROP COLUMN parent_collection_id;
ALTER TABLE http_files DROP COLUMN path;

UPDATE schema_version SET version = 6;

COMMIT;
