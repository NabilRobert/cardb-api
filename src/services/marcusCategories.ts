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
  getSalesVelocityByGroup,
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
//
// `groups`: a snapshot of the CURRENT available count for every brand +
// model_trim combination (key format "Brand :: ModelTrim", see groupKey
// above) -- not a ranking, not filtered, every group with at least one
// available unit is in here.
//
// `worst_group` / `worst_ratio`: the group whose current count has fallen
// furthest, PROPORTIONALLY, below ITS OWN trailing average (current count /
// that group's mean count across up to INVENTORY_BASELINE_MAX_HEARTBEATS
// prior heartbeats). This is a relative-decline metric, not a size ranking
// -- worst_group is often a small-count group (a group that normally only
// ever has 1-2 units can "fall 50% below baseline" the same way a
// 40-unit group can), and is NOT the group with the highest or lowest
// absolute count. worst_ratio of 1.0 means "unchanged from its own
// baseline" (not "healthy" in an absolute sense, just flat) -- with only a
// handful of heartbeats of history so far, many groups will tie at exactly
// 1.0 (flat) or whatever their only prior data point was, and ties are
// broken arbitrarily by whichever group Postgres happens to return first
// (no ORDER BY on the underlying query) -- this arbitrariness fades out as
// more heartbeats accumulate and baselines become real averages rather than
// single data points. worst_group_current_count/worst_group_baseline_count
// are included specifically so the frontend can show the real numbers
// behind the ratio instead of just the ratio.
// ---------------------------------------------------------------------------
export async function computeInventoryHealth(history: HeartbeatHistoryEntry[]): Promise<CategoryResult> {
  const current = await getAvailableCountsByGroup();
  const groupsOut: Record<string, number> = {};
  for (const g of current) groupsOut[groupKey(g.brand, g.model_trim)] = g.count;

  const insufficientHistory = history.length === 0;
  let worstGroup: string | null = null;
  let worstRatio = Infinity;
  let worstGroupCurrentCount: number | null = null;
  let worstGroupBaselineCount: number | null = null;

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
        worstGroupCurrentCount = currentCount;
        worstGroupBaselineCount = baseline;
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
    metrics: {
      groups: groupsOut,
      worst_group: worstGroup,
      worst_ratio: worstGroup ? worstRatio : null,
      worst_group_current_count: worstGroupCurrentCount,
      worst_group_baseline_count: worstGroupBaselineCount,
    },
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
  // Oldest first -- these are the ones worth discounting or pushing first;
  // the narrative names specific vehicles from this list rather than just
  // reporting the bucket counts.
  const oldestFirst = [...candidates].sort((a, b) => b.days_on_lot - a.days_on_lot);

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
    metrics: { buckets, avg_age_days: avgAgeDays, candidate_count: candidates.length, vehicles: oldestFirst.slice(0, 20) },
    severity,
  };
}

