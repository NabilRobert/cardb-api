/**
 * routes/ask.ts
 *
 * GET /api/ask - answers a natural-language question about stock (see ai.ts).
 */

import { Router, Request, Response } from "express";
import { askQuestion } from "../ai";
import { requireApiKey } from "../middleware/apiKey";

const router = Router();

router.get("/", requireApiKey, async (req: Request, res: Response) => {
  const question = typeof req.query.question === "string" ? req.query.question.trim() : "";
  if (!question) {
    return res.status(400).json({ error: "Missing 'question' query parameter" });
  }
  try {
    const result = await askQuestion(question);
    res.json(result);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Failed to answer the question", detail: err.message });
  }
});

export default router;
