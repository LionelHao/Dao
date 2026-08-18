import { describe, expect, it, vi } from "vitest";
import {
  IdentityTransportError,
  createIdentityWebSocketClient,
  validateIdentityWebSocketEndpoint,
  type IdentityWebSocketLike,
} from "./websocket-client.js";

type SocketEvent = "open" | "message" | "close" | "error";

class FakeWebSocket implements IdentityWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly close = vi.fn(() => {
    this.readyState = 3;
  });
  private readonly listeners = new Map<SocketEvent, Set<(event: unknown) => void>>();

  addEventListener(type: SocketEvent, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEvent, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  serverSend(value: unknown): void {
    this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  networkError(): void {
    this.emit("error", {});
  }

  private emit(type: SocketEvent, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createHarness(timeoutMs = 1_000) {
  const socket = new FakeWebSocket();
  let sequence = 0;
  const client = createIdentityWebSocketClient({
    endpoint: "ws://127.0.0.1:8787/auth",
    webSocketFactory: () => socket,
    requestIdFactory: () => `request-${++sequence}`,
    timeoutMs,
  });
  return { client, socket };
}

function requestAt(socket: FakeWebSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "null") as Record<string, unknown>;
}

const session = (id: string) => ({
  id,
  deviceLabel: id,
  platform: "macos",
  createdAt: "2026-08-18T00:00:00.000Z",
  refreshExpiresAt: "2026-09-18T00:00:00.000Z",
  current: true,
});

describe("Identity WebSocket endpoint policy", () => {
  it.each([
    "ws://localhost:8787",
    "ws://127.0.0.1:8787",
    "ws://127.255.10.2:8787",
    "ws://[::1]:8787",
    "wss://identity.example.test/socket",
  ])("accepts secure or loopback endpoint %s", (endpoint) => {
    expect(validateIdentityWebSocketEndpoint(endpoint)).toBe(new URL(endpoint).toString());
  });

  it.each([
    "ws://identity.example.test/socket",
    "http://127.0.0.1:8787",
    "file:///tmp/socket",
    "wss://user:password@identity.example.test/socket",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() => validateIdentityWebSocketEndpoint(endpoint)).toThrowError(/WebSocket endpoint/i);
  });
});

describe("strict Identity WebSocket client", () => {
  it("correlates out-of-order responses by requestId", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;

    const first = client.listSessions();
    const second = client.listSessions();
    const firstRequest = requestAt(socket, 0);
    const secondRequest = requestAt(socket, 1);

    socket.serverSend({
      type: "auth.sessions",
      requestId: secondRequest.requestId,
      sessions: [session("second")],
    });
    socket.serverSend({
      type: "auth.sessions",
      requestId: firstRequest.requestId,
      sessions: [session("first")],
    });

    await expect(first).resolves.toEqual([expect.objectContaining({ id: "first" })]);
    await expect(second).resolves.toEqual([expect.objectContaining({ id: "second" })]);
    client.close();
  });

  it("sends the closed login device frame and requires a complete issued credential response", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;

    const result = client.login({ accountId: "human", secret: "canary-password" }, {
      id: "installation-1",
      label: "MacBook",
      platform: "macos",
    });
    const request = requestAt(socket, 0);
    expect(request).toEqual({
      type: "auth.login",
      requestId: "request-1",
      accountId: "human",
      secret: "canary-password",
      device: { id: "installation-1", label: "MacBook", platform: "macos" },
    });

    socket.serverSend({
      type: "auth.authenticated",
      requestId: request.requestId,
      accountId: "human",
      actorId: "human-1",
      sessionId: "public-session-1",
      accessToken: "access-canary",
      refreshToken: "refresh-canary",
      expiresAt: "2026-08-18T00:15:00.000Z",
      refreshExpiresAt: "2026-09-18T00:00:00.000Z",
    });
    await expect(result).resolves.toMatchObject({
      accountId: "human",
      actorId: "human-1",
      sessionId: "public-session-1",
    });
    client.close();
  });

  it("rejects malformed and extra server fields with a sanitized protocol failure", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.listSessions();
    const request = requestAt(socket, 0);

    socket.serverSend({
      type: "auth.sessions",
      requestId: request.requestId,
      sessions: [],
      accessToken: "credential-canary-must-not-echo",
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toContain("credential-canary-must-not-echo");
    });
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("strictly consumes an unsolicited room-access change without disturbing pending auth work", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.listSessions();
    const request = requestAt(socket, 0);

    socket.serverSend({
      eventId: "identity-event-access-1",
      streamKind: "identity",
      streamId: "human-1",
      streamSeq: 4,
      actorId: "human-1",
      occurredAt: "2026-08-18T00:00:01.000Z",
      type: "identity.room-access.changed",
      payload: { roomId: "room-1", change: "removed" },
    });
    expect(socket.close).not.toHaveBeenCalled();

    socket.serverSend({
      type: "auth.sessions",
      requestId: request.requestId,
      sessions: [session("current")],
    });
    await expect(pending).resolves.toEqual([expect.objectContaining({ id: "current" })]);
    client.close();
  });

  it("fails closed for a malformed room-access change", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.listSessions();

    socket.serverSend({
      eventId: "identity-event-access-1",
      streamKind: "identity",
      streamId: "human-1",
      streamSeq: 4,
      actorId: "human-1",
      occurredAt: "2026-08-18T00:00:01.000Z",
      type: "identity.room-access.changed",
      payload: { roomId: "room-1", change: "removed", refreshToken: "must-not-pass" },
    });

    await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("rejects oversized server frames without including their payload", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.listSessions();
    socket.serverSend("credential-canary".repeat(5_000));

    await expect(pending).rejects.toMatchObject({ code: "protocol_error" });
    await pending.catch((error: unknown) => {
      expect(String(error)).not.toContain("credential-canary");
    });
  });

  it("times out pending requests finitely and releases them", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = createHarness(50);
      const connected = client.connect();
      socket.open();
      await connected;
      const pending = client.listSessions();
      const timedOut = expect(pending).rejects.toMatchObject({ code: "request_timeout" });
      await vi.advanceTimersByTimeAsync(51);
      await timedOut;
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats terminal revocation as terminal, preempts all work, and reports it once", async () => {
    const { client, socket } = createHarness();
    const terminal = vi.fn();
    client.onTerminalRevoked(terminal);
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.listSessions();

    socket.serverSend({ type: "auth.session-revoked", eventId: "event-1" });
    socket.serverClose();

    await expect(pending).rejects.toMatchObject({ code: "session_revoked" });
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal).toHaveBeenCalledWith("event-1");
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("closes an in-flight connection attempt finitely", async () => {
    const { client } = createHarness();
    const connected = client.connect();
    const settled = vi.fn();
    void connected.then(settled, settled);

    client.close();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(settled).toHaveBeenCalledOnce();
    await expect(connected).rejects.toMatchObject({ code: "client_closed" });
  });

  it("makes a socket error terminal for pending and later requests", async () => {
    const { client, socket } = createHarness();
    const connectionFailure = vi.fn();
    client.onConnectionFailure(connectionFailure);
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.listSessions();

    socket.networkError();

    await expect(pending).rejects.toMatchObject({ code: "connection_unavailable" });
    await expect(client.listSessions()).rejects.toMatchObject({ code: "client_closed" });
    expect(connectionFailure).toHaveBeenCalledOnce();
    expect(connectionFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "connection_unavailable",
    }));
    expect(socket.close).toHaveBeenCalledOnce();
    client.close();
  });

  it("turns correlated server errors into typed sanitized failures", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.resume("expired-access-token");
    const request = requestAt(socket, 0);
    socket.serverSend({
      type: "error",
      requestId: request.requestId,
      status: 401,
      code: "token_expired",
      message: "raw server detail must not be public",
    });

    await expect(pending).rejects.toEqual(expect.objectContaining({
      name: "IdentityTransportError",
      code: "token_expired",
      status: 401,
    }));
    await pending.catch((error: unknown) => {
      expect(error).toBeInstanceOf(IdentityTransportError);
      expect(String(error)).not.toContain("raw server detail");
      expect(String(error)).not.toContain("expired-access-token");
    });
    client.close();
  });

  it("accepts the closed session-limit error instead of treating it as a protocol violation", async () => {
    const { client, socket } = createHarness();
    const connected = client.connect();
    socket.open();
    await connected;
    const pending = client.login({ accountId: "human", secret: "correct-password" }, {
      id: "installation-1",
      label: "MacBook",
      platform: "macos",
    });
    const request = requestAt(socket, 0);

    socket.serverSend({
      type: "error",
      requestId: request.requestId,
      status: 409,
      code: "session_limit_reached",
      message: "raw authority detail",
    });

    await expect(pending).rejects.toMatchObject({ code: "session_limit_reached", status: 409 });
    expect(socket.close).not.toHaveBeenCalled();
    client.close();
  });
});
