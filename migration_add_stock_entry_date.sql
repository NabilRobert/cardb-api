-- Run this once against your existing database (the one you already created
-- tables in via schema.sql). schema.sql has also been updated to include this
-- column, so any brand-new database created from schema.sql going forward
-- won't need this migration.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS stock_entry_date DATE;
CREATE INDEX IF NOT EXISTS idx_vehicles_stock_entry_date ON vehicles (stock_entry_date);
