/**
 * middleware/requireAuth.ts
 *
 * Phase 8: this is now exactly middleware/apiKeyAuth.ts's mandatory,
 * DB-backed X-API-Key check -- re-exported under this historical name so
 * every route file that already imports { requireAuth } from here keeps
 * working unchanged. A session cookie is no longer an alternative path
 * here (previously it was); see apiKeyAuth.ts's doc comment for why.
 */

export { requireValidApiKey as requireAuth } from "./apiKeyAuth";
