/**
 * routes/upload.ts
 *
 * Three-step upload flow, all stateless (the uploaded file is never cached
 * server-side between steps -- every step that needs the file's bytes gets
 * it re-sent as multipart/form-data). Nothing is written to the database
 * until the final confirm step.
 *
 * STEP 1 -- POST /api/upload
 * Takes just the file. Does no parsing, no header detection, no
 * fingerprinting, no insertion -- not even for a sheet whose format is
 * already known. Only lists the sheet names present in the workbook plus
 * cheap per-sheet stats (declared row/column count -- see
 * templates.ts's getSheetSummaries for why "declared" matters: a sheet's
 * !ref can be inflated by formatting bleed well beyond its real data).
 * Source files regularly contain aggregate/summary/pivot sheets that were
 * never meant to be imported, so nothing gets processed automatically
 * until a sheet is explicitly chosen in step 2.
 *
 * STEP 2 -- POST /api/upload/process-sheet
 * Takes the file again plus sheet_name. Runs header detection and
 * fingerprinting scoped to just that one sheet:
 *   - Known fingerprint -> parse using the stored column_mapping (no AI).
 *   - Unknown fingerprint -> one SumoPod call proposes a column_mapping
 *     (see ai.ts); if it can't confidently identify license_plate/brand,
 *     responds with needs_clarification instead of guessing.
 * Either way, if a mapping is available (stored or proposed), this parses
 * the sheet with it and returns a preview -- row count, every raw cell
 * row and every parsed row (up to MAX_PREVIEW_ROWS, see below),
 * anything skipped/flagged -- WITHOUT inserting anything. A known format
 * now gets exactly the same preview-before-commit treatment an
 * unrecognized one already required.
 *
 * Optional header_row / data_start_row form fields (both integers) bypass
 * auto-detection entirely and re-scan the sheet at exactly that row instead
 * -- e.g. to preview a second table further down a sheet whose own header
 * row wouldn't otherwise win detectHeaderRow's auto-pick. Registry/AI-
 * proposal logic downstream is unchanged, just parameterized by the
 * override instead of the auto-detected row. Omit both for the previous,
 * unchanged auto-detect behavior.
 *
 * STEP 3 -- POST /api/upload/confirm-mapping
 * Takes the file again plus sheet_name and the (possibly human-edited)
 * mapping from step 2. Saves the mapping into import_templates (harmless
 * no-op re-save if it was already a registry hit; for a freshly-proposed
 * mapping this is what makes the format recognized from now on), then
 * parses and inserts for real. Optional excludeRows (JSON array of sheet
 * row numbers, same numbers the step-2 preview handed back under `_row`/
 * `row_index`) drops specific rows before parsing -- they show up in the
 * response's skipped array with reason "excluded by user". Optional
 * original_mapping (the `mapping` a prior process-sheet call returned) is
 * diffed against the submitted mapping purely for correction tracking --
 * see recordTemplateUsage / GET /api/templates -- omitting it just means no
 * correction signal gets recorded for this call, it doesn't block anything.
 */

import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { insertVehicles, findTemplateByFingerprint, saveImportTemplate, recordTemplateUsage } from "../db";
import { requireApiKey } from "../middleware/apiKey";
import { proposeColumnMapping, judgeMappingSemantics } from "../ai";
import {
  detectHeaderRow,
  extractHeaderCellsAtRow,
  extractHeaderCellsWithSubRow,
  computeHeaderFingerprint,
  buildPreviewRows,
  buildRawRowsForIndices,
  extractRowsWithMapping,
  getSheetSummaries,
  ColumnMapping,
  MappableField,
} from "../templates";
import { computeAccuracyScore, AccuracyScore } from "../scoring";
import { VehicleRow, SkippedRow } from "../parser";
import { FlaggedRow } from "../templates";

/**
 * SheetPreview -- the response shape of a successful (status: "preview")
 * process-sheet call. `accuracy` is a computed signal (see scoring.ts):
 * built from real per-value/per-column checks against the actual extracted
 * data, not a self-reported AI confidence number -- see computeAccuracyScore's
 * doc comment for exactly what it checks and why.
 */
