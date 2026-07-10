/**
 * routes/health.ts
 *
 * GET /api/health - liveness check for monitoring/uptime tools. Intentionally
 * not behind requireApiKey (alongside /api/config) so external monitors can
 * hit it without a key. Runs a `SELECT 1` to confirm Postgres is reachable;
 * returns 503 (not 200) if that fails, so this reflects real app health, not
 * just "Express is running".
 */

import { Router, Request, Response } from "express";
import { checkDbConnection } from "../db";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    return res.status(503).json({ status: "error", detail: "database unreachable", timestamp: new Date().toISOString() });
  }
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
