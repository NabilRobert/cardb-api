/**
 * routes/config.ts
 *
 * GET /api/config - returns the API key so the frontend can auth itself
 * (local/testing convenience, intentionally not behind requireApiKey).
 */

import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({ apiKey: process.env.API_KEY });
});

export default router;
