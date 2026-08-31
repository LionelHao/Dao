import {
  isRoomCursor,
  isRoomRepairPage,
  type RoomCursor,
  type RoomRepairRecord,
  type RoomSummary,
} from "@native-im/core";
import type { ClientAuthorityCache, DesktopRoomEvent } from "../sync/client-sync-replica.js";
import type { GovernanceProjection } from "../renderer/governance/view-model.js";
import type { AuthorityCachePersistence } from "./encrypted-authority-cache.js";
import {
  authorityGenerationChecksum,
  type EncryptedAuthorityGenerationStore,
} from "./encrypted-generation-store.js";
import {
  isDesktopOfflineReadLeaseClaims,
  type DesktopActiveGenerationBinding,
  type DesktopOfflineReadLeaseClaims,
} from "./offline-read-lease.js";

interface CatalogStage { readonly snapshotId: string; readonly rooms: RoomSummary[] }
interface RoomStage { readonly snapshotId: string; readonly records: RoomRepairRecord[] }
interface LiveRoom {
  records: RoomRepairRecord[];
  cursor: RoomCursor;
  updatedAt: string;
}

const OFFLINE_BINDING_INVALIDATION_EVENTS = new Set<DesktopRoomEvent["type"]>([
  "room.governance.changed", "room.archived", "room.reopened", "room.security.reduced",
  "human.role.changed", "member.removed",
]);

export function authoritySnapshotChecksum(
  kind: "catalog" | "room",
  values: readonly unknown[],
): string {
  return authorityGenerationChecksum(kind, values);
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

function removeRecord(records: RoomRepairRecord[], predicate: (record: RoomRepairRecord) => boolean): void {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (predicate(records[index]!)) records.splice(index, 1);
  }
}

type ProjectionEventAction = "upsert" | "remove" | "invalidate" | "explicit-noop";

/**
 * This manifest intentionally mirrors the complete PersistedRoomEvent discriminant union.
 * `satisfies` makes a newly added protocol event a compile failure until its cache behavior is
 * classified; the reducer below remains the executable contract for the classification.
 */
export const DESKTOP_ROOM_EVENT_PROJECTION_ACTIONS_FOR_TEST = Object.freeze({
  "room.created": "upsert",
  "room.renamed": "upsert",
  "room.governance.changed": "upsert",
  "room.archived": "upsert",
  "room.reopened": "upsert",
  "room.security.reduced": "upsert",
  "human.invitation.issued": "explicit-noop",
  "human.invitation.accepted": "upsert",
  "human.invitation.rejected": "explicit-noop",
  "human.role.changed": "upsert",
  "member.removed": "remove",
  "agent.configured": "upsert",
  "room.agent-assignment.changed": "upsert",
  "room.message.accepted": "upsert",
  "room.message.revised": "upsert",
  "room.message.recalled": "upsert",
  "room.attachment.bound": "upsert",
  "room.attachment.excluded": "remove",
  "room.memory.version.changed": "invalidate",
  "room.memory.health.changed": "upsert",
  "project.goal.changed": "invalidate",
  "project.decision.changed": "invalidate",
  "project.request.changed": "invalidate",
  "project.next-action.changed": "invalidate",
  "project.blocker.changed": "invalidate",
  "project.open-question.changed": "invalidate",
  "project.proposal.changed": "invalidate",
  "project.confirmation.changed": "invalidate",
  "project.transfer-proposal.changed": "invalidate",
  "project.ball.changed": "invalidate",
  "tool.safety.changed": "upsert",
  "room.human_read.recorded": "upsert",
  "room.agent_judgment.recorded": "upsert",
  "room.open_item.changed": "upsert",
  "room.open_item.agent_attempt_failed": "upsert",
  "room.light_task.changed": "upsert",
  "room.ball.overdue": "explicit-noop",
  "room.human_preemption.applied": "explicit-noop",
  "room.agent_execution.changed": "upsert",
  "agent.execution.queued": "invalidate",
  "agent.execution.started": "invalidate",
  "agent.execution.retry-scheduled": "invalidate",
  "agent.execution.completed": "invalidate",
  "agent.execution.failed": "invalidate",
  "agent.execution.cancelled": "invalidate",
  "agent.execution.dead-lettered": "invalidate",
  "agent.execution.recovered": "invalidate",
  "agent.invocation.intent.changed": "upsert",
  "agent.execution.changed": "upsert",
  "agent.execution.attempt.changed": "upsert",
  "agent.execution.retry.accepted": "upsert",
  "agent.invocation.scoped-cancellation.committed": "upsert",
  "project.boundary.invocation.decided": "upsert",
  "room.route_judgment.recorded": "upsert",
  "route.queued": "upsert",
  "route.started": "upsert",
  "route.retry-scheduled": "upsert",
  "route.completed": "upsert",
  "route.failed": "upsert",
  "route.recovered": "upsert",
  "agent.tool.confirmation-required": "invalidate",
  "room.calibration.recorded": "upsert",
} as const satisfies Record<DesktopRoomEvent["type"], ProjectionEventAction>);

