import {
  isRoomMemoryError,
  isRoomMemoryEvent,
  isRoomMemoryProjection,
  isRoomMemoryProtocolFrame,
  isRoomMemoryRepairRecord,
  type RoomMemoryError,
  type RoomMemoryEvent,
  type RoomMemoryProjection,
  type RoomMemoryRepairRecord,
  type RoomMemoryRequest,
  type RoomMemorySuccessFrame,
} from "@native-im/core";

export type MemoryAuthorityEpochRequest = Readonly<{
  accessEpoch: number;
  frame: RoomMemoryRequest;
}>;

export type MemoryAuthorityEpochResponse = Readonly<{
  accessEpoch: number;
  frame: RoomMemorySuccessFrame;
}>;

export interface MemoryAuthorityRawBridge {
  request(input: MemoryAuthorityEpochRequest): Promise<unknown>;
  onAuthorityInput(listener: (input: unknown) => void): () => void;
}

export type MemoryAuthorityClientApplication =
  | Readonly<{
      type: "room.memory.event";
      accessEpoch: number;
      event: RoomMemoryEvent;
      projection?: RoomMemoryProjection;
    }>
  | Readonly<{
      type: "room.memory.repair.completed";
      roomId: string;
      accessEpoch: number;
      generation: number;
      records: readonly RoomMemoryRepairRecord[];
    }>
  | Readonly<{
      type: "room.memory.repair.failed";
      roomId: string;
      accessEpoch: number;
      generation: number;
      errorCode: string;
    }>
  | Readonly<{
      type: "room.memory.context";
      roomId: string;
      accessEpoch: number;
      lifecycle: "active" | "archived";
      viewer: Readonly<{ actorId: string; currentHuman: boolean }>;
    }>
  | Readonly<{
      type: "room.memory.connection";
      roomId: string;
      accessEpoch: number;
      connection: Readonly<{ status: "online" | "offline" | "repairing" }>;
    }>
  | Readonly<{
      type: "room.memory.revoked";
      roomId: string;
      accessEpoch: number;
      scope: "room";
      purgeCompleted: true;
    }>;

export interface MemoryAuthorityClientPort {
  request(input: MemoryAuthorityEpochRequest): Promise<MemoryAuthorityEpochResponse>;
  subscribe(listener: (input: MemoryAuthorityClientApplication) => void): () => void;
  close(): void;
}

type UnknownRecord = Record<string, unknown>;

