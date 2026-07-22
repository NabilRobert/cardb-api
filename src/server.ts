/**
 * server.ts
 *
 * API-only server for the vehicle inventory system. The frontend is a
 * separately deployed Vue app that calls this API over the network (see
 * CORS_ORIGIN below) -- this process serves no frontend assets of its own.
 *   - GET  /api/config      returns the API key so the frontend can auth itself (local/testing convenience)
 *   - GET  /api/health      liveness + DB connectivity check (no auth)
 *   - POST /api/auth/login  shared web-app login (routes/auth.ts) -- sets a session cookie, separate from the API key
 *   - POST /api/auth/logout clears the session cookie
 *   - GET  /api/auth/me     whether the current request has a valid session
 *   - POST /api/upload                    step 1 of 3: list a workbook's sheets, nothing processed yet
 *   - POST /api/upload/process-sheet      step 2 of 3: parse a chosen sheet, return a preview, nothing inserted yet
 *   - POST /api/upload/confirm-mapping    step 3 of 3: commit -- save the mapping and insert
 *   - GET  /api/uploads     upload history, paginated
 *   - GET  /api/vehicles    returns every row currently in `vehicles`
 *   - GET  /api/vehicles/search   filtered/sorted/paginated search
 *   - GET/PATCH/DELETE /api/vehicles/:id   read, edit, or remove a single vehicle
 *   - PATCH /api/vehicles/:id/status   change status with optimistic concurrency (see routes/vehicles.ts)
 *   - GET  /api/ask         answers a natural-language question about stock (see ai.ts)
 *   - GET  /api/notifications              list in-app alerts (low stock, STNK expiry, aging inventory, scheduled reports)
 *   - GET  /api/notifications/unread-count { unread_count }
 *   - POST /api/notifications/:id/read     mark one as read
 *   - GET/POST /api/scheduled-reports      list/create recurring "Ask AI" questions (see reports.ts)
 *   - PATCH/DELETE /api/scheduled-reports/:id   edit (incl. enable/disable) or remove one
 *
 * Route handlers live in routes/ (one file per resource, see routes/index.ts).
 * Most data routes require middleware/requireAuth.ts (X-API-Key header OR a
 * session cookie from /api/auth/login); /api/uploads still uses
 * middleware/apiKey.ts's X-API-Key-only check directly (not yet moved over
 * to accept a session too). This file also starts scheduler.ts's background
 * jobs (nightly notifications, and a per-minute due-check for scheduled
 * reports) alongside the HTTP server.
 *
 * Requires DATABASE_URL, API_KEY, SUMOPOD_API_KEY, ADMIN_USERNAME,
 * ADMIN_PASSWORD_HASH, and SESSION_SECRET in .env. SUMMARIZER_API_KEY (and
 * optionally SUMMARIZER_MODEL, defaults to "gpt-5") is required for the
 * scheduled-report narrative summarizer (see services/ai.ts's
 * generateReportNarrative) -- if unset, that one call fails and
 * narrative_summary just stays null, nothing else is affected.
 */

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import * as dotenv from "dotenv";
import apiRouter from "./routes";
import { startScheduler } from "./jobs/scheduler";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// credentials: true is required for the session cookie (see
// middleware/session.ts / routes/auth.ts) to be sent on cross-origin
// requests at all -- but browsers reject Access-Control-Allow-Credentials
// combined with a wildcard Access-Control-Allow-Origin (confirmed live:
// "Cannot use wildcard in Access-Control-Allow-Origin when credentials flag
// is true"). The X-API-Key path is unaffected either way, since it doesn't
// rely on cookies/credentials at all.
//
// CORS_ORIGIN is a comma-separated allow-list (e.g.
// "http://localhost:5173,https://app.example.com"), not a single value --
// so adding a real deployed frontend origin later is one env-var edit, not
// a swap. A bare "*" is still honored as the literal wildcard for anyone
// who hasn't set this yet, but note it still won't work for the cookie
// login above; it only keeps the non-credentialed X-API-Key path open the
// same as before.
const corsOrigins = (process.env.CORS_ORIGIN || "*").split(",").map((o) => o.trim()).filter(Boolean);
const corsOriginOption = corsOrigins.length === 1 && corsOrigins[0] === "*" ? "*" : corsOrigins;
app.use(cors({ origin: corsOriginOption, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/api", apiRouter);

// Top-level error boundary: catches anything that reaches next(err) --
// multer errors (oversized file, wrong field name), or an error passed on
// from a route via asyncRoute (see routes/upload.ts) that wasn't already
// turned into a response by that route's own try/catch. Registered after
// all routes, as Express requires for error-handling middleware. Without
// this, Express's own default handler would respond with an HTML stack
// trace instead of the JSON shape every other error response here uses.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Unexpected server error", detail: err?.message ?? String(err) });
});

// Last-resort safety net: a bug that slips past every try/catch and error
// middleware above (e.g. a rejected promise nothing ever awaited, so it
// isn't wired to any request/response at all) would otherwise crash the
// whole process by default in modern Node -- taking down every in-flight
// request, not just the one that triggered it. Log and keep running instead;
// whatever request caused this may still fail, but the server as a whole
// stays up for everyone else.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

startScheduler();

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
