/**
 * server.ts
 *
 * API-only server for the vehicle inventory system. The frontend is a
 * separately deployed Vue app that calls this API over the network (see
 * CORS_ORIGIN below) -- this process serves no frontend assets of its own.
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
