import type { PersistedRoomEvent, RoomRepairPage, RoomRepairRecord } from "@native-im/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  authoritySnapshotChecksum,
  createDesktopAuthorityCache,
  DESKTOP_ROOM_EVENT_PROJECTION_ACTIONS_FOR_TEST,
} from "./authority-cache.js";
import {
  createEncryptedAuthorityGenerationStore,
  createRecoverableEncryptedAuthorityGenerationStore,
} from "./encrypted-generation-store.js";
import type { CredentialEncryption } from "../identity/credential-vault.js";
import { projectSnapshot } from "../project-loop/test-fixture.js";
import type { DesktopOfflineReadLeaseClaims } from "./offline-read-lease.js";

const records: readonly RoomRepairRecord[] = [
  {
    kind: "room",
    value: {
      id: "room-1", name: "Alpha", status: "active", createdAt: "2026-08-19T00:00:00.000Z",
    },
  },
  {
    kind: "governance",
    value: {
      roomId: "room-1", projectId: "room-1", lifecycle: "active",
      governanceRevision: 7, ownerActorId: "owner-1", archiveGeneration: 0,
    },
  },
  {
    kind: "membership",
    value: { kind: "human", actorId: "owner-1", role: "owner", joinedAt: "2026-08-19T00:00:00.000Z" },
  },
  {
    kind: "membership",
    value: { kind: "human", actorId: "member-1", role: "member", joinedAt: "2026-08-19T00:00:00.000Z" },
  },
];

const wrapping: CredentialEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Uint8Array.from(Buffer.from(value, "utf8")).reverse(),
  decryptString: (value) => Buffer.from(Uint8Array.from(value).reverse()).toString("utf8"),
};

function page(): RoomRepairPage {
  return {
    type: "room.repair.page", requestId: "repair-1", snapshotId: "snapshot-1",
    roomId: "room-1", page: 0, records, watermark: 9,
    snapshotChecksum: authoritySnapshotChecksum("room", records),
    hasMore: false, mode: "materialized", expiresAt: "2026-08-19T00:05:00.000Z",
  };
}

function offlineClaims(overrides: Partial<DesktopOfflineReadLeaseClaims["room"]> = {}):
DesktopOfflineReadLeaseClaims {
  return {
    version: 1, keyId: "key-1", leaseId: "lease-1", tenantId: "tenant-1",
    accountId: "human-1", actorId: "human-1", actorKind: "human",
    sessionFamilyId: "family-1", deviceId: "device-1", installationId: "install-1",
    serverSubject: "dao-server", room: { roomId: "room-1", lifecycleGeneration: 0,
      accessRevision: 7, leaseGeneration: 3, ...overrides },
    issuedAtMs: 1_000, notBeforeMs: 1_000, expiresAtMs: 10_000,
  };
}

