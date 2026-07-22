/**
 * middleware/session.ts
 *
 * Shared-login session handling (see routes/auth.ts). One team-wide
 * username/password (ADMIN_USERNAME / ADMIN_PASSWORD_HASH env vars, no user
 * table) -- a successful login gets a signed JWT stored in an httpOnly
 * cookie, not a server-side session store. Verifying a session is just
 * verifying the JWT's signature and expiry; nothing is looked up in the
 * database. This is a genuinely separate, additional gate in front of the
 * web app -- the existing X-API-Key scheme (middleware/apiKey.ts) is
 * untouched and keeps working exactly as it did before (see
 * middleware/requireAuth.ts, which accepts either).
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

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return secret;
}

/** Signs a new session token for the one shared admin login. */
export function signSessionToken(): string {
  return jwt.sign({ sub: "admin" }, getSecret(), { expiresIn: SESSION_TTL_SECONDS });
}

/** True if `token` is a validly-signed, unexpired session token. */
export function verifySessionToken(token: string): boolean {
  try {
    jwt.verify(token, getSecret());
    return true;
  } catch {
    return false;
  }
}
