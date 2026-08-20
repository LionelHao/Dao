import {
  isRoomMemoryProtocolFrame,
  isRoomMemoryRequest,
  type RoomMemoryProtocolFrame,
  type RoomMemoryRequest,
  type RoomMemorySuccessFrame,
} from "@native-im/core";
import type {
  MemoryAuthorityClientApplication,
  MemoryAuthorityEpochRequest,
  MemoryAuthorityRawBridge,
} from "../renderer/memory-authority/client.js";

export const MEMORY_AUTHORITY_IPC_CHANNELS = Object.freeze({
  context: "memory-authority:context",
  request: "memory-authority:request",
  authorityInput: "memory-authority:authority-input",
} as const);

export type MemoryAuthorityContextQuery = Readonly<{ roomId: string }>;

export type MemoryAuthorityWireResponse = Readonly<{
  accessEpoch: number;
  frame: Exclude<RoomMemoryProtocolFrame, RoomMemoryRequest>;
}>;

export type MemoryAuthorityContext = Readonly<{
  roomId: string;
  accessEpoch: number;
  lifecycle: "active" | "archived";
  viewer: Readonly<{ actorId: string; currentHuman: boolean }>;
}>;

export interface MemoryAuthorityBridge extends MemoryAuthorityRawBridge {
  context(query: MemoryAuthorityContextQuery): Promise<MemoryAuthorityContext>;
  request(input: MemoryAuthorityEpochRequest): Promise<unknown>;
  onAuthorityInput(listener: (input: MemoryAuthorityClientApplication) => void): () => void;
}

type UnknownRecord = Record<string, unknown>;
function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isMemoryAuthorityContextQuery(value: unknown): value is MemoryAuthorityContextQuery {
  return record(value) && exact(value, ["roomId"]) && identifier(value.roomId);
}

export function isMemoryAuthorityContext(value: unknown): value is MemoryAuthorityContext {
  return record(value) && exact(value, ["roomId", "accessEpoch", "lifecycle", "viewer"]) &&
    identifier(value.roomId) && positive(value.accessEpoch) &&
    (value.lifecycle === "active" || value.lifecycle === "archived") && record(value.viewer) &&
    exact(value.viewer, ["actorId", "currentHuman"]) && identifier(value.viewer.actorId) &&
    typeof value.viewer.currentHuman === "boolean";
}

export function isMemoryAuthorityEpochRequest(value: unknown): value is MemoryAuthorityEpochRequest {
  return record(value) && exact(value, ["accessEpoch", "frame"]) && positive(value.accessEpoch) &&
    isRoomMemoryRequest(value.frame);
}

export function isMemoryAuthorityEpochResponse(value: unknown): value is MemoryAuthorityWireResponse {
  return record(value) && exact(value, ["accessEpoch", "frame"]) && positive(value.accessEpoch) &&
    isRoomMemoryProtocolFrame(value.frame) && !isRoomMemoryRequest(value.frame);
}

export function cloneMemoryAuthorityContext(value: unknown): MemoryAuthorityContext {
  if (!isMemoryAuthorityContext(value)) throw new TypeError("Invalid Memory Authority context");
  return structuredClone(value);
}

export function cloneMemoryAuthorityEpochRequest(value: unknown): MemoryAuthorityEpochRequest {
  if (!isMemoryAuthorityEpochRequest(value)) throw new TypeError("Invalid Memory Authority request");
  return structuredClone(value);
}

export function cloneMemoryAuthorityEpochResponse(value: unknown): MemoryAuthorityWireResponse {
  if (!isMemoryAuthorityEpochResponse(value)) throw new TypeError("Invalid Memory Authority response");
  return structuredClone(value);
}

export function successFrame(value: unknown): RoomMemorySuccessFrame {
  if (!isRoomMemoryProtocolFrame(value) || isRoomMemoryRequest(value) || value.type === "error") {
    throw new TypeError("Invalid Memory Authority success frame");
  }
  return structuredClone(value);
}

export function requestFrame(value: unknown): RoomMemoryRequest {
  if (!isRoomMemoryRequest(value)) throw new TypeError("Invalid Memory Authority request frame");
  return structuredClone(value);
}
