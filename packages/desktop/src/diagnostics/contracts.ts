export const DIAGNOSTICS_IPC_CHANNELS = Object.freeze({
  save: "diagnostics:save",
} as const);

export type DiagnosticsSaveResult = Readonly<{ status: "saved" | "cancelled" }>;

export type DiagnosticsClosedError = Readonly<{
  status: 401 | 403 | 409 | 410 | 429 | 503;
  code: "authentication_required" | "administrator_required" |
    "diagnostics_stream_conflict" | "diagnostics_artifact_gone" |
    "diagnostics_capacity_limited" | "diagnostics_invalid_artifact" |
    "diagnostics_unavailable";
  retryAfterMs?: number;
}>;

export interface DiagnosticsBridge {
  /** No renderer argument is accepted: especially no path, token, bytes, URL, or channel. */
  save(): Promise<DiagnosticsSaveResult>;
}

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

export function isDiagnosticsSaveResult(value: unknown): value is DiagnosticsSaveResult {
  return record(value) && exact(value, ["status"]) &&
    (value.status === "saved" || value.status === "cancelled");
}

export function isDiagnosticsClosedError(value: unknown): value is DiagnosticsClosedError {
  return record(value) && exact(value, ["status", "code"], ["retryAfterMs"]) &&
    [401, 403, 409, 410, 429, 503].includes(Number(value.status)) && [
      "authentication_required", "administrator_required", "diagnostics_stream_conflict",
      "diagnostics_artifact_gone", "diagnostics_capacity_limited",
      "diagnostics_invalid_artifact", "diagnostics_unavailable",
    ].includes(String(value.code)) && (value.retryAfterMs === undefined ||
      Number.isSafeInteger(value.retryAfterMs) && Number(value.retryAfterMs) >= 0);
}

export function cloneDiagnosticsSaveResult(value: unknown): DiagnosticsSaveResult {
  if (!isDiagnosticsSaveResult(value)) throw new TypeError("Invalid diagnostics save result");
  return Object.freeze({ ...value });
}
