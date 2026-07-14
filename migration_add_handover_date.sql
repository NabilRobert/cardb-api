-- Run this once against your existing database. schema.sql has also been
-- updated so brand-new databases created from schema.sql won't need this.
--
-- New field (not a rename) -- the date a vehicle was handed over to the
-- buyer. Source files consistently label this column "HANDOVER" with no
-- other qualifying words.

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS handover_date DATE;
