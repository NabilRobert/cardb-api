/**
 * routes/ask.ts
 *
 * POST /api/ask - answers a natural-language question about stock (see ai.ts).
 * Expects multipart/form-data with a "question" field.
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { askQuestion } from "../ai";
import { requireAuth } from "../middleware/requireAuth";

const upload = multer();
const router = Router();

router.post("/", requireAuth, upload.none(), async (req: Request, res: Response) => {
  const question = typeof req.body.question === "string" ? req.body.question.trim() : "";
  if (!question) {
    return res.status(400).json({ error: "Missing 'question' form field" });
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
