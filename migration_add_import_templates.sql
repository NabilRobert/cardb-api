-- Run this once against your existing database. schema.sql has also been
-- updated so brand-new databases created from schema.sql won't need this.
--
-- Adds the template registry backing the header-fingerprint-based import
-- flow in templates.ts / routes/upload.ts. Existing databases won't have any
-- rows here until the seed script runs (scripts/seed_import_templates.ts) or
-- a mapping is confirmed via POST /api/upload/confirm-mapping.

CREATE TABLE IF NOT EXISTS import_templates (
    id SERIAL PRIMARY KEY,
    header_fingerprint TEXT NOT NULL UNIQUE,
    sheet_label TEXT NOT NULL,
    column_mapping JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
