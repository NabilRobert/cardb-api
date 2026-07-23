/**
 * routes/config.ts
 *
 * Phase 8: this used to hand back the single static API_KEY to any
 * unauthenticated caller -- exactly the hole this phase closes. There is
 * no longer a single "the" key to hand back at all (keys are per-account,
 * revocable, and only ever shown once at creation via POST
 * /api/auth/api-keys, which requires a real logged-in session). This
 * endpoint is kept, unauthenticated, purely so an old caller gets a clean
 * empty response instead of a 404 -- it no longer returns anything
 * sensitive, or anything at all.
 */

import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({});
});

export default router;
