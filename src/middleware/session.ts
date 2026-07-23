/**
 * middleware/session.ts
 *
 * Session handling for the web app's login (see routes/auth.ts). Credentials
 * are checked against real rows in the `accounts` table (see db.ts). A
 * successful login/signup gets a signed JWT -- verifying a session is just
 * verifying the JWT's signature and expiry, no DB lookup or server-side
 * session store needed.
 *
 * Bearer token, not a cookie (post-investigation fix): this was originally
 * an httpOnly SameSite=None cookie, which is spec-correct for cross-site
 * use but still not reliably delivered in real browsers -- SameSite=None
 * only opts a cookie out of *SameSite* blocking, it does NOT exempt it from
 * separate third-party-cookie blocking (Safari ITP, Firefox Total Cookie
 * Protection, Chrome's third-party cookie deprecation), which applies here
 * regardless because the frontend and this API are on different registrable
 * domains. That let a real signup/login appear to succeed (the 200 response
 * itself is unaffected) while the browser silently never stored or resent
 * the cookie, so the very next session-gated call 401'd. A bearer token in
 * a normal header isn't subject to any of that -- it's exactly why
 * X-API-Key already works fine cross-site (see middleware/apiKeyAuth.ts).
 *
 * This session is deliberately NOT an alternative to X-API-Key on the data
 * routes -- it only gates the web app's own login-walled UI and the
 * account/api-key management endpoints (routes/apiKeys.ts, via
 * middleware/requireSession.ts).
 */

import jwt from "jsonwebtoken";

// 14 days: within the requested 7-30 day range, so the team isn't
// constantly re-logging in for a single shared login.
const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

export interface SessionPayload {
  accountId: number;
  username: string;
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return secret;
}

/** Signs a new session token for a real account. Returned in the login/signup response body. */
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

/** Pulls the raw token out of a standard "Authorization: Bearer <token>" header, if present. */
export function getBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader?.startsWith("Bearer ")) return undefined;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  return token || undefined;
}
