/**
 * useApi.ts
 *
 * All HTTP communication with the backend lives here. Components never call
 * fetch() directly -- they call these functions, which keeps the network/auth
 * concerns separate from rendering.
 */

import type { Vehicle, UploadResult, ApiErrorBody } from "../types";

let cachedApiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const res = await fetch("/api/config");
  const data = await res.json();
  cachedApiKey = data.apiKey;
  return cachedApiKey as string;
}

async function authHeaders(): Promise<HeadersInit> {
  const key = await getApiKey();
  return { "X-API-Key": key };
}

export async function uploadExcelFile(file: File): Promise<UploadResult> {
  const headers = await authHeaders();
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch("/api/upload", { method: "POST", headers, body: formData });
  const data = await res.json();

  if (!res.ok) {
    const err = data as ApiErrorBody;
    throw new Error(err.detail ? `${err.error}: ${err.detail}` : err.error);
  }
  return data as UploadResult;
}

export async function fetchVehicles(): Promise<Vehicle[]> {
  const headers = await authHeaders();
  const res = await fetch("/api/vehicles", { headers });
  const data = await res.json();

  if (!res.ok) {
    const err = data as ApiErrorBody;
    throw new Error(err.error);
  }
  return data as Vehicle[];
}
