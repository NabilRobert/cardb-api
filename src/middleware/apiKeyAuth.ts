/**
 * middleware/apiKeyAuth.ts
 *
 * Phase 8: the one, mandatory X-API-Key check, backed by the api_keys
 * table instead of a single static API_KEY env var. Every request to a
 * protected route hashes the presented key (services/apiKeys.ts#hashApiKey
 * -- SHA-256, not bcrypt; see that file for why) and looks up a matching,
 * non-revoked row (db.ts#findApiKeyByHash). No exceptions and no
 * alternative: a session cookie is NEVER a substitute for this, including
 * for the app's own frontend -- see middleware/session.ts and
 * middleware/requireSession.ts, which gate a completely separate set of
 * concerns (the web app's own login state, and the account/api-key
 * management endpoints).
 *
 * middleware/requireAuth.ts and middleware/apiKey.ts both re-export
 * requireValidApiKey under their historical names (requireAuth,
 * requireApiKey) so no route file needs to change its imports -- the two
 * were already doing equivalent things for the X-API-Key case, and are now
 * identical in every case.
 */

import { Request, Response, NextFunction } from "express";
import { hashApiKey } from "../services/apiKeys";
import { findApiKeyByHash, touchApiKeyLastUsed } from "../db";

export async function requireValidApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-API-Key");
  if (!key) {
    return res.status(401).json({ error: "Missing or invalid X-API-Key header" });
  }

  // Express 4 doesn't catch a rejected promise from an async middleware on
  // its own -- without this try/catch, a DB hiccup here would hang the
  // request forever instead of failing cleanly.
  let match;
  try {
    match = await findApiKeyByHash(hashApiKey(key));
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Failed to validate API key", detail: err.message });
  }

  if (!match) {
    return res.status(401).json({ error: "Missing or invalid X-API-Key header" });
  }

  // Fire-and-forget: never awaited, so a slow or failed write here can't
  // add latency or failure risk to an otherwise-valid request.
  touchApiKeyLastUsed(match.id).catch((err) => console.error("Failed to update api key last_used_at:", err));

  next();
}
