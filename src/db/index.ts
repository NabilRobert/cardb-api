/**
 * db.ts
 *
 * Shared Postgres connection pool, used by the web server. (The CLI script
 * ingest_excel.ts creates its own short-lived pool since it runs once and exits.)
 */

import { Pool, types } from "pg";
import * as dotenv from "dotenv";
import { VehicleRow } from "../services/parser";
import { ColumnMapping } from "../services/templates";

dotenv.config();

// Postgres DATE columns represent a calendar day with no timezone attached.
// node-pg's default behavior parses them into a JS Date at local midnight,
// which then shows the wrong calendar day once anything downstream (e.g.
// JSON.stringify's implicit toISOString()) applies UTC semantics to it.
// Returning the raw "YYYY-MM-DD" string instead sidesteps that entirely --
// see formatDateOnly below, which reformats straight from this string.
types.setTypeParser(1082 /* date */, (val) => val);

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Plain DATE columns (no time component, e.g. stnk_expiry_date) are shown as
// day-month-year. TIMESTAMPTZ columns (created_at/updated_at/uploaded_at) are
// shown as full ISO-8601 UTC strings -- callers that treat updated_at as an
// optimistic-concurrency token (see updateVehicleStatus below) need
// sub-day precision, not just a calendar day.
function formatDateOnly(raw: string): string {
  const [y, m, d] = raw.split("-");
  return `${d}-${m}-${y}`;
}

function formatTimestamp(d: Date): string {
  return d.toISOString();
}

const DATE_ONLY_FIELDS = ["stnk_expiry_date", "purchase_date", "handover_date"] as const;
const TIMESTAMP_FIELDS = [
  "created_at", "updated_at", "uploaded_at", "resolved_at", "read_at", "last_run_at",
  "last_used_at", "revoked_at",
] as const;

function formatRowDates<T extends Record<string, any>>(row: T): T {
  const out: any = { ...row };
  for (const field of DATE_ONLY_FIELDS) {
    if (out[field] != null) out[field] = formatDateOnly(String(out[field]));
  }
  for (const field of TIMESTAMP_FIELDS) {
    if (out[field] instanceof Date) out[field] = formatTimestamp(out[field]);
  }
  return out;
}

