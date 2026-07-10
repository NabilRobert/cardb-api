/**
 * db.ts
 *
 * Shared Postgres connection pool, used by the web server. (The CLI script
 * ingest_excel.ts creates its own short-lived pool since it runs once and exits.)
 */

import { Pool } from "pg";
import * as dotenv from "dotenv";
import { VehicleRow } from "./parser";

dotenv.config();

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
          transmission, color, odometer_km, stnk_expiry_date, stock_entry_date,
          status, reserved_by, location, ownership,
          price_cash, price_credit, max_credit_discount,
          notes_raw, source, upload_id, sheet_name, row_index
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [
          r.license_plate, r.vin, r.engine_no, r.brand, r.model_trim, r.year,
          r.transmission, r.color, r.odometer_km, r.stnk_expiry_date, r.stock_entry_date,
          r.status, r.reserved_by, r.location, r.ownership,
          r.price_cash, r.price_credit, r.max_credit_discount,
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

export async function getAllVehicles() {
  const result = await pool.query("SELECT * FROM vehicles ORDER BY id DESC");
  return result.rows;
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
};
const DATE_RANGE_FIELDS: Record<string, { before: string; after: string }> = {
  stnk_expiry_date: { before: "stnk_expiry_before", after: "stnk_expiry_after" },
  stock_entry_date: { before: "stock_entry_before", after: "stock_entry_after" },
};
const SORT_WHITELIST = [
  ...TEXT_ILIKE_FIELDS, ...EXACT_FIELDS, "year", "odometer_km", "price_cash", "price_credit", "created_at",
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
  const sql = `SELECT * FROM vehicles ${whereSql} ORDER BY ${orderSql} LIMIT ${pushData(limit)} OFFSET ${pushData(offset)}`;

  const result = await pool.query(sql, dataParams);
  return { rows: result.rows, total };
}

export async function getVehicleById(id: number) {
  const result = await pool.query("SELECT * FROM vehicles WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

// Columns editable via PATCH /api/vehicles/:id. Anything not listed here
// (id, vin, license_plate, upload_id, created_at, ...) is immutable through
// this route regardless of what the request body contains.
const VEHICLE_EDITABLE_FIELDS = [
  "status", "reserved_by", "price_cash", "price_credit", "max_credit_discount", "notes_raw", "location",
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
  const sql = `UPDATE vehicles SET ${setClauses.join(", ")} WHERE id = ${push(id)} RETURNING *`;
  const result = await pool.query(sql, params);
  return result.rows[0] ?? null;
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
  return result.rows;
}

export async function checkDbConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
