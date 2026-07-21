/**
 * routes/notifications.ts
 *
 * GET /api/notifications - list, most recent first (created_at DESC).
 * Optional query params: is_read=true|false, is_resolved=true|false (either
 * or both omitted = no filter on that field), limit (default 100, max 500),
 * offset (default 0). Response is a plain array of notification rows.
 *
 * GET /api/notifications/unread-count - { unread_count: number }, counting
 * notifications that are both unread AND unresolved (a badge shouldn't count
 * something that auto-resolved before anyone saw it -- see db.ts's
 * countUnreadNotifications).
 *
 * POST /api/notifications/:id/read - marks one as read (sets is_read=true,
 * read_at=now()). Returns the updated row. 400 if :id isn't an integer,
 * 404 if no notification has that id.
 */

import { Router, Request, Response } from "express";
import { listNotifications, countUnreadNotifications, markNotificationRead } from "../db";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function parseBool(raw: unknown): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

router.get("/unread-count", requireAuth, async (_req: Request, res: Response) => {
  try {
    const unread_count = await countUnreadNotifications();
    res.json({ unread_count });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to count unread notifications", detail: err.message });
  }
});

router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const is_read = parseBool(req.query.is_read);
    const is_resolved = parseBool(req.query.is_resolved);
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;
    const notifications = await listNotifications({ is_read, is_resolved, limit, offset });
    res.json(notifications);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch notifications", detail: err.message });
  }
});

router.post("/:id/read", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: "Invalid id: must be a positive integer" });
  }
  try {
    const notification = await markNotificationRead(id);
    if (!notification) {
      return res.status(404).json({ error: `No notification found with id ${id}` });
    }
    res.json(notification);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to mark notification as read", detail: err.message });
  }
});

export default router;