// ---------------------------------------------------------------------------
// 3. sales_velocity -- direct SQL (flagged deviation from the letter of the
// confirmed split, see file doc comment above)
// ---------------------------------------------------------------------------
export async function computeSalesVelocity(): Promise<CategoryResult> {
  const [stats, byGroup] = await Promise.all([getSalesVelocityStats(), getSalesVelocityByGroup()]);
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
      // Per brand/model breakdown of this week's activity (non-zero groups
      // only) -- lets the narrative judge whether a shortfall is broad
      // (many small groups) or concentrated (one or two groups dominate).
      by_group: byGroup,
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
  // Most overdue first (most-negative days_diff), then soonest-to-expire --
  // the narrative prioritizes off this order when naming which to renew first.
  const prioritized = [...candidates].sort((a, b) => a.days_diff - b.days_diff);

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
      vehicles: prioritized.slice(0, 20),
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
// 6. data_hygiene -- AI pipeline. Asks for the raw field values rather than
// AI-computed counts/booleans -- missing-ness is then decided in plain code
// from those values (same "AI only fetches, code decides" discipline as
// severity everywhere else), and doubles as the source for the per-vehicle
// `vehicles`/missing_fields list the frontend needs to link to specific
// records instead of just a total.
// ---------------------------------------------------------------------------
const DATA_HYGIENE_QUESTION = `List available vehicles that are missing at least one of these required fields: price_cash, price_credit, and price_net (all three null counts as a missing price), stnk_expiry_date, or purchase_date. Return id, brand, model_trim, license_plate, price_cash, price_credit, price_net, stnk_expiry_date, and purchase_date for each.`;

export interface DataHygieneVehicle {
  id: number;
  license_plate: string | null;
  brand: string | null;
  model_trim: string | null;
  missing_fields: string[];
}

export async function computeDataHygiene(): Promise<CategoryResult> {
  const result = await askQuestion(DATA_HYGIENE_QUESTION);
  if (result.status === "needs_clarification") {
    return { metrics: null, severity: { severity: "unknown", note: result.message } };
  }

  let skipped = 0;
  const vehicles: DataHygieneVehicle[] = [];
  for (const row of result.rows) {
    const id = toNumber(row.id);
    if (id === null) {
      skipped++;
      continue;
    }

    const missingFields: string[] = [];
    const priceCash = toNumber(row.price_cash);
    const priceCredit = toNumber(row.price_credit);
    const priceNet = toNumber(row.price_net);
    if (priceCash === null && priceCredit === null && priceNet === null) missingFields.push("price");
    if (row.stnk_expiry_date === null || row.stnk_expiry_date === undefined) missingFields.push("stnk_expiry_date");
    if (row.purchase_date === null || row.purchase_date === undefined) missingFields.push("purchase_date");

    // The model may include a row that (per its own generated SQL) doesn't
    // actually have any of the three fields missing -- don't report a
    // vehicle with nothing wrong with it, just skip it.
    if (missingFields.length === 0) {
      skipped++;
      continue;
    }

    vehicles.push({
      id,
      license_plate: typeof row.license_plate === "string" ? row.license_plate : null,
      brand: typeof row.brand === "string" ? row.brand : null,
      model_trim: typeof row.model_trim === "string" ? row.model_trim : null,
      missing_fields: missingFields,
    });
  }

  // Counted per distinct vehicle (a vehicle missing two fields counts once
  // here, not twice) -- more intuitive than the old field-instance sum, but
  // note this means it's <= what the old total would have been for the same
  // data.
  const missingPriceCount = vehicles.filter((v) => v.missing_fields.includes("price")).length;
  const missingStnkCount = vehicles.filter((v) => v.missing_fields.includes("stnk_expiry_date")).length;
  const missingPurchaseDateCount = vehicles.filter((v) => v.missing_fields.includes("purchase_date")).length;
  const totalCount = vehicles.length;

  let severity: CategorySeverity;
  if (totalCount >= DATA_HYGIENE_ATTENTION_COUNT) {
    severity = { severity: "attention", note: `${totalCount} available vehicle(s) missing required data.`, skipped_rows: skipped || undefined };
  } else if (totalCount >= DATA_HYGIENE_WATCH_COUNT) {
    severity = { severity: "watch", note: `${totalCount} available vehicle(s) missing required data.`, skipped_rows: skipped || undefined };
  } else {
    severity = { severity: "ok", skipped_rows: skipped || undefined };
  }

  return {
    metrics: {
      missing_price_count: missingPriceCount,
      missing_stnk_count: missingStnkCount,
      missing_purchase_date_count: missingPurchaseDateCount,
      total_count: totalCount,
      vehicles: vehicles.slice(0, 20),
      skipped_rows: skipped,
    },
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
      return toNumber(metrics.total_count);
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

// ---------------------------------------------------------------------------
// Deterministic narrative fallback -- the hard guarantee under
// generateMarcusNarrative's AI attempt (see ai.ts): if the model's JSON
// still omits a category (or garbles it) after retries, jobs/marcus.ts
// builds a plain, code-written explanation + recommendation for exactly
// that category from the same already-computed metrics/severity the
// threshold logic produced -- no further AI call, so it can never fail the
// same way twice. Deliberately plainer than the AI version (no vehicle-by-
// vehicle narrative flourish), it just always has to be there.
// ---------------------------------------------------------------------------
export interface NarrativeEntry {
  explanation: string;
  recommendation: string;
}

function fmtMoney(n: number): string {
  return `Rp${Math.round(n).toLocaleString("id-ID")}`;
}

export function buildFallbackNarrativeEntry(
  slug: CategorySlug,
  metrics: Record<string, unknown> | null,
  severity: CategorySeverity
): NarrativeEntry {
  // No usable data at all -- say why, rather than leaving it blank or
  // inventing a recommendation the data can't support.
  if (severity.severity === "unknown" || metrics === null) {
    const reason = severity.note ?? "no usable data was available for this category this heartbeat.";
    return {
      explanation: `No usable data for this category this heartbeat: ${reason}`,
      recommendation: "No recommendation available until this category computes successfully on a future heartbeat.",
    };
  }

  const ok = severity.severity === "ok";
  const noAction = "No action needed this heartbeat.";

  switch (slug) {
    case "inventory_health": {
      const m = metrics as any;
      const worstGroup = typeof m.worst_group === "string" ? m.worst_group : null;
      if (!worstGroup) {
        return { explanation: "No group had enough data to compare against a trailing average.", recommendation: noAction };
      }
      const ratio = toNumber(m.worst_ratio);
      const current = toNumber(m.worst_group_current_count);
      const baseline = toNumber(m.worst_group_baseline_count);
      const explanation = `${worstGroup} is the weakest group, at ${ratio !== null ? (ratio * 100).toFixed(0) : "?"}% of its trailing average (${current ?? "?"} now vs a baseline of ${baseline !== null ? baseline.toFixed(1) : "?"}).`;
      return { explanation, recommendation: ok ? noAction : `Review restocking for ${worstGroup}.` };
    }

    case "aging_inventory": {
      const m = metrics as any;
      const avgAge = toNumber(m.avg_age_days);
      const buckets = m.buckets ?? {};
      const vehicles: any[] = Array.isArray(m.vehicles) ? m.vehicles.slice(0, 3) : [];
      const explanation = `Average age on lot is ${avgAge !== null ? avgAge.toFixed(1) : "?"} days across ${m.candidate_count ?? "?"} available units (${buckets["90_plus"] ?? 0} over 90 days, ${buckets["61_90"] ?? 0} in the 61-90 day range).`;
      const recommendation = vehicles.length === 0
        ? noAction
        : `Prioritize ${vehicles.map((v) => `${v.license_plate ?? "vehicle #" + v.id} (${v.days_on_lot} days)`).join(", ")} for discounting or a sales push.`;
      return { explanation, recommendation };
    }

    case "sales_velocity": {
      const m = metrics as any;
      const total = toNumber(m.total_this_week);
      const avg = toNumber(m.trailing_4week_avg_sold_per_week);
      const explanation = `This week's sold+booked total is ${total ?? "?"} against a trailing 4-week average of ${avg !== null ? avg.toFixed(1) : "?"} per week.`;
      return { explanation, recommendation: ok ? noAction : "Review this week's sales pipeline against the trailing average to see what stalled." };
    }

    case "stnk_compliance": {
      const m = metrics as any;
      const worst: any[] = Array.isArray(m.vehicles) ? m.vehicles.slice(0, 3) : [];
      const explanation = `${m.expired_count ?? 0} available vehicle(s) have an expired STNK and ${m.expiring_soon_count ?? 0} are expiring within ${m.window_days ?? "?"} days.`;
      const recommendation = worst.length === 0
        ? noAction
        : `Renew these first: ${worst.map((v) => `${v.license_plate ?? "vehicle #" + v.id} (${v.days_diff} days)`).join(", ")}.`;
      return { explanation, recommendation };
    }

    case "pricing_signals": {
      const m = metrics as any;
      const outliers: any[] = Array.isArray(m.outliers) ? m.outliers.slice(0, 3) : [];
      const explanation = `${m.outlier_count ?? 0} pricing outlier(s) detected this heartbeat.`;
      const recommendation = outliers.length === 0
        ? noAction
        : `Review pricing on ${outliers.map((o) => `${o.license_plate ?? "?"} (${Number(o.deviation_pct).toFixed(0)}% off group median)`).join(", ")}.`;
      return { explanation, recommendation };
    }

    case "data_hygiene": {
      const m = metrics as any;
      const vehicles: any[] = Array.isArray(m.vehicles) ? m.vehicles.slice(0, 3) : [];
      const explanation = `${m.total_count ?? 0} available vehicle(s) are missing required data (${m.missing_price_count ?? 0} price, ${m.missing_stnk_count ?? 0} STNK, ${m.missing_purchase_date_count ?? 0} purchase date).`;
      const recommendation = vehicles.length === 0
        ? noAction
        : `Fix these first: ${vehicles.map((v) => `${v.license_plate ?? "vehicle #" + v.id} (missing ${(v.missing_fields ?? []).join(", ")})`).join(", ")}.`;
      return { explanation, recommendation };
    }

    case "stalled_bookings": {
      const m = metrics as any;
      const stalled: any[] = Array.isArray(m.stalled) ? m.stalled.slice(0, 3) : [];
      const explanation = `${m.stalled_count ?? 0} booking(s) have gone unconverted past ${STALLED_BOOKING_WATCH_DAYS} days.`;
      const recommendation = stalled.length === 0
        ? noAction
        : `Follow up on ${stalled.map((s) => `${s.license_plate ?? "?"} (${s.days_booked} days booked)`).join(", ")}.`;
      return { explanation, recommendation };
    }

    case "discount_drift": {
      const m = metrics as any;
      const avgGapPct = toNumber(m.avg_gap_pct);
      const explanation = avgGapPct === null
        ? "No discount-gap data was available this heartbeat."
        : `Average discount gap is ${avgGapPct.toFixed(2)}% across ${m.sample_count ?? "?"} sampled vehicles.`;
      return { explanation, recommendation: ok ? noAction : "Review pricing policy -- the discount gap has widened past its normal range." };
    }

    case "financial_snapshot": {
      const m = metrics as any;
      const stockValue = toNumber(m.stock_value);
      const realizedTotal = toNumber(m.realized_total);
      const explanation = stockValue === null
        ? "No stock value data was available this heartbeat."
        : `Current stock value is ${fmtMoney(stockValue)} with a realized total of ${fmtMoney(realizedTotal ?? 0)} this period.`;
      return { explanation, recommendation: ok ? noAction : "Review why realized revenue isn't offsetting the change in stock value." };
    }

    default:
      return { explanation: "No data available for this category.", recommendation: "No recommendation available." };
  }
}

// Used when the AI narrative call never returns a usable `overall` paragraph
// even after retries -- a plain, deterministic roll-up of severities so the
// heartbeat's top-level summary is never blank either.
export function buildFallbackOverall(severities: Record<string, CategorySeverity>): string {
  const attention = CATEGORY_SLUGS.filter((slug) => severities[slug]?.severity === "attention");
  const watch = CATEGORY_SLUGS.filter((slug) => severities[slug]?.severity === "watch");
  const unknown = CATEGORY_SLUGS.filter((slug) => severities[slug]?.severity === "unknown");

  if (attention.length === 0 && watch.length === 0 && unknown.length === 0) {
    return "All categories are within normal range this heartbeat.";
  }
  const parts: string[] = [];
  if (attention.length > 0) parts.push(`${attention.join(", ")} need attention`);
  if (watch.length > 0) parts.push(`${watch.join(", ")} are worth watching`);
  if (unknown.length > 0) parts.push(`${unknown.join(", ")} had no usable data this heartbeat`);
  return parts.join("; ") + ".";
}
