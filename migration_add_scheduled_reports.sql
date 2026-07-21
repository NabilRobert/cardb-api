-- scheduled_reports: recurring "Ask AI" questions (see reports.ts for the
-- job that runs them, scheduler.ts for when). schedule is a standard
-- 5-field cron expression, evaluated against last_run_at (or created_at if
-- it's never run) to decide when the next occurrence is due.
CREATE TABLE IF NOT EXISTS scheduled_reports (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    question TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_run_at TIMESTAMPTZ(3),
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_enabled ON scheduled_reports (enabled);

-- Lets a scheduled_report notification reference which report produced it.
-- Not used for dedup yet (that's Phase 6) -- this is just the hook so a
-- later phase can join back to the report's question/name to reason about
-- what scope/alert-types it already covers, without a schema change then.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS scheduled_report_id INTEGER REFERENCES scheduled_reports(id);
CREATE INDEX IF NOT EXISTS idx_notifications_scheduled_report_id ON notifications (scheduled_report_id);
