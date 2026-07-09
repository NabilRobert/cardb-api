/**
 * routes/index.ts
 *
 * Aggregates all /api/* routers. Mounted under /api in server.ts.
 */

import { Router } from "express";
import configRouter from "./config";
import uploadRouter from "./upload";
import vehiclesRouter from "./vehicles";
import askRouter from "./ask";

const router = Router();

router.use("/config", configRouter);
router.use("/upload", uploadRouter);
router.use("/vehicles", vehiclesRouter);
router.use("/ask", askRouter);

export default router;
