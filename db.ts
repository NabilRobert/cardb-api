/**
 * db.ts
 *
 * Shared Postgres connection pool, used by the web server. (The CLI script
 * ingest_excel.ts creates its own short-lived pool since it runs once and exits.)
 */

import { Pool, types } from "pg";
import * as dotenv from "dotenv";
import { VehicleRow } from "./parser";
import { ColumnMapping } from "./templates";

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
const TIMESTAMP_FIELDS = ["created_at", "updated_at", "uploaded_at", "resolved_at", "read_at", "last_run_at"] as const;

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
  is_read: boolean;
  is_resolved: boolean;
  created_at: string;
  resolved_at: string | null;
  read_at: string | null;
}

const NOTIFICATION_COLUMNS = [
  "id", "type", "severity", "message", "vehicle_id", "brand", "model_trim", "scheduled_report_id",
  "is_read", "is_resolved", "created_at", "resolved_at", "read_at",
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
}

export async function insertNotification(input: InsertNotificationInput): Promise<NotificationRow> {
  const result = await pool.query(
    `INSERT INTO notifications (type, severity, message, vehicle_id, brand, model_trim, scheduled_report_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${NOTIFICATION_COLUMNS_SQL}`,
    [
      input.type, input.severity, input.message,
      input.vehicle_id ?? null, input.brand ?? null, input.model_trim ?? null,
      input.scheduled_report_id ?? null,
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
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEDULED_REPORT_COLUMNS = [
  "id", "name", "question", "schedule", "enabled", "last_run_at", "created_at", "updated_at",
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
}

export async function createScheduledReport(input: CreateScheduledReportInput): Promise<ScheduledReport> {
  const result = await pool.query(
    `INSERT INTO scheduled_reports (name, question, schedule, enabled)
     VALUES ($1, $2, $3, $4)
     RETURNING ${SCHEDULED_REPORT_COLUMNS_SQL}`,
    [input.name, input.question, input.schedule, input.enabled ?? true]
  );
  return formatRowDates(result.rows[0]);
}

// Editable via PATCH /api/scheduled-reports/:id. Anything not listed here
// (id, last_run_at, created_at, ...) is immutable through that route.
const SCHEDULED_REPORT_EDITABLE_FIELDS = ["name", "question", "schedule", "enabled"] as const;

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
