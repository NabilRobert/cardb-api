/**
 * server.ts
 *
 * Web app for testing the upload/parse pipeline. The frontend is a single-page
 * Vue app (client/, one index.html, routed client-side by vue-router) --
 *   - GET  /                Upload page
 *   - GET  /database         Database page
 *   - GET  /ask              Ask AI page
 *   - GET  /api/config      returns the API key so the frontend can auth itself (local/testing convenience)
 *   - POST /api/upload      accepts an .xlsx file, parses it, inserts into the database
 *   - GET  /api/vehicles    returns every row currently in `vehicles`
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
import * as path from "path";
import * as dotenv from "dotenv";
import apiRouter from "./routes";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use("/api", apiRouter);

app.use(express.static(path.join(__dirname, "client-dist")));

// SPA fallback: any GET request that isn't an API route or a real static
// file falls through to index.html, letting Vue Router handle the path
// client-side (so refreshing on /database, /ask, or /api-docs still works).
// The lookahead requires "/api" to be followed by "/" or end-of-string, not
// just any path starting with those 4 characters -- otherwise a page like
// "/api-docs" gets wrongly treated as an API route and 404s.
app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "client-dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
