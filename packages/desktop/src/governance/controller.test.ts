import type { RoomGovernanceView } from "@native-im/core";
import { describe, expect, it, vi } from "vitest";
import {
  GovernanceAuthorityFailure,
  createGovernanceController,
  type GovernanceAuthorityAdapter,
  type GovernanceReplicaApplication,
  type GovernanceReplicaFeed,
} from "./controller.js";
import type {
  GovernanceAuthorityAck,
  GovernanceAuthoritySnapshot,
  GovernanceMutationRequest,
} from "./contracts.js";

const projection = {
  roomId: "room-1", projectId: "room-1", roomName: "Alpha", lifecycle: "active",
  governanceRevision: 7, archiveGeneration: 0, ownerActorId: "owner-1",
  members: [
    { kind: "human", actorId: "owner-1", displayName: "Owner", role: "member" },
    { kind: "human", actorId: "member-1", displayName: "Member", role: "member" },
  ],
} as const;

const snapshot: GovernanceAuthoritySnapshot = {
  status: "ready",
  projection,
  viewerActorId: "owner-1",
  connection: { status: "online" },
};

class Feed implements GovernanceReplicaFeed {
  listener: ((application: GovernanceReplicaApplication) => void) | undefined;
  subscribe(listener: (application: GovernanceReplicaApplication) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
}

function adapter() {
  let resolveAck!: (ack: GovernanceAuthorityAck) => void;
  const ack = new Promise<GovernanceAuthorityAck>((resolve) => { resolveAck = resolve; });
  const value: GovernanceAuthorityAdapter = {
    querySurface: vi.fn(async () => snapshot),
    queryDepartureConflicts: vi.fn(async () => ({
      roomId: "room-1", targetActorId: "member-1", governanceRevision: 7, conflicts: [],
    })),
    execute: vi.fn(() => ack),
  };
  return { value, resolveAck };
}

describe("closed Governance controller", () => {
  it("requires matching ACK eventIds plus applied stable projection before success", async () => {
    const authority = adapter();
    const feed = new Feed();
    const states: unknown[] = [];
    const controller = createGovernanceController({
      authority: authority.value,
      replica: feed,
      createRequestIdentity: () => ({ requestId: "request-1", idempotencyKey: "internal-key-1" }),
    });
    controller.subscribe((state) => states.push(state));
    await controller.getSurface({ roomId: "room-1" });
    const submitting = controller.submit({
      roomId: "room-1",
      intent: { command: "room.archive", expectedGovernanceRevision: 7 },
    });
    expect(submitting.state.status).toBe("ready");
    expect(submitting.state.status === "ready" && submitting.state.operation.status).toBe("submitting");
    expect(authority.value.execute).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-1", idempotencyKey: "internal-key-1",
    }));
    expect(JSON.stringify(submitting)).not.toContain("internal-key-1");

    const archived = {
      ...projection,
      lifecycle: "archived" as const,
      governanceRevision: 8,
      archiveGeneration: 1,
      archivedAt: "2026-08-19T08:00:00.000Z",
    };
    authority.resolveAck({
      type: "ack", requestId: "request-1", command: "room.archive", result: "accepted",
      eventIds: ["event-archive"], projection: archived, replayed: false,
    });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({
      state: { operation: { status: "acknowledged" }, projection: { lifecycle: "active" } },
    }));

