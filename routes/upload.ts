/**
 * routes/upload.ts
 *
 * POST /api/upload - accepts an .xlsx file. For each sheet, detects the
 * header row and looks its fingerprint up in the import_templates registry
 * (see templates.ts):
 *   - Known fingerprint -> parse + insert immediately using the stored
 *     column_mapping. Fast, free, deterministic, no AI involved.
 *   - Unknown fingerprint -> nothing is inserted from this upload. One
 *     SumoPod call proposes a column_mapping (see ai.ts); if it can't
 *     confidently identify license_plate/brand, responds with
 *     needs_clarification, otherwise needs_mapping_review (proposed mapping
 *     + a preview of parsed rows, for a human to confirm or edit).
 * If a workbook has multiple sheets and any one of them is unrecognized,
 * the whole upload halts at that sheet (nothing partially inserted) --
 * resubmit via /confirm-mapping, then re-upload the file to pick up any
 * remaining sheets.
 *
 * POST /api/upload/confirm-mapping - accepts the (possibly human-edited)
 * column mapping plus the original file re-sent as multipart/form-data.
 * Stateless by design: the uploaded file from the first request is never
 * cached server-side between the two calls. Saves the mapping into
 * import_templates (so this exact header shape is recognized from now on),
 * then parses and inserts using it.
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { insertVehicles, findTemplateByFingerprint, saveImportTemplate } from "../db";
import { requireApiKey } from "../middleware/apiKey";
import { proposeColumnMapping } from "../ai";
import {
  detectHeaderRow,
  extractHeaderCellsAtRow,
  computeHeaderFingerprint,
  buildPreviewRows,
  extractRowsWithMapping,
  ColumnMapping,
} from "../templates";
import { VehicleRow, SkippedRow } from "../parser";
import { FlaggedRow } from "../templates";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

router.post("/", requireApiKey, upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded (expected form field 'file')" });
  }

  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const resolved: { sheetName: string; ws: XLSX.WorkSheet; mapping: ColumnMapping }[] = [];

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const { headerRow, dataStartRow, headerCells } = detectHeaderRow(ws);
      if (headerCells.length === 0) continue; // nothing that looks like a header -- nothing to import from this sheet

      const fingerprint = computeHeaderFingerprint(headerCells);
      const template = await findTemplateByFingerprint(fingerprint);

      if (template) {
        resolved.push({ sheetName, ws, mapping: template.column_mapping });
        continue;
      }

      // Unrecognized header shape -- stop here, don't insert anything from
      // this upload yet (even sheets already resolved above).
      const sampleRows = buildPreviewRows(ws, headerCells, dataStartRow, 5);
      const proposal = await proposeColumnMapping(headerCells, sampleRows);

      if (proposal.status === "needs_clarification") {
        return res.json({ status: "needs_clarification", sheet: sheetName, message: proposal.message, usage: proposal.usage });
      }

      const proposedMapping: ColumnMapping = { headerRow, dataStartRow, columns: proposal.columns };
      return res.json({
        status: "needs_mapping_review",
        sheet: sheetName,
        headerRow: headerCells,
        proposedMapping,
        preview: buildPreviewRows(ws, headerCells, dataStartRow, 10),
        usage: proposal.usage,
      });
    }

    let allRows: VehicleRow[] = [];
    let allSkipped: SkippedRow[] = [];
    let allFlagged: FlaggedRow[] = [];
    for (const { sheetName, ws, mapping } of resolved) {
      const { rows, skipped, flagged } = extractRowsWithMapping(ws, mapping, sheetName);
      allRows = allRows.concat(rows);
      allSkipped = allSkipped.concat(skipped);
      allFlagged = allFlagged.concat(flagged);
    }

    const { uploadId, inserted } = await insertVehicles(req.file.originalname, allRows, allSkipped.length);
    res.json({ uploadId, inserted, skipped: allSkipped, flagged: allFlagged });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to parse or insert the file", detail: err.message });
  }
});

router.post("/confirm-mapping", requireApiKey, upload.single("file"), async (req: Request, res: Response) => {
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

  const sheetLabel = typeof req.body.sheet_label === "string" && req.body.sheet_label.trim() ? req.body.sheet_label.trim() : sheetName;

  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
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

    const { rows, skipped, flagged } = extractRowsWithMapping(ws, mapping, sheetName);
    const { uploadId, inserted } = await insertVehicles(req.file.originalname, rows, skipped.length);

    res.json({ uploadId, inserted, skipped, flagged, templateSaved: true });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to confirm mapping or insert the file", detail: err.message });
  }
});

export default router;
