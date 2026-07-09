/**
 * routes/vehicles.ts
 *
 * GET /api/vehicles - returns every row currently in `vehicles`.
 */

import { Router, Request, Response } from "express";
import { getAllVehicles } from "../db";
import { requireApiKey } from "../middleware/apiKey";

const router = Router();

router.get("/", requireApiKey, async (_req: Request, res: Response) => {
  try {
    const vehicles = await getAllVehicles();
    res.json(vehicles);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vehicles", detail: err.message });
  }
});

export default router;