export async function insertVehicles(filename: string, rows: VehicleRow[], skipped: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const uploadResult = await client.query(
      "INSERT INTO uploads (filename, rows_inserted, rows_skipped) VALUES ($1, $2, $3) RETURNING id",
      [filename, rows.length, skipped]
    );
    const uploadId = uploadResult.rows[0].id;

    for (const r of rows) {
      await client.query(
        `INSERT INTO vehicles (
          license_plate, vin, engine_no, brand, model_trim, year,
          transmission, color, odometer_km, stnk_expiry_date, purchase_date, handover_date,
          status, reserved_by, location, ownership,
          price_cash, price_credit, price_net, max_credit_discount,
          notes_raw, source, upload_id, sheet_name, row_index
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          r.license_plate, r.vin, r.engine_no, r.brand, r.model_trim, r.year,
          r.transmission, r.color, r.odometer_km, r.stnk_expiry_date, r.purchase_date, r.handover_date,
          r.status, r.reserved_by, r.location, r.ownership,
          r.price_cash, r.price_credit, r.price_net, r.max_credit_discount,
          r.notes_raw, r.source, uploadId, r.sheet_name, r.row_index,
        ]
      );
    }
    await client.query("COMMIT");
    return { uploadId, inserted: rows.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Postgres has no "reorder column" DDL -- buyer_name was added via ALTER
// TABLE ... ADD COLUMN, so it physically sits at the end of the real table
// regardless of where schema.sql declares it. An explicit column list (kept
// in the same order as schema.sql) is what actually controls field order in
// API responses; every query that returns a full vehicle row uses this
// instead of SELECT */RETURNING *.
const VEHICLE_COLUMNS = [
  "id", "license_plate", "vin", "engine_no", "brand", "model_trim", "year",
  "transmission", "color", "odometer_km", "stnk_expiry_date", "purchase_date",
  "handover_date", "status", "reserved_by", "buyer_name", "location", "ownership",
  "price_cash", "price_credit", "price_net", "max_credit_discount", "notes_raw",
  "source", "upload_id", "sheet_name", "row_index", "created_at", "updated_at",
] as const;
const VEHICLE_COLUMNS_SQL = VEHICLE_COLUMNS.join(", ");

export async function getAllVehicles() {
  const result = await pool.query(`SELECT ${VEHICLE_COLUMNS_SQL} FROM vehicles ORDER BY id DESC`);
  return result.rows.map(formatRowDates);
}

// Columns exposed via GET /api/vehicles/search. Anything not listed here
// (vin, license_plate, engine_no, notes_raw, upload_id, row_index, ...) is
// never touched by a query param, whatever its name.
const TEXT_ILIKE_FIELDS = [
  "brand", "model_trim", "color", "location", "ownership", "source", "sheet_name", "reserved_by",
] as const;
const EXACT_FIELDS = ["status", "transmission"] as const;
const NUMERIC_RANGE_FIELDS: Record<string, { min: string; max: string }> = {
  odometer_km: { min: "odometer_min", max: "odometer_max" },
  price_cash: { min: "price_min", max: "price_max" },
  price_credit: { min: "price_credit_min", max: "price_credit_max" },
  price_net: { min: "price_net_min", max: "price_net_max" },
};
const DATE_RANGE_FIELDS: Record<string, { before: string; after: string }> = {
  stnk_expiry_date: { before: "stnk_expiry_before", after: "stnk_expiry_after" },
  purchase_date: { before: "purchase_date_before", after: "purchase_date_after" },
  handover_date: { before: "handover_date_before", after: "handover_date_after" },
};
const SORT_WHITELIST = [
  ...TEXT_ILIKE_FIELDS, ...EXACT_FIELDS, "year", "odometer_km", "price_cash", "price_credit", "price_net", "created_at",
];

export interface VehicleSearchParams {
  [key: string]: unknown;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const asNumber = (v: unknown): number | undefined => {
  const s = asString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};
const asDate = (v: unknown): string | undefined => {
  const s = asString(v);
  if (s === undefined || Number.isNaN(Date.parse(s))) return undefined;
  return s;
};

// Shared by searchVehicles' count query and data query so the WHERE clause
// is built exactly once and can't drift between the two.
function buildVehicleFilterClauses(query: VehicleSearchParams): { clauses: string[]; params: any[] } {
  const clauses: string[] = [];
  const params: any[] = [];
  const push = (value: any) => {
    params.push(value);
    return `$${params.length}`;
  };

  for (const field of TEXT_ILIKE_FIELDS) {
    const value = asString(query[field]);
    if (value !== undefined) clauses.push(`${field} ILIKE ${push(`%${value}%`)}`);
  }
  for (const field of EXACT_FIELDS) {
    const value = asString(query[field]);
    if (value !== undefined) clauses.push(`${field} = ${push(value)}`);
  }

  const year = asNumber(query.year);
  if (year !== undefined) clauses.push(`year = ${push(year)}`);
  const yearMin = asNumber(query.year_min);
  if (yearMin !== undefined) clauses.push(`year >= ${push(yearMin)}`);
  const yearMax = asNumber(query.year_max);
  if (yearMax !== undefined) clauses.push(`year <= ${push(yearMax)}`);

  for (const [column, { min, max }] of Object.entries(NUMERIC_RANGE_FIELDS)) {
    const minValue = asNumber(query[min]);
    if (minValue !== undefined) clauses.push(`${column} >= ${push(minValue)}`);
    const maxValue = asNumber(query[max]);
    if (maxValue !== undefined) clauses.push(`${column} <= ${push(maxValue)}`);
  }

  for (const [column, { before, after }] of Object.entries(DATE_RANGE_FIELDS)) {
    const beforeValue = asDate(query[before]);
    if (beforeValue !== undefined) clauses.push(`${column} <= ${push(beforeValue)}`);
    const afterValue = asDate(query[after]);
    if (afterValue !== undefined) clauses.push(`${column} >= ${push(afterValue)}`);
  }

  const q = asString(query.q);
  if (q !== undefined) {
    const placeholder = push(`%${q}%`);
    clauses.push(`(brand ILIKE ${placeholder} OR model_trim ILIKE ${placeholder} OR notes_raw ILIKE ${placeholder})`);
  }

  return { clauses, params };
}

export async function searchVehicles(query: VehicleSearchParams) {
  const { clauses, params } = buildVehicleFilterClauses(query);
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const sortByCandidate = asString(query.sort_by);
  const sortBy = sortByCandidate && (SORT_WHITELIST as readonly string[]).includes(sortByCandidate) ? sortByCandidate : "created_at";
  const orderCandidate = asString(query.order)?.toLowerCase();
  const order = orderCandidate === "asc" ? "ASC" : orderCandidate === "desc" ? "DESC" : undefined;
  const orderSql = sortBy === "created_at" && order === undefined ? "created_at DESC" : `${sortBy} ${order ?? "ASC"}`;

  const limit = Math.min(Math.max(asNumber(query.limit) ?? 100, 1), 500);
  const offset = Math.max(asNumber(query.offset) ?? 0, 0);

  const countResult = await pool.query(`SELECT COUNT(*) FROM vehicles ${whereSql}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  // Reuse the filter params, then append LIMIT/OFFSET on top for the data query.
  const dataParams = [...params];
  const pushData = (value: any) => {
    dataParams.push(value);
    return `$${dataParams.length}`;
  };
  const sql = `SELECT ${VEHICLE_COLUMNS_SQL} FROM vehicles ${whereSql} ORDER BY ${orderSql} LIMIT ${pushData(limit)} OFFSET ${pushData(offset)}`;

  const result = await pool.query(sql, dataParams);
  return { rows: result.rows.map(formatRowDates), total };
}

export async function getVehicleById(id: number) {
  const result = await pool.query(`SELECT ${VEHICLE_COLUMNS_SQL} FROM vehicles WHERE id = $1`, [id]);
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

// Columns editable via PATCH /api/vehicles/:id. Anything not listed here
// (id, vin, license_plate, upload_id, created_at, ...) is immutable through
// this route regardless of what the request body contains.
const VEHICLE_EDITABLE_FIELDS = [
  "status", "reserved_by", "price_cash", "price_credit", "price_net", "max_credit_discount", "notes_raw", "location",
] as const;

export function isEditableVehicleField(field: string): boolean {
  return (VEHICLE_EDITABLE_FIELDS as readonly string[]).includes(field);
}

// `fields` should already be pre-filtered to editable keys by the caller;
// this just builds the parameterized UPDATE from whatever's left.
export async function updateVehicle(id: number, fields: Record<string, unknown>) {
  const setClauses: string[] = [];
  const params: any[] = [];
  const push = (value: any) => {
    params.push(value);
    return `$${params.length}`;
  };

  for (const field of VEHICLE_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      setClauses.push(`${field} = ${push(fields[field])}`);
    }
  }
  if (setClauses.length === 0) return null;

  setClauses.push("updated_at = now()");
  const sql = `UPDATE vehicles SET ${setClauses.join(", ")} WHERE id = ${push(id)} RETURNING ${VEHICLE_COLUMNS_SQL}`;
  const result = await pool.query(sql, params);
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

const VEHICLE_STATUS_VALUES = ["available", "booked", "sold"] as const;
export type VehicleStatus = (typeof VEHICLE_STATUS_VALUES)[number];

export function isValidVehicleStatus(value: unknown): value is VehicleStatus {
  return typeof value === "string" && (VEHICLE_STATUS_VALUES as readonly string[]).includes(value);
}

export type UpdateVehicleStatusResult =
  | { outcome: "success"; vehicle: Record<string, any> }
  | { outcome: "not_found" }
  | { outcome: "conflict"; current: Record<string, any> };

// Sets status plus whichever name field that target status requires
// (reserved_by for booked, buyer_name for sold; the route layer has already
// validated that field is present). The WHERE clause includes the client's
// last-seen updated_at as an optimistic-concurrency check -- if another
// request already changed this row, updated_at won't match, zero rows are
// affected, and the caller can tell "conflict" apart from "no such id" by
// re-reading the row.
export async function updateVehicleStatus(
  id: number,
  status: VehicleStatus,
  nameValue: string | undefined,
  clientUpdatedAt: string
): Promise<UpdateVehicleStatusResult> {
  const setClauses: string[] = ["status = $1"];
  const params: any[] = [status];
  const push = (value: any) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (status === "booked") {
    setClauses.push(`reserved_by = ${push(nameValue)}`);
  } else if (status === "sold") {
    setClauses.push(`buyer_name = ${push(nameValue)}`);
  }
  setClauses.push("updated_at = now()");

  const idPlaceholder = push(id);
  const updatedAtPlaceholder = push(clientUpdatedAt);
  const sql = `UPDATE vehicles SET ${setClauses.join(", ")} WHERE id = ${idPlaceholder} AND updated_at = ${updatedAtPlaceholder} RETURNING ${VEHICLE_COLUMNS_SQL}`;

  const result = await pool.query(sql, params);
  if (result.rows[0]) {
    return { outcome: "success", vehicle: formatRowDates(result.rows[0]) };
  }

  const current = await getVehicleById(id);
  if (!current) return { outcome: "not_found" };
  return { outcome: "conflict", current };
}

export async function deleteVehicle(id: number) {
  const result = await pool.query("DELETE FROM vehicles WHERE id = $1 RETURNING id", [id]);
  return result.rows[0] ?? null;
}

export async function getUploads({ limit, offset }: { limit: number; offset: number }) {
  const result = await pool.query(
    "SELECT id, filename, uploaded_at, rows_inserted, rows_skipped FROM uploads ORDER BY uploaded_at DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );
  return result.rows.map(formatRowDates);
}

export interface ImportTemplate {
  id: number;
  header_fingerprint: string;
  sheet_label: string;
  column_mapping: ColumnMapping;
  times_used: number;
  times_corrected: number;
  created_at: Date;
}

export async function findTemplateByFingerprint(fingerprint: string): Promise<ImportTemplate | null> {
  const result = await pool.query("SELECT * FROM import_templates WHERE header_fingerprint = $1", [fingerprint]);
  return result.rows[0] ?? null;
}

// Every template, most-used first -- for GET /api/templates (see
// routes/templates.ts). Surfaces times_used/times_corrected so a format
// whose stored mapping keeps needing correction is visible over time.
export async function listImportTemplates(): Promise<ImportTemplate[]> {
  const result = await pool.query("SELECT * FROM import_templates ORDER BY times_used DESC, id ASC");
  return result.rows;
}

// Upserts on header_fingerprint -- confirming a mapping for a format that's
// already known (e.g. re-confirming with an edit) updates it in place rather
// than erroring or creating a duplicate row. Does NOT touch times_used/
// times_corrected -- see recordTemplateUsage, a separate call so the two
// concerns (what the mapping IS vs. how often it's been used/corrected)
// don't have to happen atomically together.
export async function saveImportTemplate(fingerprint: string, sheetLabel: string, mapping: ColumnMapping): Promise<ImportTemplate> {
  const result = await pool.query(
    `INSERT INTO import_templates (header_fingerprint, sheet_label, column_mapping)
     VALUES ($1, $2, $3)
     ON CONFLICT (header_fingerprint) DO UPDATE SET sheet_label = EXCLUDED.sheet_label, column_mapping = EXCLUDED.column_mapping
     RETURNING *`,
    [fingerprint, sheetLabel, JSON.stringify(mapping)]
  );
  return result.rows[0];
}

// Called once per confirm-mapping call (see routes/upload.ts): increments
// times_used always, and times_corrected when the human-submitted mapping
// differs from what was originally proposed for that same upload (see
// routes/upload.ts's diffMapping).
export async function recordTemplateUsage(fingerprint: string, corrected: boolean): Promise<void> {
  await pool.query(
    `UPDATE import_templates
     SET times_used = times_used + 1, times_corrected = times_corrected + $2
     WHERE header_fingerprint = $1`,
    [fingerprint, corrected ? 1 : 0]
  );
}

export async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// notifications -- see notifications.ts for the nightly job that computes
// these, scheduler.ts for when it runs, and routes/notifications.ts for the
// read-side API. Everything below is either a plain CRUD primitive for that
// API, or a read query the job uses to decide what to insert/escalate/resolve.
// ---------------------------------------------------------------------------

export type NotificationType = "low_stock" | "stnk_expiry" | "aging_inventory" | "scheduled_report";

export interface NotificationRow {
  id: number;
  type: NotificationType;
  severity: string;
  message: string;
  vehicle_id: number | null;
  brand: string | null;
  model_trim: string | null;
  scheduled_report_id: number | null;
  narrative_summary: string | null;
  is_read: boolean;
  is_resolved: boolean;
  created_at: string;
  resolved_at: string | null;
  read_at: string | null;
}

const NOTIFICATION_COLUMNS = [
  "id", "type", "severity", "message", "vehicle_id", "brand", "model_trim", "scheduled_report_id",
  "narrative_summary", "is_read", "is_resolved", "created_at", "resolved_at", "read_at",
] as const;
const NOTIFICATION_COLUMNS_SQL = NOTIFICATION_COLUMNS.join(", ");

export interface NotificationListParams {
  is_read?: boolean;
  is_resolved?: boolean;
  limit?: number;
  offset?: number;
}

export async function listNotifications(params: NotificationListParams): Promise<NotificationRow[]> {
  const clauses: string[] = [];
  const values: any[] = [];
  const push = (v: any) => {
    values.push(v);
    return `$${values.length}`;
  };
  if (params.is_read !== undefined) clauses.push(`is_read = ${push(params.is_read)}`);
  if (params.is_resolved !== undefined) clauses.push(`is_resolved = ${push(params.is_resolved)}`);
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);

  const sql = `SELECT ${NOTIFICATION_COLUMNS_SQL} FROM notifications ${whereSql} ORDER BY created_at DESC LIMIT ${push(limit)} OFFSET ${push(offset)}`;
  const result = await pool.query(sql, values);
  return result.rows.map(formatRowDates);
}

// Unread AND unresolved -- a notification that auto-resolved before anyone
// saw it is no longer an outstanding problem, so it shouldn't inflate a
// "things you need to look at" badge. See routes/notifications.ts's report
// for the reasoning.
export async function countUnreadNotifications(): Promise<number> {
  const result = await pool.query("SELECT COUNT(*) FROM notifications WHERE is_read = false AND is_resolved = false");
  return parseInt(result.rows[0].count, 10);
}

export async function markNotificationRead(id: number): Promise<NotificationRow | null> {
  const result = await pool.query(
    `UPDATE notifications SET is_read = true, read_at = now() WHERE id = $1 RETURNING ${NOTIFICATION_COLUMNS_SQL}`,
    [id]
  );
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

export async function findActiveNotificationsByType(type: NotificationType): Promise<NotificationRow[]> {
  const result = await pool.query(
    `SELECT ${NOTIFICATION_COLUMNS_SQL} FROM notifications WHERE type = $1 AND is_resolved = false`,
    [type]
  );
  return result.rows.map(formatRowDates);
}

export interface InsertNotificationInput {
  type: NotificationType;
  severity: string;
  message: string;
  vehicle_id?: number | null;
  brand?: string | null;
  model_trim?: string | null;
  scheduled_report_id?: number | null;
  narrative_summary?: string | null;
}

export async function insertNotification(input: InsertNotificationInput): Promise<NotificationRow> {
  const result = await pool.query(
    `INSERT INTO notifications (type, severity, message, vehicle_id, brand, model_trim, scheduled_report_id, narrative_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${NOTIFICATION_COLUMNS_SQL}`,
    [
      input.type, input.severity, input.message,
      input.vehicle_id ?? null, input.brand ?? null, input.model_trim ?? null,
      input.scheduled_report_id ?? null, input.narrative_summary ?? null,
    ]
  );
  return formatRowDates(result.rows[0]);
}

// Updates severity/message on an already-active notification in place,
// rather than inserting a duplicate row -- used when a tracked condition
// worsens (STNK goes from expiring_soon to expired, aging inventory crosses
// into the next tier) but there's already an open alert for the same
// vehicle/type.
export async function escalateNotification(id: number, severity: string, message: string): Promise<void> {
  await pool.query("UPDATE notifications SET severity = $2, message = $3 WHERE id = $1", [id, severity, message]);
}

export async function resolveNotification(id: number): Promise<void> {
  await pool.query(
    "UPDATE notifications SET is_resolved = true, resolved_at = now() WHERE id = $1 AND is_resolved = false",
    [id]
  );
}

export interface GroupCount {
  brand: string;
  model_trim: string;
  count: number;
}

export async function getAvailableCountsByGroup(): Promise<GroupCount[]> {
  const result = await pool.query(
    `SELECT brand, model_trim, COUNT(*)::int AS count
     FROM vehicles
     WHERE status = 'available' AND brand IS NOT NULL AND model_trim IS NOT NULL
     GROUP BY brand, model_trim`
  );
  return result.rows;
}

export async function getRecentHandoverCountsByGroup(days: number): Promise<GroupCount[]> {
  const result = await pool.query(
    `SELECT brand, model_trim, COUNT(*)::int AS count
     FROM vehicles
     WHERE brand IS NOT NULL AND model_trim IS NOT NULL
       AND handover_date >= CURRENT_DATE - make_interval(days => $1::int)
       AND handover_date <= CURRENT_DATE
     GROUP BY brand, model_trim`,
    [days]
  );
  return result.rows;
}

export interface StnkExpiryCandidate {
  id: number;
  license_plate: string | null;
  brand: string | null;
  model_trim: string | null;
  days_diff: number; // negative = already expired, 0..windowDays = expiring soon
}

export async function getStnkExpiryCandidates(windowDays: number): Promise<StnkExpiryCandidate[]> {
  const result = await pool.query(
    `SELECT id, license_plate, brand, model_trim, (stnk_expiry_date - CURRENT_DATE)::int AS days_diff
     FROM vehicles
     WHERE status = 'available' AND stnk_expiry_date IS NOT NULL
       AND stnk_expiry_date <= CURRENT_DATE + make_interval(days => $1::int)`,
    [windowDays]
  );
  return result.rows;
}

// Current status + days-to-expiry for a specific set of vehicles -- used to
// decide whether an already-active stnk_expiry notification should
// auto-resolve (see notifications.ts). Deliberately not scoped to
// status='available' the way getStnkExpiryCandidates is: a booked vehicle's
// STNK alert should stay open (it hasn't left the lot yet), only a sold one
// should resolve, per the spec's explicit auto-resolve conditions.
export async function getVehicleStnkSnapshots(
  ids: number[]
): Promise<Map<number, { status: string | null; days_diff: number | null }>> {
  const map = new Map<number, { status: string | null; days_diff: number | null }>();
  if (ids.length === 0) return map;
  const result = await pool.query(
    `SELECT id, status, (stnk_expiry_date - CURRENT_DATE)::int AS days_diff FROM vehicles WHERE id = ANY($1::int[])`,
    [ids]
  );
  for (const row of result.rows) map.set(row.id, { status: row.status, days_diff: row.days_diff });
  return map;
}

export interface AgingInventoryCandidate {
  id: number;
  license_plate: string | null;
  brand: string | null;
  model_trim: string | null;
  days_on_lot: number;
}

export async function getAgingInventoryCandidates(minDays: number): Promise<AgingInventoryCandidate[]> {
  const result = await pool.query(
    `SELECT id, license_plate, brand, model_trim, (CURRENT_DATE - purchase_date)::int AS days_on_lot
     FROM vehicles
     WHERE status = 'available' AND purchase_date IS NOT NULL
       AND (CURRENT_DATE - purchase_date) >= $1::int`,
    [minDays]
  );
  return result.rows;
}

export interface SalesVelocityStats {
  sold_this_week: number;
  booked_this_week: number;
  sold_trailing_4weeks: number;
}

// Powers services/marcusCategories.ts's sales_velocity category. Fully
// deterministic, one query -- deliberately NOT routed through the
// question-to-SQL AI pipeline, unlike Marcus's other non-reused categories,
// since real dated columns (handover_date) make this unambiguous. Trailing
// windows are rolling (from CURRENT_DATE), not calendar weeks, so the
// figure doesn't skew depending on which day of the week the heartbeat runs.
// booked_this_week uses updated_at as a proxy for "became booked" -- there's
// no dedicated booking-date column, so an unrelated edit to an already-
// booked vehicle this week would be miscounted (documented limitation, see
// marcusCategories.ts).
export async function getSalesVelocityStats(): Promise<SalesVelocityStats> {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sold' AND handover_date >= CURRENT_DATE - 7)::int AS sold_this_week,
       COUNT(*) FILTER (WHERE status = 'booked' AND updated_at >= now() - interval '7 days')::int AS booked_this_week,
       COUNT(*) FILTER (WHERE status = 'sold' AND handover_date >= CURRENT_DATE - 35 AND handover_date < CURRENT_DATE - 7)::int AS sold_trailing_4weeks
     FROM vehicles`
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// scheduled_reports -- recurring "Ask AI" questions. See reports.ts for the
// job that decides what's due and runs it through ai.ts#askQuestion (the
// same pipeline POST /api/ask uses), scheduler.ts for when that job runs,
// and routes/scheduledReports.ts for the CRUD API.
// ---------------------------------------------------------------------------

export interface ScheduledReport {
  id: number;
  name: string;
  question: string;
  schedule: string;
  enabled: boolean;
  covers: string[];
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEDULED_REPORT_COLUMNS = [
  "id", "name", "question", "schedule", "enabled", "covers", "last_run_at", "created_at", "updated_at",
] as const;
const SCHEDULED_REPORT_COLUMNS_SQL = SCHEDULED_REPORT_COLUMNS.join(", ");

export async function listScheduledReports(): Promise<ScheduledReport[]> {
  const result = await pool.query(
    `SELECT ${SCHEDULED_REPORT_COLUMNS_SQL} FROM scheduled_reports ORDER BY created_at DESC`
  );
  return result.rows.map(formatRowDates);
}

// Used by reports.ts's job -- due-ness itself depends on cron math, which
// lives there, not here (this file stays SQL-only).
export async function getEnabledScheduledReports(): Promise<ScheduledReport[]> {
  const result = await pool.query(
    `SELECT ${SCHEDULED_REPORT_COLUMNS_SQL} FROM scheduled_reports WHERE enabled = true`
  );
  return result.rows.map(formatRowDates);
}

// Union of `covers` across every currently-enabled report -- used by
// notifications.ts to skip creating a new low_stock/stnk_expiry/
// aging_inventory alert of a type an enabled report already surfaces. See
// migration_add_scheduled_report_covers.sql.
export async function getEnabledCoveredTypes(): Promise<Set<string>> {
  const result = await pool.query(
    `SELECT DISTINCT unnest(covers) AS type FROM scheduled_reports WHERE enabled = true`
  );
  return new Set(result.rows.map((row) => row.type as string));
}

export async function getScheduledReportById(id: number): Promise<ScheduledReport | null> {
  const result = await pool.query(
    `SELECT ${SCHEDULED_REPORT_COLUMNS_SQL} FROM scheduled_reports WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

export interface CreateScheduledReportInput {
  name: string;
  question: string;
  schedule: string;
  enabled?: boolean;
  covers?: string[];
}

export async function createScheduledReport(input: CreateScheduledReportInput): Promise<ScheduledReport> {
  const result = await pool.query(
    `INSERT INTO scheduled_reports (name, question, schedule, enabled, covers)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SCHEDULED_REPORT_COLUMNS_SQL}`,
    [input.name, input.question, input.schedule, input.enabled ?? true, input.covers ?? []]
  );
  return formatRowDates(result.rows[0]);
}

// Editable via PATCH /api/scheduled-reports/:id. Anything not listed here
// (id, last_run_at, created_at, ...) is immutable through that route.
const SCHEDULED_REPORT_EDITABLE_FIELDS = ["name", "question", "schedule", "enabled", "covers"] as const;

export function isEditableScheduledReportField(field: string): boolean {
  return (SCHEDULED_REPORT_EDITABLE_FIELDS as readonly string[]).includes(field);
}

export async function updateScheduledReport(
  id: number,
  fields: Record<string, unknown>
): Promise<ScheduledReport | null> {
  const setClauses: string[] = [];
  const params: any[] = [];
  const push = (value: any) => {
    params.push(value);
    return `$${params.length}`;
  };

  for (const field of SCHEDULED_REPORT_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      setClauses.push(`${field} = ${push(fields[field])}`);
    }
  }
  if (setClauses.length === 0) return null;

  setClauses.push("updated_at = now()");
  const sql = `UPDATE scheduled_reports SET ${setClauses.join(", ")} WHERE id = ${push(id)} RETURNING ${SCHEDULED_REPORT_COLUMNS_SQL}`;
  const result = await pool.query(sql, params);
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

export async function deleteScheduledReport(id: number): Promise<{ id: number } | null> {
  const result = await pool.query("DELETE FROM scheduled_reports WHERE id = $1 RETURNING id", [id]);
  return result.rows[0] ?? null;
}

export async function markScheduledReportRun(id: number, ranAt: Date): Promise<void> {
  await pool.query("UPDATE scheduled_reports SET last_run_at = $2 WHERE id = $1", [id, ranAt]);
}

// ---------------------------------------------------------------------------
// report_runs -- durable history of every scheduled-report execution,
// independent of notifications (see reports.ts's runScheduledReportNow,
// which inserts one of these alongside the bell notification on every run,
// and routes/scheduledReports.ts's GET /:id/runs).
// ---------------------------------------------------------------------------

export type ReportRunStatus = "answered" | "needs_clarification" | "error";

export interface ReportRun {
  id: number;
  scheduled_report_id: number | null;
  question: string;
  status: ReportRunStatus;
  summary: string;
  sql: string | null;
  narrative_summary: string | null;
  created_at: string;
}

const REPORT_RUN_COLUMNS = [
  "id", "scheduled_report_id", "question", "status", "summary", "sql", "narrative_summary", "created_at",
] as const;
const REPORT_RUN_COLUMNS_SQL = REPORT_RUN_COLUMNS.join(", ");

export interface InsertReportRunInput {
  scheduled_report_id: number | null;
  question: string;
  status: ReportRunStatus;
  summary: string;
  sql?: string | null;
  narrative_summary?: string | null;
}

export async function insertReportRun(input: InsertReportRunInput): Promise<ReportRun> {
  const result = await pool.query(
    `INSERT INTO report_runs (scheduled_report_id, question, status, summary, sql, narrative_summary)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${REPORT_RUN_COLUMNS_SQL}`,
    [
      input.scheduled_report_id, input.question, input.status, input.summary,
      input.sql ?? null, input.narrative_summary ?? null,
    ]
  );
  return formatRowDates(result.rows[0]);
}

export interface ReportRunListParams {
  limit?: number;
  offset?: number;
}

// Deliberately doesn't check that scheduledReportId still exists as a real
// scheduled_reports row -- see report_runs's soft-reference note in
// migration_add_report_runs.sql. Returns whatever runs are on file for that
// id, whether the parent report is alive, deleted, or never existed at all.
export async function listReportRuns(scheduledReportId: number, params: ReportRunListParams): Promise<ReportRun[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  const offset = Math.max(params.offset ?? 0, 0);
  const result = await pool.query(
    `SELECT ${REPORT_RUN_COLUMNS_SQL} FROM report_runs WHERE scheduled_report_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [scheduledReportId, limit, offset]
  );
  return result.rows.map(formatRowDates);
}

// ---------------------------------------------------------------------------
// accounts / api_keys -- Phase 8: real per-account API keys, replacing the
// single static API_KEY env var. See services/apiKeys.ts for raw-key
// generation/hashing, middleware/apiKeyAuth.ts for the request-time check
// that calls findApiKeyByHash below, and routes/apiKeys.ts for the
// generate/list/revoke endpoints.
// ---------------------------------------------------------------------------

export interface Account {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

export async function findAccountByUsername(username: string): Promise<Account | null> {
  const result = await pool.query(
    "SELECT id, username, password_hash, created_at FROM accounts WHERE username = $1",
    [username]
  );
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

// Used only by scripts/seed_admin_account.ts to make seeding idempotent
// (insert the shared demoman credential as a real row exactly once).
export async function createAccount(username: string, passwordHash: string): Promise<Account> {
  const result = await pool.query(
    "INSERT INTO accounts (username, password_hash) VALUES ($1, $2) RETURNING id, username, password_hash, created_at",
    [username, passwordHash]
  );
  return formatRowDates(result.rows[0]);
}

// Public-facing shape of an api_keys row -- key_hash is deliberately never
// selected here or anywhere outside findApiKeyByHash below, since it's the
// one column that must never leave this file.
export interface ApiKeyRow {
  id: number;
  account_id: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const API_KEY_PUBLIC_COLUMNS = "id, account_id, created_at, last_used_at, revoked_at";

export async function createApiKey(accountId: number, keyHash: string): Promise<ApiKeyRow> {
  const result = await pool.query(
    `INSERT INTO api_keys (account_id, key_hash) VALUES ($1, $2) RETURNING ${API_KEY_PUBLIC_COLUMNS}`,
    [accountId, keyHash]
  );
  return formatRowDates(result.rows[0]);
}

export async function listApiKeysForAccount(accountId: number): Promise<ApiKeyRow[]> {
  const result = await pool.query(
    `SELECT ${API_KEY_PUBLIC_COLUMNS} FROM api_keys WHERE account_id = $1 ORDER BY created_at DESC`,
    [accountId]
  );
  return result.rows.map(formatRowDates);
}

// Scoped to accountId so one account can never revoke another's key. Only
// succeeds (returns a row) if the key exists, belongs to this account, and
// isn't already revoked -- matches the same "no-op if already in that
// state" convention as resolveNotification.
export async function revokeApiKey(id: number, accountId: number): Promise<ApiKeyRow | null> {
  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL
     RETURNING ${API_KEY_PUBLIC_COLUMNS}`,
    [id, accountId]
  );
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

// The one lookup every single API request makes. Only matches a
// non-revoked key -- revocation takes effect on the very next request,
// nothing else to invalidate or expire.
export async function findApiKeyByHash(keyHash: string): Promise<{ id: number; accountId: number } | null> {
  const result = await pool.query(
    "SELECT id, account_id FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
    [keyHash]
  );
  return result.rows[0] ? { id: result.rows[0].id, accountId: result.rows[0].account_id } : null;
}

// Fire-and-forget from the request path (see middleware/apiKeyAuth.ts) --
// never awaited there, so a slow/failed update never adds latency or
// failure risk to an otherwise-valid request.
export async function touchApiKeyLastUsed(id: number): Promise<void> {
  await pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [id]);
}

// ---------------------------------------------------------------------------
// marcus_config / marcus_heartbeats -- Phase 9: Marcus, the proactive
// whole-business heartbeat (distinct from scheduled_reports, which re-runs
// one fixed question). See services/marcusCategories.ts for the 9 category
// computations, jobs/marcus.ts for scheduling/orchestration, and
// routes/marcus.ts for the /api/marcus/* API.
// ---------------------------------------------------------------------------

export interface MarcusConfig {
  id: 1;
  schedule: string;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const MARCUS_CONFIG_COLUMNS = ["id", "schedule", "enabled", "last_run_at", "created_at", "updated_at"] as const;
const MARCUS_CONFIG_COLUMNS_SQL = MARCUS_CONFIG_COLUMNS.join(", ");

// Always exactly one row -- id=1 is seeded by migration_add_marcus.sql and
// enforced by that table's CHECK (id = 1) constraint.
export async function getMarcusConfig(): Promise<MarcusConfig> {
  const result = await pool.query(`SELECT ${MARCUS_CONFIG_COLUMNS_SQL} FROM marcus_config WHERE id = 1`);
  return formatRowDates(result.rows[0]);
}

const MARCUS_CONFIG_EDITABLE_FIELDS = ["schedule", "enabled"] as const;

export function isEditableMarcusConfigField(field: string): boolean {
  return (MARCUS_CONFIG_EDITABLE_FIELDS as readonly string[]).includes(field);
}

export async function updateMarcusConfig(fields: Record<string, unknown>): Promise<MarcusConfig> {
  const setClauses: string[] = [];
  const params: any[] = [];
  const push = (value: any) => {
    params.push(value);
    return `$${params.length}`;
  };

  for (const field of MARCUS_CONFIG_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      setClauses.push(`${field} = ${push(fields[field])}`);
    }
  }
  setClauses.push("updated_at = now()");
  const sql = `UPDATE marcus_config SET ${setClauses.join(", ")} WHERE id = 1 RETURNING ${MARCUS_CONFIG_COLUMNS_SQL}`;
  const result = await pool.query(sql, params);
  return formatRowDates(result.rows[0]);
}

export async function markMarcusConfigRun(ranAt: Date): Promise<void> {
  await pool.query("UPDATE marcus_config SET last_run_at = $1 WHERE id = 1", [ranAt]);
}

export type MarcusHeartbeatStatus = "ok" | "partial_error";

export interface MarcusHeartbeat {
  id: number;
  status: MarcusHeartbeatStatus;
  metrics: Record<string, unknown>;
  severities: Record<string, unknown>;
  deltas: Record<string, unknown>;
  top_mover: Record<string, unknown> | null;
  rain_context: unknown[];
  narrative: Record<string, unknown>;
  created_at: string;
}

const MARCUS_HEARTBEAT_COLUMNS = [
  "id", "status", "metrics", "severities", "deltas", "top_mover", "rain_context", "narrative", "created_at",
] as const;
const MARCUS_HEARTBEAT_COLUMNS_SQL = MARCUS_HEARTBEAT_COLUMNS.join(", ");

export interface InsertMarcusHeartbeatInput {
  status: MarcusHeartbeatStatus;
  metrics: Record<string, unknown>;
  severities: Record<string, unknown>;
  deltas: Record<string, unknown>;
  top_mover: Record<string, unknown> | null;
  rain_context: unknown[];
  narrative: Record<string, unknown>;
}

// marcus_heartbeats is append-only by design -- there is deliberately no
// update/delete function here (see migration_add_marcus.sql's doc comment).
export async function insertMarcusHeartbeat(input: InsertMarcusHeartbeatInput): Promise<MarcusHeartbeat> {
  const result = await pool.query(
    `INSERT INTO marcus_heartbeats (status, metrics, severities, deltas, top_mover, rain_context, narrative)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${MARCUS_HEARTBEAT_COLUMNS_SQL}`,
    [
      input.status,
      JSON.stringify(input.metrics),
      JSON.stringify(input.severities),
      JSON.stringify(input.deltas),
      input.top_mover !== null ? JSON.stringify(input.top_mover) : null,
      JSON.stringify(input.rain_context),
      JSON.stringify(input.narrative),
    ]
  );
  return formatRowDates(result.rows[0]);
}

export interface MarcusHeartbeatListParams {
  limit?: number;
  offset?: number;
}

// Deliberately excludes metrics/narrative (the heavy columns) -- a lower
// default/max than report_runs' 100/500 convention since even without those
// two, severities across 9 categories is a nontrivial payload per row.
export async function listMarcusHeartbeatsLight(params: MarcusHeartbeatListParams) {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const result = await pool.query(
    `SELECT id, created_at, status, severities, top_mover FROM marcus_heartbeats ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return result.rows.map(formatRowDates);
}

export async function getMarcusHeartbeatById(id: number): Promise<MarcusHeartbeat | null> {
  const result = await pool.query(
    `SELECT ${MARCUS_HEARTBEAT_COLUMNS_SQL} FROM marcus_heartbeats WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

export async function getLatestMarcusHeartbeat(): Promise<MarcusHeartbeat | null> {
  const result = await pool.query(
    `SELECT ${MARCUS_HEARTBEAT_COLUMNS_SQL} FROM marcus_heartbeats ORDER BY created_at DESC LIMIT 1`
  );
  return result.rows[0] ? formatRowDates(result.rows[0]) : null;
}

// Internal only -- not exposed via any route. Powers the trailing-average/
// trend baselines for inventory_health/aging_inventory/discount_drift (see
// marcusCategories.ts): `vehicles` is a live snapshot with no history of its
// own, so those baselines are self-bootstrapped from Marcus's own prior
// heartbeats instead.
export async function getMarcusHeartbeatHistoryForBaseline(
  limit = 90
): Promise<{ created_at: string; metrics: Record<string, unknown> }[]> {
  const result = await pool.query(
    `SELECT created_at, metrics FROM marcus_heartbeats ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map(formatRowDates);
}

// Rain-awareness (see marcusCategories.ts / jobs/marcus.ts): recently-
// answered Scheduled Reports, so Marcus's narrative can reference rather
// than repeat what a report already surfaced.
export interface RecentAnsweredReportRun {
  report_id: number | null;
  report_name: string | null;
  question: string;
  summary: string;
  narrative_summary: string | null;
  created_at: string;
}

export async function getRecentAnsweredReportRuns(days: number, limit: number): Promise<RecentAnsweredReportRun[]> {
  const result = await pool.query(
    `SELECT rr.scheduled_report_id AS report_id, sr.name AS report_name, rr.question, rr.summary, rr.narrative_summary, rr.created_at
     FROM report_runs rr
     LEFT JOIN scheduled_reports sr ON sr.id = rr.scheduled_report_id
     WHERE rr.status = 'answered' AND rr.created_at >= now() - make_interval(days => $1::int)
     ORDER BY rr.created_at DESC
     LIMIT $2`,
    [days, limit]
  );
  return result.rows.map(formatRowDates);
}
