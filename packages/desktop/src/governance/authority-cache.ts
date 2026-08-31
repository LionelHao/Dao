import { createHash } from "node:crypto";
import {
  isRoomCursor,
  isRoomRepairPage,
  type RoomCursor,
  type RoomRepairRecord,
  type RoomSummary,
} from "@native-im/core";
import { isProjectEvent } from "@native-im/core";
import type { ClientAuthorityCache, DesktopRoomEvent } from "../sync/client-sync-replica.js";
import type { GovernanceProjection } from "../renderer/governance/view-model.js";
import type { AuthorityCachePersistence } from "./encrypted-authority-cache.js";
import type { EncryptedAuthorityGenerationStore } from "./encrypted-generation-store.js";
import {
  isDesktopOfflineReadLeaseClaims,
  type DesktopOfflineReadLeaseClaims,
} from "./offline-read-lease.js";

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
    case "room-agent-assignment":
      return `room-agent-assignment\0${record.value.assignmentId}`;
    case "message": return `message\0${record.value.id}`;
    case "timeline-message": return `timeline-message\0${record.value.id}`;
    case "message-revision": return `message-revision\0${record.value.messageId}\0${record.value.revision}`;
    case "attachment": return `attachment\0${record.value.attachment.attachmentId}`;
    case "human-read": return `human-read\0${record.value.id}`;
    case "agent-judgement": return `agent-judgement\0${record.value.id}`;
    case "open-item": return `open-item\0${record.value.id}`;
    case "open-item-agent-failure": return `open-item-agent-failure\0${record.value.id}`;
    case "light-task": return `light-task\0${record.value.id}`;
    case "agent-invocation-intent": return `agent-invocation-intent\0${record.value.intentId}`;
    case "agent-execution": return `agent-execution\0${record.value.executionId}`;
    case "agent-execution-attempt":
      return `agent-execution-attempt\0${record.value.executionId}\0${record.value.attemptSeq}`;
    case "agent-execution-retry": return `agent-execution-retry\0${record.value.requestId}`;
    case "agent-scoped-cancellation":
      return `agent-scoped-cancellation\0${record.value.fenceId}`;
    case "project-boundary-invocation":
      return `project-boundary-invocation\0${record.value.boundaryId}`;
    case "legacy-agent-execution": return `legacy-agent-execution\0${record.value.id}`;
    case "route-job": return `route-job\0${record.value.id}`;
    case "route-judgment": return `route-judgment\0${record.value.id}`;
    case "calibration": return `calibration\0${record.value.id}`;
    case "legacy-unknown-calibration": return `legacy-calibration\0${record.value.id}`;
    case "memory": return record.value.recordType === "status"
      ? "memory\0status"
      : `memory\0projection\0${record.value.projection.memoryRecordId}`;
    case "project-loop": return `project-loop\0${record.roomId}`;
    case "tool-call": return `tool-call\0${record.value.toolCallId}`;
    case "tool-confirmation": return `tool-confirmation\0${record.value.confirmationId}`;
    case "tool-grant": return `tool-grant\0${record.value.grantId}`;
    case "tool-dispatch": return `tool-dispatch\0${record.value.dispatchId}`;
    case "tool-review": return `tool-review\0${record.value.reviewId}`;
    case "tool-handoff": return `tool-handoff\0${record.value.handoffId}`;
    case "tool-compensation": return `tool-compensation\0${record.value.lineageId}`;
  }
}

function replaceRecord(records: RoomRepairRecord[], next: RoomRepairRecord): void {
  const key = recordIdentity(next);
  const index = records.findIndex((record) => recordIdentity(record) === key);
  if (index === -1) records.push(structuredClone(next));
  else records[index] = structuredClone(next);
}

