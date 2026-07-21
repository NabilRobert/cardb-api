/**
 * routes/scheduledReports.ts
 *
 * CRUD for scheduled "Ask AI" reports (see reports.ts for the job that runs
 * them, scheduler.ts for when). A report's `question` is answered by the
 * same ai.ts#askQuestion pipeline POST /api/ask uses; the result lands as a
 * notification of type "scheduled_report" (see routes/notifications.ts).
 *
 * GET /api/scheduled-reports - list all, most recent first (created_at DESC).
 *
 * POST /api/scheduled-reports - create. Body: { name, question, schedule,
 * enabled?, covers? }. schedule is a standard 5-field cron expression (e.g.
 * "0 8 * * *" = daily 08:00 UTC). enabled defaults to true if omitted.
 * covers is an optional array of notification types this report already
 * surfaces (low_stock, stnk_expiry, aging_inventory) -- while this report
 * is enabled, notifications.ts skips creating a new individual alert of any
 * type listed here (see notifications.ts). Defaults to [] (no suppression,
 * same as today) if omitted. 400 if name/question is missing or empty,
 * schedule isn't a valid cron expression, or covers contains anything other
 * than those three values.
 *
 * PATCH /api/scheduled-reports/:id - partial update. Editable: name,
 * question, schedule, enabled, covers (e.g. toggling enabled off/on, or
 * editing the question/schedule/covers). Same validation as create for any
 * field present. Turning enabled off, deleting the report, or removing a
 * type from covers all let that type's individual alerts resume on the
 * notifications job's next run -- no manual cleanup, and nothing already
 * fired is touched retroactively (see notifications.ts). 400 if :id isn't
 * an integer or the body has no editable/known fields, 404 if no report has
 * that id.
 *
 * DELETE /api/scheduled-reports/:id - delete. Returns { deleted: true, id }.
 * 400 if :id isn't an integer, 404 if no report has that id. Past runs
 * (report_runs) and past notifications are deliberately NOT deleted along
 * with the report -- see report_runs's soft-reference note in
 * migration_add_report_runs.sql. GET /:id/runs stays reachable by this same
 * id afterward; notifications just lose their scheduled_report_id
 * back-reference (ON DELETE SET NULL).
 *
 * POST /api/scheduled-reports/:id/run-now - runs the report immediately,
 * regardless of its schedule, via the exact same runScheduledReportNow()
 * function the cron job calls (see reports.ts) -- not a separate
 * implementation. Inserts the resulting notification AND a report_runs row,
 * and updates last_run_at, same as a normal scheduled firing would. Returns
 * the newly created notification, which (like every report_runs row) now
 * also carries narrative_summary -- an AI-written prose version of the
 * result, additive alongside the existing mechanical message/summary, only
 * populated when the run's status is "answered" (null for
 * needs_clarification/error). See ai.ts#generateReportNarrative. 400 if :id
 * isn't an integer, 404 if no report has that id.
 *
 * GET /api/scheduled-reports/:id/runs - past runs for one report, most
 * recent first (created_at DESC). limit (default 100, max 500) / offset,
 * same convention as every other list endpoint. Deliberately does NOT 404
 * if the report itself no longer exists (see the DELETE note above) --
 * it's just an empty array if there are no runs for that id, whether
 * because the id never existed or because the report was since deleted.
 * 400 if :id isn't an integer.
 */

import { Router, Request, Response } from "express";
import { CronExpressionParser } from "cron-parser";
import {
  listScheduledReports,
  createScheduledReport,
  updateScheduledReport,
  deleteScheduledReport,
  isEditableScheduledReportField,
  getScheduledReportById,
  listReportRuns,
} from "../db";
import { runScheduledReportNow } from "../reports";
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

// The three Phase 2 notification types a report's `covers` can name.
// Deliberately excludes "scheduled_report" itself -- that's not something a
// report can cover.
const COVERABLE_TYPES = ["low_stock", "stnk_expiry", "aging_inventory"] as const;

function isValidCoversArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every((v) => typeof v === "string" && (COVERABLE_TYPES as readonly string[]).includes(v));
}

router.get("/", requireAuth, async (_req: Request, res: Response) => {
  try {
    const reports = await listScheduledReports();
    res.json(reports);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch scheduled reports", detail: err.message });
  }
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }
  const { name, question, schedule, enabled, covers } = req.body as Record<string, unknown>;

  if (typeof name !== "string" || name.trim() === "") {
    return res.status(400).json({ error: "name is required and must be non-empty" });
  }
  if (typeof question !== "string" || question.trim() === "") {
    return res.status(400).json({ error: "question is required and must be non-empty" });
  }
  if (!isValidCronExpression(schedule)) {
    return res.status(400).json({ error: "schedule must be a valid 5-field cron expression, e.g. '0 8 * * *'" });
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean if provided" });
  }
  if (covers !== undefined && !isValidCoversArray(covers)) {
    return res.status(400).json({ error: `covers must be an array containing only: ${COVERABLE_TYPES.join(", ")}` });
  }

  try {
    const report = await createScheduledReport({
      name: name.trim(),
      question: question.trim(),
      schedule: (schedule as string).trim(),
      enabled: enabled as boolean | undefined,
      covers: covers as string[] | undefined,
    });
    res.json(report);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to create scheduled report", detail: err.message });
  }
});

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }
  const body = req.body as Record<string, unknown>;

  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim() === "")) {
    return res.status(400).json({ error: "name must be a non-empty string if provided" });
  }
  if (body.question !== undefined && (typeof body.question !== "string" || body.question.trim() === "")) {
    return res.status(400).json({ error: "question must be a non-empty string if provided" });
  }
  if (body.schedule !== undefined && !isValidCronExpression(body.schedule)) {
    return res.status(400).json({ error: "schedule must be a valid 5-field cron expression, e.g. '0 8 * * *'" });
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be a boolean if provided" });
  }
  if (body.covers !== undefined && !isValidCoversArray(body.covers)) {
    return res.status(400).json({ error: `covers must be an array containing only: ${COVERABLE_TYPES.join(", ")}` });
  }

  const editableFields = Object.fromEntries(
    Object.entries(body).filter(([key]) => isEditableScheduledReportField(key))
  );
  if (Object.keys(editableFields).length === 0) {
    return res.status(400).json({
      error: "No editable fields in body. Editable fields: name, question, schedule, enabled, covers",
    });
  }
  if (typeof editableFields.name === "string") editableFields.name = editableFields.name.trim();
  if (typeof editableFields.question === "string") editableFields.question = editableFields.question.trim();
  if (typeof editableFields.schedule === "string") editableFields.schedule = editableFields.schedule.trim();

  try {
    const report = await updateScheduledReport(id, editableFields);
    if (!report) {
      return res.status(404).json({ error: `No scheduled report found with id ${id}` });
    }
    res.json(report);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to update scheduled report", detail: err.message });
  }
});

router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const deleted = await deleteScheduledReport(id);
    if (!deleted) {
      return res.status(404).json({ error: `No scheduled report found with id ${id}` });
    }
    res.json({ deleted: true, id });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete scheduled report", detail: err.message });
  }
});

router.post("/:id/run-now", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const report = await getScheduledReportById(id);
    if (!report) {
      return res.status(404).json({ error: `No scheduled report found with id ${id}` });
    }
    const notification = await runScheduledReportNow(report);
    res.json(notification);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to run scheduled report", detail: err.message });
  }
});

router.get("/:id/runs", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    const runs = await listReportRuns(id, { limit, offset });
    res.json(runs);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch report runs", detail: err.message });
  }
});

export default router;
