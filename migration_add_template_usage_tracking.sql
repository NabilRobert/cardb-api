-- Per-template correction tracking (see scoring.ts / routes/upload.ts's
-- confirm-mapping): timesUsed increments on every confirm-mapping call for
-- a given template; timesCorrected increments when the human-submitted
-- mapping differs from what was originally proposed for that same upload
-- (a field's source column changed or was removed). A high
-- timesCorrected/timesUsed ratio flags a format whose stored mapping keeps
-- needing manual fixing -- a longer-horizon signal than any single upload's
-- accuracy score.
ALTER TABLE import_templates ADD COLUMN IF NOT EXISTS times_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE import_templates ADD COLUMN IF NOT EXISTS times_corrected INTEGER NOT NULL DEFAULT 0;
