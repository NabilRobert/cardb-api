/**
 * scripts/seed_admin_account.ts
 *
 * One-time seed for Phase 8: migrates the previously-shared
 * ADMIN_USERNAME/ADMIN_PASSWORD_HASH env-var credential into a real row in
 * the new `accounts` table, so the existing shared login keeps working --
 * same username/password -- without changing behavior for the frontend's
 * existing login flow. Reads the username/hash from env at run time; no
 * secret is ever written into this file or any other committed file.
 *
 * Idempotent: does nothing (just logs and exits) if an account with that
 * username already exists, so re-running this is always safe.
 *
 * Usage: npx ts-node src/scripts/seed_admin_account.ts
 * (or: npm run seed:admin)
 */

import * as dotenv from "dotenv";
import { findAccountByUsername, createAccount, pool } from "../db";

dotenv.config();

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!username || !passwordHash) {
    console.error("ADMIN_USERNAME / ADMIN_PASSWORD_HASH not set -- nothing to seed.");
    process.exitCode = 1;
    return;
  }

  const existing = await findAccountByUsername(username);
  if (existing) {
    console.log(`Account "${username}" already exists (id ${existing.id}) -- nothing to do.`);
    return;
  }

  const account = await createAccount(username, passwordHash);
  console.log(`Created account "${account.username}" (id ${account.id}).`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
