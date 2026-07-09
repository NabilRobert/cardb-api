/**
 * ai.ts
 *
 * Turns a natural-language question into a single read-only SQL query via
 * SumoPod (OpenAI-compatible endpoint, gpt-5-mini), runs it against Postgres,
 * and formats a templated answer.
 *
 * Token-saving design choices (this is the main lever for keeping cost low):
 *   - Exactly ONE AI call per question (the text-to-SQL step). The answer
 *     itself is formatted in plain code afterward, not a second AI call.
 *   - The system prompt is a short schema description, not the actual data --
 *     the model never sees your rows, only column names/types.
 *   - temperature 0 and a low max_tokens cap, since SQL output is short and
 *     doesn't benefit from "creativity" (also makes output more reliable).
 *   - Actual token usage from SumoPod's response is passed straight back to
 *     the frontend so you can see exactly what each question costs.
 */

import { pool } from "./db";
import { KNOWN_AREAS } from "./parser";

const SUMOPOD_URL = "https://ai.sumopod.com/v1/chat/completions";
const MODEL = "gpt-5-mini";

const SYSTEM_PROMPT = `You are a SQL generator for a used-car dealership's inventory database (PostgreSQL).

Table: vehicles
Columns: id, license_plate, vin, engine_no, brand, model_trim, year, transmission, color, odometer_km, stnk_expiry_date, stock_entry_date, status (available/booked/sold), reserved_by, location (branch code, e.g. DSSM or SMR), ownership, price_cash, price_credit, max_credit_discount, notes_raw, source, created_at, updated_at

Rules:
- Respond with ONLY a single read-only SELECT statement. No explanation, no markdown, no semicolon.
- Only query the vehicles table.
- Do not filter by status (available/booked/sold) unless the question explicitly names a status -- by default, include vehicles of every status so counts and lists reflect the full inventory, not just what's currently available.
- If the question does not mention a specific location, do not filter by location -- include location in the result (e.g. GROUP BY location) so all locations are represented.
- When the answer involves specific vehicles rather than a pure count/aggregate, always include brand, model_trim, location, status, and notes_raw in the SELECT list, plus license_plate, year, and price_cash/price_credit if they're not already excluded by the question -- the goal is a genuinely informative result, not just the minimum columns that technically answer the question.
- For pure aggregate questions ("how many..."), it's fine to return just the grouped count, but still include the grouping columns (e.g. brand, location, status) rather than a single bare number when more than one group is possible.
- If the question is genuinely ambiguous (refers to "it"/"that" with no clear subject, or is missing information needed to answer at all), respond with exactly: CLARIFY: <a short clarifying question>`;

interface SumoPodResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface AskAnswer {
  status: "answered";
  question: string;
  sql: string;
  summary: string;
  rows: Record<string, unknown>[];
  usage?: TokenUsage;
}

export interface AskClarification {
  status: "needs_clarification";
  message: string;
  usage?: TokenUsage;
}

