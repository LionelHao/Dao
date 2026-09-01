import {
  ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES,
  isRoomExportTransportServerFrame,
  type RoomExportTransportClientFrame,
  type RoomExportTransportServerFrame,
} from "@native-im/core";

export const ROOM_EXPORT_LIMITS = Object.freeze({
  maxChunkBytes: ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES,
  maxLineBytes: 1_048_576,
  maxRecords: 1_000_000,
  maxBytes: 2_147_483_648,
} as const);

export const ROOM_EXPORT_CATEGORIES = Object.freeze([
  "attachment_inventory", "execution_tool_review", "membership_governance_audit",
  "memory", "message", "message_revision", "project_fact", "recall_audit", "source_link",
] as const);

export type RoomExportOpenCommand = Extract<RoomExportTransportClientFrame,
  { type: "room-export.open" }>;
export type RoomExportReadCommand = Extract<RoomExportTransportClientFrame,
  { type: "room-export.read" }>;
export type RoomExportAbortCommand = Extract<RoomExportTransportClientFrame,
  { type: "room-export.abort" }>;
export type RoomExportOpened = Extract<RoomExportTransportServerFrame,
  { type: "room-export.opened" }>;
export type RoomExportChunk = Extract<RoomExportTransportServerFrame,
  { type: "room-export.chunk" }>;
export type RoomExportAborted = Extract<RoomExportTransportServerFrame,
  { type: "room-export.aborted" }>;

export function isRoomExportOpened(value: unknown): value is RoomExportOpened {
  return isRoomExportTransportServerFrame(value) && value.type === "room-export.opened";
}

export function isRoomExportChunk(value: unknown): value is RoomExportChunk {
  return isRoomExportTransportServerFrame(value) && value.type === "room-export.chunk";
}

export function isRoomExportAborted(value: unknown): value is RoomExportAborted {
  return isRoomExportTransportServerFrame(value) && value.type === "room-export.aborted";
}
