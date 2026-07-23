/**
 * marcusCategories.ts
 *
 * The 9 category computations behind Marcus's heartbeat (see jobs/marcus.ts
 * for orchestration). Severity (ok/watch/attention/unknown) is always
 * computed here, in plain code, from numbers/rows that have already been
 * fetched -- never decided by the AI, even for the categories that use the
 * AI question-to-SQL pipeline below.
 *
 * Split (confirmed with the user before implementation):
 *   - inventory_health, aging_inventory, stnk_compliance: reuse the exact
 *     tested functions/threshold constants already built for the nightly
 *     notifications job (db.ts's getAvailableCountsByGroup/
 *     getAgingInventoryCandidates/getStnkExpiryCandidates, and
 *     jobs/notifications.ts's AGING_TIERS/STNK_EXPIRY_WINDOW_DAYS), rather
 *     than reinventing them.
 *   - sales_velocity: also direct SQL (db.ts's getSalesVelocityStats) --
 *     discovered during design to be fully deterministic (real
 *     handover_date/updated_at columns, no ambiguity), so there's no benefit
 *     to routing it through an AI SQL-gen step either.
 *   - pricing_signals, data_hygiene, stalled_bookings, discount_drift,
 *     financial_snapshot: no existing query covers these, so each is a fixed
 *     internal question run through ai.ts#askQuestion -- the same gpt-5-mini
 *     question-to-SQL-to-rows pipeline that powers Ask Emily/Scheduled
 *     Reports. Since askQuestion only guarantees valid SQL against
 *     `vehicles`, not a fixed row shape, every reader below defensively
 *     skips rows with missing/non-numeric fields (counted in skipped_rows)
 *     rather than crashing the heartbeat.
 *
 * Two categories (inventory_health, aging_inventory) and one more
 * (discount_drift) also need a trailing-average/trend baseline that
 * `vehicles` itself can't provide (it's a live snapshot, not a time series)
 * -- these are self-bootstrapped from Marcus's own heartbeat archive
 * (`history`, passed in by jobs/marcus.ts via db.ts's
 * getMarcusHeartbeatHistoryForBaseline). On the very first heartbeat
 * (history.length === 0), the trend-dependent part of that category is
 * marked insufficient_history and forced to severity "ok" -- there's
 * nothing to compare against yet, so nothing is flagged.
 *
 * "Listed price" (used by discount_drift and financial_snapshot, wherever a
 * single pre-discount price figure is needed) is price_cash, falling back
 * to price_credit -- there's no schema column distinguishing an original
 * listed price from price_net, so this is a documented assumption, not a
 * schema fact.
 */

import {
  getAvailableCountsByGroup,
  getAgingInventoryCandidates,
  getStnkExpiryCandidates,
  getSalesVelocityStats,
} from "../db";
import { AGING_TIERS, AGING_TIER_RANK, STNK_EXPIRY_WINDOW_DAYS } from "../jobs/notifications";
import { askQuestion } from "./ai";

export const CATEGORY_SLUGS = [
  "inventory_health",
  "aging_inventory",
  "sales_velocity",
  "stnk_compliance",
  "pricing_signals",
  "data_hygiene",
  "stalled_bookings",
  "discount_drift",
  "financial_snapshot",
] as const;
export type CategorySlug = (typeof CATEGORY_SLUGS)[number];

export type SeverityLevel = "ok" | "watch" | "attention" | "unknown";

export interface CategorySeverity {
  severity: SeverityLevel;
  note?: string;
  insufficient_history?: boolean;
  skipped_rows?: number;
}

export interface CategoryResult {
  metrics: Record<string, unknown> | null;
  severity: CategorySeverity;
}

export interface HeartbeatHistoryEntry {
  created_at: string;
  metrics: Record<string, unknown>;
}

// -- thresholds, named rather than inlined (mirrors jobs/notifications.ts's style) --
export const INVENTORY_BASELINE_MAX_HEARTBEATS = 90;
export const INVENTORY_HEALTH_ATTENTION_RATIO = 0.5;
export const INVENTORY_HEALTH_WATCH_RATIO = 0.8;

export const AGING_TREND_INCREASE_PCT = 10;

