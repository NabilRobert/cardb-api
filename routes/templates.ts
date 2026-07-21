/**
 * routes/templates.ts
 *
 * GET /api/templates - every stored import template (see import_templates /
 * ColumnMapping in templates.ts), most-used first. Includes times_used and
 * times_corrected (see db.ts's recordTemplateUsage, set from
 * routes/upload.ts's confirm-mapping) plus a derived correction_rate, so a
 * format whose stored mapping keeps needing manual fixing is visible over
 * time -- a longer-horizon signal than any single upload's accuracy score
 * (see scoring.ts / process-sheet's `accuracy` field).
 */

import { Router, Request, Response } from "express";
import { listImportTemplates } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

router.get("/", requireAuth, async (_req: Request, res: Response) => {
  try {
    const templates = await listImportTemplates();
    const withRate = templates.map((t) => ({
      ...t,
      correction_rate: t.times_used > 0 ? t.times_corrected / t.times_used : null,
    }));
    res.json(withRate);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch templates", detail: err.message });
  }
});

export default router;
