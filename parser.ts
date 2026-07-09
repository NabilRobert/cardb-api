/**
 * parser.ts
 *
 * Shared Excel-parsing logic, used by both the CLI (ingest_excel.ts) and the
 * web server (server.ts) so the parsing rules only live in one place.
 *
 * Handles the real-world quirks found in the source file:
 *   - "Posisi Unit" -> status (available / booked) + who booked it
 *   - "Keterangan"  -> kept as raw notes
 *   - brand name typos (e.g. "Mitsubsihi" -> "Mitsubishi")
 *   - "Harga CASH" == 0 means "not offered for cash", not free -> stored as NULL
 *   - rows broken by Excel #REF! errors are skipped and reported, not inserted
 *   - Indonesian date strings ("20 Maret 2027") are parsed into real dates
 *   - "Age" (days in stock) + the report date in cell A2 -> stock_entry_date
 */

import * as XLSX from "xlsx";

// ---------------------------------------------------------------------------
// Reference data / normalization tables
// ---------------------------------------------------------------------------

const BRAND_FIXES: Record<string, string> = {
  mitsubsihi: "Mitsubishi",
  mitsubishi: "Mitsubishi",
  honda: "Honda",
  toyota: "Toyota",
  nissan: "Nissan",
  daihatsu: "Daihatsu",
  wuling: "Wuling",
  hyundai: "Hyundai",
};

// Kept for future use: known area/branch codes that can appear inside
// "Keterangan" (e.g. "BM,BS,KS/O/1/JAKSEL"). Not applied to `location` yet --
// "location" currently just tracks which sheet/branch a row came from
// (DSSM vs SMR). Revisit if you want city-level granularity later.
export const KNOWN_AREAS = [
  "TANGSEL", "JAKSEL", "JAKBAR", "JAKTIM", "JAKUT", "JAKPUS",
  "BOGOR", "BEKASI", "BKS", "TGR", "TANGERANG",
];

const INDONESIAN_MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
};

export function normalizeBrand(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const key = raw.trim().toLowerCase();
  return BRAND_FIXES[key] ?? titleCase(raw.trim());
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

/** '20 Maret 2027' -> Date(2027, 2, 20). Returns null if unparseable. */
export function parseIndonesianDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const [, day, monthName, year] = m;
  const month = INDONESIAN_MONTHS[monthName.trim().toLowerCase()];
  if (!month) return null;
  const d = new Date(Number(year), month - 1, Number(day));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 'DSSM'          -> { status: 'available', reservedBy: null }
 * 'BOOKED/CALVIN' -> { status: 'booked', reservedBy: 'CALVIN' }
 * '#REF!' / empty -> { status: null, reservedBy: null }
 */
export function parseStatusAndReserved(posisiUnit: unknown): { status: string | null; reservedBy: string | null } {
  if (typeof posisiUnit !== "string" || !posisiUnit.trim()) return { status: null, reservedBy: null };
  const val = posisiUnit.trim();
  if (val === "#REF!") return { status: null, reservedBy: null };
  if (val.toUpperCase().startsWith("BOOKED")) {
    const parts = val.split("/");
    // Not title-cased on purpose: "PT" looks like a company/entity code,
    // not a person's name like "CALVIN" or "SEAN" -- preserve as written.
    const reservedBy = parts.length > 1 ? parts.slice(1).join("/").trim() : null;
    return { status: "booked", reservedBy };
  }
  if (val.toUpperCase() === "DSSM") return { status: "available", reservedBy: null };
  return { status: val.toLowerCase(), reservedBy: null };
}

export function cleanPlate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const val = raw.trim();
  return val && val !== "#REF!" ? val : null;
}

/**
 * The sheet doesn't have a direct "date entered stock" column, but it does
 * have "Age" (days in stock) next to a report date in cell A2 (e.g. "Harga
 * hanya berlaku untuk hari ini" = prices valid as of this date). Verified
 * against the "Daily Report Updated" sheet, which has both a real purchase
 * date and an Age column side by side: report_date - purchase_date == Age,
 * exactly, in whole days. So: stock_entry_date = report_date - Age days.
 */
