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
 * POST /api/auth/signup - { username, password } -> { success: true } and
 *   sets an httpOnly session cookie, same as login -- creates a new
 *   accounts row (bcrypt-hashed password) so the frontend can chain
 *   straight into POST /api/auth/api-keys for that account's first key
 *   without a separate login round-trip. username must be non-empty (after
 *   trimming) and <= 64 chars; password must be >= 8 chars. 400 on either
 *   validation failure, 409 if the username is already taken.
 * POST /api/auth/login  - { username, password } -> { success: true } and
 *   sets an httpOnly session cookie. 401 on wrong credentials.
 * POST /api/auth/logout - clears the session cookie -> { success: true }.
 * GET  /api/auth/me     - { authenticated: boolean }, based on whatever
 *   session cookie (if any) came with the request. Never errors -- lets the
 *   frontend check auth state on page load without attempting a real
 *   protected call first.
 *
 * None of these four require requireAuth themselves -- signing up/logging
 * in can't require already being logged in, and /me's whole point is to
 * answer that question safely for an unauthenticated caller too. This
 * session cookie is NOT an alternative to X-API-Key on the data routes (see
 * middleware/apiKeyAuth.ts) -- it only gates this account's own login
 * state and the api-key management endpoints (routes/apiKeys.ts).
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS, signSessionToken, verifySessionToken } from "../middleware/session";
import { findAccountByUsername, createAccount } from "../db";

const router = Router();

// A fixed, valid bcrypt hash of a string nobody will ever type as a real
// password -- compared against when the username doesn't match any
// account, so "unknown username" and "wrong password" take the same amount
// of time. Not a real credential, doesn't need to be secret; it's only
// here to keep bcrypt.compare's cost consistent regardless of which case
// triggered it.
const DUMMY_HASH = "$2b$12$XTzqmW0NIioLvfqtzSEnDOYXU984zQ1sbVfNAgcAgqkP4tBMDuYIG";

const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 64;
const BCRYPT_COST = 12; // matches the existing seeded account's hash cost

// Postgres's error code for a unique-constraint violation -- backstop for
// the (rare) race where two signups for the same username land between the
// pre-check below and the insert; maps to the same 409 a normal duplicate
// gets, instead of leaking a raw 500.
const PG_UNIQUE_VIOLATION = "23505";

router.post("/signup", async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || username.trim() === "") {
    return res.status(400).json({ error: "username is required and must be non-empty" });
  }
  const trimmedUsername = username.trim();
  if (trimmedUsername.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: `username must be ${MAX_USERNAME_LENGTH} characters or fewer` });
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  try {
    const existing = await findAccountByUsername(trimmedUsername);
    if (existing) {
      return res.status(409).json({ error: "That username is already taken" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    let account;
    try {
      account = await createAccount(trimmedUsername, passwordHash);
    } catch (err: any) {
      if (err.code === PG_UNIQUE_VIOLATION) {
        return res.status(409).json({ error: "That username is already taken" });
      }
      throw err;
    }

    const token = signSessionToken(account.id, account.username);
    res.cookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
    res.json({ success: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: err.message });
  }
});

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
