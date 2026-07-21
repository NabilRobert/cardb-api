-- buyer_name: populated only when a vehicle's status transitions to "sold"
-- (see routes/vehicles.ts's PATCH /:id/status), including a direct
-- available -> sold transition with no prior booking step. Distinct from
-- reserved_by, which is for the booked state. Nullable; existing sold rows
-- are left blank rather than backfilled.
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS buyer_name TEXT;

-- updated_at is used as an optimistic-concurrency token by PATCH
-- /:id/status: the client echoes back the exact value it last read, and the
-- UPDATE only applies if it still matches. node-pg parses timestamptz into a
-- JS Date, which only has millisecond resolution -- so a column that stores
-- microsecond precision can never be matched exactly by a value that's been
-- round-tripped through JSON. Truncating the column itself to milliseconds
-- makes storage and the JS-side round-trip agree exactly.
ALTER TABLE vehicles ALTER COLUMN updated_at TYPE timestamptz(3);
