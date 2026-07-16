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
  "transmission", "color", "odometer_km", "stnk_expiry_date", "purchase_date",
  "handover_date", "status", "location", "ownership", "price_cash", "price_credit",
  "price_net", "max_credit_discount", "notes_raw", "source",
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/**
 * Some real-world sheets stack two structurally different tables in one
 * worksheet, sharing the same identity columns (plate, brand, model, ...)
 * but reusing the same column *letters* further right for entirely
 * different fields per table (e.g. "Daily Report Updated": rows 3-12 have
 * Q/R = credit/cash price under one header at row 2, while rows 15+ reuse
 * Q for an unrelated net price and have no cash/credit split at all, under
 * a second header at row 13). A region overrides `columns` for the fields
 * it lists, for rows in [fromRow, toRow] -- `null` means "this field does
 * not apply to this region" (not "fall back to the base mapping"), so a
 * field that's genuinely absent in one table doesn't inherit a column
 * letter that means something else there. A field key absent from a
 * region's `columns` (as opposed to present with value null) does fall
 * back to the base mapping -- e.g. identity fields shared by both tables
 * don't need to be repeated in every region.
 */
export interface ColumnMappingRegion {
  fromRow: number;
  toRow?: number; // inclusive; omitted = through the end of the sheet's data
  columns: Partial<Record<MappableField, string | null>>;
}

export interface ColumnMapping {
  headerRow: number;
  dataStartRow: number;
  columns: Partial<Record<MappableField, string>>;
  regions?: ColumnMappingRegion[];
  // Fallbacks for sheets that encode these by convention (e.g. "this whole
  // sheet is the SMR branch, everything in it is available") rather than a
  // per-row column -- only used when the corresponding column isn't mapped.
  locationDefault?: string;
  statusDefault?: string;
}

/** Resolves which column letter (if any) applies to a field at a given sheet row, honoring region overrides. */
function resolveColumn(mapping: ColumnMapping, field: MappableField, row: number): string | null {
  if (mapping.regions) {
    for (const region of mapping.regions) {
      if (row >= region.fromRow && (region.toRow === undefined || row <= region.toRow)) {
        if (field in region.columns) {
          return region.columns[field] ?? null;
        }
        break; // matched region, but it defers this field to the base mapping
      }
    }
  }
  return mapping.columns[field] ?? null;
}

export interface HeaderCell {
  col: string;
  value: string;
}

// Scan the first ~20 rows for the header. Some real-world sheets declare a
// !ref far wider than their actual data (leftover cell-formatting bleed --
// e.g. a sheet whose real data ends around column BR but whose !ref claims
// column XER, see the "Daily Inventory HQ3&CV" investigation). Cap the
// column scan so a bogus declared range can't turn a cheap header search
// into a slow one.
//
// 20 rows (not 10): some sheets stack a second table with its own header
// further down (e.g. "Daily Report Updated"'s second header at row 13) --
// if auto-detection can't see far enough to even consider that row, a human
// reviewing an AI-proposed mapping never gets a chance to notice the sheet
// has a second, differently-shaped table at all (see ColumnMappingRegion).
const MAX_HEADER_SCAN_ROWS = 20;
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

export interface SheetSummary {
  name: string;
  rowCount: number;
  colCount: number;
}

/**
 * Cheap, O(1)-per-sheet summary for the sheet-selection step (see
 * routes/upload.ts) -- just decodes each sheet's declared !ref, no cell
 * iteration at all. rowCount/colCount are the *declared* dimensions, which
 * can be inflated by leftover formatting bleed on a sheet whose real data is
 * much narrower/shorter (see the "Daily Inventory HQ3&CV" investigation,
 * where a sheet's real ~70 columns of data had a declared range out to
 * column 16,372) -- that inflation is itself part of the sanity signal this
 * is meant to surface, not something to hide from the caller.
 */
