/**
 * scheduler.ts
 *
 * Cron wiring for the three background jobs:
 *   - notifications.ts's runNotificationsJob(): nightly at 01:00 Asia/Jakarta
 *     (WIB, UTC+7, no DST) -- after normal business hours for this
 *     Jakarta-based dealership.
 *   - reports.ts's runScheduledReportsJob(): every minute, since a
 *     scheduled report's own cron schedule can be as fine-grained as cron
 *     allows (minute resolution) -- this just checks who's due, it doesn't
 *     run every report every minute. "Due" itself is computed against
 *     Asia/Jakarta too (see reports.ts's isDue) -- the per-minute trigger
 *     here fires the same regardless of timezone (every minute is every
 *     minute everywhere), the timezone option below is just for
 *     consistency with the nightly job and node-cron's own bookkeeping.
 *   - marcus.ts's runMarcusJob(): also every minute, same reasoning --
 *     Marcus's own configurable schedule (marcus_config, see
 *     routes/marcus.ts) decides whether a heartbeat is actually due (see
 *     marcus.ts's isMarcusDue). Registered as its own cron.schedule block
 *     with its own try/catch, so a Marcus failure can never affect the
 *     notifications/reports ticks or vice versa.
 * All three are started once from server.ts. None of the jobs depend on
 * cron itself to run -- all are safe to call directly (e.g. from a one-off
 * script for testing).
 */

import cron from "node-cron";
import { runNotificationsJob } from "./notifications";
import { runScheduledReportsJob } from "./reports";
import { runMarcusJob } from "./marcus";

const JAKARTA_TZ = "Asia/Jakarta";

export function startScheduler(): void {
  cron.schedule(
    "0 1 * * *",
    async () => {
      try {
        const result = await runNotificationsJob();
        console.log("[notifications job]", JSON.stringify(result));
      } catch (err) {
        console.error("[notifications job] failed:", err);
      }
    },
    { timezone: JAKARTA_TZ }
  );

  cron.schedule(
    "* * * * *",
    async () => {
      try {
        const result = await runScheduledReportsJob();
        if (result.ran > 0) console.log("[scheduled reports job]", JSON.stringify(result));
      } catch (err) {
        console.error("[scheduled reports job] failed:", err);
      }
    },
    { timezone: JAKARTA_TZ }
  );

  cron.schedule(
    "* * * * *",
    async () => {
      try {
        const result = await runMarcusJob();
        if (result.ran) console.log("[marcus job]", JSON.stringify(result));
      } catch (err) {
        console.error("[marcus job] failed:", err);
      }
    },
    { timezone: JAKARTA_TZ }
  );
}
