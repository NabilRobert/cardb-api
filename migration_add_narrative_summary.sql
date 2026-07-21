-- narrative_summary: an AI-written prose summary of a scheduled report's
-- result, additive alongside the existing mechanical `summary`/`message`
-- text (see reports.ts's runScheduledReportNow). Only populated for
-- status="answered" runs; null for needs_clarification/error, and null for
-- anything from the plain POST /api/ask path (which is untouched by this
-- feature and keeps its single mechanical summary only).
ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS narrative_summary TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS narrative_summary TEXT;
