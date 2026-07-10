-- Run this once against your existing database. schema.sql has also been
-- updated so brand-new databases created from schema.sql won't need this.
--
-- Existing upload rows will have NULL rows_inserted/rows_skipped since that
-- data was never captured before this migration -- only uploads made after
-- this migration (and the corresponding db.ts change) will have real values.

ALTER TABLE uploads ADD COLUMN IF NOT EXISTS rows_inserted INTEGER;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS rows_skipped INTEGER;
