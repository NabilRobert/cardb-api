-- Run this once against your existing database. schema.sql has also been
-- updated so brand-new databases created from schema.sql won't need this.
--
-- New field (not a synonym for price_cash or price_credit) -- "Harga Net" /
-- "Harga Jual (NETT)" is its own distinct price category. See
-- ai.ts's MAPPING_SYSTEM_PROMPT for the terminology this was confused with
-- (a "Harga Jual (NETT)" column had been landing in price_credit).

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS price_net NUMERIC;
