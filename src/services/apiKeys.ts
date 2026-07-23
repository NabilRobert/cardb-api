/**
 * services/apiKeys.ts
 *
 * Raw API key generation and hashing (Phase 8). The raw key is 32 bytes of
 * cryptographic randomness (256 bits) -- already computationally infeasible
 * to guess -- so hashing it is purely about not storing the secret at rest,
 * not about slowing down brute-force the way bcrypt/argon2 do for
 * low-entropy human passwords. A fast, unsalted SHA-256 digest is the
 * correct tool here: it lets every request look the presented key up by an
 * indexed equality match (WHERE key_hash = $1) without the ~100ms+ per-call
 * cost bcrypt would add to literally every API request.
 */

import * as crypto from "crypto";

const KEY_PREFIX = "cardb_";
const KEY_BYTES = 32;

/** A brand-new raw key, e.g. "cardb_3f9a...". Never store this -- only hashApiKey(this). */
export function generateRawApiKey(): string {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString("hex");
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}
