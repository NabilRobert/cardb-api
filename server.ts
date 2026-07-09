/**
 * server.ts
 *
 * Minimal web app for testing the upload/parse pipeline:
 *   - GET  /                serves the upload homepage
 *   - GET  /database.html   serves the data browser page
 *   - GET  /api/config      returns the API key so the frontend can auth itself (local/testing convenience)
 *   - POST /api/upload      accepts an .xlsx file, parses it, inserts into the database
 *   - GET  /api/vehicles    returns every row currently in `vehicles`
 *
 * Run with: npx ts-node server.ts
 * Requires DATABASE_URL and API_KEY in .env.
 */

import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import * as path from "path";
import * as dotenv from "dotenv";
import { parseWorkbook } from "./parser";
import { insertVehicles, getAllVehicles } from "./db";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

// Every /api/* route except /api/config requires the API key in X-API-Key.
function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-API-Key");
  if (!process.env.API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: API_KEY not set" });
  }
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Missing or invalid X-API-Key header" });
  }
  next();
}

app.get("/api/config", (_req, res) => {
  res.json({ apiKey: process.env.API_KEY });
});

app.post("/api/upload", requireApiKey, upload.single("file"), async (req: Request, res: Response) => {
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

app.get("/api/vehicles", requireApiKey, async (_req: Request, res: Response) => {
  try {
    const vehicles = await getAllVehicles();
    res.json(vehicles);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vehicles", detail: err.message });
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