export const SALES_VELOCITY_ATTENTION_RATIO = 0.5;
export const SALES_VELOCITY_WATCH_RATIO = 0.8;

export const PRICING_MIN_GROUP_SIZE = 3;
export const PRICING_OUTLIER_WATCH_PCT = 20;
export const PRICING_OUTLIER_ATTENTION_PCT = 35;

export const DATA_HYGIENE_WATCH_COUNT = 1;
export const DATA_HYGIENE_ATTENTION_COUNT = 10;

export const STALLED_BOOKING_WATCH_DAYS = 14;
export const STALLED_BOOKING_ATTENTION_DAYS = 30;

export const DISCOUNT_DRIFT_WATCH_PCT = 10;
export const DISCOUNT_DRIFT_ATTENTION_PCT = 25;

export const FINANCIAL_SNAPSHOT_DROP_PCT = 15;

const SEVERITY_ORDER: SeverityLevel[] = ["ok", "watch", "attention"];
function bumpSeverity(s: SeverityLevel): SeverityLevel {
  const idx = SEVERITY_ORDER.indexOf(s);
  if (idx === -1) return s;
  return SEVERITY_ORDER[Math.min(idx + 1, SEVERITY_ORDER.length - 1)];
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function groupKey(brand: string, modelTrim: string): string {
  return `${brand} :: ${modelTrim}`;
}

// ---------------------------------------------------------------------------
// 1. inventory_health -- direct reuse
// ---------------------------------------------------------------------------
export async function computeInventoryHealth(history: HeartbeatHistoryEntry[]): Promise<CategoryResult> {
  const current = await getAvailableCountsByGroup();
  const groupsOut: Record<string, number> = {};
  for (const g of current) groupsOut[groupKey(g.brand, g.model_trim)] = g.count;

  const insufficientHistory = history.length === 0;
  let worstGroup: string | null = null;
  let worstRatio = Infinity;

  if (!insufficientHistory) {
    const historicalValues = new Map<string, number[]>();
    for (const h of history) {
      const groups = (h.metrics?.inventory_health as any)?.groups as Record<string, unknown> | undefined;
      if (!groups) continue;
      for (const [key, count] of Object.entries(groups)) {
        const n = toNumber(count);
        if (n === null) continue;
        if (!historicalValues.has(key)) historicalValues.set(key, []);
        historicalValues.get(key)!.push(n);
      }
    }
    for (const [key, currentCount] of Object.entries(groupsOut)) {
      const priorValues = historicalValues.get(key);
      if (!priorValues || priorValues.length === 0) continue;
      const baseline = priorValues.reduce((a, b) => a + b, 0) / priorValues.length;
      if (baseline <= 0) continue;
      const ratio = currentCount / baseline;
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worstGroup = key;
      }
    }
  }

  let severity: CategorySeverity;
  if (insufficientHistory) {
    severity = {
      severity: "ok",
      insufficient_history: true,
      note: "No prior heartbeat to compare against -- this heartbeat establishes the baseline.",
    };
  } else if (worstGroup === null) {
    severity = { severity: "ok", note: "No group had enough prior history to compare against yet." };
  } else if (worstRatio < INVENTORY_HEALTH_ATTENTION_RATIO) {
    severity = { severity: "attention", note: `${worstGroup} is at ${(worstRatio * 100).toFixed(0)}% of its trailing average available count.` };
  } else if (worstRatio < INVENTORY_HEALTH_WATCH_RATIO) {
    severity = { severity: "watch", note: `${worstGroup} is at ${(worstRatio * 100).toFixed(0)}% of its trailing average available count.` };
  } else {
    severity = { severity: "ok" };
  }

  return {
    metrics: { groups: groupsOut, worst_group: worstGroup, worst_ratio: worstGroup ? worstRatio : null },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 2. aging_inventory -- direct reuse
// ---------------------------------------------------------------------------
export async function computeAgingInventory(history: HeartbeatHistoryEntry[]): Promise<CategoryResult> {
  const candidates = await getAgingInventoryCandidates(0);
  const buckets = { "0_30": 0, "31_60": 0, "61_90": 0, "90_plus": 0 };
  let totalDays = 0;
  let worstTierSeverity: string | null = null;

  for (const c of candidates) {
    const d = c.days_on_lot;
    if (d <= 30) buckets["0_30"]++;
    else if (d <= 60) buckets["31_60"]++;
    else if (d <= 90) buckets["61_90"]++;
    else buckets["90_plus"]++;
    totalDays += d;

    const tier = AGING_TIERS.find((t) => d >= t.days);
    if (tier && (worstTierSeverity === null || AGING_TIER_RANK[tier.severity] > AGING_TIER_RANK[worstTierSeverity])) {
      worstTierSeverity = tier.severity;
    }
  }
  const avgAgeDays = candidates.length > 0 ? totalDays / candidates.length : 0;

  // Map notifications.ts's notice/warning/critical vocabulary onto Marcus's ok/watch/attention.
  const baseSeverity: SeverityLevel =
    worstTierSeverity === "critical" ? "attention" : worstTierSeverity ? "watch" : "ok";

  const insufficientHistory = history.length === 0;
  let severity: CategorySeverity;
  if (insufficientHistory) {
    severity = {
      severity: baseSeverity,
      insufficient_history: true,
      note: "No prior heartbeat to compare the average-age trend against -- this heartbeat establishes the baseline.",
    };
  } else {
    const prevAvgAge = toNumber((history[0].metrics?.aging_inventory as any)?.avg_age_days);
    let finalSeverity: SeverityLevel = baseSeverity;
    let note: string | undefined;
    if (prevAvgAge !== null && prevAvgAge > 0) {
      const changePct = ((avgAgeDays - prevAvgAge) / prevAvgAge) * 100;
      if (changePct >= AGING_TREND_INCREASE_PCT) {
        finalSeverity = bumpSeverity(baseSeverity);
        note = `Average age on lot rose ${changePct.toFixed(1)}% since the last heartbeat.`;
      }
    }
    severity = { severity: finalSeverity, note };
  }

  return {
    metrics: { buckets, avg_age_days: avgAgeDays, candidate_count: candidates.length },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 3. sales_velocity -- direct SQL (flagged deviation from the letter of the
// confirmed split, see file doc comment above)
// ---------------------------------------------------------------------------
export async function computeSalesVelocity(): Promise<CategoryResult> {
  const stats = await getSalesVelocityStats();
  const totalThisWeek = stats.sold_this_week + stats.booked_this_week;
  const trailingAvgSoldPerWeek = stats.sold_trailing_4weeks / 4;

  let severity: CategorySeverity;
  if (trailingAvgSoldPerWeek <= 0) {
    severity = { severity: "ok", note: "No trailing sales history to compare against yet." };
  } else {
    const ratio = totalThisWeek / trailingAvgSoldPerWeek;
    if (ratio < SALES_VELOCITY_ATTENTION_RATIO) {
      severity = { severity: "attention", note: `This week's sold+booked total is ${(ratio * 100).toFixed(0)}% of the trailing 4-week average.` };
    } else if (ratio < SALES_VELOCITY_WATCH_RATIO) {
      severity = { severity: "watch", note: `This week's sold+booked total is ${(ratio * 100).toFixed(0)}% of the trailing 4-week average.` };
    } else {
      severity = { severity: "ok" };
    }
  }

  return {
    metrics: {
      sold_this_week: stats.sold_this_week,
      booked_this_week: stats.booked_this_week,
      total_this_week: totalThisWeek,
      trailing_4week_avg_sold_per_week: trailingAvgSoldPerWeek,
    },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 4. stnk_compliance -- direct reuse. Always surfaced/non-"ok" if anything
// is inside the window, per explicit requirement.
// ---------------------------------------------------------------------------
export async function computeStnkCompliance(): Promise<CategoryResult> {
  const candidates = await getStnkExpiryCandidates(STNK_EXPIRY_WINDOW_DAYS);
  const expiredCount = candidates.filter((c) => c.days_diff < 0).length;
  const expiringSoonCount = candidates.length - expiredCount;

  let severity: CategorySeverity;
  if (candidates.length === 0) {
    severity = { severity: "ok" };
  } else if (expiredCount > 0) {
    severity = { severity: "attention", note: `${expiredCount} available vehicle(s) have an expired STNK.` };
  } else {
    severity = { severity: "watch", note: `${expiringSoonCount} available vehicle(s) have an STNK expiring within ${STNK_EXPIRY_WINDOW_DAYS} days.` };
  }

  return {
    metrics: {
      window_days: STNK_EXPIRY_WINDOW_DAYS,
      expired_count: expiredCount,
      expiring_soon_count: expiringSoonCount,
      total_count: candidates.length,
      vehicles: candidates.slice(0, 20),
    },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 5. pricing_signals -- AI pipeline
// ---------------------------------------------------------------------------
const PRICING_SIGNALS_QUESTION = `For each brand and model_trim group that has at least ${PRICING_MIN_GROUP_SIZE} available vehicles, find vehicles whose price_net differs from that group's median available price_net by more than ${PRICING_OUTLIER_WATCH_PCT} percent. Return brand, model_trim, license_plate, price_net, and the group's median available price_net as group_median_price_net, for each such vehicle.`;

export async function computePricingSignals(): Promise<CategoryResult> {
  const result = await askQuestion(PRICING_SIGNALS_QUESTION);
  if (result.status === "needs_clarification") {
    return { metrics: null, severity: { severity: "unknown", note: result.message } };
  }

  let skipped = 0;
  const outliers: { brand: string; model_trim: string; license_plate: string | null; price_net: number; group_median_price_net: number; deviation_pct: number }[] = [];
  for (const row of result.rows) {
    const priceNet = toNumber(row.price_net);
    const median = toNumber(row.group_median_price_net);
    if (priceNet === null || median === null || median === 0) {
      skipped++;
      continue;
    }
    outliers.push({
      brand: typeof row.brand === "string" ? row.brand : "?",
      model_trim: typeof row.model_trim === "string" ? row.model_trim : "?",
      license_plate: typeof row.license_plate === "string" ? row.license_plate : null,
      price_net: priceNet,
      group_median_price_net: median,
      deviation_pct: Math.abs((priceNet - median) / median) * 100,
    });
  }

  const worst = outliers.reduce<typeof outliers[number] | null>(
    (max, o) => (max === null || o.deviation_pct > max.deviation_pct ? o : max),
    null
  );

  let severity: CategorySeverity;
  if (!worst) {
    severity = { severity: "ok", skipped_rows: skipped || undefined };
  } else {
    const label = `${worst.brand} ${worst.model_trim} (${worst.license_plate ?? "?"})`;
    if (worst.deviation_pct >= PRICING_OUTLIER_ATTENTION_PCT) {
      severity = { severity: "attention", note: `${label} is ${worst.deviation_pct.toFixed(0)}% off its group median.`, skipped_rows: skipped || undefined };
    } else {
      severity = { severity: "watch", note: `${label} is ${worst.deviation_pct.toFixed(0)}% off its group median.`, skipped_rows: skipped || undefined };
    }
  }

  return {
    metrics: { outlier_count: outliers.length, outliers: outliers.slice(0, 20), skipped_rows: skipped },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 6. data_hygiene -- AI pipeline
// ---------------------------------------------------------------------------
const DATA_HYGIENE_QUESTION = `Among available vehicles, count how many have price_cash, price_credit, AND price_net all null (as missing_price_count), how many have stnk_expiry_date null (as missing_stnk_count), and how many have purchase_date null (as missing_purchase_date_count). Return exactly one row with those three columns.`;

export async function computeDataHygiene(): Promise<CategoryResult> {
  const result = await askQuestion(DATA_HYGIENE_QUESTION);
  if (result.status === "needs_clarification") {
    return { metrics: null, severity: { severity: "unknown", note: result.message } };
  }

  const row = result.rows[0] ?? {};
  const missingPrice = toNumber(row.missing_price_count) ?? 0;
  const missingStnk = toNumber(row.missing_stnk_count) ?? 0;
  const missingPurchaseDate = toNumber(row.missing_purchase_date_count) ?? 0;
  const total = missingPrice + missingStnk + missingPurchaseDate;

  let severity: CategorySeverity;
  if (total >= DATA_HYGIENE_ATTENTION_COUNT) {
    severity = { severity: "attention", note: `${total} available vehicle field(s) missing required data.` };
  } else if (total >= DATA_HYGIENE_WATCH_COUNT) {
    severity = { severity: "watch", note: `${total} available vehicle field(s) missing required data.` };
  } else {
    severity = { severity: "ok" };
  }

  return {
    metrics: { missing_price_count: missingPrice, missing_stnk_count: missingStnk, missing_purchase_date_count: missingPurchaseDate },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 7. stalled_bookings -- AI pipeline
// ---------------------------------------------------------------------------
const STALLED_BOOKINGS_QUESTION = `List vehicles with status booked whose updated_at is more than ${STALLED_BOOKING_WATCH_DAYS} days ago. Return license_plate, brand, model_trim, reserved_by, and days_booked (the number of whole days between updated_at and now).`;

export async function computeStalledBookings(): Promise<CategoryResult> {
  const result = await askQuestion(STALLED_BOOKINGS_QUESTION);
  if (result.status === "needs_clarification") {
    return { metrics: null, severity: { severity: "unknown", note: result.message } };
  }

  let skipped = 0;
  const stalled: { license_plate: string | null; brand: string | null; model_trim: string | null; reserved_by: string | null; days_booked: number }[] = [];
  for (const row of result.rows) {
    const days = toNumber(row.days_booked);
    if (days === null) {
      skipped++;
      continue;
    }
    stalled.push({
      license_plate: typeof row.license_plate === "string" ? row.license_plate : null,
      brand: typeof row.brand === "string" ? row.brand : null,
      model_trim: typeof row.model_trim === "string" ? row.model_trim : null,
      reserved_by: typeof row.reserved_by === "string" ? row.reserved_by : null,
      days_booked: days,
    });
  }
  const worstDays = stalled.reduce((max, s) => Math.max(max, s.days_booked), 0);

  let severity: CategorySeverity;
  if (stalled.length === 0) {
    severity = { severity: "ok", skipped_rows: skipped || undefined };
  } else if (worstDays >= STALLED_BOOKING_ATTENTION_DAYS) {
    severity = { severity: "attention", note: `${stalled.length} booking(s) stalled, longest ${worstDays} day(s).`, skipped_rows: skipped || undefined };
  } else {
    severity = { severity: "watch", note: `${stalled.length} booking(s) stalled, longest ${worstDays} day(s).`, skipped_rows: skipped || undefined };
  }

  return {
    metrics: { stalled_count: stalled.length, stalled: stalled.slice(0, 20) },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 8. discount_drift -- AI pipeline (current gap) + self-bootstrapped trend
// ---------------------------------------------------------------------------
const DISCOUNT_DRIFT_QUESTION = `List available vehicles that have price_net set and at least one of price_cash or price_credit set. Return brand, model_trim, license_plate, price_net, and listed_price (equal to price_cash when price_cash is not null, otherwise price_credit).`;

export async function computeDiscountDrift(history: HeartbeatHistoryEntry[]): Promise<CategoryResult> {
  const result = await askQuestion(DISCOUNT_DRIFT_QUESTION);
  if (result.status === "needs_clarification") {
    return { metrics: null, severity: { severity: "unknown", note: result.message } };
  }

  let skipped = 0;
  let totalGapPct = 0;
  let sampleCount = 0;
  for (const row of result.rows) {
    const priceNet = toNumber(row.price_net);
    const listed = toNumber(row.listed_price);
    if (priceNet === null || listed === null || listed === 0) {
      skipped++;
      continue;
    }
    totalGapPct += ((listed - priceNet) / listed) * 100;
    sampleCount++;
  }
  const avgGapPct = sampleCount > 0 ? totalGapPct / sampleCount : null;

  const insufficientHistory = history.length === 0;
  let severity: CategorySeverity;
  if (avgGapPct === null) {
    severity = { severity: "ok", skipped_rows: skipped || undefined };
  } else if (insufficientHistory) {
    severity = {
      severity: "ok",
      insufficient_history: true,
      note: "No prior heartbeat to compare the discount-gap trend against -- this heartbeat establishes the baseline.",
    };
  } else {
    const prevAvgGapPct = toNumber((history[0].metrics?.discount_drift as any)?.avg_gap_pct);
    if (prevAvgGapPct === null) {
      severity = { severity: "ok" };
    } else {
      const change = avgGapPct - prevAvgGapPct;
      if (change >= DISCOUNT_DRIFT_ATTENTION_PCT) {
        severity = { severity: "attention", note: `Average discount gap widened by ${change.toFixed(1)} points since the last heartbeat.` };
      } else if (change >= DISCOUNT_DRIFT_WATCH_PCT) {
        severity = { severity: "watch", note: `Average discount gap widened by ${change.toFixed(1)} points since the last heartbeat.` };
      } else {
        severity = { severity: "ok" };
      }
    }
  }

  return {
    metrics: { avg_gap_pct: avgGapPct, sample_count: sampleCount, skipped_rows: skipped },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 9. financial_snapshot -- AI pipeline
// ---------------------------------------------------------------------------
const FINANCIAL_SNAPSHOT_QUESTION = `Compute two totals in a single row: stock_value, the sum of price_net (using price_cash instead when price_net is null) across all currently available vehicles; and realized_total, the same price preference summed over vehicles with status sold and handover_date within the last 30 days. Return exactly one row with stock_value and realized_total.`;

export async function computeFinancialSnapshot(history: HeartbeatHistoryEntry[]): Promise<CategoryResult> {
  const result = await askQuestion(FINANCIAL_SNAPSHOT_QUESTION);
  if (result.status === "needs_clarification") {
    return { metrics: null, severity: { severity: "unknown", note: result.message } };
  }

  const row = result.rows[0] ?? {};
  const stockValue = toNumber(row.stock_value);
  const realizedTotal = toNumber(row.realized_total) ?? 0;

  if (stockValue === null) {
    return {
      metrics: { stock_value: null, realized_total: realizedTotal },
      severity: { severity: "unknown", note: "Could not parse a stock value from the generated query's result." },
    };
  }

  const insufficientHistory = history.length === 0;
  let severity: CategorySeverity;
  if (insufficientHistory) {
    severity = {
      severity: "ok",
      insufficient_history: true,
      note: "No prior heartbeat to compare stock value against -- this heartbeat establishes the baseline.",
    };
  } else {
    const prevStockValue = toNumber((history[0].metrics?.financial_snapshot as any)?.stock_value);
    if (prevStockValue !== null && prevStockValue > 0) {
      const dropPct = ((prevStockValue - stockValue) / prevStockValue) * 100;
      const drop = prevStockValue - stockValue;
      if (dropPct >= FINANCIAL_SNAPSHOT_DROP_PCT && realizedTotal < drop) {
        severity = { severity: "watch", note: `Stock value dropped ${dropPct.toFixed(1)}% since the last heartbeat without a matching realized total.` };
      } else {
        severity = { severity: "ok" };
      }
    } else {
      severity = { severity: "ok" };
    }
  }

  return {
    metrics: { stock_value: stockValue, realized_total: realizedTotal },
    severity,
  };
}

// ---------------------------------------------------------------------------
// Headline metric extraction -- one comparable number per category, used by
// jobs/marcus.ts to compute since-last-heartbeat deltas and the single "top
// mover" without needing category-specific logic duplicated there.
// ---------------------------------------------------------------------------
export function getHeadlineMetric(slug: CategorySlug, metrics: Record<string, unknown> | null): number | null {
  if (!metrics) return null;
  switch (slug) {
    case "inventory_health":
      return toNumber(metrics.worst_ratio);
    case "aging_inventory":
      return toNumber(metrics.avg_age_days);
    case "sales_velocity":
      return toNumber(metrics.total_this_week);
    case "stnk_compliance":
      return toNumber(metrics.total_count);
    case "pricing_signals":
      return toNumber(metrics.outlier_count);
    case "data_hygiene":
      return (toNumber(metrics.missing_price_count) ?? 0) + (toNumber(metrics.missing_stnk_count) ?? 0) + (toNumber(metrics.missing_purchase_date_count) ?? 0);
    case "stalled_bookings":
      return toNumber(metrics.stalled_count);
    case "discount_drift":
      return toNumber(metrics.avg_gap_pct);
    case "financial_snapshot":
      return toNumber(metrics.stock_value);
    default:
      return null;
  }
}
