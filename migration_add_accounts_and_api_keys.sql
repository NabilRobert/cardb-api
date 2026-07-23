-- accounts: real per-user rows, replacing the single shared
-- ADMIN_USERNAME/ADMIN_PASSWORD_HASH env-var credential. Password hashing
-- (bcrypt) is unchanged in spirit -- same algorithm, just backed by a real
-- table now instead of a single env-var pair. See
-- src/scripts/seed_admin_account.ts for how the existing shared credential
-- gets migrated into a real row here (reads ADMIN_USERNAME/
-- ADMIN_PASSWORD_HASH from env at seed time -- no secret is ever written
-- into this migration file or any other committed file).
CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- api_keys: the actual random key is never stored, only key_hash (SHA-256
-- of the raw key). Unlike password_hash, this deliberately does NOT use
-- bcrypt/argon2 -- those add cost specifically to slow down brute-forcing a
-- low-entropy human password, which is pointless (and would add real
-- latency to every single API request) for a key that's already 256 bits
-- of cryptographic randomness and infeasible to guess regardless of hash
-- speed. See src/services/apiKeys.ts.
CREATE TABLE IF NOT EXISTS api_keys (
    id SERIAL PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ(3),
    revoked_at TIMESTAMPTZ(3)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_account_id ON api_keys (account_id);
-- key_hash already has a UNIQUE constraint (and therefore an index) from
-- above; the lookup on every request is WHERE key_hash = $1 AND
-- revoked_at IS NULL, which that index already serves directly.
