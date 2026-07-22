/**
 * middleware/requireAuth.ts
 *
 * Accepts EITHER the existing X-API-Key header (see middleware/apiKey.ts --
 * that check is reused verbatim here, unchanged, so nothing currently
 * working via the API key breaks) OR a valid session cookie from the new
 * shared-login web-app gate (see routes/auth.ts / middleware/session.ts).
 * Applied to the data routes (/api/vehicles*, /api/upload*, /api/ask,
 * /api/templates) in place of requireApiKey alone. /api/config and
 * /api/health stay open, unauthenticated, same as before.
 */

import { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./session";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-API-Key");
  if (process.env.API_KEY && key === process.env.API_KEY) {
    return next();
  }

  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (typeof token === "string" && verifySessionToken(token)) {
    return next();
  }

  return res.status(401).json({ error: "Missing or invalid X-API-Key header, and no valid session" });
}