const expectedResponseType: Readonly<Record<RoomMemoryRequest["type"], RoomMemorySuccessFrame["type"]>> = {
  "room.memory.query.v1": "room.memory.page.v1",
  "room.memory.source.query.v1": "room.memory.source.v1",
  "room.memory.context.dispute.v1": "room.memory.context.dispute.accepted.v1",
  "room.memory.context.resolve.v1": "room.memory.context.resolve.accepted.v1",
  "room.memory.status.query.v1": "room.memory.status.v1",
  "room.memory.retry.v1": "room.memory.retry.accepted.v1",
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function isClosedArray(value: unknown, maximumLength: number): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      return false;
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function safeDependencyError(request: MemoryAuthorityEpochRequest): RoomMemoryError {
  return Object.freeze({
    type: "error",
    status: 503,
    code: "memory_dependency_unavailable",
    message: "Memory authority response was unavailable or invalid",
    requestId: request.frame.requestId,
    objectId: request.frame.roomId,
    retryable: true,
  });
}

export class MemoryAuthorityClientFailure extends Error {
  readonly accessEpoch: number;
  readonly error: RoomMemoryError;

  constructor(accessEpoch: number, error: RoomMemoryError) {
    super(error.code);
    this.name = "MemoryAuthorityClientFailure";
    this.accessEpoch = accessEpoch;
    this.error = structuredClone(error);
  }
}

function matchesRequest(frame: RoomMemorySuccessFrame, request: RoomMemoryRequest): boolean {
  if (frame.type !== expectedResponseType[request.type] || frame.requestId !== request.requestId ||
      frame.roomId !== request.roomId) return false;
  if (request.type === "room.memory.source.query.v1") {
    return frame.type === "room.memory.source.v1" &&
      frame.source.sourceKind === request.sourceKind &&
      frame.source.sourceId === request.sourceId &&
      frame.source.sourceRevision === request.sourceRevision;
  }
  if (request.type === "room.memory.context.dispute.v1") {
    return frame.type === "room.memory.context.dispute.accepted.v1" &&
      frame.dispute.memoryRecordId === request.memoryRecordId;
  }
  if (request.type === "room.memory.context.resolve.v1") {
    return frame.type === "room.memory.context.resolve.accepted.v1" &&
      frame.resolution.memoryRecordId === request.memoryRecordId;
  }
  return true;
}

function parseResponse(input: unknown, request: MemoryAuthorityEpochRequest): MemoryAuthorityEpochResponse {
  if (!isRecord(input) || !hasExactKeys(input, ["accessEpoch", "frame"]) ||
      input.accessEpoch !== request.accessEpoch || !isRoomMemoryProtocolFrame(input.frame)) {
    throw new MemoryAuthorityClientFailure(request.accessEpoch, safeDependencyError(request));
  }
  if (isRoomMemoryError(input.frame)) {
    if (input.frame.requestId !== request.frame.requestId) {
      throw new MemoryAuthorityClientFailure(request.accessEpoch, safeDependencyError(request));
    }
    throw new MemoryAuthorityClientFailure(request.accessEpoch, input.frame);
  }
  if (input.frame.type.endsWith(".v1") && matchesRequest(input.frame as RoomMemorySuccessFrame, request.frame)) {
    return Object.freeze({ accessEpoch: request.accessEpoch, frame: structuredClone(input.frame) as RoomMemorySuccessFrame });
  }
  throw new MemoryAuthorityClientFailure(request.accessEpoch, safeDependencyError(request));
}

function parseVersionEvent(value: UnknownRecord): MemoryAuthorityClientApplication | undefined {
  if (!hasExactKeys(value, ["type", "accessEpoch", "event"], ["projection"]) ||
      value.type !== "room.memory.event" || !isPositiveSafeInteger(value.accessEpoch) ||
      !isRoomMemoryEvent(value.event)) return undefined;
  const event = value.event;
  if (event.type === "room.memory.version.changed") {
    if (!Object.hasOwn(value, "projection") || !isRoomMemoryProjection(value.projection) ||
        value.projection.projectionKind !== "memory" ||
        value.projection.roomId !== event.roomId ||
        value.projection.memoryRecordId !== event.payload.memoryRecordId) return undefined;
    const sourceIds = value.projection.currentVersion.sourceRefs.map((sourceRef) => sourceRef.sourceId);
    if (value.projection.kind !== event.payload.kind ||
        !sourceIds.every((sourceId) => event.payload.sourceIds.includes(sourceId)) ||
        sourceIds.length !== event.payload.sourceIds.length) return undefined;
    if (value.projection.currentVersion.memoryVersionId !== event.payload.memoryVersionId ||
        value.projection.currentVersion.state !== event.payload.state) return undefined;
    return Object.freeze({
      type: "room.memory.event",
      accessEpoch: value.accessEpoch,
      event: structuredClone(event),
      projection: structuredClone(value.projection),
    });
  }
  if (Object.hasOwn(value, "projection") || event.payload.roomId !== event.roomId) return undefined;
  return Object.freeze({
    type: "room.memory.event",
    accessEpoch: value.accessEpoch,
    event: structuredClone(event),
  });
}

export function parseMemoryAuthorityClientApplication(
  input: unknown,
): MemoryAuthorityClientApplication | undefined {
  if (!isRecord(input) || typeof input.type !== "string") return undefined;
  if (input.type === "room.memory.event") return parseVersionEvent(input);
  if (input.type === "room.memory.context") {
    if (!hasExactKeys(input, ["type", "roomId", "accessEpoch", "lifecycle", "viewer"]) ||
        !isIdentifier(input.roomId) || !isPositiveSafeInteger(input.accessEpoch) ||
        (input.lifecycle !== "active" && input.lifecycle !== "archived") ||
        !isRecord(input.viewer) || !hasExactKeys(input.viewer, ["actorId", "currentHuman"]) ||
        !isIdentifier(input.viewer.actorId) || typeof input.viewer.currentHuman !== "boolean") {
      return undefined;
    }
    return Object.freeze({ type: input.type, roomId: input.roomId,
      accessEpoch: input.accessEpoch, lifecycle: input.lifecycle,
      viewer: Object.freeze({ actorId: input.viewer.actorId,
        currentHuman: input.viewer.currentHuman }) });
  }
  if (input.type === "room.memory.repair.completed") {
    const roomId = input.roomId;
    if (!hasExactKeys(input, ["type", "roomId", "accessEpoch", "generation", "records"]) ||
        !isIdentifier(roomId) || !isPositiveSafeInteger(input.accessEpoch) ||
        !isNonnegativeSafeInteger(input.generation) || !isClosedArray(input.records, 5_000) ||
        !input.records.every((record) => isRoomMemoryRepairRecord(record, roomId))) return undefined;
    return Object.freeze({
      type: input.type,
      roomId,
      accessEpoch: input.accessEpoch,
      generation: input.generation,
      records: Object.freeze(structuredClone(input.records) as RoomMemoryRepairRecord[]),
    });
  }
  if (input.type === "room.memory.repair.failed") {
    if (!hasExactKeys(input, ["type", "roomId", "accessEpoch", "generation", "errorCode"]) ||
        !isIdentifier(input.roomId) || !isPositiveSafeInteger(input.accessEpoch) ||
        !isNonnegativeSafeInteger(input.generation) || !isIdentifier(input.errorCode)) return undefined;
    return Object.freeze({ type: input.type, roomId: input.roomId, accessEpoch: input.accessEpoch,
      generation: input.generation, errorCode: input.errorCode });
  }
  if (input.type === "room.memory.connection") {
    if (!hasExactKeys(input, ["type", "roomId", "accessEpoch", "connection"]) ||
        !isIdentifier(input.roomId) || !isPositiveSafeInteger(input.accessEpoch) ||
        !isRecord(input.connection) || !hasExactKeys(input.connection, ["status"]) ||
        (input.connection.status !== "online" && input.connection.status !== "offline" &&
         input.connection.status !== "repairing")) return undefined;
    return Object.freeze({ type: input.type, roomId: input.roomId, accessEpoch: input.accessEpoch,
      connection: Object.freeze({ status: input.connection.status }) });
  }
  if (input.type === "room.memory.revoked") {
    if (!hasExactKeys(input, ["type", "roomId", "accessEpoch", "scope", "purgeCompleted"]) ||
        !isIdentifier(input.roomId) || !isPositiveSafeInteger(input.accessEpoch) ||
        input.scope !== "room" || input.purgeCompleted !== true) return undefined;
    return Object.freeze({ type: input.type, roomId: input.roomId, accessEpoch: input.accessEpoch,
      scope: "room", purgeCompleted: true });
  }
  return undefined;
}

export function createMemoryAuthorityClient(rawBridge: MemoryAuthorityRawBridge): MemoryAuthorityClientPort {
  const listeners = new Set<(input: MemoryAuthorityClientApplication) => void>();
  let closed = false;
  const stop = rawBridge.onAuthorityInput((input) => {
    if (closed) return;
    const parsed = parseMemoryAuthorityClientApplication(input);
    if (parsed === undefined) return;
    for (const listener of listeners) listener(structuredClone(parsed));
  });
  const client: MemoryAuthorityClientPort = {
    async request(input): Promise<MemoryAuthorityEpochResponse> {
      if (closed) throw new MemoryAuthorityClientFailure(input.accessEpoch, safeDependencyError(input));
      try {
        return parseResponse(await rawBridge.request(structuredClone(input)), input);
      } catch (error) {
        if (error instanceof MemoryAuthorityClientFailure) throw error;
        throw new MemoryAuthorityClientFailure(input.accessEpoch, safeDependencyError(input));
      }
    },
    subscribe(listener): () => void {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close(): void {
      if (closed) return;
      closed = true;
      listeners.clear();
      stop();
    },
  };
  return Object.freeze(client);
}
