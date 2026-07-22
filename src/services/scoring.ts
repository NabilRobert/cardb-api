/**
 * scoring.ts
 *
 * Computed parsing-accuracy score for a sheet preview (see routes/upload.ts's
 * process-sheet) -- built from real per-value and per-column checks against
 * the already-extracted VehicleRow data, not a self-reported AI confidence
 * number. Extends templates.ts's existing checkPriceSanity price-range check
 * (same MIN_PLAUSIBLE_PRICE threshold) rather than duplicating it; everything
 * else here (plate pattern, date range, year range, odometer range,
 * status/transmission vocabulary) is new.
 *
 * Design note shared across every numeric/date field below: extractRowsWithMapping
 * already collapses a non-numeric or unparseable raw cell to `null` before it
 * ever reaches VehicleRow (see e.g. `typeof hargaCash.value === "number" ? ... : null`
 * in templates.ts). Scoring operates on VehicleRow, the natural integration
 * point for "the extracted value" -- so for these fields, "non-numeric
 * placeholder" and "genuinely empty" are indistinguishable by the time they
 * get here, and both correctly score 0.0. String fields (brand, vin, ...)
 * don't have this limitation -- the raw text survives into VehicleRow, so a
 * placeholder like "-" or "N/A" is still detectable there.
 */

import { VehicleRow } from "./parser";
import { ColumnMapping, MappableField, resolveColumn } from "./templates";

export type ValueScoreNum = 0 | 0.5 | 1;

export interface ValueScore {
  score: ValueScoreNum;
  reason?: string; // only set when score < 1, for surfacing in columnScores
}

// Reuse the exact threshold checkPriceSanity already uses, so a value that's
// flagged there and a value that scores low here agree with each other.
const MIN_PLAUSIBLE_PRICE = 500_000;
const MAX_PLAUSIBLE_PRICE = 10_000_000_000; // generous upper bound -- no existing signal to derive this from, kept wide to avoid false negatives

const MIN_YEAR = 1980;
const MAX_ODOMETER_KM = 500_000;

const CURRENT_YEAR = new Date().getFullYear();
// stnk_expiry_date is inherently a future-dated field (STNK renews every 5
// years); purchase_date/handover_date are inherently past-dated. Different
// plausible windows for each, rather than one shared range.
const FUTURE_DATE_FIELD_RANGE = { minYear: CURRENT_YEAR - 10, maxYear: CURRENT_YEAR + 10 };
const PAST_DATE_FIELD_RANGE = { minYear: 1990, maxYear: CURRENT_YEAR + 1 };

const KNOWN_STATUS_VALUES = new Set(["available", "booked", "sold"]); // per schema.sql's own comment on the status column
const KNOWN_TRANSMISSION_VALUES = new Set(["automatic", "manual", "at", "mt", "cvt"]);

// "B 1234 XYZ" / "B1234XYZ" / "B 1234XY" -- 1-2 letters (region code), 1-4
// digits, 0-3 letters, optional spaces between groups.
const PLATE_PATTERN = /^[A-Z]{1,2}\s?\d{1,4}\s?[A-Z]{0,3}$/i;

const PLACEHOLDER_TEXT = new Set(["-", "n/a", "na", "none", ""]);

function isPlaceholder(s: string): boolean {
  return PLACEHOLDER_TEXT.has(s.trim().toLowerCase());
}

function scorePlate(value: string | null): ValueScore {
  if (!value || isPlaceholder(value)) return { score: 0, reason: "empty" };
  return PLATE_PATTERN.test(value.trim())
    ? { score: 1 }
    : { score: 0.5, reason: `"${value}" doesn't match a typical plate pattern` };
}

function scoreAlphanumericId(value: string | null): ValueScore {
  if (!value || isPlaceholder(value)) return { score: 0, reason: "empty" };
  const v = value.trim();
  if (v.length >= 5 && v.length <= 20 && /^[A-Z0-9]+$/i.test(v)) return { score: 1 };
  return { score: 0.5, reason: `"${v}" is an unusual length/format for this field` };
}

function scorePrice(value: number | null): ValueScore {
  if (value === null) return { score: 0, reason: "empty" };
  if (value >= MIN_PLAUSIBLE_PRICE && value <= MAX_PLAUSIBLE_PRICE) return { score: 1 };
  return { score: 0.5, reason: `${value} is outside the plausible IDR price range` };
}

