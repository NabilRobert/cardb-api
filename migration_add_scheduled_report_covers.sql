-- covers: which Phase 2 notification types (low_stock | stnk_expiry |
-- aging_inventory) this scheduled report already surfaces, so the nightly
-- notifications job (notifications.ts) can skip creating a new individual
-- alert of that type while an enabled report covers it. Forward-looking
-- only -- see notifications.ts for how it's applied. Defaults to '{}' so
-- existing reports (and any report that doesn't set it) suppress nothing,
-- unchanged from today's behavior.
ALTER TABLE scheduled_reports ADD COLUMN IF NOT EXISTS covers TEXT[] NOT NULL DEFAULT '{}';