async function callSumoPod(question: string): Promise<{ text: string; usage?: TokenUsage }> {
  if (!process.env.SUMOPOD_API_KEY) {
    throw new Error("SUMOPOD_API_KEY is not set");
  }

  const res = await fetch(SUMOPOD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SUMOPOD_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // gpt-5-mini spends part of its token budget on hidden reasoning before
      // writing the visible answer. Reasoning models require
      // max_completion_tokens (max_tokens is the legacy, non-reasoning param
      // and can leave `content` empty here). reasoning_effort is kept low
      // since text-to-SQL for one table doesn't need deep reasoning, and the
      // budget is generous enough to survive reasoning + a full SELECT.
      max_completion_tokens: 1000,
      reasoning_effort: "minimal",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SumoPod request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as SumoPodResponse;
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  return { text, usage: data.usage };
}

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/i;

/** Throws if the model produced anything other than a safe, single, read-only SELECT against `vehicles`. */
export function sanitizeSql(raw: string): string {
  let cleaned = raw.trim();
  // Strip markdown code fences anywhere in the response, not just at the very edges.
  cleaned = cleaned.replace(/```(?:sql)?/gi, "").trim();

  // Reject outright if a destructive keyword shows up anywhere in the response,
  // even if the extraction below would end up discarding it -- if the model
  // produced it at all, that's worth refusing rather than silently proceeding.
  if (FORBIDDEN.test(cleaned)) {
    throw new Error("Refusing statement with a disallowed keyword");
  }

  // The model may add explanatory prose before/after the query despite being
  // told not to (a common instruction-following slip, especially on smaller
  // models) -- pull out just the SELECT statement itself instead of requiring
  // it to be the very first thing in the response.
  const match = cleaned.match(/SELECT\s[\s\S]*/i);
  if (!match) {
    throw new Error("Refusing non-SELECT statement");
  }
  let sql = match[0].trim();

  // Cut off at the first semicolon -- drop any trailing prose or a second statement.
  const semiIndex = sql.indexOf(";");
  if (semiIndex !== -1) {
    sql = sql.slice(0, semiIndex).trim();
  }

  if (!/\bFROM\s+vehicles\b/i.test(sql)) {
    throw new Error("Refusing query that doesn't select from vehicles");
  }
  if (!/\bLIMIT\s+\d+/i.test(sql)) {
    sql += " LIMIT 50";
  }
  return sql;
}

// Fields folded into the hand-built description below (name, plate, location,
// status, price, area) -- anything else the query returned gets appended as
// extras so nothing the AI chose to select is silently dropped.
const DESCRIBED_FIELDS = new Set([
  "brand", "model_trim", "license_plate", "location", "status", "reserved_by",
  "price_cash", "price_credit", "notes_raw",
]);

/**
 * "location" is just the branch code (DSSM/SMR), not an actual place -- the
 * only area/city hint we have is buried inside the free-text "notes_raw"
 * field (e.g. "BM,BS,KS/O/1/JAKSEL"). Pull that out so "available at DSSM"
 * can become "available at DSSM (JAKSEL)" when the data has it.
 */
function extractArea(notesRaw: unknown): string | null {
  if (typeof notesRaw !== "string") return null;
  const upper = notesRaw.toUpperCase();
  for (const area of KNOWN_AREAS) {
    if (upper.includes(area)) return area;
  }
  return null;
}

function describeVehicleRow(row: Record<string, unknown>): string {
  const parts: string[] = [];

  const name = [row.brand, row.model_trim].filter(Boolean).join(" ");
  if (name) parts.push(name);
  if (row.license_plate) parts.push(String(row.license_plate));
  if (row.location) {
    const area = extractArea(row.notes_raw);
    parts.push(area ? `at ${row.location} (${area})` : `at ${row.location}`);
  }
  if (row.status) {
    const statusText = row.reserved_by ? `${row.status} - ${row.reserved_by}` : String(row.status);
    parts.push(`(${statusText})`);
  }
  const price = row.price_cash ?? row.price_credit;
  if (price !== undefined && price !== null) {
    parts.push(`Rp${Number(price).toLocaleString("id-ID")}`);
  }

  const extras = Object.entries(row)
    .filter(([key, value]) => !DESCRIBED_FIELDS.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  parts.push(...extras);

  return "- " + parts.join(", ");
}

export function formatAnswer(rows: Record<string, unknown>[]): { summary: string; rows: Record<string, unknown>[] } {
  if (rows.length === 0) {
    return { summary: "No matching vehicles found.", rows: [] };
  }
  if (rows.length === 1 && Object.keys(rows[0]).length === 1) {
    const [key, value] = Object.entries(rows[0])[0];
    return { summary: `${key}: ${value}`, rows };
  }

  // If the result includes vehicle identity columns, describe each row in
  // plain language (model, location, status, price) instead of a bare count --
  // still zero extra AI calls, this is templated purely from the SQL result.
  const hasVehicleDetails = "brand" in rows[0] || "model_trim" in rows[0];
  if (hasVehicleDetails) {
    const shown = rows.slice(0, 20);
    const lines = shown.map(describeVehicleRow);
    let summary = `${rows.length} vehicle(s) found:\n${lines.join("\n")}`;
    if (rows.length > 20) {
      summary += `\n...and ${rows.length - 20} more (see table below).`;
    }
    return { summary, rows };
  }

  return { summary: `${rows.length} result(s):`, rows };
}

export async function askQuestion(question: string): Promise<AskAnswer | AskClarification> {
  const { text, usage } = await callSumoPod(question);
  console.log("[ask] raw model response:", text);

  if (text.toUpperCase().startsWith("CLARIFY:")) {
    return {
      status: "needs_clarification",
      message: text.slice(text.indexOf(":") + 1).trim(),
      usage,
    };
  }

  let sql: string;
  try {
    sql = sanitizeSql(text);
  } catch (err: any) {
    // Surface exactly what the model said, not just a generic rejection reason --
    // this is the difference between "something's wrong" and being able to see why.
    const snippet = text.length > 300 ? text.slice(0, 300) + "..." : text;
    throw new Error(`${err.message}. Model responded with: "${snippet}"`);
  }

  console.log("[ask] executing SQL:", sql);

  let result;
  try {
    result = await pool.query(sql);
  } catch (err: any) {
    throw new Error(`Database rejected the generated query: ${err.message}. SQL was: ${sql}`);
  }

  const { summary, rows } = formatAnswer(result.rows);

  return {
    status: "answered",
    question,
    sql,
    summary,
    rows,
    usage,
  };
}