function scorePlausibleText(value: string | null): ValueScore {
  if (!value || isPlaceholder(value)) return { score: 0, reason: "empty" };
  // "suspiciously short" -- a single character is very unlikely to be a real
  // brand/model name (vs. a genuine but short one, e.g. "Kia", "BMW").
  if (value.trim().length < 2) return { score: 0.5, reason: `"${value}" is suspiciously short` };
  return { score: 1 };
}

function scoreYear(value: number | null): ValueScore {
  if (value === null) return { score: 0, reason: "empty" };
  if (value >= MIN_YEAR && value <= CURRENT_YEAR + 1) return { score: 1 };
  return { score: 0.5, reason: `${value} is outside a plausible vehicle year range` };
}

function scoreOdometer(value: number | null): ValueScore {
  if (value === null) return { score: 0, reason: "empty" };
  if (value >= 0 && value <= MAX_ODOMETER_KM) return { score: 1 };
  return { score: 0.5, reason: `${value} km is outside a plausible odometer range` };
}

function scoreDate(value: Date | null, range: { minYear: number; maxYear: number }): ValueScore {
  if (value === null || isNaN(value.getTime())) return { score: 0, reason: "empty" };
  const y = value.getFullYear();
  if (y >= range.minYear && y <= range.maxYear) return { score: 1 };
  return { score: 0.5, reason: `${value.toDateString()} is outside a plausible date range` };
}

function scoreVocabulary(value: string | null, vocab: ReadonlySet<string>): ValueScore {
  if (!value || isPlaceholder(value)) return { score: 0, reason: "empty" };
  return vocab.has(value.trim().toLowerCase())
    ? { score: 1 }
    : { score: 0.5, reason: `"${value}" isn't a recognized value for this field` };
}

function scorePresenceOnly(value: string | null): ValueScore {
  return !value || isPlaceholder(value) ? { score: 0, reason: "empty" } : { score: 1 };
}

/** Per-value score for one field on one row. See the module doc comment for the VehicleRow-vs-raw-cell tradeoff. */
export function scoreValue(field: MappableField, row: VehicleRow): ValueScore {
  switch (field) {
    case "license_plate":
      return scorePlate(row.license_plate);
    case "vin":
    case "engine_no":
      return scoreAlphanumericId(row[field]);
    case "price_cash":
    case "price_credit":
    case "price_net":
      return scorePrice(row[field]);
    case "brand":
    case "model_trim":
      return scorePlausibleText(row[field]);
    case "year":
      return scoreYear(row.year);
    case "odometer_km":
      return scoreOdometer(row.odometer_km);
    case "stnk_expiry_date":
      return scoreDate(row.stnk_expiry_date, FUTURE_DATE_FIELD_RANGE);
    case "purchase_date":
    case "handover_date":
      return scoreDate(row[field], PAST_DATE_FIELD_RANGE);
    case "status":
      return scoreVocabulary(row.status, KNOWN_STATUS_VALUES);
    case "transmission":
      return scoreVocabulary(row.transmission, KNOWN_TRANSMISSION_VALUES);
    case "color":
    case "location":
    case "ownership":
    case "max_credit_discount":
    case "source":
      return scorePresenceOnly(row[field]);
    case "notes_raw":
      return scorePresenceOnly(row.notes_raw);
  }
}

// Weight table -- matches the requested table exactly, plus price_net scored
// like price_cash/price_credit (see step-0 finding: checkPriceSanity already
// treats them identically) and source added at the same low weight as the
// other legitimately-often-blank free-text fields. reserved_by is
// deliberately absent -- see step-0 finding: it's never its own mapped
// column, so it can never be anything but "unmapped" under the Step 3 rule.
export const FIELD_WEIGHTS: Partial<Record<MappableField, number>> = {
  license_plate: 3,
  vin: 3,
  engine_no: 2,
  price_cash: 3,
  price_credit: 3,
  price_net: 3,
  brand: 2,
  model_trim: 2,
  year: 2,
  odometer_km: 2,
  stnk_expiry_date: 2,
  purchase_date: 1,
  handover_date: 1,
  status: 2,
  transmission: 1,
  color: 1,
  location: 1,
  ownership: 1,
  max_credit_discount: 1,
  source: 1,
  notes_raw: 0.5,
};

