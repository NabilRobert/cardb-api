/**
 * templates.ts
 *
 * Template-registry-based Excel import mapping. Instead of hardcoding a
 * parser per known sheet name, this detects a sheet's header row, fingerprints
 * it, and either reuses a known column_mapping from import_templates (fast,
 * free, deterministic -- no AI involved) or hands off to the AI-proposal flow
 * in ai.ts for a header shape we haven't seen before. See routes/upload.ts
 * for how the two paths are wired together, and migration_add_import_templates.sql
 * / schema.sql for the import_templates table itself.
 */

import * as XLSX from "xlsx";
import * as crypto from "crypto";
import { VehicleRow, SkippedRow, getCell, normalizeBrand, cleanPlate, parseIndonesianDate, parseStatusAndReserved } from "./parser";

export const MAPPABLE_FIELDS = [
  "license_plate", "vin", "engine_no", "brand", "model_trim", "year",
  "transmission", "color", "odometer_km", "stnk_expiry_date", "status",
  "location", "ownership", "price_cash", "price_credit",
  "max_credit_discount", "notes_raw", "source",
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

export interface ColumnMapping {
  headerRow: number;
  dataStartRow: number;
  columns: Partial<Record<MappableField, string>>;
  // Fallbacks for sheets that encode these by convention (e.g. "this whole
  // sheet is the SMR branch, everything in it is available") rather than a
  // per-row column -- only used when the corresponding column isn't mapped.
  locationDefault?: string;
  statusDefault?: string;
}

export interface HeaderCell {
  col: string;
  value: string;
}

// Scan the first ~10 rows for the header. Some real-world sheets declare a
// !ref far wider than their actual data (leftover cell-formatting bleed --
// e.g. a sheet whose real data ends around column BR but whose !ref claims
// column XER, see the "Daily Inventory HQ3&CV" investigation). Cap the
// column scan so a bogus declared range can't turn a cheap header search
// into a slow one.
const MAX_HEADER_SCAN_ROWS = 10;
const MAX_HEADER_SCAN_COLS = 200;

function colLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function looksLikeLabel(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 40;
}

function getRange(ws: XLSX.WorkSheet): { s: { r: number; c: number }; e: { r: number; c: number } } {
  const ref = ws["!ref"] as string | undefined;
  return ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
}

function headerCellsAtRow(ws: XLSX.WorkSheet, row: number, maxCol: number): HeaderCell[] {
  const cells: HeaderCell[] = [];
  for (let c = 0; c <= maxCol; c++) {
    const col = colLetter(c);
    const { value } = getCell(ws, col, row);
    if (looksLikeLabel(value)) cells.push({ col, value: (value as string).trim() });
  }
  return cells;
}

/**
 * Scans the first ~10 rows for the one with the most non-empty, label-shaped
 * (short string) cells -- that row is taken to be the header, with data
 * assumed to start on the very next row. Reasonable for both a clean sheet
 * (header on row 1) and one with title/section rows above the real header
 * (e.g. Pricelist's header on row 6, or HQ3/HQ CV's on row 3).
 */
export function detectHeaderRow(ws: XLSX.WorkSheet): { headerRow: number; dataStartRow: number; headerCells: HeaderCell[] } {
  const range = getRange(ws);
  const maxCol = Math.min(range.e.c, MAX_HEADER_SCAN_COLS);
  const maxRow = Math.min(range.e.r, range.s.r + MAX_HEADER_SCAN_ROWS - 1);

  let bestRow = range.s.r + 1; // 1-indexed Excel row
  let bestCells: HeaderCell[] = [];
  let bestScore = -1;

  for (let r = range.s.r + 1; r <= maxRow + 1; r++) {
    const cells = headerCellsAtRow(ws, r, maxCol);
    if (cells.length > bestScore) {
      bestScore = cells.length;
      bestRow = r;
      bestCells = cells;
    }
  }

  return { headerRow: bestRow, dataStartRow: bestRow + 1, headerCells: bestCells };
}

/** Re-extracts header cells at a specific (possibly human-edited) row, e.g. when confirming a mapping. */
export function extractHeaderCellsAtRow(ws: XLSX.WorkSheet, row: number): HeaderCell[] {
  const range = getRange(ws);
  const maxCol = Math.min(range.e.c, MAX_HEADER_SCAN_COLS);
  return headerCellsAtRow(ws, row, maxCol);
}

/**
 * Hashes the normalized header row (trim + uppercase each non-empty cell,
 * join, hash) so minor whitespace/casing differences between two uploads of
 * "the same" format don't produce a false-negative registry miss.
 */
export function computeHeaderFingerprint(headerCells: HeaderCell[]): string {
  const normalized = headerCells
    .map((h) => h.value.trim().toUpperCase())
    .filter((v) => v !== "")
    .join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/** A handful of data rows keyed by column letter -- used both as AI sample input and as the human-facing preview. */
export function buildPreviewRows(ws: XLSX.WorkSheet, headerCells: HeaderCell[], dataStartRow: number, maxRows: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let r = dataStartRow; r < dataStartRow + maxRows; r++) {
    const row: Record<string, unknown> = {};
    let hasValue = false;
    for (const { col } of headerCells) {
      const { value } = getCell(ws, col, r);
      if (value !== null) hasValue = true;
      row[col] = value;
    }
    if (!hasValue) break; // ran out of data
    rows.push(row);
  }
  return rows;
}

export interface FlaggedRow {
  sheet: string;
  row: number;
  field: string;
  value: unknown;
  reason: string;
}

// A car price below this is almost certainly column drift (e.g. the "Age" or
// "Km" column got read as the price column), not a genuine price -- this is
// the failure mode a header-only check (AI mapping or human approval of it)
// can't catch, since the header row can be entirely correct while the data
// rows drift columns partway through.
const MIN_PLAUSIBLE_PRICE = 500_000;

function checkPriceSanity(row: VehicleRow, sheetName: string): FlaggedRow[] {
  const flags: FlaggedRow[] = [];
  for (const field of ["price_cash", "price_credit"] as const) {
    const value = row[field];
    if (typeof value === "number" && value > 0 && value < MIN_PLAUSIBLE_PRICE) {
      flags.push({
        sheet: sheetName,
        row: row.row_index,
        field,
        value,
        reason: `${field} = ${value} is implausibly low for a vehicle -- likely column drift`,
      });
    }
  }
  return flags;
}

// Same defensive cap as the header-column scan, applied to rows -- a
// sheet's declared row range can be inflated by formatting bleed too.
const MAX_DATA_ROWS = 20_000;

/**
 * Extracts VehicleRows from a sheet using a stored or just-confirmed
 * column_mapping. This is the one shared extraction path for both a
 * registry hit and a human-confirmed AI proposal -- so the price sanity
 * check below applies regardless of where the mapping came from.
 */
export function extractRowsWithMapping(
  ws: XLSX.WorkSheet,
  mapping: ColumnMapping,
  sheetName: string
): { rows: VehicleRow[]; skipped: SkippedRow[]; flagged: FlaggedRow[] } {
  const rows: VehicleRow[] = [];
  const skipped: SkippedRow[] = [];
  const flagged: FlaggedRow[] = [];

  const range = getRange(ws);
  const lastRow = Math.min(range.e.r + 1, mapping.dataStartRow + MAX_DATA_ROWS);
  const cols = mapping.columns;

  const get = (field: MappableField, r: number) => (cols[field] ? getCell(ws, cols[field]!, r) : { value: null, isError: false });

  for (let r = mapping.dataStartRow; r <= lastRow; r++) {
    const plate = get("license_plate", r);
    const merk = get("brand", r);

    if (plate.value === null && merk.value === null && !plate.isError && !merk.isError) {
      continue; // blank spacer row
    }
    if (plate.isError || merk.isError) {
      skipped.push({ sheet: sheetName, row: r, reason: "#REF! error" });
      continue;
    }

    const tipe = get("model_trim", r);
    const transmisi = get("transmission", r);
    const tahun = get("year", r);
    const warna = get("color", r);
    const km = get("odometer_km", r);
    const tglStnk = get("stnk_expiry_date", r);
    const hargaCash = get("price_cash", r);
    const hargaKredit = get("price_credit", r);
    const maxDisc = get("max_credit_discount", r);
    const kepemilikan = get("ownership", r);
    const keterangan = get("notes_raw", r);
    const posisiUnit = get("status", r);
    const lokasi = get("location", r);
    const vinCell = get("vin", r);
    const engineCell = get("engine_no", r);
    const sourceCell = get("source", r);

    const { status, reservedBy } = posisiUnit.value
      ? parseStatusAndReserved(posisiUnit.value as string)
      : { status: mapping.statusDefault ?? null, reservedBy: null };

    const vehicleRow: VehicleRow = {
      license_plate: cleanPlate(plate.value),
      vin: typeof vinCell.value === "string" ? vinCell.value.trim() : null,
      engine_no: typeof engineCell.value === "string" ? engineCell.value.trim() : null,
      brand: normalizeBrand(merk.value),
      model_trim: typeof tipe.value === "string" ? tipe.value.trim() : null,
      year: typeof tahun.value === "number" ? tahun.value : null,
      transmission: typeof transmisi.value === "string" ? transmisi.value : null,
      color: typeof warna.value === "string" ? warna.value : null,
      odometer_km: typeof km.value === "number" ? km.value : null,
      stnk_expiry_date: tglStnk.value instanceof Date ? tglStnk.value : parseIndonesianDate(tglStnk.value),
      stock_entry_date: null, // generic mappings don't derive this -- no reliable "Age" convention across arbitrary formats
      status,
      reserved_by: reservedBy,
      location: typeof lokasi.value === "string" ? lokasi.value : mapping.locationDefault ?? null,
      ownership: typeof kepemilikan.value === "string" ? kepemilikan.value : null,
      price_cash: typeof hargaCash.value === "number" && hargaCash.value !== 0 ? hargaCash.value : null,
      price_credit: typeof hargaKredit.value === "number" && hargaKredit.value !== 0 ? hargaKredit.value : null,
      max_credit_discount: maxDisc.isError ? null : typeof maxDisc.value === "string" ? maxDisc.value : null,
      notes_raw: typeof keterangan.value === "string" ? keterangan.value : null,
      source: typeof sourceCell.value === "string" ? sourceCell.value : null,
      sheet_name: sheetName,
      row_index: r,
    };

    flagged.push(...checkPriceSanity(vehicleRow, sheetName));
    rows.push(vehicleRow);
  }

  return { rows, skipped, flagged };
}
