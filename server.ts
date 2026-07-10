/**
 * server.ts
 *
 * Web app for testing the upload/parse pipeline. The frontend is a single-page
 * Vue app (client/, one index.html, routed client-side by vue-router) --
 *   - GET  /                Upload page
 *   - GET  /database         Database page
 *   - GET  /ask              Ask AI page
 *   - GET  /api/config      returns the API key so the frontend can auth itself (local/testing convenience)
 *   - GET  /api/health      liveness + DB connectivity check (no auth)
 *   - POST /api/upload      accepts an .xlsx file, parses it, inserts into the database
 *   - GET  /api/uploads     upload history, paginated
 *   - GET  /api/vehicles    returns every row currently in `vehicles`
 *   - GET  /api/vehicles/search   filtered/sorted/paginated search
 *   - GET/PATCH/DELETE /api/vehicles/:id   read, edit, or remove a single vehicle
 *   - GET  /api/ask         answers a natural-language question about stock (see ai.ts)
 *
 * Route handlers live in routes/ (one file per resource, see routes/index.ts),
 * with shared auth in middleware/apiKey.ts -- this file only wires the app together.
 *
 * The frontend lives in client/ (Vue 3 + TypeScript + Tailwind, built with Vite).
 * Run `npm run build` once to produce client-dist/, then `npm start` to run this server.
 * For frontend development with hot reload, use `npm run dev:client` alongside `npm run dev:server`.
 *
 * Requires DATABASE_URL, API_KEY, and SUMOPOD_API_KEY in .env.
 */

import express from "express";
import cors from "cors";
import * as dotenv from "dotenv";
import apiRouter from "./routes";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

app.use("/api", apiRouter);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
