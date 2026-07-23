/**
 * middleware/requireSession.ts
 *
 * Gates routes/apiKeys.ts (generate/list/revoke your own API keys) on a
 * bearer session token -- deliberately not X-API-Key (an account has to be
 * able to fetch its first key without already holding one) and deliberately
 * not a cookie (see middleware/session.ts's doc comment for why a
 * cross-site cookie silently failed in real browsers). Reads
 * "Authorization: Bearer <token>", the same token login/signup return in
 * their response body. Attaches the authenticated account's id to
 * req.accountId for the route handler.
 */

import { Request, Response, NextFunction } from "express";
import { getBearerToken, decodeSessionToken } from "./session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      accountId?: number;
    }
  }
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  const token = getBearerToken(req.header("Authorization"));
  const payload = token ? decodeSessionToken(token) : null;
  if (!payload) {
    return res.status(401).json({ error: "Not logged in" });
  }

  req.accountId = payload.accountId;
  next();
}
