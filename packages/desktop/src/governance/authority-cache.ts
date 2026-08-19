import { createHash } from "node:crypto";
import type {
  PersistedRoomEvent,
  RoomCursor,
  RoomRepairRecord,
  RoomSummary,
} from "@native-im/core";
import type { ClientAuthorityCache } from "../sync/client-sync-replica.js";
import type { GovernanceProjection } from "../renderer/governance/view-model.js";

interface CatalogStage { readonly snapshotId: string; readonly rooms: RoomSummary[] }
interface RoomStage { readonly snapshotId: string; readonly records: RoomRepairRecord[] }
interface LiveRoom {
  records: RoomRepairRecord[];
  cursor: RoomCursor;
  updatedAt: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Authority cache cannot canonicalize this value");
}

export function authoritySnapshotChecksum(
  kind: "catalog" | "room",
  values: readonly unknown[],
): string {
  return createHash("sha256")
    .update(canonicalJson({ kind, values, version: 1 }), "utf8")
    .digest("hex");
}

function recordIdentity(record: RoomRepairRecord): string {
  switch (record.kind) {
    case "room": return "room";
    case "governance": return "governance";
    case "membership": return `membership\0${record.value.actorId}`;
    case "message": return `message\0${record.value.id}`;
    case "human-read": return `human-read\0${record.value.id}`;
    case "agent-judgement": return `agent-judgement\0${record.value.id}`;
    case "open-item": return `open-item\0${record.value.id}`;
    case "open-item-agent-failure": return `open-item-agent-failure\0${record.value.id}`;
    case "light-task": return `light-task\0${record.value.id}`;
    case "agent-execution": return `agent-execution\0${record.value.id}`;
    case "route-job": return `route-job\0${record.value.id}`;
    case "route-judgment": return `route-judgment\0${record.value.id}`;
    case "calibration": return `calibration\0${record.value.id}`;
    case "legacy-unknown-calibration": return `legacy-calibration\0${record.value.id}`;
  }
}

function replaceRecord(records: RoomRepairRecord[], next: RoomRepairRecord): void {
  const key = recordIdentity(next);
  const index = records.findIndex((record) => recordIdentity(record) === key);
  if (index === -1) records.push(structuredClone(next));
  else records[index] = structuredClone(next);
}

function applyProjectionEvent(records: RoomRepairRecord[], event: PersistedRoomEvent): void {
  switch (event.type) {
    case "room.created":
    case "room.renamed":
    case "room.archived": {
      replaceRecord(records, { kind: "room", value: {
        id: event.payload.room.id,
        name: event.payload.room.name,
        status: event.payload.room.status,
        createdAt: event.payload.room.createdAt,
      } });
      return;
    }
    case "room.governance.changed":
      replaceRecord(records, { kind: "governance", value: event.payload.governance });
      return;
    case "human.invitation.accepted":
    case "human.role.changed":
      replaceRecord(records, { kind: "membership", value: event.payload.membership });
      return;
    case "agent.configured":
      replaceRecord(records, { kind: "membership", value: event.payload.membership });
      return;
    case "member.removed": {
      const index = records.findIndex((record) =>
        record.kind === "membership" && record.value.actorId === event.payload.targetActorId);
      if (index !== -1) records.splice(index, 1);
      return;
    }
    default:
      return;
  }
}

export interface DesktopAuthorityCache extends ClientAuthorityCache {
  governanceProjection(roomId: string): GovernanceProjection | undefined;
  roomIds(): readonly string[];
  updatedAt(roomId: string): string | undefined;
}

