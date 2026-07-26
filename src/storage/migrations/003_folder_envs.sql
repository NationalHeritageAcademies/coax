-- Folder-scoped environments: drop the global/collection scope discriminator
-- and attach envs to folders instead. Every collection gets an implicit root
-- folder; existing collection-scoped envs move to that root. Existing global
-- envs are dropped (user authorized at design time).

BEGIN;

-- 1. New nullable column on collections pointing at the root folder.
ALTER TABLE collections ADD COLUMN root_folder_id TEXT;

-- 2. Create a (root) folder per collection.
INSERT INTO folders (id, collection_id, parent_folder_id, name, sort_order)
SELECT lower(hex(randomblob(16))), id, NULL, '(root)', -1
FROM collections;

-- 3. Backfill collections.root_folder_id.
UPDATE collections
SET root_folder_id = (
  SELECT f.id
  FROM folders f
  WHERE f.collection_id = collections.id
    AND f.name = '(root)'
    AND f.parent_folder_id IS NULL
  LIMIT 1
);

-- 4. Reparent all existing top-level folders under the new root folder.
-- Excludes the root folders themselves.
UPDATE folders
SET parent_folder_id = (
  SELECT root_folder_id
  FROM collections
  WHERE collections.id = folders.collection_id
)
WHERE parent_folder_id IS NULL AND name != '(root)';

-- 5. Add folder_id to environments.
ALTER TABLE environments ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE;

-- 6. Map collection-scoped envs to their collection's root folder.
UPDATE environments
SET folder_id = (
  SELECT root_folder_id
  FROM collections
  WHERE collections.id = environments.scope_id
)
WHERE scope_kind = 'collection';

-- 7. Drop global envs and their vars (FK cascade). User authorized at design.
DELETE FROM environments WHERE scope_kind = 'global';

-- 8. Remove scope columns. better-sqlite3 11.x ships SQLite 3.45+ which
-- supports ALTER TABLE DROP COLUMN.
ALTER TABLE environments DROP COLUMN scope_kind;
ALTER TABLE environments DROP COLUMN scope_id;

UPDATE schema_version SET version = 3;

COMMIT;
