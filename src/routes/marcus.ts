/**
 * routes/marcus.ts
 *
 * Marcus: a proactive whole-business heartbeat, fully separate from
 * /api/ask (Ask Emily, one question at a time) and /api/scheduled-reports
 * (one fixed topic each, re-run on a schedule) -- see jobs/marcus.ts for the
 * heartbeat orchestration and services/marcusCategories.ts for the 9
 * category computations. This route file is intentionally isolated: it
 * doesn't import from or branch off routes/ask.ts or
 * routes/scheduledReports.ts, even though the underlying question-to-SQL
 * pipeline (ai.ts#askQuestion) is shared code.
 *
 * GET  /api/marcus/config - { id, schedule, enabled, last_run_at, created_at,
 *   updated_at }. schedule is a standard 5-field cron expression, evaluated
 *   against Asia/Jakarta exactly like scheduled_reports (see
 *   jobs/marcus.ts's isMarcusDue).
 *
 * PATCH /api/marcus/config - body { schedule?, enabled? }. 400 if schedule
 *   isn't a valid cron expression, enabled isn't a boolean, or neither field
 *   is present.
 *
 * POST /api/marcus/run-now - runs a heartbeat immediately regardless of
 *   marcus_config's schedule/enabled state, via the exact same
 *   runMarcusHeartbeatNow() the cron job calls (see jobs/marcus.ts) -- not a
 *   separate implementation. Returns the newly created, full heartbeat row.
 *   Per-category AI failures don't 500 this route -- they land inside a
 *   stored heartbeat with status "partial_error" instead; only a genuinely
 *   unexpected failure (e.g. the archive insert itself failing) 500s.
 *
 * GET  /api/marcus/heartbeats - Marcus's Archive, lightweight list:
 *   { id, created_at, status, severities, top_mover }[], most recent first.
 *   limit (default 20, max 100) / offset. Deliberately excludes metrics/
 *   narrative -- fetch a specific heartbeat by id for the full payload.
 *
 * GET  /api/marcus/heartbeats/:id - one heartbeat in full: { id, created_at,
 *   status, metrics, severities, deltas, top_mover, rain_context, narrative
 *   }. 404 if no heartbeat has that id, 400 if :id isn't an integer.
 *
 * POST /api/marcus/heartbeats/:id/ask - body { question }. Answers the
 *   question grounded in that ONE heartbeat's already-computed data (not
 *   fresh open-ended SQL like /api/ask) -- Marcus explains his own past
 *   findings, he doesn't re-investigate the database (see
 *   ai.ts#answerMarcusFollowUp). Returns { question, answer, usage }. 404 if
 *   no heartbeat has that id, 400 if question is missing/empty or :id isn't
 *   an integer.
 */

import { Router, Request, Response } from "express";
import { CronExpressionParser } from "cron-parser";
import {
  getMarcusConfig,
  updateMarcusConfig,
  isEditableMarcusConfigField,
  listMarcusHeartbeatsLight,
  getMarcusHeartbeatById,
} from "../db";
import { runMarcusHeartbeatNow } from "../jobs/marcus";
import { answerMarcusFollowUp } from "../services/ai";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function isValidCronExpression(schedule: unknown): schedule is string {
  if (typeof schedule !== "string" || schedule.trim() === "") return false;
  try {
    CronExpressionParser.parse(schedule.trim());
    return true;
  } catch {
    return false;
  }
}

router.get("/config", requireAuth, async (_req: Request, res: Response) => {
  try {
    const config = await getMarcusConfig();
    res.json(config);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Marcus config", detail: err.message });
  }
});

router.patch("/config", requireAuth, async (req: Request, res: Response) => {
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }
  const body = req.body as Record<string, unknown>;

  if (body.schedule !== undefined && !isValidCronExpression(body.schedule)) {
    return res.status(400).json({ error: "schedule must be a valid 5-field cron expression, e.g. '0 7 * * *'" });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean if provided" });
  }

  const editableFields = Object.fromEntries(
    Object.entries(body).filter(([key]) => isEditableMarcusConfigField(key))
  );
  if (Object.keys(editableFields).length === 0) {
    return res.status(400).json({ error: "No editable fields in body. Editable fields: schedule, enabled" });
  }
  if (typeof editableFields.schedule === "string") editableFields.schedule = editableFields.schedule.trim();

  try {
    const config = await updateMarcusConfig(editableFields);
    res.json(config);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to update Marcus config", detail: err.message });
  }
});

router.post("/run-now", requireAuth, async (_req: Request, res: Response) => {
  try {
    const heartbeat = await runMarcusHeartbeatNow();
    res.json(heartbeat);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to run Marcus heartbeat", detail: err.message });
  }
});

router.get("/heartbeats", requireAuth, async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    const heartbeats = await listMarcusHeartbeatsLight({ limit, offset });
    res.json(heartbeats);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Marcus heartbeats", detail: err.message });
  }
});

router.get("/heartbeats/:id", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const heartbeat = await getMarcusHeartbeatById(id);
    if (!heartbeat) {
      return res.status(404).json({ error: `No Marcus heartbeat found with id ${id}` });
    }
    res.json(heartbeat);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch Marcus heartbeat", detail: err.message });
  }
});

router.post("/heartbeats/:id/ask", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  const { question } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof question !== "string" || question.trim() === "") {
    return res.status(400).json({ error: "question is required and must be non-empty" });
  }

  try {
    const heartbeat = await getMarcusHeartbeatById(id);
    if (!heartbeat) {
      return res.status(404).json({ error: `No Marcus heartbeat found with id ${id}` });
    }
    const { text, usage } = await answerMarcusFollowUp(
      { metrics: heartbeat.metrics, severities: heartbeat.severities, narrative: heartbeat.narrative },
      question.trim()
    );
    res.json({ question: question.trim(), answer: text, usage });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to answer follow-up question", detail: err.message });
  }
});

export default router;