export function createDesktopAuthorityCache(
  now: () => string = () => new Date().toISOString(),
): DesktopAuthorityCache {
  let catalogStage: CatalogStage | undefined;
  let catalog: RoomSummary[] = [];
  const roomStages = new Map<string, RoomStage>();
  const rooms = new Map<string, LiveRoom>();

  return {
    roomCursor(roomId) {
      const cursor = rooms.get(roomId)?.cursor;
      return cursor === undefined ? undefined : structuredClone(cursor);
    },
    beginCatalog(snapshotId) {
      catalogStage = { snapshotId, rooms: [] };
    },
    stageCatalogPage(page) {
      if (catalogStage?.snapshotId !== page.snapshotId) throw new TypeError("Catalog stage is absent");
      catalogStage.rooms.push(...structuredClone(page.rooms));
    },
    async finalizeCatalog(snapshotId, expectedChecksum) {
      return catalogStage?.snapshotId === snapshotId &&
        new Set(catalogStage.rooms.map((room) => room.roomId)).size === catalogStage.rooms.length &&
        authoritySnapshotChecksum("catalog", catalogStage.rooms) === expectedChecksum;
    },
    commitCatalog() {
      if (catalogStage === undefined) throw new TypeError("Catalog stage is absent");
      catalog = structuredClone(catalogStage.rooms);
      catalogStage = undefined;
    },
    *catalogRoomIds() {
      for (const room of catalog) yield room.roomId;
    },
    beginRoom(roomId, snapshotId) {
      roomStages.set(roomId, { snapshotId, records: [] });
    },
    stageRoomPage(page) {
      const stage = roomStages.get(page.roomId);
      if (stage?.snapshotId !== page.snapshotId) throw new TypeError("Room stage is absent");
      stage.records.push(...structuredClone(page.records));
    },
    async finalizeRoom(snapshotId, expectedChecksum) {
      const stage = [...roomStages.values()].find((candidate) => candidate.snapshotId === snapshotId);
      if (stage === undefined) return false;
      const identities = stage.records.map(recordIdentity);
      return new Set(identities).size === identities.length &&
        stage.records.filter((record) => record.kind === "room").length === 1 &&
        stage.records.filter((record) => record.kind === "governance").length === 1 &&
        authoritySnapshotChecksum("room", stage.records) === expectedChecksum;
    },
    commitRoom(roomId, watermark) {
      const stage = roomStages.get(roomId);
      if (stage === undefined) throw new TypeError("Room stage is absent");
      rooms.set(roomId, {
        records: structuredClone(stage.records),
        cursor: { version: 1, roomId, afterSeq: watermark },
        updatedAt: now(),
      });
      roomStages.delete(roomId);
    },
    applyRoomEvents(roomId, events, cursor) {
      const room = rooms.get(roomId);
      if (room === undefined) throw new TypeError("Live Room is absent");
      for (const event of events) applyProjectionEvent(room.records, event);
      room.cursor = structuredClone(cursor);
      room.updatedAt = now();
    },
    discardSnapshot(snapshotId) {
      if (catalogStage?.snapshotId === snapshotId) catalogStage = undefined;
      for (const [roomId, stage] of roomStages) {
        if (stage.snapshotId === snapshotId) roomStages.delete(roomId);
      }
    },
    clear() {
      catalogStage = undefined;
      catalog = [];
      roomStages.clear();
      rooms.clear();
    },
    governanceProjection(roomId) {
      const records = rooms.get(roomId)?.records;
      if (records === undefined) return undefined;
      const room = records.find((record) => record.kind === "room")?.value;
      const governance = records.find((record) => record.kind === "governance")?.value;
      if (room === undefined || governance === undefined || room.id !== roomId ||
          governance.roomId !== roomId || room.status !== governance.lifecycle) return undefined;
      const memberships = records.filter(
        (record): record is Extract<RoomRepairRecord, { kind: "membership" }> =>
          record.kind === "membership",
      );
      if (!memberships.some((record) =>
        record.value.kind === "human" && record.value.actorId === governance.ownerActorId)) return undefined;
      return {
        roomId,
        projectId: governance.projectId,
        roomName: room.name,
        lifecycle: governance.lifecycle,
        governanceRevision: governance.governanceRevision,
        archiveGeneration: governance.archiveGeneration,
        ownerActorId: governance.ownerActorId,
        ...(governance.archivedAt === undefined ? {} : { archivedAt: governance.archivedAt }),
        members: memberships.map(({ value }) => value.kind === "human"
          ? {
              kind: "human" as const,
              actorId: value.actorId,
              displayName: value.actorId,
              role: value.role === "admin" ? "admin" as const : "member" as const,
            }
          : {
              kind: "agent" as const,
              actorId: value.actorId,
              displayName: value.actorId,
              ordinary: false,
            }),
      };
    },
    roomIds() {
      return [...rooms.keys()];
    },
    updatedAt(roomId) {
      return rooms.get(roomId)?.updatedAt;
    },
  };
}
