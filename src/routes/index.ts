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
import templatesRouter from "./templates";
import authRouter from "./auth";
import apiKeysRouter from "./apiKeys";
import notificationsRouter from "./notifications";
import scheduledReportsRouter from "./scheduledReports";

const router = Router();

router.use("/config", configRouter);
router.use("/health", healthRouter);
router.use("/auth", authRouter);
router.use("/auth/api-keys", apiKeysRouter);
router.use("/upload", uploadRouter);
router.use("/uploads", uploadsRouter);
router.use("/vehicles", vehiclesRouter);
router.use("/ask", askRouter);
router.use("/templates", templatesRouter);
router.use("/notifications", notificationsRouter);
router.use("/scheduled-reports", scheduledReportsRouter);

export default router;
