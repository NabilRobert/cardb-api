/**
 * scripts/seed_import_templates.ts
 *
 * One-time seed: migrates the two hardcoded sheet formats this app already
 * knew how to parse (Pricelist, SMR -- see parser.ts's loadPricelistSheet /
 * loadSmrSheet doc comments for the column layout this is built from) into
 * import_templates, so the generic registry-based upload flow in
 * routes/upload.ts recognizes them without ever calling the AI.
 *
 * Deliberately does NOT seed HQ3 / HQ CV: those sheet names were never
 * actually handled by hardcoded logic in this codebase (parseWorkbook only
 * ever checked for "Pricelist" and "SMR") -- that gap is exactly the
 * silent-0-rows-inserted bug diagnosed earlier. There is no
 * already-known-correct mapping for that format to migrate; it's meant to
 * flow through the AI-proposal + human-confirmation path instead, same as
 * any other new format.
 *
 * Builds a minimal synthetic worksheet with the real, documented header
 * labels at their real row position, then runs it through the same
 * detectHeaderRow/computeHeaderFingerprint functions the live upload path
 * uses -- so the seeded fingerprint is guaranteed to match what a real
 * upload of this format computes, rather than a hand-hashed string that
 * could silently drift from the real normalization logic.
 *
 * Usage: npx ts-node scripts/seed_import_templates.ts
 */

import * as XLSX from "xlsx";
import * as dotenv from "dotenv";
import { detectHeaderRow, computeHeaderFingerprint, ColumnMapping } from "../templates";
import { saveImportTemplate, pool } from "../db";

dotenv.config();

function buildHeaderOnlySheet(headers: { cell: string; label: string }[], ref: string): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {};
  for (const { cell, label } of headers) {
    ws[cell] = { t: "s", v: label };
  }
  ws["!ref"] = ref;
  return ws;
}

async function seedTemplate(sheetLabel: string, headers: { cell: string; label: string }[], ref: string, mapping: Omit<ColumnMapping, "headerRow" | "dataStartRow">, expectedHeaderRow: number) {
  const ws = buildHeaderOnlySheet(headers, ref);
  const { headerRow, dataStartRow, headerCells } = detectHeaderRow(ws);

  if (headerRow !== expectedHeaderRow) {
    throw new Error(
      `${sheetLabel}: header-detection heuristic picked row ${headerRow}, expected row ${expectedHeaderRow} -- refusing to seed a fingerprint that wouldn't match a real upload of this format.`
    );
  }

  const fingerprint = computeHeaderFingerprint(headerCells);
  const fullMapping: ColumnMapping = { headerRow, dataStartRow, ...mapping };
  const saved = await saveImportTemplate(fingerprint, sheetLabel, fullMapping);
  console.log(`Seeded "${sheetLabel}" -> fingerprint ${fingerprint.slice(0, 12)}... (template id ${saved.id}, header row ${headerRow}, data starts row ${dataStartRow})`);
}

async function main() {
  // Pricelist: header row 6, data starts row 8 (row 7 reserved for section
  // spacing in the real file). Columns per parser.ts's loadPricelistSheet doc.
  await seedTemplate(
    "Pricelist",
    [
      { cell: "A6", label: "No." }, { cell: "B6", label: "No.Pol" }, { cell: "C6", label: "Merk" },
      { cell: "D6", label: "Tipe" }, { cell: "E6", label: "Transmisi" }, { cell: "F6", label: "Tahun" },
      { cell: "G6", label: "Warna" }, { cell: "H6", label: "Km" }, { cell: "I6", label: "Tgl STNK" },
      { cell: "J6", label: "Age" }, { cell: "K6", label: "Harga CASH" }, { cell: "L6", label: "Harga Kredit" },
      { cell: "M6", label: "Maksimal Disc Kredit" }, { cell: "N6", label: "Kepemilikan" },
      { cell: "O6", label: "Keterangan" }, { cell: "P6", label: "Posisi Unit" }, { cell: "Q6", label: "Total Nilai Stock" },
    ],
    "A1:Q8",
    {
      columns: {
        license_plate: "B", brand: "C", model_trim: "D", transmission: "E", year: "F",
        color: "G", odometer_km: "H", stnk_expiry_date: "I", price_cash: "K", price_credit: "L",
        max_credit_discount: "M", ownership: "N", notes_raw: "O", status: "P",
      },
      locationDefault: "DSSM",
    },
    6
  );

  // SMR: header row 3, data starts row 5 (row 4 reserved for spacing).
  // No status/price columns -- every row here is available SMR-branch stock.
  await seedTemplate(
    "SMR",
    [
      { cell: "A3", label: "No" }, { cell: "B3", label: "Nomor Polisi" }, { cell: "C3", label: "Merk" },
      { cell: "D3", label: "Tipe" }, { cell: "E3", label: "Transmisi" }, { cell: "F3", label: "Tahun" },
      { cell: "G3", label: "Warna" }, { cell: "H3", label: "Km" }, { cell: "I3", label: "Grade" }, { cell: "J3", label: "Notes" },
    ],
    "A1:J5",
    {
      columns: {
        license_plate: "B", brand: "C", model_trim: "D", transmission: "E", year: "F",
        color: "G", odometer_km: "H", notes_raw: "J",
      },
      locationDefault: "SMR",
      statusDefault: "available",
    },
    3
  );

  // "Daily Report Updated" (DSSM Bintaro file): unlike Pricelist/SMR above,
  // we don't have the full literal header-row-2 text for every column of
  // this real-world file -- only the column letters each field maps to,
  // learned from an actual upload plus a human correction after the
  // "Harga Jual" mis-mapping bug (see commit 6855bbd). The sheet also
  // stacks a second table further down (header row 13) that reuses the
  // same column letters for unrelated fields -- see ColumnMapping.regions
  // in templates.ts. So this seeds the already-known-good fingerprint and
  // mapping directly rather than rederiving the fingerprint from a
  // reconstructed header row.
  await saveImportTemplate(
    "66ca37b572e65bf38426d291f897ef6e2aa02fd5dde6933b4f4abda7c8390efb",
    "Daily Report Updated",
    {
      headerRow: 2,
      dataStartRow: 3,
      columns: {
        license_plate: "E", vin: "M", engine_no: "N", brand: "F", model_trim: "G",
        transmission: "H", year: "I", color: "J", odometer_km: "K", stnk_expiry_date: "L",
        purchase_date: "O", handover_date: "AU", status: "D", ownership: "AW",
        notes_raw: "AS", source: "AV",
        price_credit: "Q", // table 1 header (row 2): Q = "Harga Real Jual Credit"
        price_cash: "R",   // table 1 header (row 2): R = "Harga Real Jual Cash"
      },
      regions: [
        {
          fromRow: 13, // second header (row 13) redefines Q onward for rows below it
          columns: {
            price_credit: null, // no cash/credit split in this table
            price_cash: null,
            price_net: "Q", // row 13: Q = "Harga Jual (NETT)"
          },
        },
      ],
    }
  );
  console.log(`Seeded "Daily Report Updated" -> fingerprint 66ca37b572e6... (known fingerprint, not rederived)`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