    const governance: RoomGovernanceView = {
      roomId: "room-1", projectId: "room-1", lifecycle: "archived",
      governanceRevision: 8, archiveGeneration: 1, ownerActorId: "owner-1",
      archivedAt: "2026-08-19T08:00:00.000Z",
    };
    feed.listener?.({ roomId: "room-1", source: "events", eventIds: ["event-other"], governance });
    expect(states.at(-1)).toMatchObject({ state: { operation: { status: "acknowledged" } } });
    feed.listener?.({ roomId: "room-1", source: "events", eventIds: ["event-archive"], governance });
    expect(states.at(-1)).toMatchObject({
      state: { operation: { status: "succeeded" }, projection: { lifecycle: "archived" } },
    });
    controller.close();
  });

  it("repairs a replayed ACK and succeeds only from the matching authoritative projection", async () => {
    const feed = new Feed();
    let resolveAck!: (ack: GovernanceAuthorityAck) => void;
    const archived = {
      ...projection, lifecycle: "archived" as const, governanceRevision: 8, archiveGeneration: 1,
      archivedAt: "2026-08-19T08:00:00.000Z",
    };
    const authority: GovernanceAuthorityAdapter = {
      querySurface: vi.fn()
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValue({ ...snapshot, projection: archived }),
      queryDepartureConflicts: vi.fn(),
      execute: vi.fn(() => new Promise<GovernanceAuthorityAck>((resolve) => { resolveAck = resolve; })),
    };
    const controller = createGovernanceController({
      authority, replica: feed,
      createRequestIdentity: () => ({ requestId: "request-replay", idempotencyKey: "key-replay" }),
    });
    await controller.getSurface({ roomId: "room-1" });
    controller.submit({ roomId: "room-1", intent: {
      command: "room.archive", expectedGovernanceRevision: 7,
    } });
    resolveAck({
      type: "ack", requestId: "request-replay", command: "room.archive", result: "accepted",
      eventIds: ["historical-room-event"], projection: archived, replayed: true,
    });
    await vi.waitFor(() => expect(controller.current("room-1")).toMatchObject({
      projection: { lifecycle: "archived", governanceRevision: 8 },
      operation: { status: "succeeded", requestId: "request-replay" },
    }));
    expect(authority.querySurface).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it("accepts a matching atomic repair when lifecycle preemption prevents live ACK events", async () => {
    const authority = adapter();
    const feed = new Feed();
    const controller = createGovernanceController({
      authority: authority.value,
      replica: feed,
      createRequestIdentity: () => ({ requestId: "request-repair", idempotencyKey: "key-repair" }),
    });
    await controller.getSurface({ roomId: "room-1" });
    controller.submit({ roomId: "room-1", intent: {
      command: "room.archive", expectedGovernanceRevision: 7,
    } });
    const archived = {
      ...projection, lifecycle: "archived" as const, governanceRevision: 8, archiveGeneration: 1,
      archivedAt: "2026-08-19T08:00:00.000Z",
    };
    authority.resolveAck({
      type: "ack", requestId: "request-repair", command: "room.archive", result: "accepted",
      eventIds: ["preempted-room-event"], projection: archived, replayed: false,
    });
    await vi.waitFor(() => expect(controller.current("room-1")).toMatchObject({
      operation: { status: "acknowledged" }, projection: { lifecycle: "active" },
    }));

    feed.listener?.({
      source: "repair", roomId: "room-1", eventIds: [],
      governance: {
        roomId: "room-1", projectId: "room-1", lifecycle: "archived",
        governanceRevision: 8, archiveGeneration: 1, ownerActorId: "owner-1",
        archivedAt: "2026-08-19T08:00:00.000Z",
      },
    });
    expect(controller.current("room-1")).toMatchObject({
      operation: { status: "succeeded" }, projection: { lifecycle: "archived" },
    });
    controller.close();
  });

  it("converges when the stable repair projection arrives before its ACK", async () => {
    const authority = adapter();
    const feed = new Feed();
    const controller = createGovernanceController({
      authority: authority.value,
      replica: feed,
      createRequestIdentity: () => ({ requestId: "request-race", idempotencyKey: "key-race" }),
    });
    await controller.getSurface({ roomId: "room-1" });
    controller.submit({ roomId: "room-1", intent: {
      command: "room.archive", expectedGovernanceRevision: 7,
    } });
    const governance: RoomGovernanceView = {
      roomId: "room-1", projectId: "room-1", lifecycle: "archived",
      governanceRevision: 8, archiveGeneration: 1, ownerActorId: "owner-1",
      archivedAt: "2026-08-19T08:00:00.000Z",
    };
    feed.listener?.({ source: "repair", roomId: "room-1", eventIds: [], governance });
    authority.resolveAck({
      type: "ack", requestId: "request-race", command: "room.archive", result: "accepted",
      eventIds: ["event-race"], replayed: false,
      projection: {
        ...projection, lifecycle: "archived", governanceRevision: 8, archiveGeneration: 1,
        archivedAt: "2026-08-19T08:00:00.000Z",
      },
    });
    await vi.waitFor(() => expect(controller.current("room-1")).toMatchObject({
      operation: { status: "succeeded", requestId: "request-race" },
      projection: { lifecycle: "archived", governanceRevision: 8 },
    }));
    controller.close();
  });

  it("replaces final departure conflicts and refreshes stale revision without claiming success", async () => {
    const feed = new Feed();
    const finalConflicts = {
      roomId: "room-1", targetActorId: "member-1", governanceRevision: 8,
      conflicts: [{
        conflictId: "conflict-final", roomId: "room-1", subjectId: "request-1",
        kind: "request" as const, summary: "Still owned", state: "accepted",
        sourceRef: "request-1", revision: 2, allowedResolutions: ["transfer" as const],
      }],
    };
    const authority: GovernanceAuthorityAdapter = {
      querySurface: vi.fn()
        .mockResolvedValueOnce(snapshot)
        .mockResolvedValue({
          ...snapshot,
          projection: { ...projection, governanceRevision: 8 },
        }),
      queryDepartureConflicts: vi.fn(async () => finalConflicts),
      execute: vi.fn(async (input) => {
        throw input.intent.command === "room.member.remove"
          ? new GovernanceAuthorityFailure({ status: 409, code: "departure_blocked", details: finalConflicts })
          : new GovernanceAuthorityFailure({ status: 409, code: "room_revision_conflict" });
      }),
    };
    let sequence = 0;
    const controller = createGovernanceController({
      authority, replica: feed,
      createRequestIdentity: () => ({ requestId: `request-${++sequence}`, idempotencyKey: `key-${sequence}` }),
    });
    await controller.getSurface({ roomId: "room-1" });
    controller.submit({
      roomId: "room-1",
      intent: { command: "room.member.remove", targetActorId: "member-1", expectedGovernanceRevision: 7 },
    });
    await vi.waitFor(() => expect(controller.current("room-1")).toMatchObject({
      operation: { status: "failed", error: { code: "departure_blocked" } },
      departureConflicts: finalConflicts,
    }));

    controller.submit({
      roomId: "room-1",
      intent: { command: "room.reopen", expectedGovernanceRevision: 7 },
    } as GovernanceMutationRequest);
    await vi.waitFor(() => expect(controller.current("room-1")).toMatchObject({
      operation: { status: "failed", error: { code: "room_revision_conflict" } },
      projection: { governanceRevision: 8 },
    }));
  });

  it("fails offline mutations before the authority adapter and redacts revoked state", async () => {
    const feed = new Feed();
    const authority = adapter();
    authority.value.querySurface = vi.fn(async () => ({
      ...snapshot,
      connection: { status: "offline", asOf: "2026-08-19T08:00:00.000Z", leaseExpiresAt: "2026-08-19T14:00:00.000Z" },
    }));
    const controller = createGovernanceController({
      authority: authority.value, replica: feed,
      createRequestIdentity: () => ({ requestId: "request-offline", idempotencyKey: "key-offline" }),
    });
    await controller.getSurface({ roomId: "room-1" });
    const result = controller.submit({
      roomId: "room-1", intent: { command: "room.archive", expectedGovernanceRevision: 7 },
    });
    expect(result.state).toMatchObject({ operation: { status: "failed", error: { status: 503 } } });
    expect(authority.value.execute).not.toHaveBeenCalled();

    feed.listener?.({ roomId: "room-1", source: "revoked", eventIds: [], scope: "room", purgeCompleted: true });
    expect(controller.current("room-1")).toEqual({
      status: "locked", roomId: "room-1",
      connection: { status: "revoked", scope: "room", purgeCompleted: true },
    });
    expect(JSON.stringify(controller.current("room-1"))).not.toContain("Alpha");
  });
});
