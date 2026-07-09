/**
 * routes/upload.ts
 *
 * POST /api/upload - accepts an .xlsx file, parses it, inserts into the database.
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { parseWorkbook } from "../parser";
import { insertVehicles } from "../db";
import { requireApiKey } from "../middleware/apiKey";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

router.post("/", requireApiKey, upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded (expected form field 'file')" });
  }
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const { rows, skipped } = parseWorkbook(wb);
    const { uploadId, inserted } = await insertVehicles(req.file.originalname, rows);
    res.json({ uploadId, inserted, skipped });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to parse or insert the file", detail: err.message });
  }
});

export default router;
