/**
 * routes/auth.ts
 *
 * Login/signup check real rows in the `accounts` table (db.ts). Session is
 * a bearer token in the response body, not a cookie -- see
 * middleware/session.ts's doc comment for why: a cross-site cookie here
 * (frontend and this API are on different registrable domains) was subject
 * to browser third-party-cookie blocking even with correct
 * SameSite=None; Secure attributes, so a real signup/login could appear to
 * succeed while the browser silently never stored or resent the cookie,
 * 401-ing on the very next session-gated call. This response-shape change
 * (adding `token`) is the fix for that; POST /api/auth/api-keys itself
 * (middleware/requireSession.ts) now reads "Authorization: Bearer <token>".
 *
 * POST /api/auth/signup - { username, password } -> { success: true, token }
 *   -- creates a new accounts row (bcrypt-hashed password). username must
 *   be non-empty (after trimming) and <= 64 chars; password must be >= 8
 *   chars. 400 on either validation failure, 409 if the username is
 *   already taken. The frontend stores `token` and sends it as
 *   "Authorization: Bearer <token>" on /api/auth/me, /api/auth/api-keys,
 *   etc. -- lets it chain straight into generating that account's first
 *   API key without a separate login round-trip.
 * POST /api/auth/login  - { username, password } -> { success: true, token }.
 *   401 on wrong credentials.
 * POST /api/auth/logout - { success: true }. The token is a stateless JWT
 *   with no server-side session record to revoke (same as before this was
 *   a cookie) -- this endpoint exists for symmetry/frontend bookkeeping;
 *   the frontend is what actually "logs out" by discarding its stored
 *   token.
 * GET  /api/auth/me     - { authenticated: boolean }, based on whatever
 *   bearer token (if any) came with the request. Never errors -- lets the
 *   frontend check auth state on load without attempting a real protected
 *   call first.
 *
 * None of these four require requireAuth themselves -- signing up/logging
 * in can't require already being logged in, and /me's whole point is to
 * answer that question safely for an unauthenticated caller too. This
 * session token is NOT an alternative to X-API-Key on the data routes (see
 * middleware/apiKeyAuth.ts) -- it only gates this account's own login
 * state and the api-key management endpoints (routes/apiKeys.ts).
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { signSessionToken, verifySessionToken, getBearerToken } from "../middleware/session";
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
    res.json({ success: true, token });
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
  res.json({ success: true, token });
});

router.post("/logout", (_req: Request, res: Response) => {
  res.json({ success: true });
});

router.get("/me", (req: Request, res: Response) => {
  const token = getBearerToken(req.header("Authorization"));
  const authenticated = typeof token === "string" && verifySessionToken(token);
  res.json({ authenticated });
});

export default router;