export function deriveStockEntryDate(reportDate: Date | null, age: unknown): Date | null {
  if (!reportDate || typeof age !== "number" || isNaN(age)) return null;
  const d = new Date(reportDate);
  d.setDate(d.getDate() - age);
  return d;
}

// ---------------------------------------------------------------------------
// Raw cell helper -- needed because a #REF! error cell has type 'e', and a
// naive sheet_to_json conversion silently turns it into null, which would
// look identical to a genuinely blank cell. We check cell.t === 'e' explicitly
// so broken rows get reported instead of quietly inserted with gaps.
// ---------------------------------------------------------------------------

export function getCell(ws: XLSX.WorkSheet, col: string, row: number) {
  const cell = ws[`${col}${row}`];
  if (!cell) return { value: null, isError: false };
  if (cell.t === "e") return { value: null, isError: true };
  return { value: cell.v, isError: false };
}

export interface VehicleRow {
  license_plate: string | null;
  vin: string | null;
  engine_no: string | null;
  brand: string | null;
  model_trim: string | null;
  year: number | null;
  transmission: string | null;
  color: string | null;
  odometer_km: number | null;
  stnk_expiry_date: Date | null;
  stock_entry_date: Date | null;
  status: string | null;
  reserved_by: string | null;
  location: string | null;
  ownership: string | null;
  price_cash: number | null;
  price_credit: number | null;
  max_credit_discount: string | null;
  notes_raw: string | null;
  source: string | null;
  sheet_name: string;
  row_index: number;
}

