import { describe, expect, it } from "vitest";
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

  constructor(private readonly options: Readonly<{
    assignments: readonly Record<string, unknown>[];
    eventDuringSubscribe?: Record<string, unknown>;
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
        response = { type: "room-agent-assignment.repair.result", requestId,
          watermark: 5, roomRevision: 12, assignments: this.options.assignments, provider };
        break;
      case "room.subscribe":
        response = { type: "room.subscribed", requestId, roomId: frame.roomId };
        if (this.options.eventDuringSubscribe !== undefined) {
          queueMicrotask(() => this.emit("message", {
            data: JSON.stringify(this.options.eventDuringSubscribe),
          }));
        }
        break;
      default:
        throw new Error(`unexpected frame ${String(frame.type)}`);
    }
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(response) }));
  }

  close(): void {
    queueMicrotask(() => this.emit("close", {}));
  }

  authorityFrame(frame: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(frame) });
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
    effectiveCapabilities: ["room.respond"], toolCeiling: ["room-memory.read"],
    toolSubset: ["room-memory.read"], effectiveTools: ["room-memory.read"],
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
  eventDuringSubscribe?: Record<string, unknown>;
}> = {}) {
  let socket: AuthoritySocket | undefined;
  let ordinal = 0;
  const runtime = createDesktopAgentSettingsRuntime({
    endpoint: "ws://authority.test",
    session: () => ({ actorId: "human-owner", sessionId: "session-owner",
      accessToken: "opaque-access-token", expiresAt: "2026-08-25T12:00:00.000Z" }),
    webSocketFactory: () => {
      socket = new AuthoritySocket({ assignments: options.assignments ?? [],
        ...(options.eventDuringSubscribe === undefined
          ? {} : { eventDuringSubscribe: options.eventDuringSubscribe }) });
      return socket;
    },
    governance: async (roomId) => ({ roomId, roomName: "Authority Room",
      lifecycle: "active", roomRevision: 12, roomRole: "owner" }),
    createRequestIdentity: () => {
      ordinal += 1;
      return { requestId: `request-${ordinal}`, idempotencyKey: `key-${ordinal}` };
    },
    timeoutMs: 1_000,
    syncIntervalMs: 60_000,
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
});