describe("production Desktop authority cache", () => {
  it("derives notification projection from the single Room repair and applies stable updates", async () => {
    const notification = { recordVersion: "notification.v1" as const, notificationId: "notification-1",
      roomId: "room-1", recipientActorId: "human-1", notificationKind: "human_request" as const,
      source: { sourceKind: "project_request" as const, sourceId: "request-1", sourceRevision: 1,
        sourceBoundaryId: "request-1:1", ordinal: 0 }, dedupeKey: "a".repeat(64),
      createdAt: "2026-08-31T08:00:00.000Z", readAt: null, readRevision: 0,
      handled: false, handledAt: null, sourceAccessible: true as const,
      deepLink: { kind: "request" as const, targetId: "request-1" },
      safeProjection: { titleKey: "human_request" as const, actorId: "human-2" } };
    const notificationRecords: readonly RoomRepairRecord[] = [
      ...records, { kind: "notification", value: notification },
    ];
    const checksum = authoritySnapshotChecksum("room", notificationRecords);
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "notification-repair");
    cache.stageRoomPage({ ...page(), snapshotId: "notification-repair", records: notificationRecords,
      snapshotChecksum: checksum });
    expect(await cache.finalizeRoom("notification-repair", checksum)).toBe(true);
    cache.commitRoom("room-1", 9, checksum);
    expect(cache.notificationProjections("human-1")).toEqual([notification]);
    cache.establishNotificationIdentityCursor(4);
    expect(cache.advanceNotificationIdentityCursor({ eventId: "room-access-event-5", streamSeq: 5 }))
      .toBe("applied");
    expect(cache.applyNotificationEvent({ eventId: "notification-event-6", streamKind: "identity",
      streamId: "human-1", streamSeq: 6, type: "notification.read",
      occurredAt: "2026-08-31T08:01:00.000Z", payload: { ...notification,
        readAt: "2026-08-31T08:01:00.000Z", readRevision: 1 } })).toBe("applied");
    expect(cache.notificationProjections("human-1")[0]).toMatchObject({ readRevision: 1 });
  });

  it("classifies the complete persisted Room event union before cursor advancement", () => {
    expect(Object.keys(DESKTOP_ROOM_EVENT_PROJECTION_ACTIONS_FOR_TEST)).toHaveLength(62);
    expect(new Set(Object.values(DESKTOP_ROOM_EVENT_PROJECTION_ACTIONS_FOR_TEST))).toEqual(new Set([
      "upsert", "remove", "invalidate", "explicit-noop",
    ]));
  });

  it("exposes the durability fence for an asynchronous authorized-state purge", async () => {
    let releaseClear: (() => void) | undefined;
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const persistence = { async load() { return undefined; }, async save() {}, async clear() { await clearGate; } };
    const cache = createDesktopAuthorityCache(() => "2026-08-25T05:00:00.000Z", persistence);
    cache.clear();
    let durable = false;
    const fence = cache.waitForPersistence().then(() => { durable = true; });
    await Promise.resolve();
    expect(durable).toBe(false);
    releaseClear?.();
    await fence;
    expect(durable).toBe(true);
  });

  it("restores only a complete encrypted actor-bound cache and purges it on revocation", async () => {
    let stored: unknown;
    let clearCount = 0;
    const persistence = {
      async load() { return structuredClone(stored); },
      async save(value: unknown) { stored = structuredClone(value); },
      async clear() { stored = undefined; clearCount += 1; },
    };
    const snapshot = projectSnapshot();
    const persistedRecords: readonly RoomRepairRecord[] = [
      ...records, { kind: "project-loop", roomId: "room-1", value: snapshot },
    ];
    const checksum = authoritySnapshotChecksum("room", persistedRecords);
    const first = createDesktopAuthorityCache(() => "2026-08-25T05:00:00.000Z", persistence);
    await first.restore("human-1");
    first.beginRoom("room-1", "snapshot-persist");
    first.stageRoomPage({ ...page(), snapshotId: "snapshot-persist", records: persistedRecords,
      watermark: snapshot.watermark, snapshotChecksum: checksum });
    expect(await first.finalizeRoom("snapshot-persist", checksum)).toBe(true);
    first.commitRoom("room-1", snapshot.watermark, checksum);
    await vi.waitFor(() => expect(stored).toBeDefined());

    const restarted = createDesktopAuthorityCache(() => "2026-08-25T05:01:00.000Z", persistence);
    await expect(restarted.restore("human-1")).resolves.toBe(true);
    expect(restarted.roomCursor("room-1")?.afterSeq).toBe(snapshot.watermark);
    expect(restarted.roomRepairRecords("room-1")?.find((record) => record.kind === "project-loop"))
      .toEqual({ kind: "project-loop", roomId: "room-1", value: snapshot });
    restarted.clear();
    await restarted.waitForPersistence();
    expect(clearCount).toBeGreaterThan(0);
    expect(stored).toBeUndefined();
  });

  it("restores the committed SQLite generation after a crash before stale legacy save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-authority-cache-"));
    const databasePath = join(directory, "authority-cache.sqlite");
    let stored: unknown;
    let rejectSave = false;
    const persistence = {
      async load() { return structuredClone(stored); },
      async save(value: unknown) {
        if (rejectSave) throw new Error("simulated legacy save crash");
        stored = structuredClone(value);
      },
      async clear() { stored = undefined; },
    };
    const factory = (actorId: string) => createEncryptedAuthorityGenerationStore({
      databasePath, accountId: actorId, encryption: wrapping,
    });
    try {
      const first = createDesktopAuthorityCache(
        () => "2026-08-31T10:00:00.000Z", persistence, factory,
      );
      await expect(first.restore("human-1")).resolves.toBe(false);
      const oldPage = page();
      first.beginRoom("room-1", oldPage.snapshotId);
      first.stageRoomPage(oldPage);
      expect(await first.finalizeRoom(oldPage.snapshotId, oldPage.snapshotChecksum)).toBe(true);
      first.commitRoom("room-1", oldPage.watermark, oldPage.snapshotChecksum);
      await first.waitForPersistence();

      const nextRecords = records.map((record) => record.kind === "room"
        ? { ...record, value: { ...record.value, name: "SQLite wins" } }
        : record) as readonly RoomRepairRecord[];
      const nextChecksum = authoritySnapshotChecksum("room", nextRecords);
      rejectSave = true;
      first.beginRoom("room-1", "snapshot-after-crash");
      first.stageRoomPage({ ...page(), snapshotId: "snapshot-after-crash", records: nextRecords,
        watermark: 10, snapshotChecksum: nextChecksum });
      expect(await first.finalizeRoom("snapshot-after-crash", nextChecksum)).toBe(true);
      first.commitRoom("room-1", 10, nextChecksum);
      await expect(first.waitForPersistence()).rejects.toThrow("simulated legacy save crash");
      first.close();

      rejectSave = false;
      const restarted = createDesktopAuthorityCache(
        () => "2026-08-31T10:01:00.000Z", persistence, factory,
      );
      await expect(restarted.restore("human-1")).resolves.toBe(true);
      expect(restarted.roomCursor("room-1")?.afterSeq).toBe(10);
      expect(restarted.governanceProjection("room-1")?.roomName).toBe("SQLite wins");
      restarted.close();

      stored = undefined;
      const withoutLegacy = createDesktopAuthorityCache(
        () => "2026-08-31T10:02:00.000Z", persistence, factory,
      );
      await expect(withoutLegacy.restore("human-1")).resolves.toBe(true);
      expect(withoutLegacy.governanceProjection("room-1")?.roomName).toBe("SQLite wins");
      withoutLegacy.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps restored records private until a persisted lease matches the active generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-authority-cache-"));
    const databasePath = join(directory, "authority-cache.sqlite");
    const factory = (actorId: string) => createEncryptedAuthorityGenerationStore({
      databasePath, accountId: actorId, encryption: wrapping,
    });
    try {
      const first = createDesktopAuthorityCache(() => "2026-08-31T10:00:00.000Z", undefined, factory);
      await first.restore("human-1");
      const repair = page();
      first.beginRoom("room-1", repair.snapshotId);
      first.stageRoomPage(repair);
      expect(await first.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).toBe(true);
      first.commitRoom("room-1", repair.watermark, repair.snapshotChecksum);
      first.installOfflineReadLease("room-1", { token: "signed-token", claims: offlineClaims() });
      first.close();

      const restarted = createDesktopAuthorityCache(
        () => "2026-08-31T10:01:00.000Z", undefined, factory,
      );
      const published = vi.fn();
      restarted.subscribeRoomRecords(published);
      await expect(restarted.restore("human-1")).resolves.toBe(true);
      expect(published).not.toHaveBeenCalled();
      expect(restarted.activeGenerationBinding("room-1")).toEqual({
        roomId: "room-1", complete: true,
        lifecycleGeneration: 0, accessRevision: 7, leaseGeneration: 3,
      });
      restarted.authorizeOfflineRead("room-1", 10_000);
      expect(published).toHaveBeenCalledOnce();
      restarted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    "after-rebuild-marker",
    "after-rebuild-sidecars",
    "after-rebuild-main",
  ] as const)("fences an interrupted clear-account fallback destroy at %s", async (failurePoint) => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-clear-fallback-"));
    const databasePath = join(directory, "authority-cache.sqlite");
    let faulted = false;
    const failingFactory = (actorId: string) => createEncryptedAuthorityGenerationStore({
      databasePath, accountId: actorId, encryption: wrapping,
      clearAccountFault: () => { throw new Error("logical-clear-rollback"); },
      recoveryFault(point) {
        if (!faulted && point === failurePoint) {
          faulted = true;
          throw new Error(`physical-clear-crash:${point}`);
        }
      },
    });
    try {
      const first = createDesktopAuthorityCache(undefined, undefined, failingFactory);
      await first.restore("human-1");
      const repair = page();
      first.beginRoom("room-1", repair.snapshotId);
      first.stageRoomPage(repair);
      expect(await first.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).toBe(true);
      first.commitRoom("room-1", repair.watermark, repair.snapshotChecksum);
      first.installOfflineReadLease("room-1", { token: "lease-before-clear", claims: offlineClaims() });
      expect(() => first.clear()).toThrow("Authority cache account purge");

      const recovered = createDesktopAuthorityCache(undefined, undefined, (actorId) =>
        createRecoverableEncryptedAuthorityGenerationStore({
          databasePath, accountId: actorId, encryption: wrapping,
        }));
      await expect(recovered.restore("human-1")).resolves.toBe(false);
      expect(recovered.roomIds()).toEqual([]);
      expect(recovered.offlineReadLease("room-1")).toBeUndefined();
      expect(recovered.activeGenerationBinding("room-1")).toBeUndefined();
      recovered.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps verified offline-read authorization process-local, expiring, and revocable", async () => {
    const cache = createDesktopAuthorityCache();
    const repair = page();
    cache.beginRoom("room-1", repair.snapshotId);
    cache.stageRoomPage(repair);
    expect(await cache.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", repair.watermark, repair.snapshotChecksum);

    cache.authorizeOfflineRead("room-1", 2_000);
    expect(cache.isOfflineReadAuthorized("room-1", 1_999)).toBe(true);
    expect(cache.isOfflineReadAuthorized("room-1", 2_000)).toBe(false);
    cache.authorizeOfflineRead("room-1", 3_000);
    cache.revokeOfflineRead("room-1");
    expect(cache.isOfflineReadAuthorized("room-1", 2_500)).toBe(false);
    cache.authorizeOfflineRead("room-1", 3_000);
    cache.clearRoom("room-1");
    expect(cache.isOfflineReadAuthorized("room-1", 2_500)).toBe(false);
  });

  it("commits only verified repair records and builds a closed actorId-fallback projection", async () => {
    const cache = createDesktopAuthorityCache(() => "2026-08-19T00:00:10.000Z");
    const repair = page();
    cache.beginRoom("room-1", repair.snapshotId);
    cache.stageRoomPage(repair);
    await expect(cache.finalizeRoom(repair.snapshotId, "wrong")).resolves.toBe(false);
    await expect(cache.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).resolves.toBe(true);
    cache.commitRoom("room-1", repair.watermark, repair.snapshotChecksum);

    expect(cache.governanceProjection("room-1")).toEqual({
      roomId: "room-1", projectId: "room-1", roomName: "Alpha", lifecycle: "active",
      governanceRevision: 7, archiveGeneration: 0, ownerActorId: "owner-1",
      members: [
        { kind: "human", actorId: "owner-1", displayName: "owner-1", role: "member" },
        { kind: "human", actorId: "member-1", displayName: "member-1", role: "member" },
      ],
    });
    expect(cache.updatedAt("room-1")).toBe("2026-08-19T00:00:10.000Z");
  });

  it("applies stable lifecycle projection events without inventing local lifecycle", async () => {
    const cache = createDesktopAuthorityCache();
    const repair = page();
    cache.beginRoom("room-1", repair.snapshotId);
    cache.stageRoomPage(repair);
    expect(await cache.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", 9, repair.snapshotChecksum);
    const archivedGovernance = {
      roomId: "room-1", projectId: "room-1", lifecycle: "archived" as const,
      governanceRevision: 8, ownerActorId: "owner-1", archiveGeneration: 1,
      archivedAt: "2026-08-19T00:01:00.000Z",
    };
    const events: readonly PersistedRoomEvent[] = [
      {
        eventId: "event-room-archived", streamKind: "room", streamId: "room-1", streamSeq: 10,
        roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-19T00:01:00.000Z",
        type: "room.archived", payload: {
          governance: archivedGovernance, archiveGeneration: 1, frozenTimerCount: 0,
        },
      },
      {
        eventId: "event-room-reopened", streamKind: "room", streamId: "room-1", streamSeq: 11,
        roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-19T00:02:00.000Z",
        type: "room.reopened",
        payload: { governance: {
          roomId: "room-1", projectId: "room-1", lifecycle: "active",
          governanceRevision: 9, ownerActorId: "owner-1", archiveGeneration: 1,
        }, archiveGeneration: 1, resumedTimerCount: 0 },
      },
    ];
    cache.installOfflineReadLease("room-1", { token: "lease-before-archive", claims: offlineClaims() });
    expect(cache.activeGenerationBinding("room-1")).toBeDefined();
    cache.applyRoomEvents("room-1", [events[0]!], { version: 1, roomId: "room-1", afterSeq: 10 });
    expect(cache.governanceProjection("room-1")).toMatchObject({
      lifecycle: "archived", governanceRevision: 8, archiveGeneration: 1,
      archivedAt: "2026-08-19T00:01:00.000Z",
    });
    expect(cache.offlineReadLease("room-1")).toBeUndefined();
    expect(cache.activeGenerationBinding("room-1")).toBeUndefined();
    cache.applyRoomEvents("room-1", [events[1]!], { version: 1, roomId: "room-1", afterSeq: 11 });
    expect(cache.governanceProjection("room-1")).toMatchObject({
      lifecycle: "active", governanceRevision: 9, archiveGeneration: 1,
    });
  });

  it("applies canonical Tool Safety stable records and publishes the repaired projection", async () => {
    const cache = createDesktopAuthorityCache();
    const repair = page();
    cache.beginRoom("room-1", repair.snapshotId);
    cache.stageRoomPage(repair);
    expect(await cache.finalizeRoom(repair.snapshotId, repair.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", 9, repair.snapshotChecksum);
    const published = vi.fn();
    cache.subscribeRoomRecords(published);
    const confirmation = { kind: "tool-confirmation", value: {
      confirmationId: "confirmation-1", toolCallId: "call-1", toolId: "sandbox-file.write",
      state: "confirmed", safePreview: JSON.stringify({ schemaVersion: "tool-safe-preview.v1",
        target: "notes/release.txt", summary: "12 bytes", impact: "write one file",
        reversibility: "compensatable" }), reasonCode: null,
      expiresAt: "2026-08-30T08:10:00.000Z", version: 2,
      namedHumanDisplayRef: "Human A", sourceRef: "message-1",
    } };
    cache.applyRoomEvents("room-1", [{
      eventId: "tool-event-10", streamKind: "room", streamId: "room-1", streamSeq: 10,
      roomId: "room-1", actorId: "tool-safety", occurredAt: "2026-08-30T08:00:00.000Z",
      type: "tool.safety.changed", payload: confirmation,
    } as unknown as PersistedRoomEvent], { version: 1, roomId: "room-1", afterSeq: 10 });
    expect(cache.roomRepairRecords("room-1")).toContainEqual(confirmation);
    expect(published).toHaveBeenCalledWith("room-1", expect.arrayContaining([confirmation]));
  });

  it("converges Room Agent Assignment repair records with stable upsert and removal events", async () => {
    const assignment = {
      recordVersion: "room-agent-assignment.v1" as const,
      assignmentId: "assignment-1", roomId: "room-1", profileId: "profile-1",
      actorId: "agent-1", displayName: "Researcher",
      globalResponsibility: "Verify evidence", roomResponsibility: "Review this Room",
      participation: "active" as const, availability: "ready" as const, paused: false,
      capabilityCeiling: ["room.respond"] as const,
      capabilitySubset: ["room.respond"] as const,
      effectiveCapabilities: ["room.respond"] as const,
      toolCeiling: ["repository.git-status"] as const,
      toolSubset: ["repository.git-status"] as const,
      effectiveTools: ["repository.git-status"] as const,
      profileRevision: 1, assignmentRevision: 1, accessRevision: 1,
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
    const repairedRecords: readonly RoomRepairRecord[] = [
      ...records, { kind: "room-agent-assignment", value: assignment },
    ];
    const checksum = authoritySnapshotChecksum("room", repairedRecords);
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "assignment-snapshot");
    cache.stageRoomPage({ ...page(), snapshotId: "assignment-snapshot", records: repairedRecords,
      snapshotChecksum: checksum });
    expect(await cache.finalizeRoom("assignment-snapshot", checksum)).toBe(true);
    cache.commitRoom("room-1", 9, checksum);
    expect(cache.roomRepairRecords("room-1")).toContainEqual({
      kind: "room-agent-assignment", value: assignment,
    });

    const paused = { ...assignment, availability: "paused" as const, paused: true,
      assignmentRevision: 2, updatedAt: "2026-08-31T00:01:00.000Z" };
    cache.applyRoomEvents("room-1", [{
      eventId: "assignment-paused", streamKind: "room", streamId: "room-1", streamSeq: 10,
      roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-31T00:01:00.000Z",
      type: "room.agent-assignment.changed",
      payload: { change: "availability-changed", roomRevision: 8, assignment: paused },
    }], { version: 1, roomId: "room-1", afterSeq: 10 });
    expect(cache.roomRepairRecords("room-1")).toContainEqual({
      kind: "room-agent-assignment", value: paused,
    });

    cache.applyRoomEvents("room-1", [{
      eventId: "assignment-removed", streamKind: "room", streamId: "room-1", streamSeq: 11,
      roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-31T00:02:00.000Z",
      type: "room.agent-assignment.changed", payload: { change: "removed", roomRevision: 9,
        assignmentId: "assignment-1", actorId: "agent-1", assignmentRevision: 3 },
    }], { version: 1, roomId: "room-1", afterSeq: 11 });
    expect(cache.roomRepairRecords("room-1")?.some((record) =>
      record.kind === "room-agent-assignment")).toBe(false);
  });

  it("invalidates the Project repair record on a stable Project event for fixed-watermark repair", async () => {
    const snapshot = projectSnapshot();
    const projectRecords: readonly RoomRepairRecord[] = [
      ...records, { kind: "project-loop", roomId: "room-1", value: snapshot },
    ];
    const checksum = authoritySnapshotChecksum("room", projectRecords);
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "project-snapshot");
    cache.stageRoomPage({ ...page(), snapshotId: "project-snapshot", records: projectRecords,
      snapshotChecksum: checksum });
    expect(await cache.finalizeRoom("project-snapshot", checksum)).toBe(true);
    cache.commitRoom("room-1", snapshot.watermark, checksum);
    expect(cache.roomRepairRecords("room-1")?.some((record) => record.kind === "project-loop")).toBe(true);
    const request = snapshot.requests[0]!;
    cache.applyRoomEvents("room-1", [{
      eventId: "project-event-8", streamKind: "room", streamId: "room-1", streamSeq: 8,
      roomId: "room-1", projectId: "room-1",
      transitionAuthority: { kind: "human", actorId: "human-2" },
      causalActor: { kind: "human", actorId: "human-2" },
      occurredAt: "2026-08-25T03:03:04.005Z", type: "project.request.changed", payload: request,
    }], { version: 1, roomId: "room-1", afterSeq: 8 });
    expect(cache.roomRepairRecords("room-1")?.some((record) => record.kind === "project-loop")).toBe(false);
  });

  it("keeps memory repair identities distinct and invalidates stale projections on minimal events", async () => {
    const memoryRecords: readonly RoomRepairRecord[] = [
      ...records,
      {
        kind: "memory", roomId: "room-1", value: { recordType: "status", status: {
          roomId: "room-1", health: {
            state: "healthy", reason: "none", memoryWatermark: 9, corpusHead: 9,
            lag: 0, lastAttemptAt: null, retryable: false, recoveryRequired: false,
          }, recoveryGeneration: 1, updatedAt: "2026-08-19T00:00:00.000Z",
        } },
      },
      {
        kind: "memory", roomId: "room-1", value: { recordType: "projection", projection: {
          projectionKind: "memory", roomId: "room-1", memoryRecordId: "memory-1",
          kind: "context", currentVersion: {
            roomId: "room-1", memoryRecordId: "memory-1", memoryVersionId: "memory-version-1",
            version: 1, kind: "context", state: "active", derivedText: "Safe derived context",
            sourceRefs: [{
              sourceKind: "message", sourceId: "message:message-1", sourceRevision: 1,
              eligibility: "eligible", availability: "readable",
            }], createdAt: "2026-08-19T00:00:00.000Z", replacesMemoryVersionId: null,
          }, disputes: [], resolutions: [],
        } },
      },
    ];
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "memory-snapshot");
    cache.stageRoomPage({
      ...page(), snapshotId: "memory-snapshot", records: memoryRecords,
      snapshotChecksum: authoritySnapshotChecksum("room", memoryRecords),
    });
    expect(await cache.finalizeRoom(
      "memory-snapshot", authoritySnapshotChecksum("room", memoryRecords),
    )).toBe(true);
    cache.commitRoom("room-1", 9, authoritySnapshotChecksum("room", memoryRecords));
    expect(cache.roomRepairRecords("room-1")?.filter((record) => record.kind === "memory"))
      .toHaveLength(2);

    const events: readonly PersistedRoomEvent[] = [{
      eventId: "memory-version-event", streamKind: "room", streamId: "room-1", streamSeq: 10,
      roomId: "room-1", actorId: "memory-service", occurredAt: "2026-08-19T00:01:00.000Z",
      type: "room.memory.version.changed", payload: {
        memoryRecordId: "memory-1", memoryVersionId: "memory-version-2", kind: "context",
        state: "disputed", sourceIds: ["message:message-1"], memoryWatermark: 9,
      },
    }, {
      eventId: "memory-health-event", streamKind: "room", streamId: "room-1", streamSeq: 11,
      roomId: "room-1", actorId: "memory-service", occurredAt: "2026-08-19T00:02:00.000Z",
      type: "room.memory.health.changed", payload: {
        roomId: "room-1", health: {
          state: "degraded", reason: "invalid_provider_output", memoryWatermark: 9,
          corpusHead: 10, lag: 1, lastAttemptAt: "2026-08-19T00:02:00.000Z",
          retryable: true, recoveryRequired: false,
        }, recoveryGeneration: 1, updatedAt: "2026-08-19T00:02:00.000Z",
      },
    }];
    cache.applyRoomEvents("room-1", events, { version: 1, roomId: "room-1", afterSeq: 11 });
    const currentMemory = cache.roomRepairRecords("room-1")
      ?.filter((record) => record.kind === "memory");
    expect(currentMemory).toHaveLength(1);
    expect(currentMemory?.[0]).toMatchObject({
      value: { recordType: "status", status: { health: { state: "degraded" } } },
    });
  });

  it("projects every canonical invocation stable event onto the same identities used by repair", async () => {
    const occurredAt = "2026-08-25T00:00:00.000Z";
    const intent = {
      intentId: "intent-1", lineageId: "lineage-1", turnId: "turn-1", roomId: "room-1",
      sourceMessageId: "message-1", sourceRevision: 1, targetId: "target-1", agentId: "agent-1",
      origin: { kind: "message_target" as const, messageTransactionId: "message-1", targetId: "target-1" },
      profileRevision: 1, assignmentRevision: 1, accessRevision: 1,
      status: "claimed" as const, createdAt: occurredAt, claimedAt: occurredAt,
    };
    const execution = {
      executionId: "execution-1", intentId: intent.intentId, lineageId: intent.lineageId,
      executionOrdinal: 1, roomId: intent.roomId, agentId: intent.agentId,
      snapshotId: "snapshot-1", providerId: "provider-1", modelId: "model-1",
      status: "running" as const, phase: "waiting_confirmation" as const,
      currentAttemptSeq: 1, version: 2, queuedAt: occurredAt, startedAt: occurredAt,
      updatedAt: occurredAt,
    };
    const attempt = {
      executionId: execution.executionId, intentId: intent.intentId, lineageId: intent.lineageId,
      roomId: intent.roomId, agentId: intent.agentId, attemptSeq: 1,
      snapshotId: execution.snapshotId, providerId: execution.providerId, modelId: execution.modelId,
      status: "running" as const, phase: "waiting_confirmation" as const,
      executionVersion: 2, startedAt: occurredAt, updatedAt: occurredAt,
    };
    const retry = {
      requestId: "retry-1", sourceExecutionId: execution.executionId,
      executionId: "execution-2", intentId: intent.intentId, lineageId: intent.lineageId,
      roomId: intent.roomId, executionOrdinal: 2, snapshotId: execution.snapshotId,
      status: "accepted" as const, createdAt: occurredAt,
    };
    const cancellation = {
      requestId: "cancel-1", fenceId: "fence-1", roomId: intent.roomId,
      lineageId: intent.lineageId,
      scope: { kind: "execution" as const, executionId: execution.executionId, expectedVersion: 2 },
      reason: "human_cancelled" as const,
      intentOutcomes: [{ intentId: intent.intentId, outcome: "already_claimed" as const }],
      executionOutcomes: [{ executionId: execution.executionId, outcome: "cancelled" as const, version: 3 }],
      rejectedConfirmationIds: ["confirmation-1"], revokedGrantIds: ["grant-1"],
      preservedDispatchIds: [], committedAt: occurredAt,
    };
    const boundary = {
      boundaryId: "boundary-1", roomId: intent.roomId, status: "suppressed" as const,
      reason: "dependency_unavailable" as const, decidedAt: occurredAt,
    };
    const cache = createDesktopAuthorityCache();
    const seed = page();
    cache.beginRoom("room-1", seed.snapshotId);
    cache.stageRoomPage(seed);
    expect(await cache.finalizeRoom(seed.snapshotId, seed.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", seed.watermark, seed.snapshotChecksum);
    const event = <T extends PersistedRoomEvent["type"]>(
      streamSeq: number,
      type: T,
      payload: Extract<PersistedRoomEvent, { readonly type: T }>["payload"],
    ): Extract<PersistedRoomEvent, { readonly type: T }> => ({
      eventId: `event-${streamSeq}`, streamKind: "room", streamId: "room-1", streamSeq,
      roomId: "room-1", actorId: type.startsWith("agent.execution") ? "agent-1" : "human-1",
      occurredAt, type, payload,
    } as Extract<PersistedRoomEvent, { readonly type: T }>);
    const events = [
      event(10, "agent.invocation.intent.changed", intent),
      event(11, "agent.execution.changed", execution),
      event(12, "agent.execution.attempt.changed", attempt),
      event(13, "agent.execution.retry.accepted", retry),
      event(14, "agent.invocation.scoped-cancellation.committed", cancellation),
      event(15, "project.boundary.invocation.decided", boundary),
    ];
    cache.applyRoomEvents("room-1", events, { version: 1, roomId: "room-1", afterSeq: 15 });

    expect(cache.roomRepairRecords("room-1")?.slice(-6)).toEqual([
      { kind: "agent-invocation-intent", value: intent },
      { kind: "agent-execution", value: execution },
      { kind: "agent-execution-attempt", value: attempt },
      { kind: "agent-execution-retry", value: retry },
      { kind: "agent-scoped-cancellation", value: cancellation },
      { kind: "project-boundary-invocation", value: boundary },
    ]);
  });

  it("reduces message, attachment, collaboration, membership and removal event families", async () => {
    const cache = createDesktopAuthorityCache();
    const seed = page();
    cache.beginRoom("room-1", seed.snapshotId);
    cache.stageRoomPage(seed);
    expect(await cache.finalizeRoom(seed.snapshotId, seed.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", seed.watermark, seed.snapshotChecksum);
    const base = {
      streamKind: "room" as const, streamId: "room-1", roomId: "room-1",
      actorId: "owner-1", occurredAt: "2026-08-31T01:00:00.000Z",
    };
    const events = [
      { ...base, eventId: "legacy-message", streamSeq: 10, type: "room.message.accepted",
        payload: { id: "legacy-message", roomId: "room-1", authorId: "owner-1",
          authorKind: "human", body: "legacy", sentAt: base.occurredAt } },
      { ...base, eventId: "timeline-message", streamSeq: 11, type: "room.message.accepted",
        payload: { id: "timeline-message", roomId: "room-1", authorId: "owner-1",
          authorKind: "human", createdAt: base.occurredAt, lifecycle: "active",
          currentRevision: { messageId: "timeline-message", revision: 1, body: "current",
            revisedAt: base.occurredAt, revisedByActorId: "owner-1" }, revisionCount: 1,
          mentionedTargets: [], attachments: [], targetOutcomes: [] } },
      { ...base, eventId: "attachment-bound", streamSeq: 12, type: "room.attachment.bound",
        payload: { attachment: { attachmentId: "attachment-1" }, sourceEligibility: "bound-active" } },
      { ...base, eventId: "read", streamSeq: 13, type: "room.human_read.recorded",
        payload: { id: "read-1", messageId: "timeline-message", readerId: "member-1",
          readAt: base.occurredAt } },
      { ...base, eventId: "judgement", streamSeq: 14, type: "room.agent_judgment.recorded",
        payload: { id: "judgement-1" } },
      { ...base, eventId: "open", streamSeq: 15, type: "room.open_item.changed",
        payload: { id: "open-1" } },
      { ...base, eventId: "open-failure", streamSeq: 16,
        type: "room.open_item.agent_attempt_failed", payload: { id: "failure-1" } },
      { ...base, eventId: "task", streamSeq: 17, type: "room.light_task.changed",
        payload: { id: "task-1" } },
      { ...base, eventId: "agent", streamSeq: 18, type: "agent.configured",
        payload: { membership: { kind: "agent", actorId: "agent-1" } } },
      { ...base, eventId: "member-remove", streamSeq: 19, type: "member.removed",
        payload: { targetActorId: "member-1" } },
      { ...base, eventId: "attachment-excluded", streamSeq: 20,
        type: "room.attachment.excluded", payload: { attachmentId: "attachment-1" } },
    ] as unknown as readonly PersistedRoomEvent[];

    cache.applyRoomEvents("room-1", events, { version: 1, roomId: "room-1", afterSeq: 20 });
    const current = cache.roomRepairRecords("room-1") ?? [];
    expect(current).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "message", value: expect.objectContaining({ id: "legacy-message" }) }),
      expect.objectContaining({ kind: "timeline-message",
        value: expect.objectContaining({ id: "timeline-message" }) }),
      expect.objectContaining({ kind: "message-revision",
        value: expect.objectContaining({ messageId: "timeline-message", revision: 1 }) }),
      expect.objectContaining({ kind: "human-read", value: expect.objectContaining({ id: "read-1" }) }),
      expect.objectContaining({ kind: "agent-judgement",
        value: expect.objectContaining({ id: "judgement-1" }) }),
      expect.objectContaining({ kind: "open-item", value: expect.objectContaining({ id: "open-1" }) }),
      expect.objectContaining({ kind: "open-item-agent-failure",
        value: expect.objectContaining({ id: "failure-1" }) }),
      expect.objectContaining({ kind: "light-task", value: expect.objectContaining({ id: "task-1" }) }),
      expect.objectContaining({ kind: "membership", value: expect.objectContaining({ actorId: "agent-1" }) }),
    ]));
    expect(current.some((record) => record.kind === "attachment")).toBe(false);
    expect(current.some((record) => record.kind === "membership" &&
      record.value.actorId === "member-1")).toBe(false);
  });

  it("upserts and invalidates legacy execution, route and calibration event families", async () => {
    const legacyExecution = { id: "legacy-execution-1" };
    const seedRecords = [
      ...records,
      { kind: "legacy-agent-execution", value: legacyExecution },
    ] as unknown as readonly RoomRepairRecord[];
    const checksum = authoritySnapshotChecksum("room", seedRecords);
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "legacy-families");
    cache.stageRoomPage({ ...page(), snapshotId: "legacy-families", records: seedRecords,
      snapshotChecksum: checksum });
    expect(await cache.finalizeRoom("legacy-families", checksum)).toBe(true);
    cache.commitRoom("room-1", 9, checksum);
    const base = {
      streamKind: "room" as const, streamId: "room-1", roomId: "room-1",
      actorId: "system", occurredAt: "2026-08-31T02:00:00.000Z",
    };
    cache.applyRoomEvents("room-1", [
      { ...base, eventId: "legacy-running", streamSeq: 10,
        type: "room.agent_execution.changed", payload: { id: "legacy-execution-2" } },
      { ...base, eventId: "legacy-terminal", streamSeq: 11,
        type: "agent.execution.completed", payload: { executionId: "legacy-execution-1" } },
      { ...base, eventId: "route", streamSeq: 12, type: "route.started",
        payload: { id: "route-1" } },
      { ...base, eventId: "route-judgement", streamSeq: 13,
        type: "room.route_judgment.recorded", payload: { id: "route-judgement-1" } },
      { ...base, eventId: "calibration", streamSeq: 14,
        type: "room.calibration.recorded", payload: { id: "calibration-1" } },
    ] as unknown as readonly PersistedRoomEvent[], {
      version: 1, roomId: "room-1", afterSeq: 14,
    });
    const current = cache.roomRepairRecords("room-1") ?? [];
    expect(current).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "legacy-agent-execution",
        value: expect.objectContaining({ id: "legacy-execution-2" }) }),
      expect.objectContaining({ kind: "route-job", value: expect.objectContaining({ id: "route-1" }) }),
      expect.objectContaining({ kind: "route-judgment",
        value: expect.objectContaining({ id: "route-judgement-1" }) }),
      expect.objectContaining({ kind: "calibration",
        value: expect.objectContaining({ id: "calibration-1" }) }),
    ]));
    expect(current.some((record) => record.kind === "legacy-agent-execution" &&
      record.value.id === "legacy-execution-1")).toBe(false);
  });

  it("removes every retained message body when a stable recall tombstone arrives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-ft13-recall-cache-"));
    const databasePath = join(directory, "authority-cache.sqlite");
    const factory = (actorId: string) => createEncryptedAuthorityGenerationStore({
      databasePath, accountId: actorId, encryption: wrapping,
    });
    try {
    const messageId = "recalled-message";
    const messageRecords = [
      ...records,
      { kind: "message", value: { id: messageId, roomId: "room-1", body: "legacy sentinel" } },
      { kind: "timeline-message", value: { id: messageId, roomId: "room-1", authorId: "owner-1",
        authorKind: "human", createdAt: "2026-08-31T01:00:00.000Z", lifecycle: "active",
        currentRevision: { messageId, revision: 2, body: "current sentinel",
          revisedAt: "2026-08-31T01:01:00.000Z", revisedByActorId: "owner-1" },
        revisionCount: 2, mentionedTargets: [], attachments: [], targetOutcomes: [] } },
      { kind: "message-revision", roomId: "room-1", value: { messageId, revision: 1,
        body: "first sentinel", revisedAt: "2026-08-31T01:00:00.000Z",
        revisedByActorId: "owner-1" } },
      { kind: "message-revision", roomId: "room-1", value: { messageId, revision: 2,
        body: "current sentinel", revisedAt: "2026-08-31T01:01:00.000Z",
        revisedByActorId: "owner-1" } },
    ] as unknown as readonly RoomRepairRecord[];
    const checksum = authoritySnapshotChecksum("room", messageRecords);
    const cache = createDesktopAuthorityCache(undefined, undefined, factory);
    await cache.restore("human-1");
    cache.beginRoom("room-1", "message-recall");
    cache.stageRoomPage({ ...page(), snapshotId: "message-recall", records: messageRecords,
      snapshotChecksum: checksum });
    expect(await cache.finalizeRoom("message-recall", checksum)).toBe(true);
    cache.commitRoom("room-1", 9, checksum);
    cache.applyRoomEvents("room-1", [{
      eventId: "recall-10", streamKind: "room", streamId: "room-1", streamSeq: 10,
      roomId: "room-1", actorId: "owner-1", occurredAt: "2026-08-31T01:02:00.000Z",
      type: "room.message.recalled", payload: { id: messageId, roomId: "room-1",
        authorId: "owner-1", authorKind: "human", createdAt: "2026-08-31T01:00:00.000Z",
        lifecycle: "recalled", recalledAt: "2026-08-31T01:02:00.000Z", revisionCount: 2 },
    }], { version: 1, roomId: "room-1", afterSeq: 10 });
    const current = cache.roomRepairRecords("room-1") ?? [];
    expect(current.filter((record) => record.kind === "message-revision" &&
      record.value.messageId === messageId)).toEqual([]);
    expect(current.some((record) => record.kind === "message" && record.value.id === messageId)).toBe(false);
    expect(current).toContainEqual(expect.objectContaining({ kind: "timeline-message",
      value: expect.objectContaining({ id: messageId, lifecycle: "recalled" }) }));
    expect(JSON.stringify(current)).not.toContain("sentinel");
    cache.close();

    const reopened = createDesktopAuthorityCache(undefined, undefined, factory);
    await expect(reopened.restore("human-1")).resolves.toBe(true);
    expect(JSON.stringify(reopened.roomRepairRecords("room-1"))).not.toContain("sentinel");
    expect(reopened.roomRepairRecords("room-1")?.some((record) =>
      record.kind === "message-revision" && record.value.messageId === messageId)).toBe(false);
    reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("invalidates legacy confirmation cards and requires canonical Tool Safety repair", async () => {
    const toolRecords = [
      ...records,
      { kind: "tool-call", value: { toolCallId: "call-1" } },
      { kind: "tool-confirmation", value: { confirmationId: "confirmation-1" } },
    ] as unknown as readonly RoomRepairRecord[];
    const checksum = authoritySnapshotChecksum("room", toolRecords);
    const cache = createDesktopAuthorityCache();
    cache.beginRoom("room-1", "tool-confirmation");
    cache.stageRoomPage({ ...page(), snapshotId: "tool-confirmation", records: toolRecords,
      snapshotChecksum: checksum });
    expect(await cache.finalizeRoom("tool-confirmation", checksum)).toBe(true);
    cache.commitRoom("room-1", 9, checksum);
    cache.applyRoomEvents("room-1", [{
      eventId: "legacy-confirmation", streamKind: "room", streamId: "room-1", streamSeq: 10,
      roomId: "room-1", actorId: "agent-1", occurredAt: "2026-08-31T02:00:00.000Z",
      type: "agent.tool.confirmation-required", payload: {},
    }] as unknown as readonly PersistedRoomEvent[], {
      version: 1, roomId: "room-1", afterSeq: 10,
    });
    expect(cache.roomRepairRecords("room-1")?.some((record) => record.kind.startsWith("tool-")))
      .toBe(false);
    expect(cache.toolSafetyRepairRequired("room-1")).toBe(true);

    cache.beginRoom("room-1", "canonical-tool-repair");
    cache.stageRoomPage({ ...page(), snapshotId: "canonical-tool-repair" });
    expect(await cache.finalizeRoom("canonical-tool-repair", page().snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", 10, page().snapshotChecksum);
    expect(cache.toolSafetyRepairRequired("room-1")).toBe(false);
  });

  it("advances explicitly classified notification-only events without mutating repair records", async () => {
    const cache = createDesktopAuthorityCache();
    const seed = page();
    cache.beginRoom("room-1", seed.snapshotId);
    cache.stageRoomPage(seed);
    expect(await cache.finalizeRoom(seed.snapshotId, seed.snapshotChecksum)).toBe(true);
    cache.commitRoom("room-1", seed.watermark, seed.snapshotChecksum);
    const before = cache.roomRepairRecords("room-1");
    const base = {
      streamKind: "room" as const, streamId: "room-1", roomId: "room-1",
      actorId: "system", occurredAt: "2026-08-31T03:00:00.000Z",
    };
    cache.applyRoomEvents("room-1", [
      { ...base, eventId: "invite", streamSeq: 10, type: "human.invitation.issued", payload: {} },
      { ...base, eventId: "reject", streamSeq: 11, type: "human.invitation.rejected", payload: {} },
      { ...base, eventId: "ball", streamSeq: 12, type: "room.ball.overdue", payload: {} },
      { ...base, eventId: "preempt", streamSeq: 13,
        type: "room.human_preemption.applied", payload: {} },
    ] as unknown as readonly PersistedRoomEvent[], {
      version: 1, roomId: "room-1", afterSeq: 13,
    });
    expect(cache.roomRepairRecords("room-1")).toEqual(before);
    expect(cache.roomCursor("room-1")?.afterSeq).toBe(13);
  });
});
