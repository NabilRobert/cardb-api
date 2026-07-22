/**
 * middleware/apiKey.ts
 *
 * Requires the API key in an X-API-Key header. Still applied directly to
 * /api/uploads (upload history) -- everything else that used to import this
 * directly (/api/vehicles*, /api/upload*, /api/ask, /api/templates) now
 * goes through middleware/requireAuth.ts instead, which accepts this same
 * check OR a session cookie from the shared web-app login (routes/auth.ts).
 * /api/config and /api/health stay reachable without either.
 */

import { Request, Response, NextFunction } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-API-Key");
  if (!process.env.API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: API_KEY not set" });
  }
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Missing or invalid X-API-Key header" });
  }
  next();
}
