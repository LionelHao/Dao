import type { ActiveHumanMessage, MessageAuthorityEvent } from "@native-im/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IdentityAuthoritySession } from "../identity/controller.js";
import { createDesktopMessageAuthorityRuntime } from "./production-runtime.js";
import type { MessageAuthorityWebSocketLike } from "./websocket-authority.js";

const now = "2026-08-19T08:00:00.000Z";
const message: ActiveHumanMessage = {
  id: "message-existing", roomId: "room-1", authorId: "human-1", authorKind: "human",
  createdAt: now, lifecycle: "active",
  currentRevision: { messageId: "message-existing", revision: 1, body: "Existing",
    revisedAt: now, revisedByActorId: "human-1" },
  revisionCount: 1, mentionedTargets: [], attachments: [], targetOutcomes: [],
};
const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

const session = (): IdentityAuthoritySession => ({
  actorId: "human-1", sessionId: "session-1", accessToken: "main-only-token",
  expiresAt: "2026-08-19T12:00:00.000Z",
});

async function runtimeServer(): Promise<{
  endpoint: string;
  send(frame: unknown): void;
  disconnect(): void;
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string") throw new TypeError("Expected loopback TCP server");
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    const requestId = frame.requestId as string;
    const send = (value: unknown): void => socket.send(JSON.stringify(value));
    if (frame.type === "auth.resume") {
      send({ type: "auth.authenticated", requestId, accountId: "account-1",
        actorId: "human-1", sessionId: "session-1" });
    } else if (frame.type === "room.subscribe.v2") {
      send({ type: "room.sync.result", requestId, mode: "delta", events: [],
        nextCursor: { version: 1, roomId: "room-1", afterSeq: 0 },
        watermark: 0, hasMore: false });
      send({ type: "room.subscribed.v2", requestId, roomId: "room-1",
        cursor: { version: 1, roomId: "room-1", afterSeq: 0 }, watermark: 0 });
    } else if (frame.type === "room.history.v2") {
      send({ type: "room.history.v2", requestId, roomId: "room-1",
        messages: [message], hasMore: false });
    } else if (frame.type === "message.send.v2") {
      const submitted = frame.message as { messageId: string; body: string };
      const accepted: ActiveHumanMessage = {
        ...message,
        id: submitted.messageId,
        currentRevision: { ...message.currentRevision,
          messageId: submitted.messageId, body: submitted.body },
      };
      const event: MessageAuthorityEvent = { eventId: `event-${submitted.messageId}`,
        streamKind: "room", streamId: "room-1", streamSeq: 1, roomId: "room-1",
        type: "room.message.accepted", actorId: "human-1", occurredAt: now,
        payload: accepted };
      send({ type: "room.event", event });
      setTimeout(() => send({ type: "message.accepted", requestId,
        messageId: submitted.messageId, persistedAt: now, targetOutcomes: [] }), 20);
    }
  }));
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    send(frame) {
      for (const client of server.clients) client.send(JSON.stringify(frame));
    },
    disconnect() { for (const client of server.clients) client.terminate(); },
  };
}

describe("production Desktop Message Authority runtime", () => {
  it("is the production main-process port and participates in Identity invalidation", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../main.ts"), "utf8");
    expect(source).toContain("createDesktopMessageAuthorityRuntime");
    expect(source).toContain("messageAuthorityRuntime?.invalidateAuthorizedState()");
    expect(source).toContain("client: messageAuthorityRuntime.client");
    expect(source).not.toContain("createUnavailableMessageAuthorityClientPort");
  });

  it("enriches real history from Identity and converges event-before-ACK", async () => {
    const server = await runtimeServer();
    const runtime = createDesktopMessageAuthorityRuntime({
      endpoint: server.endpoint,
      session,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
      timeoutMs: 2_000,
      now: () => now,
    });
    const inputs: unknown[] = [];
    runtime.client.subscribe((input) => inputs.push(input));
    await expect(runtime.client.historyV2({
      type: "room.history.v2", requestId: "history-1", roomId: "room-1",
    })).resolves.toMatchObject({
      type: "room.history.v2", status: "ready", viewerActorId: "human-1",
      lifecycle: "active", actors: [], generation: 1, watermark: 0,
      messages: [message],
    });
    const pending = runtime.client.sendV2({
      type: "message.send.v2", requestId: "send-1",
      message: { messageId: "message-new", roomId: "room-1", body: "New",
        mentionedTargets: [], attachments: [] },
    });
    await vi.waitFor(() => expect(inputs).toContainEqual(expect.objectContaining({
      type: "room.event", cursorBefore: 0, generation: 1,
      event: expect.objectContaining({ eventId: "event-message-new" }),
    })));
    await expect(pending).resolves.toMatchObject({ requestId: "send-1" });
    runtime.close();
  });

  it("advances mixed Room cursors and publishes offline/revoked terminal states", async () => {
    const server = await runtimeServer();
    const runtime = createDesktopMessageAuthorityRuntime({
      endpoint: server.endpoint,
      session,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
      timeoutMs: 2_000,
      now: () => now,
    });
    const inputs: unknown[] = [];
    runtime.client.subscribe((input) => inputs.push(input));
    await runtime.client.historyV2({
      type: "room.history.v2", requestId: "history-1", roomId: "room-1",
    });

    server.send({ type: "room.event", event: {
      eventId: "room-renamed-1", streamKind: "room", streamId: "room-1", streamSeq: 1,
      roomId: "room-1", actorId: "human-1", occurredAt: now, type: "room.renamed",
      payload: { room: { id: "room-1", name: "Renamed", status: "active", createdAt: now,
        members: [] } },
    } });
    await vi.waitFor(() => expect(inputs).toContainEqual({
      type: "room.cursor.advanced", roomId: "room-1", cursorBefore: 0, generation: 1,
      eventId: "room-renamed-1", streamSeq: 1,
    }));
    server.send({ type: "room.event", event: {
      eventId: "message-after-rename-2", streamKind: "room", streamId: "room-1",
      streamSeq: 2, roomId: "room-1", actorId: "human-1", occurredAt: now,
      type: "room.message.accepted", payload: {
        ...message,
        id: "message-after-rename",
        currentRevision: {
          ...message.currentRevision,
          messageId: "message-after-rename",
          body: "After rename",
        },
      },
    } });
    await vi.waitFor(() => expect(inputs).toContainEqual(expect.objectContaining({
      type: "room.event", cursorBefore: 1, generation: 1,
      event: expect.objectContaining({ eventId: "message-after-rename-2", streamSeq: 2 }),
    })));

    server.send({ type: "auth.session-revoked", eventId: "session-revoked-1" });
    await vi.waitFor(() => expect(inputs).toContainEqual({
      type: "message.connection", roomId: "room-1",
      connection: { status: "revoked", scope: "session", purgeCompleted: true },
    }));
    runtime.close();

    const offlineServer = await runtimeServer();
    const offlineRuntime = createDesktopMessageAuthorityRuntime({
      endpoint: offlineServer.endpoint, session,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
      timeoutMs: 2_000, now: () => now,
    });
    const offlineInputs: unknown[] = [];
    offlineRuntime.client.subscribe((input) => offlineInputs.push(input));
    await offlineRuntime.client.historyV2({
      type: "room.history.v2", requestId: "history-offline", roomId: "room-1",
    });
    offlineServer.disconnect();
    await vi.waitFor(() => expect(offlineInputs).toContainEqual({
      type: "message.connection", roomId: "room-1",
      connection: { status: "offline", asOf: now },
    }));
    offlineRuntime.close();
  });
});
