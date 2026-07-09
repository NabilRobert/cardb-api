export interface Vehicle {
  id: number;
  license_plate: string | null;
  vin: string | null;
  engine_no: string | null;
  brand: string | null;
  model_trim: string | null;
  year: number | null;
  transmission: string | null;
  color: string | null;
  odometer_km: number | null;
  stnk_expiry_date: string | null;
  stock_entry_date: string | null;
  status: string | null;
  reserved_by: string | null;
  location: string | null;
  ownership: string | null;
  price_cash: number | null;
  price_credit: number | null;
  max_credit_discount: string | null;
  notes_raw: string | null;
  source: string | null;
  upload_id: number | null;
  sheet_name: string | null;
  row_index: number | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface SkippedRow {
  sheet: string;
  row: number;
  reason: string;
}

export interface UploadResult {
  uploadId: number;
  inserted: number;
  skipped: SkippedRow[];
}

export interface ApiErrorBody {
  error: string;
  detail?: string;
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

export type AskResult = AskAnswer | AskClarification;
