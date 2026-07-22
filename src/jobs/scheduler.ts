/**
 * scheduler.ts
 *
 * Cron wiring for the two background jobs:
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
 * Both are started once from server.ts. Neither job depends on cron itself
 * to run -- both are safe to call directly (e.g. from a one-off script for
 * testing).
 */

import cron from "node-cron";
import { runNotificationsJob } from "./notifications";
import { runScheduledReportsJob } from "./reports";

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
}
