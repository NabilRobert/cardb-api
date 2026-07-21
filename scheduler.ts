/**
 * scheduler.ts
 *
 * Nightly cron wiring for the notifications job (see notifications.ts).
 * Runs at 01:00 server time, after normal business hours. Started once
 * from server.ts; runNotificationsJob() itself has no dependency on cron
 * and is safe to call directly (e.g. from a one-off script for testing).
 */

import cron from "node-cron";
import { runNotificationsJob } from "./notifications";

export function startScheduler(): void {
  cron.schedule("0 1 * * *", async () => {
    try {
      const result = await runNotificationsJob();
      console.log("[notifications job]", JSON.stringify(result));
    } catch (err) {
      console.error("[notifications job] failed:", err);
    }
  });
}