function applyProjectionEvent(records: RoomRepairRecord[], event: DesktopRoomEvent): void {
  if (event.type === "tool.safety.changed") {
    replaceRecord(records, event.payload);
    return;
  }
  if (isProjectEvent(event)) {
    const index = records.findIndex((record) => record.kind === "project-loop" &&
      record.roomId === event.roomId);
    if (index !== -1) records.splice(index, 1);
    return;
  }
  switch (event.type) {
    case "room.archived":
    case "room.reopened": {
      const current = records.find(
        (record): record is Extract<RoomRepairRecord, { kind: "room" }> => record.kind === "room",
      );
      if (current !== undefined) replaceRecord(records, {
        kind: "room", value: {
          ...current.value,
          status: event.type === "room.archived" ? "archived" : "active",
        },
      });
      replaceRecord(records, { kind: "governance", value: event.payload.governance });
      return;
    }
    case "room.created":
    case "room.renamed": {
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
    case "room.security.reduced":
      replaceRecord(records, { kind: "governance", value: event.payload.governance });
      return;
    case "human.invitation.accepted":
    case "human.role.changed":
      replaceRecord(records, { kind: "membership", value: event.payload.membership });
      return;
    case "agent.configured":
      replaceRecord(records, { kind: "membership", value: event.payload.membership });
      return;
    case "room.agent-assignment.changed": {
      const payload = event.payload;
      if (payload.change === "removed") {
        const index = records.findIndex((record) =>
          record.kind === "room-agent-assignment" &&
          record.value.assignmentId === payload.assignmentId);
        if (index !== -1) records.splice(index, 1);
      } else {
        replaceRecord(records, {
          kind: "room-agent-assignment",
          value: payload.assignment,
        });
      }
      return;
    }
    case "member.removed": {
      const index = records.findIndex((record) =>
        record.kind === "membership" && record.value.actorId === event.payload.targetActorId);
      if (index !== -1) records.splice(index, 1);
      return;
    }
    case "room.memory.health.changed":
      replaceRecord(records, {
        kind: "memory",
        roomId: event.roomId,
        value: { recordType: "status", status: event.payload },
      });
      return;
    case "room.memory.version.changed": {
      const index = records.findIndex((record) => record.kind === "memory" &&
        record.value.recordType === "projection" &&
        record.value.projection.memoryRecordId === event.payload.memoryRecordId);
      if (index !== -1) records.splice(index, 1);
      return;
    }
    case "room.message.accepted":
      if ("lifecycle" in event.payload) {
        replaceRecord(records, { kind: "timeline-message", value: event.payload });
      }
      return;
    case "room.message.revised":
    case "room.message.recalled":
      replaceRecord(records, { kind: "timeline-message", value: event.payload });
      return;
    case "agent.invocation.intent.changed":
      replaceRecord(records, { kind: "agent-invocation-intent", value: event.payload });
      return;
    case "agent.execution.changed":
      replaceRecord(records, { kind: "agent-execution", value: event.payload });
      return;
    case "agent.execution.attempt.changed":
      replaceRecord(records, { kind: "agent-execution-attempt", value: event.payload });
      return;
    case "agent.execution.retry.accepted":
      replaceRecord(records, { kind: "agent-execution-retry", value: event.payload });
      return;
    case "agent.invocation.scoped-cancellation.committed":
      replaceRecord(records, { kind: "agent-scoped-cancellation", value: event.payload });
      return;
    case "project.boundary.invocation.decided":
      replaceRecord(records, { kind: "project-boundary-invocation", value: event.payload });
      return;
    default:
      return;
  }
}

export interface DesktopAuthorityCache extends ClientAuthorityCache {
  governanceProjection(roomId: string): GovernanceProjection | undefined;
  roomIds(): readonly string[];
  updatedAt(roomId: string): string | undefined;
  roomRepairRecords(roomId: string): readonly RoomRepairRecord[] | undefined;
  subscribeRoomRecords(listener: (
    roomId: string,
    records: readonly RoomRepairRecord[] | undefined,
  ) => void): () => void;
  clearRoom(roomId: string): void;
  waitForPersistence(): Promise<void>;
  restore(actorId: string): Promise<boolean>;
  installOfflineReadLease(roomId: string, lease: Readonly<{
    token: string;
    claims: DesktopOfflineReadLeaseClaims;
  }>): void;
  offlineReadLease(roomId: string): Readonly<{
    token: string;
    claims: DesktopOfflineReadLeaseClaims;
  }> | undefined;
  close(): void;
}

export function createDesktopAuthorityCache(
  now: () => string = () => new Date().toISOString(),
  persistence?: AuthorityCachePersistence,
  generationStoreFactory?: (actorId: string) => EncryptedAuthorityGenerationStore,
): DesktopAuthorityCache {
  let catalogStage: CatalogStage | undefined;
  let catalog: RoomSummary[] = [];
  const roomStages = new Map<string, RoomStage>();
  const rooms = new Map<string, LiveRoom>();
  const offlineLeases = new Map<string, Readonly<{
    token: string;
    claims: DesktopOfflineReadLeaseClaims;
  }>>();
  let activeActorId: string | undefined;
  let generationStore: EncryptedAuthorityGenerationStore | undefined;
  let persistenceWork = Promise.resolve();
  const roomListeners = new Set<(
    roomId: string,
    records: readonly RoomRepairRecord[] | undefined,
  ) => void>();
  const publishRoom = (roomId: string): void => {
    const records = rooms.get(roomId)?.records;
    for (const listener of [...roomListeners]) {
      try { listener(roomId, records === undefined ? undefined : structuredClone(records)); }
      catch { /* A projection observer cannot alter authoritative cache state. */ }
    }
  };
  const schedulePersistence = (operation: () => Promise<void>): void => {
    persistenceWork = persistenceWork.catch(() => undefined).then(operation);
    void persistenceWork.catch(() => undefined);
  };
  const persist = (): void => {
    if (persistence === undefined || activeActorId === undefined) return;
    const value = {
      version: 1,
      actorId: activeActorId,
      rooms: [...rooms].map(([roomId, room]) => ({ roomId, records: structuredClone(room.records),
        cursor: structuredClone(room.cursor), updatedAt: room.updatedAt,
        checksum: authoritySnapshotChecksum("room", room.records) })),
    };
    schedulePersistence(() => persistence.save(value));
  };

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
      if (stage.records.length === 0 && generationStore !== undefined) {
        generationStore.beginRoomGeneration({
          roomId: page.roomId,
          snapshotId: page.snapshotId,
          watermark: page.watermark,
          checksum: page.snapshotChecksum,
        });
      }
      generationStore?.stageRoomRecords(page.roomId, page.snapshotId, page.records.map((record) => ({
        identity: recordIdentity(record),
        value: record,
      })));
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
      const checksum = authoritySnapshotChecksum("room", stage.records);
      generationStore?.commitRoomGeneration({
        roomId,
        snapshotId: stage.snapshotId,
        watermark,
        expectedCount: stage.records.length,
        checksum,
      });
      rooms.set(roomId, {
        records: structuredClone(stage.records),
        cursor: { version: 1, roomId, afterSeq: watermark },
        updatedAt: now(),
      });
      roomStages.delete(roomId);
      publishRoom(roomId);
      persist();
    },
    applyRoomEvents(roomId, events, cursor) {
      const room = rooms.get(roomId);
      if (room === undefined) throw new TypeError("Live Room is absent");
      const nextRecords = structuredClone(room.records);
      for (const event of events) applyProjectionEvent(nextRecords, event);
      if (generationStore !== undefined) {
        const nextIdentities = new Set(nextRecords.map(recordIdentity));
        generationStore.applyRoomEventBatch({
          roomId,
          events: events.map((event) => ({ eventId: event.eventId, streamSeq: event.streamSeq })),
          nextCursor: cursor.afterSeq,
          upserts: nextRecords.map((record) => ({ identity: recordIdentity(record), value: record })),
          deletes: room.records.map(recordIdentity).filter((identity) => !nextIdentities.has(identity)),
        });
      }
      room.records = nextRecords;
      room.cursor = structuredClone(cursor);
      room.updatedAt = now();
      publishRoom(roomId);
      persist();
    },
    discardSnapshot(snapshotId) {
      if (catalogStage?.snapshotId === snapshotId) catalogStage = undefined;
      for (const [roomId, stage] of roomStages) {
        if (stage.snapshotId === snapshotId) {
          generationStore?.discardRoomGeneration(roomId, snapshotId);
          roomStages.delete(roomId);
        }
      }
    },
    clear() {
      const roomIds = [...rooms.keys()];
      catalogStage = undefined;
      catalog = [];
      roomStages.clear();
      rooms.clear();
      offlineLeases.clear();
      for (const roomId of roomIds) publishRoom(roomId);
      activeActorId = undefined;
      generationStore?.clearAccount();
      generationStore = undefined;
      if (persistence !== undefined) schedulePersistence(() => persistence.clear());
    },
    clearRoom(roomId) {
      if (catalogStage !== undefined) {
        catalogStage = {
          ...catalogStage,
          rooms: catalogStage.rooms.filter((room) => room.roomId !== roomId),
        };
      }
      catalog = catalog.filter((room) => room.roomId !== roomId);
      roomStages.delete(roomId);
      rooms.delete(roomId);
      offlineLeases.delete(roomId);
      generationStore?.clearRoom(roomId);
      publishRoom(roomId);
      persist();
    },
    waitForPersistence() { return persistenceWork; },
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
    roomRepairRecords(roomId) {
      const records = rooms.get(roomId)?.records;
      return records === undefined ? undefined : structuredClone(records);
    },
    subscribeRoomRecords(listener) {
      roomListeners.add(listener);
      return () => roomListeners.delete(listener);
    },
    installOfflineReadLease(roomId, lease) {
      if (lease.claims.room.roomId !== roomId) throw new TypeError("Offline lease Room mismatch");
      const closed = structuredClone(lease);
      generationStore?.writeOfflineLease(roomId, closed);
      offlineLeases.set(roomId, closed);
    },
    offlineReadLease(roomId) {
      const lease = offlineLeases.get(roomId);
      return lease === undefined ? undefined : structuredClone(lease);
    },
    async restore(actorId) {
      if (activeActorId === actorId) return rooms.size > 0;
      if (activeActorId !== undefined && activeActorId !== actorId) {
        const priorRoomIds = [...rooms.keys()];
        rooms.clear();
        for (const roomId of priorRoomIds) publishRoom(roomId);
      }
      if (persistence === undefined) { activeActorId = actorId; return false; }
      generationStore ??= generationStoreFactory?.(actorId);
      await persistenceWork;
      const value = await persistence.load();
      if (typeof value !== "object" || value === null || Array.isArray(value) ||
          Reflect.ownKeys(value).length !== 3 ||
          (value as { version?: unknown }).version !== 1 ||
          (value as { actorId?: unknown }).actorId !== actorId ||
          !Array.isArray((value as { rooms?: unknown }).rooms) ||
          (value as { rooms: unknown[] }).rooms.length > 512) {
        await persistence.clear().catch(() => undefined);
        activeActorId = actorId;
        return false;
      }
      const restored = new Map<string, LiveRoom>();
      for (const candidate of (value as { rooms: unknown[] }).rooms) {
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
            Reflect.ownKeys(candidate).length !== 5) {
          await persistence.clear().catch(() => undefined); activeActorId = actorId; return false;
        }
        const item = candidate as { roomId?: unknown; records?: unknown; cursor?: unknown;
          updatedAt?: unknown; checksum?: unknown };
        if (typeof item.roomId !== "string" || item.roomId.length === 0 ||
            !Array.isArray(item.records) || typeof item.checksum !== "string" ||
            authoritySnapshotChecksum("room", item.records) !== item.checksum ||
            !isRoomCursor(item.cursor) || item.cursor.roomId !== item.roomId ||
            typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt)) ||
            new Date(Date.parse(item.updatedAt)).toISOString() !== item.updatedAt ||
            !isRoomRepairPage({ type: "room.repair.page", requestId: "cache-restore",
              snapshotId: `cache:${item.roomId}`, roomId: item.roomId, page: 0,
              records: item.records, watermark: item.cursor.afterSeq,
              snapshotChecksum: item.checksum, hasMore: false, mode: "materialized",
              expiresAt: "2099-01-01T00:00:00.000Z" })) {
          await persistence.clear().catch(() => undefined); activeActorId = actorId; return false;
        }
        const durable = generationStore?.readActiveRoom(item.roomId);
        const durableRecords = durable?.records.map((record) => record.value);
        if (generationStore !== undefined && (durable === undefined ||
            !Array.isArray(durableRecords) || durable.cursor.afterSeq !== item.cursor.afterSeq ||
            authoritySnapshotChecksum("room", durableRecords) !== item.checksum ||
            !isRoomRepairPage({ type: "room.repair.page", requestId: "cache-durable-restore",
              snapshotId: `cache:${item.roomId}`, roomId: item.roomId, page: 0,
              records: durableRecords, watermark: durable.cursor.afterSeq,
              snapshotChecksum: item.checksum, hasMore: false, mode: "materialized",
              expiresAt: "2099-01-01T00:00:00.000Z" }))) {
          generationStore.clearAccount(); generationStore = undefined;
          await persistence.clear().catch(() => undefined); activeActorId = actorId; return false;
        }
        restored.set(item.roomId, {
          records: structuredClone((durableRecords ?? item.records) as RoomRepairRecord[]),
          cursor: structuredClone(durable?.cursor ?? item.cursor), updatedAt: item.updatedAt,
        });
        const lease = generationStore?.readOfflineLease(item.roomId);
        if (lease !== undefined && typeof lease === "object" && lease !== null &&
            "token" in lease && typeof lease.token === "string" && lease.token.length > 0 &&
            "claims" in lease && isDesktopOfflineReadLeaseClaims(lease.claims) &&
            lease.claims.actorId === actorId && lease.claims.room.roomId === item.roomId) {
          offlineLeases.set(item.roomId, structuredClone(lease) as Readonly<{
            token: string; claims: DesktopOfflineReadLeaseClaims;
          }>);
        }
      }
      const priorRoomIds = new Set(rooms.keys());
      rooms.clear();
      for (const [roomId, room] of restored) { rooms.set(roomId, room); priorRoomIds.add(roomId); }
      activeActorId = actorId;
      for (const roomId of priorRoomIds) publishRoom(roomId);
      return restored.size > 0;
    },
    close() {
      generationStore?.close();
      generationStore = undefined;
    },
  };
}
