/**
 * ingest_excel.ts
 *
 * CLI entry point: parses the DSS Motor inventory Excel workbook and loads
 * it into the `uploads` / `vehicles` tables (see schema.sql) in Postgres.
 * Parsing logic lives in parser.ts, shared with server.ts.
 *
 * Usage:
 *   npx ts-node ingest_excel.ts path/to/file.xlsx              # parse + insert into DB
 *   npx ts-node ingest_excel.ts path/to/file.xlsx --dry-run    # parse only, no DB writes
 *
 * Requires DATABASE_URL in a .env file alongside this script (or in the environment).
 */

import * as XLSX from "xlsx";
import * as path from "path";
import { Pool } from "pg";
import * as dotenv from "dotenv";
import { parseWorkbook, VehicleRow } from "./parser";

dotenv.config();

async function insertIntoDb(filename: string, rows: VehicleRow[]) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
    console.log(`Inserted ${rows.length} vehicles under upload_id=${uploadId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const xlsxPath = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");

  if (!xlsxPath) {
    console.error("Usage: ts-node ingest_excel.ts path/to/file.xlsx [--dry-run]");
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  const { rows, skipped } = parseWorkbook(wb);

  console.log(`Parsed ${rows.length} vehicle rows, skipped ${skipped.length} broken rows.`);
  for (const s of skipped) console.log("  skipped:", s);

  if (dryRun) {
    for (const r of rows.slice(0, 10)) console.log(r);
    console.log("... (dry run, nothing written to the database)");
    return;
  }

  await insertIntoDb(path.basename(xlsxPath), rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
