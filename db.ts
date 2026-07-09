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

export async function insertVehicles(filename: string, rows: VehicleRow[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const uploadResult = await client.query(
      "INSERT INTO uploads (filename) VALUES ($1) RETURNING id",
      [filename]
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