// license_plate/brand are the only fields the system already hard-requires
// (see confirm-mapping's own validation and proposeColumnMapping's own
// license_plate/brand check) -- kept here so computeAccuracyScore agrees
// with that existing requirement rather than inventing a separate list.
export const REQUIRED_FIELDS: ReadonlySet<MappableField> = new Set(["license_plate", "brand"]);

export interface ColumnScoreEntry {
  field: MappableField;
  column: string | null; // the mapped column letter, or null if this field wasn't mapped at all
  score: number; // 0-1, average per-value score across rows that had this field mapped
  weight: number;
  sampleCount: number; // rows actually scored (0 if the field wasn't mapped)
  topIssues: string[]; // up to 3 distinct example reasons for a score below 1
}

export interface AccuracyScore {
  score: number; // 0-1 overall
  label: "high" | "needs_review" | "low";
  columnScores: ColumnScoreEntry[];
}

function bucketLabel(score: number): AccuracyScore["label"] {
  if (score >= 0.85) return "high";
  if (score >= 0.6) return "needs_review";
  return "low";
}

/** Every field that resolves to a real column somewhere in the mapping -- checks regions too, not just the base columns (e.g. price_net in a "Daily Report Updated"-style mapping is region-only, never in the base columns at all). */
function anyMappedColumn(mapping: ColumnMapping, field: MappableField): string | null {
  if (mapping.columns[field]) return mapping.columns[field]!;
  for (const region of mapping.regions ?? []) {
    const col = region.columns[field];
    if (col) return col;
  }
  return null;
}

/**
 * Step 2 (per-column average) + Step 3 (weighted overall combination).
 *
 * Region-aware: a field like price_net that's only mapped for some rows
 * (via a ColumnMapping region -- see templates.ts's ColumnMappingRegion)
 * is only scored against the rows it actually applies to, via
 * resolveColumn per row. Without this, a field a region deliberately nulls
 * out for half the sheet (e.g. price_cash for "Daily Report Updated"'s
 * second table, which genuinely has no cash/credit split) would be scored
 * as if those rows were parsing failures, when they're correctly null by
 * design.
 *
 * `semanticFlags` (Step 4's output, ai_proposed sheets only) caps a
 * specific field's column score rather than introducing a second number --
 * a field the semantic judge flagged can't score above 0.5 regardless of
 * how clean its individual values look, since the problem it's flagging is
 * "this column doesn't mean what the mapping says it means", which
 * per-value checks can't see at all.
 */
export function computeAccuracyScore(
  rows: VehicleRow[],
  mapping: ColumnMapping,
  semanticFlags?: ReadonlyMap<MappableField, string>
): AccuracyScore {
  const columnScores: ColumnScoreEntry[] = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [field, weight] of Object.entries(FIELD_WEIGHTS) as [MappableField, number][]) {
    const displayColumn = anyMappedColumn(mapping, field);

    if (displayColumn === null) {
      if (REQUIRED_FIELDS.has(field)) {
        // Required but never mapped: counts as 0, not excluded (Step 3).
        columnScores.push({ field, column: null, score: 0, weight, sampleCount: 0, topIssues: ["required field was never mapped"] });
        weightedSum += 0 * weight;
        totalWeight += weight;
      }
      continue; // optional + unmapped -> excluded entirely, not scored
    }

    let sum = 0;
    let count = 0;
    const issueReasons = new Set<string>();
    for (const row of rows) {
      // Only score this row for this field if the field actually resolves
      // to a real column THERE -- a region may legitimately exclude it.
      if (resolveColumn(mapping, field, row.row_index) === null) continue;
      const { score, reason } = scoreValue(field, row);
      sum += score;
      count++;
      if (reason && issueReasons.size < 3) issueReasons.add(reason);
    }
    let columnScore = count > 0 ? sum / count : 0;

    const semanticReason = semanticFlags?.get(field);
    if (semanticReason !== undefined) {
      columnScore = Math.min(columnScore, 0.5);
      issueReasons.add(`semantic check: ${semanticReason}`);
    }

    columnScores.push({ field, column: displayColumn, score: columnScore, weight, sampleCount: count, topIssues: [...issueReasons] });
    weightedSum += columnScore * weight;
    totalWeight += weight;
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { score, label: bucketLabel(score), columnScores };
}
