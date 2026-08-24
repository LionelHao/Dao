import { describe, expect, it } from "vitest";
import {
  createDesktopAgentSettingsRuntime,
  type AgentSettingsWebSocketLike,
} from "./production-runtime.js";

type SocketEvent = "open" | "message" | "close" | "error";

class AuthoritySocket implements AgentSettingsWebSocketLike {
  readonly #listeners = new Map<SocketEvent, Set<(event: unknown) => void>>();

  constructor() {
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
          watermark: 5, roomRevision: 12, assignments: [], provider };
        break;
      case "room.subscribe":
        response = { type: "room.subscribed", requestId, roomId: frame.roomId };
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

function runtimeFixture() {
  let socket: AuthoritySocket | undefined;
  let ordinal = 0;
  const runtime = createDesktopAgentSettingsRuntime({
    endpoint: "ws://authority.test",
    session: () => ({ actorId: "human-owner", sessionId: "session-owner",
      accessToken: "opaque-access-token", expiresAt: "2026-08-25T12:00:00.000Z" }),
    webSocketFactory: () => {
      socket = new AuthoritySocket();
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