function applyProjectionEvent(records: RoomRepairRecord[], event: DesktopRoomEvent): void {
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
      removeRecord(records, (record) =>
        record.kind === "membership" && record.value.actorId === event.payload.targetActorId);
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
      removeRecord(records, (record) => record.kind === "memory" &&
        record.value.recordType === "projection" &&
        record.value.projection.memoryRecordId === event.payload.memoryRecordId);
      return;
    }
    case "room.message.accepted": {
      if ("lifecycle" in event.payload) {
        replaceRecord(records, { kind: "timeline-message", value: event.payload });
        if ("currentRevision" in event.payload) {
          replaceRecord(records, {
            kind: "message-revision",
            roomId: event.roomId,
            value: event.payload.currentRevision,
          });
        }
      } else {
        replaceRecord(records, { kind: "message", value: event.payload });
      }
      return;
    }
    case "room.message.revised":
      replaceRecord(records, {
        kind: "message-revision",
        roomId: event.roomId,
        value: event.payload.currentRevision,
      });
      replaceRecord(records, { kind: "timeline-message", value: event.payload });
      return;
    case "room.message.recalled":
      removeRecord(records, (record) =>
        record.kind === "message-revision" && record.value.messageId === event.payload.id ||
        record.kind === "message" && record.value.id === event.payload.id);
      replaceRecord(records, { kind: "timeline-message", value: event.payload });
      return;
    case "room.attachment.bound":
      replaceRecord(records, { kind: "attachment", value: event.payload });
      return;
    case "room.attachment.excluded":
      removeRecord(records, (record) => record.kind === "attachment" &&
        record.value.attachment.attachmentId === event.payload.attachmentId);
      return;
    case "room.human_read.recorded":
      replaceRecord(records, { kind: "human-read", value: event.payload });
      return;
    case "room.agent_judgment.recorded":
      replaceRecord(records, { kind: "agent-judgement", value: event.payload });
      return;
    case "room.open_item.changed":
      replaceRecord(records, { kind: "open-item", value: event.payload });
      return;
    case "room.open_item.agent_attempt_failed":
      replaceRecord(records, { kind: "open-item-agent-failure", value: event.payload });
      return;
    case "room.light_task.changed":
      replaceRecord(records, { kind: "light-task", value: event.payload });
      return;
    case "room.agent_execution.changed":
      replaceRecord(records, { kind: "legacy-agent-execution", value: event.payload });
      return;
    case "agent.execution.queued":
    case "agent.execution.started":
    case "agent.execution.retry-scheduled":
    case "agent.execution.completed":
    case "agent.execution.failed":
    case "agent.execution.cancelled":
    case "agent.execution.dead-lettered":
    case "agent.execution.recovered":
      removeRecord(records, (record) => record.kind === "legacy-agent-execution" &&
        record.value.id === event.payload.executionId);
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
    case "room.route_judgment.recorded":
      replaceRecord(records, { kind: "route-judgment", value: event.payload });
      return;
    case "route.queued":
    case "route.started":
    case "route.retry-scheduled":
    case "route.completed":
    case "route.failed":
    case "route.recovered":
      replaceRecord(records, { kind: "route-job", value: event.payload });
      return;
    case "room.calibration.recorded":
      replaceRecord(records, { kind: "calibration", value: event.payload });
      return;
    case "tool.safety.changed":
      replaceRecord(records, event.payload);
      return;
    case "project.goal.changed":
    case "project.decision.changed":
    case "project.request.changed":
    case "project.next-action.changed":
    case "project.blocker.changed":
    case "project.open-question.changed":
    case "project.proposal.changed":
    case "project.confirmation.changed":
    case "project.transfer-proposal.changed":
    case "project.ball.changed":
      removeRecord(records, (record) => record.kind === "project-loop" &&
        record.roomId === event.roomId);
      return;
    case "agent.tool.confirmation-required":
      removeRecord(records, (record) => record.kind.startsWith("tool-"));
      return;
    case "human.invitation.issued":
    case "human.invitation.rejected":
    case "room.ball.overdue":
    case "room.human_preemption.applied":
      return;
  }
  const unhandled: never = event;
  throw new TypeError(`Unhandled Desktop Room event: ${String(unhandled)}`);
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
  activeGenerationBinding(roomId: string): DesktopActiveGenerationBinding | undefined;
  authorizeOfflineRead(roomId: string, expiresAtMs: number): void;
  isOfflineReadAuthorized(roomId: string, nowMs?: number): boolean;
  revokeOfflineRead(roomId: string): void;
  toolSafetyRepairRequired(roomId: string): boolean;
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
  const offlineReadAuthorizations = new Map<string, number>();
  const generationBindings = new Map<string, DesktopActiveGenerationBinding>();
  const toolSafetyRepairRequired = new Set<string>();
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
      offlineLeases.delete(roomId);
      offlineReadAuthorizations.delete(roomId);
      generationBindings.delete(roomId);
      toolSafetyRepairRequired.delete(roomId);
      roomStages.delete(roomId);
      publishRoom(roomId);
      persist();
    },
    applyRoomEvents(roomId, events, cursor) {
      const room = rooms.get(roomId);
      if (room === undefined) throw new TypeError("Live Room is absent");
      const nextRecords = structuredClone(room.records);
      for (const event of events) applyProjectionEvent(nextRecords, event);
      const invalidatesOfflineBinding = events.some((event) =>
        OFFLINE_BINDING_INVALIDATION_EVENTS.has(event.type));
      if (generationStore !== undefined) {
        const nextIdentities = new Set(nextRecords.map(recordIdentity));
        generationStore.applyRoomEventBatch({
          roomId,
          events: events.map((event) => ({ eventId: event.eventId, streamSeq: event.streamSeq })),
          nextCursor: cursor.afterSeq,
          upserts: nextRecords.map((record) => ({ identity: recordIdentity(record), value: record })),
          deletes: room.records.map(recordIdentity).filter((identity) => !nextIdentities.has(identity)),
          invalidateActiveBinding: invalidatesOfflineBinding,
        });
      }
      room.records = nextRecords;
      room.cursor = structuredClone(cursor);
      room.updatedAt = now();
      if (events.some((event) => event.type === "agent.tool.confirmation-required")) {
        toolSafetyRepairRequired.add(roomId);
      }
      if (invalidatesOfflineBinding) {
        offlineReadAuthorizations.delete(roomId);
        offlineLeases.delete(roomId);
        generationBindings.delete(roomId);
        generationStore?.clearOfflineLease(roomId);
        generationStore?.clearActiveGenerationBinding(roomId);
      }
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
      offlineReadAuthorizations.clear();
      generationBindings.clear();
      toolSafetyRepairRequired.clear();
      for (const roomId of roomIds) publishRoom(roomId);
      activeActorId = undefined;
      const store = generationStore;
      if (store !== undefined) {
        try {
          store.clearAccount();
          generationStore = undefined;
        } catch (clearCause: unknown) {
          // This is a derived cache. Physical removal is the fail-closed recovery when its
          // own schema or metadata is too damaged to perform the logical account purge.
          try {
            store.destroy();
            generationStore = undefined;
          } catch (destroyCause: unknown) {
            generationStore = store;
            throw new AggregateError(
              [clearCause, destroyCause],
              "Authority cache account purge and physical cleanup both failed",
            );
          }
        }
      }
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
      offlineReadAuthorizations.delete(roomId);
      generationBindings.delete(roomId);
      toolSafetyRepairRequired.delete(roomId);
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
      const binding = Object.freeze({
        roomId,
        complete: true as const,
        lifecycleGeneration: lease.claims.room.lifecycleGeneration,
        accessRevision: lease.claims.room.accessRevision,
        leaseGeneration: lease.claims.room.leaseGeneration,
      });
      generationStore?.bindActiveGeneration(roomId, binding);
      generationStore?.writeOfflineLease(roomId, closed);
      generationBindings.set(roomId, binding);
      offlineLeases.set(roomId, closed);
    },
    offlineReadLease(roomId) {
      const lease = offlineLeases.get(roomId);
      return lease === undefined ? undefined : structuredClone(lease);
    },
    activeGenerationBinding(roomId) {
      const binding = generationBindings.get(roomId);
      return binding === undefined ? undefined : structuredClone(binding);
    },
    authorizeOfflineRead(roomId, expiresAtMs) {
      if (!rooms.has(roomId) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) {
        throw new TypeError("Offline read authorization is invalid");
      }
      offlineReadAuthorizations.set(roomId, expiresAtMs);
      publishRoom(roomId);
    },
    isOfflineReadAuthorized(roomId, nowMs = Date.now()) {
      if (!Number.isFinite(nowMs)) return false;
      const expiresAtMs = offlineReadAuthorizations.get(roomId);
      if (expiresAtMs === undefined) return false;
      if (nowMs >= expiresAtMs || !rooms.has(roomId)) {
        offlineReadAuthorizations.delete(roomId);
        return false;
      }
      return true;
    },
    revokeOfflineRead(roomId) {
      offlineReadAuthorizations.delete(roomId);
    },
    toolSafetyRepairRequired(roomId) {
      return toolSafetyRepairRequired.has(roomId);
    },
    async restore(actorId) {
      if (activeActorId === actorId) return rooms.size > 0;
      if (activeActorId !== undefined && activeActorId !== actorId) {
        const priorRoomIds = [...rooms.keys()];
        rooms.clear();
        offlineLeases.clear();
        offlineReadAuthorizations.clear();
        generationBindings.clear();
        for (const roomId of priorRoomIds) publishRoom(roomId);
      }
      generationStore ??= generationStoreFactory?.(actorId);
      if (persistence === undefined && generationStore === undefined) {
        activeActorId = actorId;
        return false;
      }
      await persistenceWork;
      const value = await persistence?.load();
      const legacyRooms = new Map<string, LiveRoom>();
      let legacyValid = typeof value === "object" && value !== null && !Array.isArray(value) &&
        Reflect.ownKeys(value).length === 3 &&
        (value as { version?: unknown }).version === 1 &&
        (value as { actorId?: unknown }).actorId === actorId &&
        Array.isArray((value as { rooms?: unknown }).rooms) &&
        (value as { rooms: unknown[] }).rooms.length <= 512;
      if (legacyValid) {
        for (const candidate of (value as { rooms: unknown[] }).rooms) {
          if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate) ||
              Reflect.ownKeys(candidate).length !== 5) {
            legacyValid = false;
            break;
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
            legacyValid = false;
            break;
          }
          legacyRooms.set(item.roomId, {
            records: structuredClone(item.records as RoomRepairRecord[]),
            cursor: structuredClone(item.cursor),
            updatedAt: item.updatedAt,
          });
        }
      }
      if (!legacyValid) {
        legacyRooms.clear();
        await persistence?.clear().catch(() => undefined);
      }

      const restored = new Map<string, LiveRoom>();
      const roomIds = generationStore === undefined
        ? [...legacyRooms.keys()]
        : [...generationStore.listActiveRoomIds()];
      for (const roomId of roomIds) {
        const durable = generationStore?.readActiveRoom(roomId);
        const durableRecords = durable?.records.map((record) => record.value);
        if (generationStore !== undefined && (durable === undefined ||
            !Array.isArray(durableRecords) ||
            !isRoomRepairPage({ type: "room.repair.page", requestId: "cache-durable-restore",
              snapshotId: `cache:${roomId}`, roomId, page: 0,
              records: durableRecords, watermark: durable.cursor.afterSeq,
              snapshotChecksum: durable.checksum, hasMore: false, mode: "materialized",
              expiresAt: "2099-01-01T00:00:00.000Z" }))) {
          throw new TypeError("Durable authority generation is invalid");
        }
        const legacy = legacyRooms.get(roomId);
        if (durable === undefined && legacy === undefined) continue;
        restored.set(roomId, durable === undefined ? structuredClone(legacy!) : {
          records: structuredClone(durableRecords as RoomRepairRecord[]),
          cursor: structuredClone(durable.cursor),
          updatedAt: legacy?.updatedAt ?? now(),
        });
        const lease = generationStore?.readOfflineLease(roomId);
        if (lease !== undefined && typeof lease === "object" && lease !== null &&
            "token" in lease && typeof lease.token === "string" && lease.token.length > 0 &&
            "claims" in lease && isDesktopOfflineReadLeaseClaims(lease.claims) &&
            lease.claims.actorId === actorId && lease.claims.room.roomId === roomId) {
          offlineLeases.set(roomId, structuredClone(lease) as Readonly<{
            token: string; claims: DesktopOfflineReadLeaseClaims;
          }>);
        }
        const binding = generationStore?.readActiveGenerationBinding(roomId);
        if (binding !== undefined) generationBindings.set(roomId, binding);
      }
      rooms.clear();
      for (const [roomId, room] of restored) rooms.set(roomId, room);
      activeActorId = actorId;
      return restored.size > 0;
    },
    close() {
      offlineReadAuthorizations.clear();
      generationBindings.clear();
      generationStore?.close();
      generationStore = undefined;
    },
  };
}
