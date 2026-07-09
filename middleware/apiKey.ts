/**
 * middleware/apiKey.ts
 *
 * Guards every /api/* route except /api/config, which requires the API key
 * in an X-API-Key header.
 */

import { Request, Response, NextFunction } from "express";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-API-Key");
  if (!process.env.API_KEY) {
    return res.status(500).json({ error: "Server misconfigured: API_KEY not set" });
  }
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Missing or invalid X-API-Key header" });
  }
  next();
}
