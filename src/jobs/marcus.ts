/**
 * jobs/marcus.ts
 *
 * Marcus: a proactive whole-business heartbeat, distinct from
 * scheduled-reports (jobs/reports.ts), which re-runs one fixed question.
 * Every heartbeat computes 9 fixed categories (see
 * services/marcusCategories.ts), computes a since-last-heartbeat delta and a
 * single "top mover" per category in plain code, gathers recent Scheduled
 * Reports findings ("rain-awareness") so the narrative can reference rather
 * than repeat them, writes a grounded AI narrative on top
 * (services/ai.ts#generateMarcusNarrative), and freezes the whole thing as
 * one immutable row in marcus_heartbeats -- Marcus's Archive.
 *
 * runMarcusHeartbeatNow() is the single shared primitive, called both by the
 * per-minute due-check below and directly by POST /api/marcus/run-now (see
 * routes/marcus.ts) -- exactly the same code either way, never two
 * implementations to keep in sync (mirrors jobs/reports.ts's
 * runScheduledReportNow).
 *
 * Per-category failures never fail the whole heartbeat: each of the 9 runs
 * through computeCategorySafely, which turns a thrown error (or an AI
 * category's needs_clarification response) into
 * { severity: "unknown", note }. The heartbeat's own `status` field
 * ("ok" | "partial_error") reflects computation completeness only -- a
 * fully successful heartbeat can still have individual categories at
 * "attention"; that's the normal case, not a failure.
 */

import { CronExpressionParser } from "cron-parser";
import {
  MarcusConfig,
  MarcusHeartbeat,
  MarcusHeartbeatStatus,
  getMarcusConfig,
  markMarcusConfigRun,
  insertMarcusHeartbeat,
  getLatestMarcusHeartbeat,
  getMarcusHeartbeatHistoryForBaseline,
  getRecentAnsweredReportRuns,
} from "../db";
import { generateMarcusNarrative, MarcusNarrative } from "../services/ai";
import {
  CATEGORY_SLUGS,
  CategorySlug,
  CategoryResult,
  CategorySeverity,
  HeartbeatHistoryEntry,
  INVENTORY_BASELINE_MAX_HEARTBEATS,
  getHeadlineMetric,
  computeInventoryHealth,
  computeAgingInventory,
  computeSalesVelocity,
  computeStnkCompliance,
  computePricingSignals,
  computeDataHygiene,
  computeStalledBookings,
  computeDiscountDrift,
  computeFinancialSnapshot,
} from "../services/marcusCategories";

// How far back to look for "rain" (recently-answered Scheduled Reports) to
// pass into the narrative prompt.
const RAIN_CONTEXT_WINDOW_DAYS = 7;
const RAIN_CONTEXT_MAX_REPORTS = 10;

// A heartbeat is due once the next scheduled occurrence after its last run
// (or after marcus_config's creation, if it's never run) has passed,
// evaluated against Asia/Jakarta -- exactly mirrors jobs/reports.ts's isDue.
export function isMarcusDue(config: MarcusConfig, now: Date): boolean {
  if (!config.enabled) return false;
  const baseline = new Date(config.last_run_at ?? config.created_at);
  try {
    const interval = CronExpressionParser.parse(config.schedule, { currentDate: baseline, tz: "Asia/Jakarta" });
    return interval.next().toDate() <= now;
  } catch {
    // routes/marcus.ts validates the cron expression on update, so this
    // should be unreachable -- but a bad schedule shouldn't crash the job.
    return false;
  }
}

async function computeCategorySafely(fn: () => Promise<CategoryResult>): Promise<{ result: CategoryResult; failed: boolean }> {
  try {
    const result = await fn();
    return { result, failed: result.severity.severity === "unknown" };
  } catch (err: any) {
    console.error("[marcus] category computation failed:", err);
    return {
      result: { metrics: null, severity: { severity: "unknown", note: err.message } },
      failed: true,
    };
  }
}

