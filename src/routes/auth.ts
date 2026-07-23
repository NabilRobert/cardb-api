/**
 * routes/auth.ts
 *
 * Phase 8: login now checks a real row in the `accounts` table (db.ts)
 * instead of a single ADMIN_USERNAME/ADMIN_PASSWORD_HASH env-var pair --
 * see migration_add_accounts_and_api_keys.sql and
 * scripts/seed_admin_account.ts for how the previously-shared credential
 * became the first real account row. Request/response shapes are
 * unchanged from before Phase 8.
 *
 * POST /api/auth/login  - { username, password } -> { success: true } and
 *   sets an httpOnly session cookie. 401 on wrong credentials.
 * POST /api/auth/logout - clears the session cookie -> { success: true }.
 * GET  /api/auth/me     - { authenticated: boolean }, based on whatever
 *   session cookie (if any) came with the request. Never errors -- lets the
 *   frontend check auth state on page load without attempting a real
 *   protected call first.
 *
 * None of these three require requireAuth themselves -- logging in can't
 * require already being logged in, and /me's whole point is to answer that
 * question safely for an unauthenticated caller too. This session cookie is
 * NOT an alternative to X-API-Key on the data routes (see
 * middleware/apiKeyAuth.ts) -- it only gates this account's own login
 * state and the api-key management endpoints (routes/apiKeys.ts).
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS, signSessionToken, verifySessionToken } from "../middleware/session";
import { findAccountByUsername } from "../db";

const router = Router();

// A fixed, valid bcrypt hash of a string nobody will ever type as a real
// password -- compared against when the username doesn't match any
// account, so "unknown username" and "wrong password" take the same amount
// of time. Not a real credential, doesn't need to be secret; it's only
// here to keep bcrypt.compare's cost consistent regardless of which case
// triggered it.
const DUMMY_HASH = "$2b$12$XTzqmW0NIioLvfqtzSEnDOYXU984zQ1sbVfNAgcAgqkP4tBMDuYIG";

router.post("/login", async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  let account;
  try {
    account = await findAccountByUsername(username);
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: err.message });
  }

  // bcrypt.compare always runs, even against a dummy hash when the
  // username doesn't exist, so a wrong username doesn't return faster than
  // a wrong password would -- one less timing signal for an attacker to
  // use to enumerate valid usernames.
  const passwordOk = await bcrypt.compare(password, account?.password_hash ?? DUMMY_HASH);

  if (!account || !passwordOk) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = signSessionToken(account.id, account.username);
  res.cookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  res.json({ success: true });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.clearCookie(SESSION_COOKIE_NAME, { ...SESSION_COOKIE_OPTIONS, maxAge: undefined });
  res.json({ success: true });
});

router.get("/me", (req: Request, res: Response) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const authenticated = typeof token === "string" && verifySessionToken(token);
  res.json({ authenticated });
});

export default router;
