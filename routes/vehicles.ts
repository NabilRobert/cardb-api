/**
 * routes/vehicles.ts
 *
 * GET /api/vehicles - returns every row currently in `vehicles`.
 *
 * GET /api/vehicles/search - filtered, sorted, paginated search. Supported
 * query params:
 *   Text (case-insensitive partial match, ILIKE '%value%'):
 *     brand, model_trim, color, location, ownership, source, sheet_name, reserved_by
 *   Exact match:
 *     status, transmission
 *   Year:
 *     year (exact), year_min, year_max (range)
 *   Numeric ranges:
 *     odometer_min / odometer_max        -> odometer_km
 *     price_min / price_max              -> price_cash
 *     price_credit_min / price_credit_max -> price_credit
 *     price_net_min / price_net_max      -> price_net
 *   Date ranges (before = <=, after = >=):
 *     stnk_expiry_before / stnk_expiry_after       -> stnk_expiry_date
 *     purchase_date_before / purchase_date_after   -> purchase_date
 *     handover_date_before / handover_date_after   -> handover_date
 *   Free text (OR across brand, model_trim, notes_raw):
 *     q
 *   Sorting:
 *     sort_by (whitelisted columns; default created_at), order=asc|desc (default desc for
 *     the default sort_by, asc otherwise)
 *   Pagination:
 *     limit (default 100, max 500), offset (default 0)
 *
 * All filters combine with AND (q is applied on top of them). Unrecognized query params
 * are silently ignored rather than erroring. With no query params at all, this behaves like
 * /api/vehicles but subject to the default sort/pagination above (created_at desc, limit 100).
 * Response shape: { rows: Vehicle[], total: number }, where `total` is the count of all rows
 * matching the filters before limit/offset was applied (for building "showing X-Y of total" UI).
 *
 * GET /api/vehicles/:id - a single vehicle by id. 400 if :id isn't an integer, 404 if no
 * vehicle has that id.
 *
 * PATCH /api/vehicles/:id - partial update of one vehicle. Body is a JSON object; only the
 * following fields are editable this way: status, reserved_by, price_cash, price_credit,
 * price_net, max_credit_discount, notes_raw, location. Any other field in the body (id, vin,
 * license_plate, upload_id, created_at, etc.) is silently ignored -- same convention as
 * unrecognized query params on /search. If nothing editable remains after filtering (empty
 * or all-unknown body), returns 400. On success, updated_at is set to now() and the full
 * updated vehicle is returned. 400 if :id isn't an integer, 404 if no vehicle has that id.
 *
 * DELETE /api/vehicles/:id - deletes one vehicle by id. Returns { deleted: true, id } on
 * success. 400 if :id isn't an integer, 404 if no vehicle has that id.
 */

import { Router, Request, Response } from "express";
import {
  getAllVehicles,
  searchVehicles,
  getVehicleById,
  updateVehicle,
  isEditableVehicleField,
  deleteVehicle,
} from "../db";
import { requireApiKey } from "../middleware/apiKey";

const router = Router();

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

router.get("/", requireApiKey, async (_req: Request, res: Response) => {
  try {
    const vehicles = await getAllVehicles();
    res.json(vehicles);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vehicles", detail: err.message });
  }
});

router.get("/search", requireApiKey, async (req: Request, res: Response) => {
  try {
    const result = await searchVehicles(req.query);
    res.json(result);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to search vehicles", detail: err.message });
  }
});

router.get("/:id", requireApiKey, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const vehicle = await getVehicleById(id);
    if (!vehicle) {
      return res.status(404).json({ error: `No vehicle found with id ${id}` });
    }
    res.json(vehicle);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vehicle", detail: err.message });
  }
});

router.patch("/:id", requireApiKey, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  const editableFields = Object.fromEntries(
    Object.entries(req.body).filter(([key]) => isEditableVehicleField(key))
  );
  if (Object.keys(editableFields).length === 0) {
    return res.status(400).json({
      error: "No editable fields in body. Editable fields: status, reserved_by, price_cash, price_credit, price_net, max_credit_discount, notes_raw, location",
    });
  }

  try {
    const vehicle = await updateVehicle(id, editableFields);
    if (!vehicle) {
      return res.status(404).json({ error: `No vehicle found with id ${id}` });
    }
    res.json(vehicle);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to update vehicle", detail: err.message });
  }
});

router.delete("/:id", requireApiKey, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const deleted = await deleteVehicle(id);
    if (!deleted) {
      return res.status(404).json({ error: `No vehicle found with id ${id}` });
    }
    res.json({ deleted: true, id });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete vehicle", detail: err.message });
  }
});

export default router;
