-- report_runs: a durable record of every scheduled-report execution,
-- independent of the notifications table's own retention/read-state
-- semantics -- this is the Reports page's history, not a borrowed view of
-- the alerts system.
--
-- scheduled_report_id is a soft reference to scheduled_reports(id) --
-- deliberately NOT a FK constraint. Runs need to stay reachable via
-- GET /api/scheduled-reports/:id/runs even after the parent report is
-- deleted (a real FK, even with ON DELETE SET NULL, would sever that
-- lookup by nulling the column out). Rows are only ever inserted from
-- runScheduledReportNow() with an id it just read from a real row, so this
-- doesn't risk holding garbage values in practice.
CREATE TABLE IF NOT EXISTS report_runs (
    id SERIAL PRIMARY KEY,
    scheduled_report_id INTEGER,
    question TEXT NOT NULL,      -- snapshot of the report's question at run time, not a live join
    status TEXT NOT NULL,        -- answered | needs_clarification | error
    summary TEXT NOT NULL,       -- full result text (same content as the notification's message)
    sql TEXT,                    -- generated SQL, if any (null for needs_clarification/most errors)
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_runs_scheduled_report_id ON report_runs (scheduled_report_id, created_at DESC);

-- Pre-existing bug fix, found while building this: notifications.scheduled_report_id
-- was added (migration_add_scheduled_reports.sql) as a plain FK with the
-- Postgres default ON DELETE NO ACTION -- meaning DELETE
-- /api/scheduled-reports/:id has been failing with a foreign-key violation
-- for any report that has ever produced a notification (i.e. ever run),
-- surfaced as an unhelpful 500. Switching to ON DELETE SET NULL: deleting a
-- report now always succeeds, its past notifications survive with their
-- content intact, they just lose the back-reference (there's no
-- GET-notifications-by-report endpoint depending on it staying populated,
-- unlike report_runs above).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_scheduled_report_id_fkey;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_scheduled_report_id_fkey
  FOREIGN KEY (scheduled_report_id) REFERENCES scheduled_reports(id) ON DELETE SET NULL;
