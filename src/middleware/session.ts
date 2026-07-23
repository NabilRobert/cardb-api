/**
 * middleware/session.ts
 *
 * Session handling for the web app's login (see routes/auth.ts). As of
 * Phase 8, credentials are checked against real rows in the `accounts`
 * table (see db.ts) rather than a single ADMIN_USERNAME/ADMIN_PASSWORD_HASH
 * env-var pair -- the JWT payload carries the real account id/username so
 * routes/apiKeys.ts (which needs to know *which* account is asking) can
 * trust it. A successful login gets a signed JWT stored in an httpOnly
 * cookie, not a server-side session store -- verifying a session is just
 * verifying the JWT's signature and expiry, no DB lookup needed.
 *
 * This session is deliberately NOT an alternative to X-API-Key on the data
 * routes (see middleware/apiKeyAuth.ts) -- it only gates the web app's own
 * login-walled UI and the account/api-key management endpoints
 * (routes/apiKeys.ts, via middleware/requireSession.ts).
 */

import jwt from "jsonwebtoken";
import { CookieOptions } from "express";

export const SESSION_COOKIE_NAME = "session";

// 14 days: within the requested 7-30 day range, so the team isn't
// constantly re-logging in for a single shared login.
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  // The frontend is a separately deployed app on a different origin (see
  // server.ts's own doc comment), so the cookie must be sendable
  // cross-site -- SameSite=None requires Secure=true, which is already set
  // above (production is HTTPS-only behind nginx).
  sameSite: "none",
  maxAge: SESSION_TTL_SECONDS * 1000,
  path: "/",
};

export interface SessionPayload {
  accountId: number;
  username: string;
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return secret;
}

/** Signs a new session token for a real account (post Phase 8). */
export function signSessionToken(accountId: number, username: string): string {
  const payload: SessionPayload = { accountId, username };
  return jwt.sign(payload, getSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

/**
 * Verifies `token` and returns the decoded { accountId, username }, or null
 * if it's missing, expired, or invalid. Used by anything that needs to know
 * *which* account is logged in (routes/apiKeys.ts via requireSession).
 */
export function decodeSessionToken(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret());
    if (typeof decoded !== "object" || decoded === null) return null;
    const { accountId, username } = decoded as Partial<SessionPayload>;
    if (typeof accountId !== "number" || typeof username !== "string") return null;
    return { accountId, username };
  } catch {
    return null;
  }
}

/** True if `token` is a validly-signed, unexpired session token. Used by GET /api/auth/me. */
export function verifySessionToken(token: string): boolean {
  return decodeSessionToken(token) !== null;
}
