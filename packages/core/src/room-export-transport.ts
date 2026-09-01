export const ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES = 64 * 1_024;
export const ROOM_EXPORT_TRANSPORT_MAX_STREAMS_PER_CONNECTION = 1;

export type RoomExportTransportClientFrame =
  | Readonly<{ type: "room-export.open"; requestId: string; roomId: string }>
  | Readonly<{ type: "room-export.read"; requestId: string; streamId: string; offset: number }>
  | Readonly<{ type: "room-export.abort"; requestId: string; streamId: string }>;

export type RoomExportTransportServerFrame =
  | Readonly<{
      type: "room-export.opened";
      requestId: string;
      streamId: string;
      roomId: string;
      chunkSize: typeof ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES;
    }>
  | Readonly<{
      type: "room-export.chunk";
      requestId: string;
      streamId: string;
      offset: number;
      byteLength: number;
      base64: string;
      eof: boolean;
    }>
  | Readonly<{
      type: "room-export.aborted";
      requestId: string;
      streamId: string;
    }>;

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: UnknownRecord, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key));
};
const id = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
const requestId = (value: unknown): value is string => id(value) && value.length <= 128;
const offset = (value: unknown): value is number => typeof value === "number" &&
  Number.isSafeInteger(value) && value >= 0;

export function isRoomExportTransportFrameType(
  value: unknown,
): value is RoomExportTransportClientFrame["type"] {
  return value === "room-export.open" || value === "room-export.read" ||
    value === "room-export.abort";
}

export function parseRoomExportTransportClientFrame(value: unknown):
  Readonly<{ ok: true; frame: RoomExportTransportClientFrame }> |
  Readonly<{ ok: false; requestId?: string }> {
  const correlatedRequestId = record(value) && requestId(value.requestId) ? value.requestId : undefined;
  if (!record(value) || !isRoomExportTransportFrameType(value.type)) {
    return Object.freeze({ ok: false,
      ...(correlatedRequestId === undefined ? {} : { requestId: correlatedRequestId }) });
  }
  const valid = value.type === "room-export.open"
    ? exact(value, ["type", "requestId", "roomId"]) && requestId(value.requestId) && id(value.roomId)
    : value.type === "room-export.read"
      ? exact(value, ["type", "requestId", "streamId", "offset"]) && requestId(value.requestId) &&
        id(value.streamId) && offset(value.offset)
      : exact(value, ["type", "requestId", "streamId"]) && requestId(value.requestId) &&
        id(value.streamId);
  return valid
    ? Object.freeze({ ok: true, frame: value as RoomExportTransportClientFrame })
    : Object.freeze({ ok: false,
      ...(correlatedRequestId === undefined ? {} : { requestId: correlatedRequestId }) });
}

function canonicalBase64(value: unknown, expectedBytes: number): boolean {
  if (typeof value !== "string" || value.length >
      Math.ceil(ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES / 3) * 4) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === expectedBytes && bytes.toString("base64") === value;
}

export function isRoomExportTransportServerFrame(
  value: unknown,
): value is RoomExportTransportServerFrame {
  if (!record(value)) return false;
  if (value.type === "room-export.opened") {
    return exact(value, ["type", "requestId", "streamId", "roomId", "chunkSize"]) &&
      requestId(value.requestId) && id(value.streamId) && id(value.roomId) &&
      value.chunkSize === ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES;
  }
  if (value.type === "room-export.aborted") {
    return exact(value, ["type", "requestId", "streamId"]) && requestId(value.requestId) &&
      id(value.streamId);
  }
  return value.type === "room-export.chunk" &&
    exact(value, ["type", "requestId", "streamId", "offset", "byteLength", "base64", "eof"]) &&
    requestId(value.requestId) && id(value.streamId) && offset(value.offset) &&
    offset(value.byteLength) && value.byteLength <= ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES &&
    canonicalBase64(value.base64, value.byteLength) && typeof value.eof === "boolean";
}
