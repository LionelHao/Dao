import { describe, expect, it, vi } from "vitest";
import {
  createDesktopAgentSettingsRuntime,
  type AgentSettingsWebSocketLike,
} from "./production-runtime.js";
import {
  applyAgentSettingsAuthorityMessage,
  createAgentSettingsInitialState,
} from "../renderer/agent-settings/view-model.js";

type SocketEvent = "open" | "message" | "close" | "error";

class AuthoritySocket implements AgentSettingsWebSocketLike {
  readonly #listeners = new Map<SocketEvent, Set<(event: unknown) => void>>();
  #assignmentRepairOrdinal = 0;
  #profileSyncOrdinal = 0;
  #heldAssignmentRepair: (() => void) | undefined;

  constructor(private readonly options: Readonly<{
    assignmentRepairs: readonly (readonly Record<string, unknown>[])[];
    eventDuringSubscribe?: Record<string, unknown>;
    eventsAfterAssignmentRepair: Readonly<Record<number, Record<string, unknown>>>;
    holdAssignmentRepairOrdinal?: number;
    profileSyncRepairRequiredOnce: boolean;
  }>) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: SocketEvent, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEvent, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    const requestId = String(frame.requestId);
    const provider = { providerId: "openai-responses", modelId: "gpt-5",
      credentialReadiness: "ready" };
    let response: Record<string, unknown>;
    let afterResponse: Record<string, unknown> | undefined;
    switch (frame.type) {
      case "auth.resume":
        response = { type: "auth.authenticated", requestId };
        break;
      case "tenant-administrator.list":
        response = { type: "tenant-administrator.registry", requestId };
        break;
      case "agent-profile.list":
        response = { type: "agent-profile.catalog", requestId,
          catalogRevision: 50, profiles: [], provider };
        break;
      case "room-agent-assignment.repair":
        this.#assignmentRepairOrdinal += 1;
        response = { type: "room-agent-assignment.repair.result", requestId,
          watermark: 5, roomRevision: 12,
          assignments: this.options.assignmentRepairs[this.#assignmentRepairOrdinal - 1] ??
            this.options.assignmentRepairs.at(-1) ?? [],
          provider };
        afterResponse = this.options.eventsAfterAssignmentRepair[this.#assignmentRepairOrdinal];
        break;
      case "room.subscribe":
        response = { type: "room.subscribed", requestId, roomId: frame.roomId };
        if (this.options.eventDuringSubscribe !== undefined) {
          queueMicrotask(() => this.emit("message", {
            data: JSON.stringify(this.options.eventDuringSubscribe),
          }));
        }
        break;
      case "agent-profile.sync":
        this.#profileSyncOrdinal += 1;
        response = this.options.profileSyncRepairRequiredOnce && this.#profileSyncOrdinal === 1
          ? { type: "agent-profile.sync.result", requestId, mode: "repair_required", watermark: 50 }
          : { type: "agent-profile.sync.result", requestId, mode: "delta", events: [],
              nextCursor: 50, hasMore: false };
        break;
      case "agent-profile.repair":
        response = { type: "agent-profile.repair.result", requestId,
          watermark: 50, profiles: [], provider };
        break;
      case "room.sync":
        response = { type: "room.sync.result", requestId, mode: "delta", events: [],
          nextCursor: { version: 1, roomId: frame.roomId, afterSeq: 5 }, hasMore: false };
        break;
      default:
        throw new Error(`unexpected frame ${String(frame.type)}`);
    }
    const emitResponse = () => this.emit("message", { data: JSON.stringify(response) });
    const scheduleResponse = () => {
      queueMicrotask(emitResponse);
      if (afterResponse !== undefined) queueMicrotask(() => this.emit("message", {
        data: JSON.stringify(afterResponse),
      }));
    };
    if (frame.type === "room-agent-assignment.repair" &&
        this.#assignmentRepairOrdinal === this.options.holdAssignmentRepairOrdinal) {
      this.#heldAssignmentRepair = scheduleResponse;
    } else scheduleResponse();
  }

  close(): void {
    queueMicrotask(() => this.emit("close", {}));
  }

  authorityFrame(frame: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }

  disconnect(): void {
    this.emit("close", {});
  }

  hasHeldAssignmentRepair(): boolean {
    return this.#heldAssignmentRepair !== undefined;
  }

  profileSyncCount(): number {
    return this.#profileSyncOrdinal;
  }

  releaseHeldAssignmentRepair(): void {
    const release = this.#heldAssignmentRepair;
    this.#heldAssignmentRepair = undefined;
    if (release === undefined) throw new Error("assignment repair was not held");
    release();
  }

  private emit(type: SocketEvent, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function assignment(revision: number, paused = false): Record<string, unknown> {
  return {
    recordVersion: "room-agent-assignment.v1", assignmentId: "assignment-1", roomId: "room-1",
    profileId: "profile-1", actorId: "agent-1", displayName: "Researcher",
    globalResponsibility: "Verify evidence", roomResponsibility: "Review this Room",
    participation: "active", availability: paused ? "paused" : "ready", paused,
    capabilityCeiling: ["room.respond"], capabilitySubset: ["room.respond"],
    effectiveCapabilities: ["room.respond"], toolCeiling: ["repository.git-status"],
    toolSubset: ["repository.git-status"], effectiveTools: ["repository.git-status"],
    profileRevision: 1, assignmentRevision: revision, accessRevision: 1,
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

function assignmentEvent(input: Readonly<{
  eventId: string;
  streamSeq: number;
  revision: number;
  change?: "upserted" | "removed";
  paused?: boolean;
}>): Record<string, unknown> {
  return { type: "room.event", event: {
    eventId: input.eventId, streamKind: "room", streamId: "room-1",
    streamSeq: input.streamSeq, roomId: "room-1", actorId: "human-owner",
    occurredAt: "2026-08-25T00:00:01.000Z", type: "room.agent-assignment.changed",
    payload: input.change === "removed"
      ? { change: "removed", roomRevision: 13, assignmentId: "assignment-1",
          actorId: "agent-1", assignmentRevision: input.revision }
      : { change: "upserted", roomRevision: 13,
          assignment: assignment(input.revision, input.paused) },
  } };
}

function runtimeFixture(options: Readonly<{
  assignments?: readonly Record<string, unknown>[];
  assignmentRepairs?: readonly (readonly Record<string, unknown>[])[];
  eventDuringSubscribe?: Record<string, unknown>;
  eventsAfterAssignmentRepair?: Readonly<Record<number, Record<string, unknown>>>;
  holdAssignmentRepairOrdinal?: number;
  profileSyncRepairRequiredOnce?: boolean;
  governance?: (roomId: string) => Promise<Readonly<{ roomId: string; roomName: string;
    lifecycle: "active" | "archived"; roomRevision: number;
    roomRole: "owner" | "admin" | "member" | null }>>;
  syncIntervalMs?: number;
}> = {}) {
  let socket: AuthoritySocket | undefined;
  let ordinal = 0;
  const runtime = createDesktopAgentSettingsRuntime({
    endpoint: "ws://authority.test",
    session: () => ({ actorId: "human-owner", sessionId: "session-owner",
      accessToken: "opaque-access-token", expiresAt: "2026-08-25T12:00:00.000Z" }),
    webSocketFactory: () => {
      socket = new AuthoritySocket({
        assignmentRepairs: options.assignmentRepairs ?? [options.assignments ?? []],
        eventsAfterAssignmentRepair: options.eventsAfterAssignmentRepair ?? {},
        profileSyncRepairRequiredOnce: options.profileSyncRepairRequiredOnce ?? false,
        ...(options.eventDuringSubscribe === undefined
          ? {} : { eventDuringSubscribe: options.eventDuringSubscribe }),
        ...(options.holdAssignmentRepairOrdinal === undefined
          ? {} : { holdAssignmentRepairOrdinal: options.holdAssignmentRepairOrdinal }),
      });
      return socket;
    },
    governance: options.governance ?? (async (roomId) => ({ roomId, roomName: "Authority Room",
      lifecycle: "active", roomRevision: 12, roomRole: "owner" })),
    createRequestIdentity: () => {
      ordinal += 1;
      return { requestId: `request-${ordinal}`, idempotencyKey: `key-${ordinal}` };
    },
    timeoutMs: 1_000,
    syncIntervalMs: options.syncIntervalMs ?? 60_000,
  });
  return { runtime, socket: () => {
    if (socket === undefined) throw new Error("socket was not opened");
    return socket;
  } };
}

describe("Desktop Agent Settings production authority invalidation", () => {
  it("returns the live Assignment that arrives after repair but before subscribe completes", async () => {
    const fixture = runtimeFixture({
      assignments: [assignment(1)],
      eventDuringSubscribe: assignmentEvent({ eventId: "pause-live", streamSeq: 6,
        revision: 2, paused: true }),
    });
    let state = createAgentSettingsInitialState();
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => {
      observed.push(message);
      state = applyAgentSettingsAuthorityMessage(state, message);
    });
    const snapshot = await fixture.runtime.getSnapshot({ roomId: "room-1" });
    state = applyAgentSettingsAuthorityMessage(state, { type: "snapshot", snapshot });
    expect(observed).toEqual([expect.objectContaining({ type: "online" }),
      expect.objectContaining({ type: "stable-event", eventId: "pause-live" })]);
    expect(observed[1]).toMatchObject({ event: { kind: "assignment.upserted",
      assignment: { assignmentRevision: 2, paused: true } } });
    expect(snapshot.room.status === "available" ? snapshot.room.assignments[0] : undefined)
      .toMatchObject({ assignmentRevision: 2, paused: true });
    expect(state.snapshot?.room.status === "available"
      ? state.snapshot.room.assignments[0] : undefined).toMatchObject({
      assignmentRevision: 2, paused: true, availability: "paused",
    });
    expect(state.appliedEventIds).toEqual([]);
    fixture.runtime.close();
  });

  it("does not let an already-subscribed refresh overwrite a newer live removal", async () => {
    const fixture = runtimeFixture({
      assignmentRepairs: [[assignment(2)], [assignment(2)]],
      eventsAfterAssignmentRepair: { 2: assignmentEvent({ eventId: "remove-live",
        streamSeq: 6, revision: 3, change: "removed" }) },
    });
    let state = createAgentSettingsInitialState();
    fixture.runtime.onAuthorityMessage((message) => {
      state = applyAgentSettingsAuthorityMessage(state, message);
    });
    const initial = await fixture.runtime.getSnapshot({ roomId: "room-1" });
    state = applyAgentSettingsAuthorityMessage(state, { type: "snapshot", snapshot: initial });
    const refreshed = await fixture.runtime.getSnapshot({ roomId: "room-1" });
    state = applyAgentSettingsAuthorityMessage(state, { type: "snapshot", snapshot: refreshed });
    expect(refreshed.room.status === "available" ? refreshed.room.assignments : undefined)
      .toEqual([]);
    expect(state.snapshot?.room.status === "available" ? state.snapshot.room.assignments : undefined)
      .toEqual([]);
    expect(state.appliedEventIds).toContain("remove-live");
    fixture.runtime.close();
  });

  it("does not write repair authority back after a concurrent Room revoke", async () => {
    const governance = { roomId: "room-1", roomName: "Authority Room", lifecycle: "active" as const,
      roomRevision: 12, roomRole: "owner" as const };
    let governanceCalls = 0;
    let releaseGovernance: ((value: typeof governance) => void) | undefined;
    const heldGovernance = new Promise<typeof governance>((resolve) => {
      releaseGovernance = resolve;
    });
    const fixture = runtimeFixture({
      assignments: [assignment(1)],
      profileSyncRepairRequiredOnce: true,
      syncIntervalMs: 1,
      governance: async () => {
        governanceCalls += 1;
        return governanceCalls === 2 ? heldGovernance : governance;
      },
    });
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => observed.push(message));
    await fixture.runtime.getSnapshot({ roomId: "room-1" });
    await vi.waitFor(() => expect(observed).toContainEqual(
      expect.objectContaining({ type: "repair-started" }),
    ));
    fixture.socket().authorityFrame({ type: "identity.room-access.changed",
      eventId: "access-during-repair", actorId: "human-owner", roomId: "room-1",
      change: "removed" });
    releaseGovernance?.(governance);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const revokedIndex = observed.findIndex((message) =>
      (message as { type?: unknown }).type === "access-revoked");
    expect(revokedIndex).toBeGreaterThanOrEqual(0);
    expect(observed.slice(revokedIndex + 1)).not.toContainEqual(
      expect.objectContaining({ type: "repair-completed" }),
    );
    expect(observed.at(-1)).toEqual({ type: "access-revoked", scope: "room",
      purgeCompleted: true });
    fixture.runtime.close();
  });

  it("bounds deferred Room events during refresh and replays only the retained window", async () => {
    const fixture = runtimeFixture({ assignments: [assignment(1)],
      holdAssignmentRepairOrdinal: 2 });
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => observed.push(message));
    await fixture.runtime.getSnapshot({ roomId: "room-1" });
    const refresh = fixture.runtime.getSnapshot({ roomId: "room-1" });
    await vi.waitFor(() => expect(fixture.socket().hasHeldAssignmentRepair()).toBe(true));
    for (let ordinal = 0; ordinal < 600; ordinal += 1) {
      fixture.socket().authorityFrame(assignmentEvent({ eventId: `buffered-${ordinal}`,
        streamSeq: ordinal + 6, revision: ordinal + 2 }));
    }
    fixture.socket().releaseHeldAssignmentRepair();
    const snapshot = await refresh;
    const stableEvents = observed.filter((message) =>
      (message as { type?: unknown }).type === "stable-event");
    expect(stableEvents).toHaveLength(512);
    expect(snapshot.room.status === "available" ? snapshot.room.assignments[0] : undefined)
      .toMatchObject({ assignmentRevision: 513 });
    fixture.runtime.close();
  });

  it("serializes periodic Profile sync behind an already-subscribed snapshot refresh", async () => {
    const fixture = runtimeFixture({ assignments: [assignment(1)],
      holdAssignmentRepairOrdinal: 2, syncIntervalMs: 1 });
    await fixture.runtime.getSnapshot({ roomId: "room-1" });
    const refresh = fixture.runtime.getSnapshot({ roomId: "room-1" });
    await vi.waitFor(() => expect(fixture.socket().hasHeldAssignmentRepair()).toBe(true));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(fixture.socket().profileSyncCount()).toBe(0);
    fixture.socket().releaseHeldAssignmentRepair();
    await refresh;
    await vi.waitFor(() => expect(fixture.socket().profileSyncCount()).toBeGreaterThan(0));
    fixture.runtime.close();
  });

  it("keeps a removal tombstone when an older in-flight upsert arrives later", async () => {
    const fixture = runtimeFixture({ assignments: [assignment(1)] });
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => observed.push(message));
    await fixture.runtime.getSnapshot({ roomId: "room-1" });
    fixture.socket().authorityFrame(assignmentEvent({ eventId: "remove-3", streamSeq: 7,
      revision: 3, change: "removed" }));
    fixture.socket().authorityFrame(assignmentEvent({ eventId: "upsert-2", streamSeq: 6,
      revision: 2 }));
    expect(observed).toEqual([expect.objectContaining({ type: "online" }),
      expect.objectContaining({ type: "stable-event", eventId: "remove-3",
        event: expect.objectContaining({ kind: "assignment.removed", assignmentRevision: 3 }) })]);
    fixture.runtime.close();
  });

  it("purges its projection on the live Room access-revoked fact", async () => {
    const fixture = runtimeFixture();
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => observed.push(message));
    await fixture.runtime.getSnapshot({ roomId: "room-1" });
    fixture.socket().authorityFrame({ type: "identity.room-access.changed",
      eventId: "access-event", actorId: "human-owner", roomId: "room-1", change: "removed" });
    expect(observed.at(-1)).toEqual({ type: "access-revoked", scope: "room",
      purgeCompleted: true });
    fixture.runtime.close();
  });

  it("purges its projection when Identity invalidates the current session", async () => {
    const fixture = runtimeFixture();
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => observed.push(message));
    await fixture.runtime.getSnapshot({ roomId: "room-1" });
    fixture.runtime.invalidateAuthorizedState();
    expect(observed.at(-1)).toEqual({ type: "access-revoked", scope: "session",
      purgeCompleted: true });
    fixture.runtime.close();
  });

  it("purges its projection on the terminal session-revoked frame", async () => {
    const fixture = runtimeFixture();
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => observed.push(message));
    await fixture.runtime.getSnapshot({ roomId: "room-1" });
    fixture.socket().authorityFrame({ type: "auth.session-revoked", eventId: "session-event" });
    expect(observed.at(-1)).toEqual({ type: "access-revoked", scope: "session",
      purgeCompleted: true });
    fixture.runtime.close();
  });

  it("fails closed on disconnect instead of minting a local offline lease", async () => {
    const fixture = runtimeFixture({ assignments: [assignment(1)] });
    const observed: unknown[] = [];
    fixture.runtime.onAuthorityMessage((message) => observed.push(message));
    await fixture.runtime.getSnapshot({ roomId: "room-1" });

    fixture.socket().disconnect();

    expect(observed).not.toContainEqual(expect.objectContaining({ type: "offline" }));
    expect(observed.at(-1)).toEqual({ type: "access-revoked", scope: "session",
      purgeCompleted: true });
    fixture.runtime.close();
  });
});
