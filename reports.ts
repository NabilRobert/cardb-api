/**
 * reports.ts
 *
 * Scheduled "Ask AI" reports: periodically checks scheduled_reports for
 * anything due to run (per its cron schedule), answers the question through
 * the existing ai.ts#askQuestion pipeline -- the same one POST /api/ask
 * uses, no separate question->SQL->summary logic here -- and records the
 * result in two places: a notification (type "scheduled_report", bell-alert
 * facing, see db.ts's insertNotification) and a report_runs row (durable
 * history for the Reports page, independent of notification retention/
 * read-state, see db.ts's insertReportRun). Both happen on every run, one
 * doesn't replace the other.
 *
 * runScheduledReportsJob() is what scheduler.ts calls every minute.
 * runScheduledReportNow() is the single-report primitive it's built on --
 * also called directly by POST /api/scheduled-reports/:id/run-now (see
 * routes/scheduledReports.ts) so the manual-trigger and cron paths are
 * exactly the same code, never two implementations to keep in sync.
 */

import { CronExpressionParser } from "cron-parser";
import { askQuestion } from "./ai";
import {
  ScheduledReport,
  NotificationRow,
  ReportRunStatus,
  getEnabledScheduledReports,
  markScheduledReportRun,
  insertNotification,
  insertReportRun,
} from "./db";

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

// Runs one report right now, regardless of its schedule -- used both by the
// due-check loop below and by the manual POST /:id/run-now trigger. Always
// inserts exactly one notification AND one report_runs row (same content),
// and advances last_run_at, whatever the outcome, so a persistently broken
// question surfaces once per invocation rather than being retried
// indefinitely.
export async function runScheduledReportNow(report: ScheduledReport, now: Date = new Date()): Promise<NotificationRow> {
  let notification: NotificationRow;
  let runStatus: ReportRunStatus;
  let runSummary: string;
  let runSql: string | null = null;

  try {
    const result = await askQuestion(report.question);
    if (result.status === "needs_clarification") {
      // Flagged with a distinct severity (not "info") specifically so it
      // doesn't fail silently -- someone needs to reword the question.
      runStatus = "needs_clarification";
      runSummary = `Scheduled report "${report.name}" couldn't run: ${result.message} (the question needs to be reworded)`;
      notification = await insertNotification({
        type: "scheduled_report",
        severity: "needs_clarification",
        message: runSummary,
        scheduled_report_id: report.id,
      });
    } else {
      runStatus = "answered";
      runSummary = result.summary;
      runSql = result.sql;
      notification = await insertNotification({
        type: "scheduled_report",
        severity: "info",
        message: runSummary,
        scheduled_report_id: report.id,
      });
    }
  } catch (err: any) {
    runStatus = "error";
    runSummary = `Scheduled report "${report.name}" failed to run: ${err.message}`;
    notification = await insertNotification({
      type: "scheduled_report",
      severity: "error",
      message: runSummary,
      scheduled_report_id: report.id,
    });
  }

  await insertReportRun({
    scheduled_report_id: report.id,
    question: report.question,
    status: runStatus,
    summary: runSummary,
    sql: runSql,
  });
  await markScheduledReportRun(report.id, now);
  return notification;
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
    await runScheduledReportNow(report, now);
  }
  return { checked: reports.length, ran: due.length };
}