interface SheetPreview {
  status: "preview";
  sheet: string;
  source: "registry" | "ai_proposed";
  headerRow: ReturnType<typeof extractHeaderCellsAtRow>;
  mapping: ColumnMapping;
  rowCount: number;
  rawPreview: Record<string, unknown>[];
  parsedPreview: VehicleRow[];
  truncated: boolean;
  skipped: SkippedRow[];
  flagged: FlaggedRow[];
  accuracy: AccuracyScore;
  usage?: unknown;
}

// Safety cap on the preview response's rawPreview/parsedPreview arrays --
// distinct from the "always 10" sample this replaces. Real sheets in this
// system run to the low hundreds of rows at most; this is deliberately far
// above that (a genuine few-thousand-row sheet is already an outlier) so it
// only ever bites on a truly pathological file, not normal usage. rowCount
// always reflects the true total; `truncated` tells the caller if the
// arrays were capped short of it.
const MAX_PREVIEW_ROWS = 5000;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

// Wraps an async handler so any rejected promise reaches Express's error
// pipeline (and this file's own res.status(500) catch blocks below) instead
// of becoming an unhandled rejection -- the last line of defense alongside
// the try/catch already inside each handler. See server.ts for the global
// error middleware and process-level safety net this ultimately feeds into.
function asyncRoute(fn: (req: Request, res: Response) => Promise<void | Response>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function readWorkbook(buffer: Buffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: "buffer", cellDates: true });
}

// Parses an optional integer form field. Returns undefined if the field
// wasn't sent at all (the normal, unchanged-behavior case), or null if it
// was sent but isn't a valid integer (caller should 400).
function parseOptionalInt(raw: unknown): number | undefined | null {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw.trim())) return null;
  return parseInt(raw, 10);
}

// STEP 1 -----------------------------------------------------------------

router.post(
  "/",
  requireApiKey,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected form field 'file')" });
    }

    try {
      const wb = readWorkbook(req.file.buffer);
      const sheets = getSheetSummaries(wb);
      res.json({ status: "select_sheet", sheets });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to read the file", detail: err.message });
    }
  })
);

// STEP 2 -------------------------------------------------------------------

