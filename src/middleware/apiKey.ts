/**
 * middleware/apiKey.ts
 *
 * Phase 8: this is now exactly middleware/apiKeyAuth.ts's mandatory,
 * DB-backed X-API-Key check -- re-exported under this historical name so
 * /api/uploads (the one route that still imports { requireApiKey } from
 * here directly) keeps working unchanged. requireAuth.ts re-exports the
 * same thing under its own name; the two were already doing equivalent
 * checks for the X-API-Key case and are now identical in every case.
 */

export { requireValidApiKey as requireApiKey } from "./apiKeyAuth";