export interface SkippedRow {
  sheet: string;
  row: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Sheet loaders
// ---------------------------------------------------------------------------

/**
 * 'Pricelist' sheet columns (row 6 is the header, data starts row 8):
 * A=No. B=No.Pol C=Merk D=Tipe E=Transmisi F=Tahun G=Warna H=Km I=Tgl STNK
 * J=Age K=Harga CASH L=Harga Kredit M=Maksimal Disc Kredit N=Kepemilikan
 * O=Keterangan P=Posisi Unit Q=Total Nilai Stock
 */
export function loadPricelistSheet(ws: XLSX.WorkSheet): { rows: VehicleRow[]; skipped: SkippedRow[] } {
  const rows: VehicleRow[] = [];
  const skipped: SkippedRow[] = [];

  // Cell A2 holds the date this pricelist snapshot is valid for -- used as
  // the reference point to turn "Age" (days in stock) into an actual date.
  const reportDateCell = getCell(ws, "A", 2);
  const reportDate = reportDateCell.value instanceof Date ? reportDateCell.value : null;

  const range = XLSX.utils.decode_range(ws["!ref"] as string);
  for (let r = 8; r <= range.e.r + 1; r++) {
    const plate = getCell(ws, "B", r);
    const merk = getCell(ws, "C", r);
    const tipe = getCell(ws, "D", r);
    const transmisi = getCell(ws, "E", r);
    const tahun = getCell(ws, "F", r);
    const warna = getCell(ws, "G", r);
    const km = getCell(ws, "H", r);
    const tglStnk = getCell(ws, "I", r);
    const age = getCell(ws, "J", r);
    const hargaCash = getCell(ws, "K", r);
    const hargaKredit = getCell(ws, "L", r);
    const maxDisc = getCell(ws, "M", r);
    const kepemilikan = getCell(ws, "N", r);
    const keterangan = getCell(ws, "O", r);
    const posisiUnit = getCell(ws, "P", r);

    if (plate.value === null && merk.value === null && !plate.isError && !merk.isError) {
      continue; // blank spacer row
    }

    if (plate.isError || merk.isError || tipe.isError || transmisi.isError || tahun.isError || warna.isError || km.isError || tglStnk.isError) {
      skipped.push({ sheet: "Pricelist", row: r, reason: "#REF! error" });
      continue;
    }

    const { status, reservedBy } = parseStatusAndReserved(posisiUnit.value as string);

    rows.push({
      license_plate: cleanPlate(plate.value),
      vin: null,
      engine_no: null,
      brand: normalizeBrand(merk.value),
      model_trim: typeof tipe.value === "string" ? tipe.value.trim() : (tipe.value as any),
      year: typeof tahun.value === "number" ? tahun.value : null,
      transmission: transmisi.value as string,
      color: warna.value as string,
      odometer_km: typeof km.value === "number" ? km.value : null,
      stnk_expiry_date: parseIndonesianDate(tglStnk.value),
      stock_entry_date: deriveStockEntryDate(reportDate, age.isError ? null : age.value),
      status,
      reserved_by: reservedBy,
      location: "DSSM", // this sheet is the DSS Motor Bintaro master list
      ownership: kepemilikan.value as string,
      price_cash: hargaCash.value !== 0 && hargaCash.value !== null ? (hargaCash.value as number) : null,
      price_credit: hargaKredit.value !== 0 && hargaKredit.value !== null ? (hargaKredit.value as number) : null,
      max_credit_discount: maxDisc.isError ? null : (maxDisc.value as string),
      notes_raw: typeof keterangan.value === "string" ? keterangan.value : null,
      source: null,
      sheet_name: "Pricelist",
      row_index: r,
    });
  }

  return { rows, skipped };
}

/**
 * 'SMR' sheet columns (row 3 is the header, data starts row 5):
 * A=No B=Nomor Polisi C=Merk D=Tipe E=Transmisi F=Tahun G=Warna H=Km I=Grade J=Notes
 * No status/price columns here -- treated as available stock at the SMR branch.
 */
export function loadSmrSheet(ws: XLSX.WorkSheet): { rows: VehicleRow[]; skipped: SkippedRow[] } {
  const rows: VehicleRow[] = [];
  const range = XLSX.utils.decode_range(ws["!ref"] as string);

  for (let r = 5; r <= range.e.r + 1; r++) {
    const plate = getCell(ws, "B", r);
    const merk = getCell(ws, "C", r);
    const tipe = getCell(ws, "D", r);
    const transmisi = getCell(ws, "E", r);
    const tahun = getCell(ws, "F", r);
    const warna = getCell(ws, "G", r);
    const km = getCell(ws, "H", r);
    const grade = getCell(ws, "I", r);
    const notes = getCell(ws, "J", r);

    if (plate.value === null && merk.value === null) continue;

    rows.push({
      license_plate: cleanPlate(plate.value),
      vin: null,
      engine_no: null,
      brand: normalizeBrand(merk.value),
      model_trim: typeof tipe.value === "string" ? tipe.value.trim() : (tipe.value as any),
      year: typeof tahun.value === "number" ? tahun.value : null,
      transmission: transmisi.value as string,
      color: warna.value as string,
      odometer_km: typeof km.value === "number" ? km.value : null,
      stnk_expiry_date: null,
      stock_entry_date: null, // SMR sheet has no age/purchase-date info to derive this from
      status: "available",
      reserved_by: null,
      location: "SMR",
      ownership: null,
      price_cash: null,
      price_credit: null,
      max_credit_discount: null,
      notes_raw: (typeof notes.value === "string" ? notes.value : (grade.value as string)) ?? null,
      source: null,
      sheet_name: "SMR",
      row_index: r,
    });
  }

  return { rows, skipped: [] };
}

/** Parses every sheet we know how to handle out of a workbook. */
export function parseWorkbook(wb: XLSX.WorkBook): { rows: VehicleRow[]; skipped: SkippedRow[] } {
  let allRows: VehicleRow[] = [];
  let allSkipped: SkippedRow[] = [];

  if (wb.SheetNames.includes("Pricelist")) {
    const { rows, skipped } = loadPricelistSheet(wb.Sheets["Pricelist"]);
    allRows = allRows.concat(rows);
    allSkipped = allSkipped.concat(skipped);
  }

  if (wb.SheetNames.includes("SMR")) {
    const { rows, skipped } = loadSmrSheet(wb.Sheets["SMR"]);
    allRows = allRows.concat(rows);
    allSkipped = allSkipped.concat(skipped);
  }

  return { rows: allRows, skipped: allSkipped };
}
