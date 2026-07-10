/**
 * routes/uploads.ts
 *
 * GET /api/uploads - upload history, most recent first. One row per past
 * upload: id, filename, uploaded_at, rows_inserted, rows_skipped.
 * rows_inserted/rows_skipped are NULL for uploads made before these columns
 * were added (see migration_add_upload_counts.sql) -- only uploads made
 * afterward have real values.
 *
 * Pagination via ?limit=&offset=, same pattern as /api/vehicles/search
 * (default limit 100, max 500, default offset 0).
 */

import { Router, Request, Response } from "express";
import { getUploads } from "../db";
import { requireApiKey } from "../middleware/apiKey";

const router = Router();

router.get("/", requireApiKey, async (req: Request, res: Response) => {
  const limitRaw = Number(req.query.limit);
  const offsetRaw = Number(req.query.offset);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100, 1), 500);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

  try {
    const uploads = await getUploads({ limit, offset });
    res.json(uploads);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch uploads", detail: err.message });
  }
});

export default router;
