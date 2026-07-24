-- marcus_config / marcus_heartbeats -- Phase 9: Marcus, the proactive
-- whole-business heartbeat. Distinct from scheduled_reports (one topic each)
-- -- Marcus computes 9 fixed categories every run on its own cadence. See
-- jobs/marcus.ts for the heartbeat orchestration, routes/marcus.ts for the
-- /api/marcus/* API.

-- Singleton config row (id fixed at 1 via the CHECK constraint) holding
-- Marcus's heartbeat cadence -- mirrors scheduled_reports' schedule/enabled/
-- last_run_at shape. schedule is a standard 5-field cron expression,
-- evaluated against Asia/Jakarta exactly like scheduled_reports (see
-- jobs/marcus.ts's isMarcusDue, mirroring jobs/reports.ts's isDue).
CREATE TABLE IF NOT EXISTS marcus_config (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    schedule TEXT NOT NULL DEFAULT '0 7 * * *',   -- daily 07:00 WIB
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_run_at TIMESTAMPTZ(3),
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
INSERT INTO marcus_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Marcus's Archive. Immutable once written -- db.ts never gets an
-- UPDATE/DELETE path for this table. Every heartbeat freezes its computed
-- numbers, severities, deltas, top_mover, rain-awareness context, and
-- narrative forever, even if later data would change the picture.
CREATE TABLE IF NOT EXISTS marcus_heartbeats (
    id SERIAL PRIMARY KEY,
    status TEXT NOT NULL,          -- 'ok' | 'partial_error' -- computation completeness, NOT business severity
    metrics JSONB NOT NULL,        -- { <category_slug>: {...raw numbers...} } for all 9 categories
    severities JSONB NOT NULL,     -- { <category_slug>: { severity: ok|watch|attention|unknown, note?, insufficient_history? } }
    deltas JSONB NOT NULL,         -- { <category_slug>: { headline_metric, current, previous, delta, delta_pct } | null }
    top_mover JSONB,               -- { category, headline_metric, delta_pct } | null (null on the first heartbeat)
    rain_context JSONB NOT NULL,   -- [{ report_id, report_name, question, summary, ran_at }, ...] -- recent Scheduled Reports findings, so Marcus references rather than repeats them
    narrative JSONB NOT NULL,      -- { overall, categories: { <slug>: {explanation, recommendation} }, parse_ok }
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marcus_heartbeats_created_at ON marcus_heartbeats (created_at DESC);