router.post(
  "/process-sheet",
  requireApiKey,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected form field 'file')" });
    }
    const sheetName = typeof req.body.sheet_name === "string" ? req.body.sheet_name.trim() : "";
    if (!sheetName) {
      return res.status(400).json({ error: "Missing 'sheet_name' form field" });
    }

    // Optional override: re-scan at exactly this row instead of accepting
    // detectHeaderRow's auto-pick -- see file-level doc comment.
    const headerRowOverride = parseOptionalInt(req.body.header_row);
    const dataStartRowOverride = parseOptionalInt(req.body.data_start_row);
    if (headerRowOverride === null) {
      return res.status(400).json({ error: "'header_row' must be an integer" });
    }
    if (dataStartRowOverride === null) {
      return res.status(400).json({ error: "'data_start_row' must be an integer" });
    }

    try {
      const wb = readWorkbook(req.file.buffer);
      const ws = wb.Sheets[sheetName];
      if (!ws) {
        return res.status(400).json({ error: `Sheet '${sheetName}' not found in the uploaded file` });
      }

      let headerRow: number;
      let dataStartRow: number;
      let headerCells: ReturnType<typeof extractHeaderCellsAtRow>;

      if (headerRowOverride !== undefined) {
        headerRow = headerRowOverride;
        dataStartRow = dataStartRowOverride ?? headerRow + 1;
        headerCells = extractHeaderCellsAtRow(ws, headerRow);
        console.log(`[process-sheet] header_row override: row=${headerRow} dataStartRow=${dataStartRow} headerCells=${headerCells.length}`);
      } else {
        ({ headerRow, dataStartRow, headerCells } = detectHeaderRow(ws));
        console.log(`[process-sheet] auto-detected: row=${headerRow} dataStartRow=${dataStartRow} headerCells=${headerCells.length}`);
      }

      if (headerCells.length === 0) {
        return res.json({
          status: "no_header_detected",
          sheet: sheetName,
          message: "No header row could be detected in this sheet -- it may not be a data sheet.",
        });
      }

      // Fingerprint/registry matching always uses the plain single-row scan
      // -- never the sub-row fallback below -- so it can't silently change
      // which stored template a re-upload matches. Skipped entirely when a
      // header_row override is given: the point of the override is to see
      // exactly what a fresh scan of that specific row produces, not to
      // risk matching an unrelated stored template by coincidence.
      const fingerprint = computeHeaderFingerprint(headerCells);
      const template = headerRowOverride !== undefined ? null : await findTemplateByFingerprint(fingerprint);
      console.log(
        `[process-sheet] fingerprint=${fingerprint.slice(0, 16)}... ` +
          (headerRowOverride !== undefined
            ? "registry lookup skipped (header_row override given)"
            : `registryHit=${!!template}` + (template ? ` template.headerRow=${template.column_mapping.headerRow}` : ""))
      );

      // Richer, display-only cell list: falls back to the row directly below
      // for any column that's blank at the detected header row (e.g. a
      // merged group header with independent sub-labels one row down -- see
      // extractHeaderCellsWithSubRow's doc comment). Used for what a human
      // reviews and what the AI sees, never for the fingerprint above.
      const displayHeaderCells = extractHeaderCellsWithSubRow(ws, headerRow);

      let mapping: ColumnMapping;
      let source: "registry" | "ai_proposed";
      let usage: unknown;

      if (template) {
        mapping = template.column_mapping;
        source = "registry";
      } else {
        const sampleRows = buildPreviewRows(ws, displayHeaderCells, dataStartRow, 5);
        const proposal = await proposeColumnMapping(displayHeaderCells, sampleRows);

        if (proposal.status === "needs_clarification") {
          return res.json({ status: "needs_clarification", sheet: sheetName, message: proposal.message, usage: proposal.usage });
        }

        mapping = { headerRow, dataStartRow, columns: proposal.columns };
        source = "ai_proposed";
        usage = proposal.usage;
      }

      const { rows, skipped, flagged } = extractRowsWithMapping(ws, mapping, sheetName);

      // Step 4 (semantic judge): only for a freshly ai_proposed mapping --
      // a registry hit already went through a human confirm-mapping once,
      // so re-judging it every upload would be redundant AI spend. See
      // ai.ts's judgeMappingSemantics doc comment.
      let semanticFlags: Map<MappableField, string> | undefined;
      if (source === "ai_proposed") {
        const judgeResult = await judgeMappingSemantics(displayHeaderCells, mapping.columns);
        if (judgeResult.flags.length > 0) {
          semanticFlags = new Map(judgeResult.flags.map((f) => [f.field as MappableField, f.reason]));
          console.log(`[process-sheet] semantic judge flagged ${judgeResult.flags.length} field(s):`, JSON.stringify(judgeResult.flags));
        }
      }

      // Scored against the full extracted row set, not the possibly-truncated
      // preview slice below -- more representative of the actual upload.
      const accuracy = computeAccuracyScore(rows, mapping, semanticFlags);

      const truncated = rows.length > MAX_PREVIEW_ROWS;
      const parsedPreview = truncated ? rows.slice(0, MAX_PREVIEW_ROWS) : rows;
      // Built from parsedPreview's own row_index values (not scanned
      // independently) so rawPreview and parsedPreview are guaranteed to
      // cover exactly the same rows, in the same order.
      const rawPreview = buildRawRowsForIndices(ws, displayHeaderCells, parsedPreview.map((r) => r.row_index));

      const preview: SheetPreview = {
        status: "preview",
        sheet: sheetName,
        source,
        headerRow: displayHeaderCells,
        mapping,
        rowCount: rows.length,
        rawPreview,
        parsedPreview,
        truncated,
        skipped,
        flagged,
        accuracy,
        ...(usage ? { usage } : {}),
      };
      res.json(preview);
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to process the sheet", detail: err.message });
    }
  })
);

// STEP 3 -------------------------------------------------------------------

