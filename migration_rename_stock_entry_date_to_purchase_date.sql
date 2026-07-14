-- Run this once against your existing database. schema.sql has also been
-- updated so brand-new databases created from schema.sql won't need this.
--
-- "stock_entry_date" was renamed to "purchase_date" -- the old name was more
-- abstract than what the data represents, and made AI column-mapping harder
-- for no reason, since source files consistently label this column
-- "Purchase Date" almost verbatim.

ALTER TABLE vehicles RENAME COLUMN stock_entry_date TO purchase_date;
ALTER INDEX IF EXISTS idx_vehicles_stock_entry_date RENAME TO idx_vehicles_purchase_date;

-- Any already-saved import_templates row whose column_mapping.columns still
-- keys this field as "stock_entry_date" needs the same rename, or a
-- known-format upload would silently stop populating this field going
-- forward. This is a no-op (WHERE matches nothing) for templates that never
-- had this key mapped (e.g. the seeded Pricelist/SMR templates derive this
-- field from "Age" rather than mapping a column directly).
UPDATE import_templates
SET column_mapping = jsonb_set(
  column_mapping,
  '{columns}',
  ((column_mapping->'columns') - 'stock_entry_date'::text) || jsonb_build_object('purchase_date', (column_mapping->'columns')->'stock_entry_date')
)
WHERE (column_mapping->'columns') ? 'stock_entry_date';