// Runs one heartbeat right now, regardless of marcus_config's schedule/
// enabled state -- used both by the due-check loop below and by the manual
// POST /api/marcus/run-now trigger.
export async function runMarcusHeartbeatNow(now: Date = new Date()): Promise<MarcusHeartbeat> {
  const history: HeartbeatHistoryEntry[] = (await getMarcusHeartbeatHistoryForBaseline(
    INVENTORY_BASELINE_MAX_HEARTBEATS
  )) as HeartbeatHistoryEntry[];
  const isFirstHeartbeat = history.length === 0;

  const computations: Record<CategorySlug, () => Promise<CategoryResult>> = {
    inventory_health: () => computeInventoryHealth(history),
    aging_inventory: () => computeAgingInventory(history),
    sales_velocity: () => computeSalesVelocity(),
    stnk_compliance: () => computeStnkCompliance(),
    pricing_signals: () => computePricingSignals(),
    data_hygiene: () => computeDataHygiene(),
    stalled_bookings: () => computeStalledBookings(),
    discount_drift: () => computeDiscountDrift(history),
    financial_snapshot: () => computeFinancialSnapshot(history),
  };

  let anyFailed = false;
  const metrics: Record<string, unknown> = {};
  const severities: Record<string, CategorySeverity> = {};

  for (const slug of CATEGORY_SLUGS) {
    const { result, failed } = await computeCategorySafely(computations[slug]);
    metrics[slug] = result.metrics;
    severities[slug] = result.severity;
    if (failed) anyFailed = true;
  }

  // Since-last-heartbeat deltas + a single top mover, both computed in plain
  // code from each category's headline metric (see marcusCategories.ts's
  // getHeadlineMetric) -- never by the AI.
  const previousHeartbeat = await getLatestMarcusHeartbeat();
  const deltas: Record<string, unknown> = {};
  let topMover: { category: string; headline_metric: string; delta_pct: number } | null = null;
  let topMoverAbsPct = -1;

  for (const slug of CATEGORY_SLUGS) {
    const current = getHeadlineMetric(slug, metrics[slug] as Record<string, unknown> | null);
    const previous = previousHeartbeat
      ? getHeadlineMetric(slug, ((previousHeartbeat.metrics as any)?.[slug] as Record<string, unknown> | null) ?? null)
      : null;

    if (current === null || previous === null) {
      deltas[slug] = { headline_metric: slug, current, previous: null, delta: null, delta_pct: null };
      continue;
    }

    const delta = current - previous;
    const deltaPct = previous !== 0 ? (delta / Math.abs(previous)) * 100 : null;
    deltas[slug] = { headline_metric: slug, current, previous, delta, delta_pct: deltaPct };

    if (deltaPct !== null && Math.abs(deltaPct) > topMoverAbsPct) {
      topMoverAbsPct = Math.abs(deltaPct);
      topMover = { category: slug, headline_metric: slug, delta_pct: deltaPct };
    }
  }

  const rainContext = await getRecentAnsweredReportRuns(RAIN_CONTEXT_WINDOW_DAYS, RAIN_CONTEXT_MAX_REPORTS);

  let narrative: MarcusNarrative;
  try {
    const generated = await generateMarcusNarrative({
      metrics,
      severities,
      deltas,
      topMover,
      rainContext,
      isFirstHeartbeat,
    });
    narrative = generated.narrative;
  } catch (err) {
    // Same graceful-degradation precedent as reports.ts's
    // generateNarrativeSafely -- a broken narrative call never blocks the
    // heartbeat; metrics/severities/deltas are already valid and get stored
    // regardless.
    console.error("[marcus] narrative generation failed:", err);
    narrative = { overall: "", categories: {}, parse_ok: false };
  }

  const status: MarcusHeartbeatStatus = anyFailed ? "partial_error" : "ok";

  const heartbeat = await insertMarcusHeartbeat({
    status,
    metrics,
    severities,
    deltas,
    top_mover: topMover,
    rain_context: rainContext,
    narrative: narrative as unknown as Record<string, unknown>,
  });

  await markMarcusConfigRun(now);
  return heartbeat;
}

export interface MarcusJobResult {
  ran: boolean;
  heartbeatId?: number;
}

export async function runMarcusJob(): Promise<MarcusJobResult> {
  const now = new Date();
  const config = await getMarcusConfig();
  if (!isMarcusDue(config, now)) {
    return { ran: false };
  }
  const heartbeat = await runMarcusHeartbeatNow(now);
  return { ran: true, heartbeatId: heartbeat.id };
}
