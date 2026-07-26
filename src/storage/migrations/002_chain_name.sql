ALTER TABLE requests ADD COLUMN chain_name TEXT;
UPDATE schema_version SET version = 2;
