/**
 * routes/auth.ts
 *
 * Shared login for the web app -- one team-wide username/password
 * (ADMIN_USERNAME / ADMIN_PASSWORD_HASH env vars), not per-user accounts.
 * A separate, additional gate in front of the web app itself; the existing
 * X-API-Key scheme (middleware/apiKey.ts) is untouched.
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
 * question safely for an unauthenticated caller too.
 */

import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS, signSessionToken, verifySessionToken } from "../middleware/session";

const router = Router();

router.post("/login", async (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD_HASH) {
    console.error("ADMIN_USERNAME / ADMIN_PASSWORD_HASH not set");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // bcrypt.compare is run regardless of whether the username already
  // failed, so a wrong username doesn't return faster than a wrong
  // password would -- one less timing signal for an attacker to use to
  // tell "bad username" apart from "bad password".
  const usernameOk = username === process.env.ADMIN_USERNAME;
  const passwordOk = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);

  if (!usernameOk || !passwordOk) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  const token = signSessionToken();
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
