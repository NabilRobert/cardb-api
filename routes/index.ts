/**
 * routes/index.ts
 *
 * Aggregates all /api/* routers. Mounted under /api in server.ts.
 */

import { Router } from "express";
import configRouter from "./config";
import healthRouter from "./health";
import uploadRouter from "./upload";
import uploadsRouter from "./uploads";
import vehiclesRouter from "./vehicles";
import askRouter from "./ask";

const router = Router();

router.use("/config", configRouter);
router.use("/health", healthRouter);
router.use("/upload", uploadRouter);
router.use("/uploads", uploadsRouter);
router.use("/vehicles", vehiclesRouter);
router.use("/ask", askRouter);

export default router;
