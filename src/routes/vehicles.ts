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
 *
 * PATCH /api/vehicles/:id/status - change status with optimistic concurrency. Body:
 *   { status: "available"|"booked"|"sold", reserved_by?, buyer_name?, updated_at }
 *   reserved_by is required (non-empty) when status is "booked"; buyer_name is required
 *   (non-empty) when status is "sold" -- including a direct available -> sold transition
 *   with no prior booking step. updated_at must be the value the client last saw for this
 *   row (full ISO-8601 timestamp, as returned by every vehicle response).
 *   400 if :id isn't an integer, status isn't one of the three values, updated_at is
 *   missing, or the required name field for the target status is missing/empty.
 *   404 if no vehicle has that id.
 *   409 if the row's actual current updated_at doesn't match what was sent (someone else
 *   changed it first) -- body is { error, current: <the row's real current state> }.
 *   200 with the full updated row (including its new updated_at) on success.
 */

import { Router, Request, Response } from "express";
import {
  getAllVehicles,
  searchVehicles,
  getVehicleById,
  updateVehicle,
  isEditableVehicleField,
  deleteVehicle,
  isValidVehicleStatus,
  updateVehicleStatus,
} from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

router.get("/", requireAuth, async (_req: Request, res: Response) => {
  try {
    const vehicles = await getAllVehicles();
    res.json(vehicles);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vehicles", detail: err.message });
  }
});

router.get("/search", requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await searchVehicles(req.query);
    res.json(result);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to search vehicles", detail: err.message });
  }
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
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

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
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

router.patch("/:id/status", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Request body must be a JSON object" });
  }

  const { status, reserved_by, buyer_name, updated_at } = req.body as Record<string, unknown>;

  if (!isValidVehicleStatus(status)) {
    return res.status(400).json({ error: "status must be one of: available, booked, sold" });
  }
  if (typeof updated_at !== "string" || updated_at.trim() === "") {
    return res.status(400).json({ error: "updated_at is required: the value last seen for this row" });
  }
  if (status === "booked" && (typeof reserved_by !== "string" || reserved_by.trim() === "")) {
    return res.status(400).json({ error: "reserved_by is required and must be non-empty when status is 'booked'" });
  }
  if (status === "sold" && (typeof buyer_name !== "string" || buyer_name.trim() === "")) {
    return res.status(400).json({ error: "buyer_name is required and must be non-empty when status is 'sold'" });
  }

  const nameValue =
    status === "booked" ? (reserved_by as string).trim() : status === "sold" ? (buyer_name as string).trim() : undefined;

  try {
    const result = await updateVehicleStatus(id, status, nameValue, updated_at);
    if (result.outcome === "not_found") {
      return res.status(404).json({ error: `No vehicle found with id ${id}` });
    }
    if (result.outcome === "conflict") {
      return res.status(409).json({
        error: "Conflict: this vehicle was modified since you last loaded it",
        current: result.current,
      });
    }
    res.json(result.vehicle);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to update vehicle status", detail: err.message });
  }
});

router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
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
