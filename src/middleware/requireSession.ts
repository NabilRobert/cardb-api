/**
 * middleware/requireSession.ts
 *
 * Phase 8: gates routes/apiKeys.ts (generate/list/revoke your own API
 * keys) on the session cookie ONLY -- deliberately not X-API-Key. An
 * account has to be able to fetch its first key without already holding
 * one, and key management is a "manage my own account" concern, not a
 * general API-access concern (that's exactly what middleware/apiKeyAuth.ts
 * is for). Attaches the authenticated account's id to req.accountId for
 * the route handler.
 */

import { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE_NAME, decodeSessionToken } from "./session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accountId?: number;
    }
  }
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const payload = typeof token === "string" ? decodeSessionToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: "Not logged in" });
  }

  req.accountId = payload.accountId;
  next();
}