export function getSheetSummaries(wb: XLSX.WorkBook): SheetSummary[] {
  return wb.SheetNames.map((name) => {
    const range = getRange(wb.Sheets[name]);
    return {
      name,
      rowCount: range.e.r - range.s.r + 1,
      colCount: range.e.c - range.s.c + 1,
    };
  });
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
 * Like extractHeaderCellsAtRow, but for any column whose cell at `row`
 * doesn't parse as a label, also checks the row directly below before
 * giving up on that column. Some real-world sheets put a column's only
 * readable label one row below a merged/grouped header cell -- e.g. "Daily
 * Report Updated"'s row 13 has a merged "Market Price ..." header over
 * columns U:V, with independent "Kredit"/"Cash" sub-labels at U14/V14; a
 * single-row scan can end up missing column U there even though it has a
 * real label and real per-row data, depending on exactly how the source
 * file encodes the merged cell.
 *
 * Deliberately NOT used for computeHeaderFingerprint / registry matching --
 * only for what's shown to a human (preview) and what's handed to the AI as
 * sample context. Folding the fallback into fingerprinting would change the
 * hash for sheets that already have stored templates, silently breaking
 * their registry match.
 */
export function extractHeaderCellsWithSubRow(ws: XLSX.WorkSheet, row: number): HeaderCell[] {
  const range = getRange(ws);
  const maxCol = Math.min(range.e.c, MAX_HEADER_SCAN_COLS);
  const cells: HeaderCell[] = [];
  for (let c = 0; c <= maxCol; c++) {
    const col = colLetter(c);
    let { value } = getCell(ws, col, row);
    if (!looksLikeLabel(value)) {
      const below = getCell(ws, col, row + 1).value;
      if (looksLikeLabel(below)) value = below;
    }
    if (looksLikeLabel(value)) cells.push({ col, value: (value as string).trim() });
  }
  return cells;
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

/**
 * A handful of data rows keyed by column letter -- used both as AI sample
 * input and as the human-facing raw preview. Skips blank rows rather than
 * stopping at the first one: several known real formats have an
 * intentional blank spacer row immediately after the header (e.g.
 * Pricelist/SMR, header row N, data starting N+2) -- treating that as
 * "end of data" would return an empty preview despite real rows existing
 * a line further down. The scan itself is still bounded, so a sheet that's
 * genuinely empty (or has a huge declared range with no real data) can't
 * turn this into an unbounded walk.
 *
 * Each row carries its actual sheet row number under `_row` -- a leading
 * underscore so it can never collide with a real column letter -- so a
 * caller (e.g. a "remove this row" UI) can reference a specific row back
 * to routes/upload.ts's confirm-mapping excludeRows. (extractRowsWithMapping's
 * VehicleRow-shaped output already exposes the same number as `row_index`,
 * the existing field name used everywhere else in this codebase.)
 */
export function buildPreviewRows(ws: XLSX.WorkSheet, headerCells: HeaderCell[], dataStartRow: number, maxRows: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const scanLimit = dataStartRow + Math.max(maxRows * 20, 50);
  for (let r = dataStartRow; r < scanLimit && rows.length < maxRows; r++) {
    const row: Record<string, unknown> = { _row: r };
    let hasValue = false;
    for (const { col } of headerCells) {
      const { value } = getCell(ws, col, r);
      if (value !== null) hasValue = true;
      row[col] = value;
    }
    if (!hasValue) continue; // skip blank spacer rows rather than assuming end-of-data
    rows.push(row);
  }
  return rows;
}

/**
 * Raw (column-letter-keyed) cell values for an exact, already-known set of
 * sheet row numbers -- e.g. the row_index of every row extractRowsWithMapping
 * successfully parsed. Unlike buildPreviewRows, this doesn't scan for or
 * skip anything: the caller already decided which rows matter, so this just
 * reads them. Used so a "preview" response's rawPreview and parsedPreview
 * stay in exact 1:1 correspondence (same rows, same order, same count) --
 * scanning independently (as buildPreviewRows does) could disagree with
 * extractRowsWithMapping's own row-inclusion rules (e.g. a #REF! error row
 * that extractRowsWithMapping sends to `skipped` rather than `rows`).
 */
export function buildRawRowsForIndices(ws: XLSX.WorkSheet, headerCells: HeaderCell[], rowIndices: number[]): Record<string, unknown>[] {
  return rowIndices.map((r) => {
    const row: Record<string, unknown> = { _row: r };
    for (const { col } of headerCells) {
      row[col] = getCell(ws, col, r).value;
    }
    return row;
  });
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
  for (const field of ["price_cash", "price_credit", "price_net"] as const) {
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
 *
 * excludeRows (sheet row numbers, matching the `_row`/`row_index` a preview
 * step already handed back to the caller) lets a human drop specific rows
 * before they're ever parsed -- e.g. rows they've visually identified as
 * garbage in the preview. Excluded rows land in `skipped` just like any
 * other skip reason, so the final counts stay honest.
 */
export function extractRowsWithMapping(
  ws: XLSX.WorkSheet,
  mapping: ColumnMapping,
  sheetName: string,
  excludeRows?: ReadonlySet<number>
): { rows: VehicleRow[]; skipped: SkippedRow[]; flagged: FlaggedRow[] } {
  const rows: VehicleRow[] = [];
  const skipped: SkippedRow[] = [];
  const flagged: FlaggedRow[] = [];

  const range = getRange(ws);
  const lastRow = Math.min(range.e.r + 1, mapping.dataStartRow + MAX_DATA_ROWS);

  const get = (field: MappableField, r: number) => {
    const col = resolveColumn(mapping, field, r);
    return col ? getCell(ws, col, r) : { value: null, isError: false };
  };

  for (let r = mapping.dataStartRow; r <= lastRow; r++) {
    if (excludeRows?.has(r)) {
      skipped.push({ sheet: sheetName, row: r, reason: "excluded by user" });
      continue;
    }
    // A single malformed row (unexpected cell shape, a helper throwing on
    // something it wasn't defended against) must never abort the whole
    // sheet -- catch it, record the real reason, and keep going.
    try {
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
      const tglBeli = get("purchase_date", r);
      const tglHandover = get("handover_date", r);
      const hargaCash = get("price_cash", r);
      const hargaKredit = get("price_credit", r);
      const hargaNet = get("price_net", r);
      const maxDisc = get("max_credit_discount", r);
      const kepemilikan = get("ownership", r);
      const keterangan = get("notes_raw", r);
      const posisiUnit = get("status", r);
      const lokasi = get("location", r);
      const vinCell = get("vin", r);
      const engineCell = get("engine_no", r);
      const sourceCell = get("source", r);

      const { status, reservedBy } = typeof posisiUnit.value === "string"
        ? parseStatusAndReserved(posisiUnit.value)
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
        purchase_date: tglBeli.value instanceof Date ? tglBeli.value : parseIndonesianDate(tglBeli.value),
        handover_date: tglHandover.value instanceof Date ? tglHandover.value : parseIndonesianDate(tglHandover.value),
        status,
        reserved_by: reservedBy,
        location: typeof lokasi.value === "string" ? lokasi.value : mapping.locationDefault ?? null,
        ownership: typeof kepemilikan.value === "string" ? kepemilikan.value : null,
        price_cash: typeof hargaCash.value === "number" && hargaCash.value !== 0 ? hargaCash.value : null,
        price_credit: typeof hargaKredit.value === "number" && hargaKredit.value !== 0 ? hargaKredit.value : null,
        price_net: typeof hargaNet.value === "number" && hargaNet.value !== 0 ? hargaNet.value : null,
        max_credit_discount: maxDisc.isError ? null : typeof maxDisc.value === "string" ? maxDisc.value : null,
        notes_raw: typeof keterangan.value === "string" ? keterangan.value : null,
        source: typeof sourceCell.value === "string" ? sourceCell.value : null,
        sheet_name: sheetName,
        row_index: r,
      };

      flagged.push(...checkPriceSanity(vehicleRow, sheetName));
      rows.push(vehicleRow);
    } catch (err: any) {
      skipped.push({ sheet: sheetName, row: r, reason: err?.message ?? String(err) });
    }
  }

  return { rows, skipped, flagged };
}