router.post(
  "/confirm-mapping",
  requireApiKey,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected form field 'file')" });
    }

    const sheetName = typeof req.body.sheet_name === "string" ? req.body.sheet_name.trim() : "";
    if (!sheetName) {
      return res.status(400).json({ error: "Missing 'sheet_name' form field" });
    }

    let mapping: ColumnMapping;
    try {
      mapping = JSON.parse(req.body.mapping);
    } catch {
      return res.status(400).json({ error: "'mapping' form field must be valid JSON" });
    }
    if (!mapping || typeof mapping.headerRow !== "number" || typeof mapping.dataStartRow !== "number" || typeof mapping.columns !== "object") {
      return res.status(400).json({ error: "'mapping' must be an object with headerRow, dataStartRow, and columns" });
    }
    if (!mapping.columns.license_plate || !mapping.columns.brand) {
      return res.status(400).json({ error: "mapping.columns must include at least license_plate and brand" });
    }

    // Optional: sheet row numbers (matching _row/row_index from the preview
    // step) to drop before parsing, on top of whatever price-sanity/error
    // isolation already skips -- e.g. rows a human flagged as garbage while
    // reviewing the preview.
    let excludeRows: Set<number> | undefined;
    if (typeof req.body.excludeRows === "string" && req.body.excludeRows.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body.excludeRows);
      } catch {
        return res.status(400).json({ error: "'excludeRows' form field must be valid JSON" });
      }
      if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) {
        return res.status(400).json({ error: "'excludeRows' must be a JSON array of row numbers" });
      }
      excludeRows = new Set(parsed);
    }

    // Optional: the mapping that was originally proposed for this same
    // upload (whatever a prior process-sheet call returned as `mapping`) --
    // the 3-step flow is stateless (file re-sent every step, see file-level
    // doc comment), so this is the only way confirm-mapping can know what
    // changed. Used purely for correction tracking (see recordTemplateUsage);
    // absence doesn't block confirming, it just means no correction signal
    // gets recorded for this call.
    let originalMapping: ColumnMapping | undefined;
    if (typeof req.body.original_mapping === "string" && req.body.original_mapping.trim()) {
      try {
        originalMapping = JSON.parse(req.body.original_mapping);
      } catch {
        return res.status(400).json({ error: "'original_mapping' form field must be valid JSON" });
      }
    }

    const sheetLabel = typeof req.body.sheet_label === "string" && req.body.sheet_label.trim() ? req.body.sheet_label.trim() : sheetName;

    try {
      const wb = readWorkbook(req.file.buffer);
      const ws = wb.Sheets[sheetName];
      if (!ws) {
        return res.status(400).json({ error: `Sheet '${sheetName}' not found in the re-uploaded file` });
      }

      // Fingerprint is recomputed from what's actually in the re-uploaded file
      // at the (possibly human-edited) header row the mapping specifies --
      // never trusted blindly from the request.
      const headerCells = extractHeaderCellsAtRow(ws, mapping.headerRow);
      const fingerprint = computeHeaderFingerprint(headerCells);

      await saveImportTemplate(fingerprint, sheetLabel, mapping);

      if (originalMapping) {
        const corrected = mappingWasCorrected(originalMapping, mapping);
        await recordTemplateUsage(fingerprint, corrected);
      }

      const { rows, skipped, flagged } = extractRowsWithMapping(ws, mapping, sheetName, excludeRows);
      const { uploadId, inserted } = await insertVehicles(req.file.originalname, rows, skipped.length);

      res.json({ uploadId, inserted, skipped, flagged, templateSaved: true });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: "Failed to confirm mapping or insert the file", detail: err.message });
    }
  })
);

/**
 * True if any field's mapped column in `submitted` changed or was removed
 * compared to `original` -- a newly-added field (present in submitted but
 * absent from original) doesn't count, since enriching an already-good
 * mapping isn't the same signal as fixing a wrong one. Only compares the
 * base `columns`, not regions -- regions are a structural, human-authored
 * feature (see ColumnMappingRegion), not something either proposal or
 * confirmation is expected to churn on per upload.
 */
function mappingWasCorrected(original: ColumnMapping, submitted: ColumnMapping): boolean {
  for (const [field, originalCol] of Object.entries(original.columns)) {
    if (submitted.columns[field as MappableField] !== originalCol) return true;
  }
  return false;
}

export default router;
