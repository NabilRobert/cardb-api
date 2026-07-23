/**
 * routes/apiKeys.ts
 *
 * Phase 8: lets a logged-in account manage its own API keys. Gated on
 * middleware/requireSession.ts (the session cookie only -- NOT X-API-Key;
 * see that file's doc comment for why). This is the only way a usable raw
 * key is ever produced or revealed anywhere in this API -- there is no
 * unauthenticated endpoint that returns a key.
 *
 * POST /api/auth/api-keys - generates a new key for the caller's own
 *   account. Response: { id, key, created_at }. `key` is the raw secret --
 *   it is returned here exactly once and never retrievable again; only
 *   its SHA-256 hash is stored (see services/apiKeys.ts, db.ts).
 *
 * GET /api/auth/api-keys - lists the caller's own keys: { id, account_id,
 *   created_at, last_used_at, revoked_at }[]. Never includes the key
 *   itself or its hash.
 *
 * POST /api/auth/api-keys/:id/revoke - revokes one of the caller's own
 *   keys (sets revoked_at = now()), which invalidates it for every future
 *   request immediately. Returns the updated row. 400 if :id isn't an
 *   integer, 404 if no such key exists for this account or it's already
 *   revoked.
 */

import { Router, Request, Response } from "express";
import { generateRawApiKey, hashApiKey } from "../services/apiKeys";
import { createApiKey, listApiKeysForAccount, revokeApiKey } from "../db";
import { requireSession } from "../middleware/requireSession";

const router = Router();

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

router.post("/", requireSession, async (req: Request, res: Response) => {
  try {
    const rawKey = generateRawApiKey();
    const row = await createApiKey(req.accountId as number, hashApiKey(rawKey));
    res.json({ id: row.id, key: rawKey, created_at: row.created_at });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to create API key", detail: err.message });
  }
});

router.get("/", requireSession, async (req: Request, res: Response) => {
  try {
    const keys = await listApiKeysForAccount(req.accountId as number);
    res.json(keys);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch API keys", detail: err.message });
  }
});

router.post("/:id/revoke", requireSession, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const revoked = await revokeApiKey(id, req.accountId as number);
    if (!revoked) {
      return res.status(404).json({ error: `No active API key found with id ${id}` });
    }
    res.json(revoked);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to revoke API key", detail: err.message });
  }
});

export default router;
