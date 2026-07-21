/**
 * reports.ts
 *
 * Scheduled "Ask AI" reports: periodically checks scheduled_reports for
 * anything due to run (per its cron schedule), answers the question through
 * the existing ai.ts#askQuestion pipeline -- the same one POST /api/ask
 * uses, no separate question->SQL->summary logic here -- and inserts the
 * result as a notification (type "scheduled_report", see db.ts's
 * insertNotification).
 *
 * runScheduledReportsJob() is what scheduler.ts calls every minute. It's
 * also safe to call directly (e.g. for manual testing).
 */

import { CronExpressionParser } from "cron-parser";
import { askQuestion } from "./ai";
import { ScheduledReport, getEnabledScheduledReports, markScheduledReportRun, insertNotification } from "./db";

// A report is due once the next scheduled occurrence after its last run (or
// after its creation, if it's never run) has passed. Evaluated in UTC so
// behavior doesn't depend on the server process's local timezone setting.
function isDue(report: ScheduledReport, now: Date): boolean {
  const baseline = new Date(report.last_run_at ?? report.created_at);
  try {
    const interval = CronExpressionParser.parse(report.schedule, { currentDate: baseline, tz: "UTC" });
    return interval.next().toDate() <= now;
  } catch {
    // routes/scheduledReports.ts validates the cron expression on
    // create/update, so this should be unreachable -- but a bad schedule
    // shouldn't crash the whole job either way. Treat as never-due.
    return false;
  }
}

async function runReport(report: ScheduledReport, now: Date): Promise<void> {
  try {
    const result = await askQuestion(report.question);
    if (result.status === "needs_clarification") {
      // Flagged with a distinct severity (not "info") specifically so it
      // doesn't fail silently -- someone needs to reword the question.
      await insertNotification({
        type: "scheduled_report",
        severity: "needs_clarification",
        message: `Scheduled report "${report.name}" couldn't run: ${result.message} (the question needs to be reworded)`,
        scheduled_report_id: report.id,
      });
    } else {
      await insertNotification({
        type: "scheduled_report",
        severity: "info",
        message: result.summary,
        scheduled_report_id: report.id,
      });
    }
  } catch (err: any) {
    await insertNotification({
      type: "scheduled_report",
      severity: "error",
      message: `Scheduled report "${report.name}" failed to run: ${err.message}`,
      scheduled_report_id: report.id,
    });
  } finally {
    // Advances last_run_at regardless of outcome, so a persistently broken
    // question surfaces once per scheduled occurrence rather than being
    // retried every minute until fixed.
    await markScheduledReportRun(report.id, now);
  }
}

export interface ReportsJobResult {
  checked: number;
  ran: number;
}

export async function runScheduledReportsJob(): Promise<ReportsJobResult> {
  const now = new Date();
  const reports = await getEnabledScheduledReports();
  const due = reports.filter((r) => isDue(r, now));
  for (const report of due) {
    await runReport(report, now);
  }
  return { checked: reports.length, ran: due.length };
}
