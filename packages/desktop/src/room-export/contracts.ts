export const ROOM_EXPORT_IPC_CHANNELS = Object.freeze({
  save: "room-export:save",
} as const);

export type RoomExportIntent = Readonly<{ roomId: string }>;
export type RoomExportResult = Readonly<{
  status: "saved" | "cancelled";
  roomId: string;
}>;

export type RoomExportClosedError = Readonly<{
  status: 401 | 403 | 409 | 410 | 429 | 503;
  code: "authentication_required" | "room_export_forbidden" |
    "room_export_conflict" | "room_export_access_revoked" |
    "room_export_capacity_exceeded" | "room_export_invalid_stream" |
    "storage_unavailable";
  retryAfterMs?: number;
}>;

export interface RoomExportBridge {
  save(intent: RoomExportIntent): Promise<RoomExportResult>;
}

type UnknownRecord = Record<string, unknown>;
const encoder = new TextEncoder();

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: UnknownRecord, keys: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...keys, ...optional]);
  return keys.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

export function isRoomExportIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    encoder.encode(value).byteLength <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

export function isRoomExportIntent(value: unknown): value is RoomExportIntent {
  return record(value) && exact(value, ["roomId"]) && isRoomExportIdentifier(value.roomId);
}

export function isRoomExportResult(value: unknown): value is RoomExportResult {
  return record(value) && exact(value, ["status", "roomId"]) &&
    (value.status === "saved" || value.status === "cancelled") &&
    isRoomExportIdentifier(value.roomId);
}

export function isRoomExportClosedError(value: unknown): value is RoomExportClosedError {
  return record(value) && exact(value, ["status", "code"], ["retryAfterMs"]) &&
    [401, 403, 409, 410, 429, 503].includes(Number(value.status)) && [
      "authentication_required", "room_export_forbidden", "room_export_conflict",
      "room_export_access_revoked", "room_export_capacity_exceeded",
      "room_export_invalid_stream", "storage_unavailable",
    ].includes(String(value.code)) && (value.retryAfterMs === undefined ||
      Number.isSafeInteger(value.retryAfterMs) && Number(value.retryAfterMs) >= 0);
}

export function cloneRoomExportResult(value: unknown): RoomExportResult {
  if (!isRoomExportResult(value)) throw new TypeError("Invalid Room export result");
  return Object.freeze({ ...value });
}
