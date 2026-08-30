import type { ActiveHumanMessage, MessageAuthorityEvent } from "@native-im/core";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  MessageAuthorityTransportError,
  createMessageAuthorityWebSocketTransport,
  parseMessageAuthorityServerFrame,
  validateMessageAuthorityWebSocketEndpoint,
  type MessageAuthorityWebSocketLike,
} from "./websocket-authority.js";

const createdAt = "2026-08-19T08:00:00.000Z";
const message: ActiveHumanMessage = {
  id: "message-1",
  roomId: "room-1",
  authorId: "human-1",
  authorKind: "human",
  createdAt,
  lifecycle: "active",
  currentRevision: {
    messageId: "message-1",
    revision: 1,
    body: "Hello",
    revisedAt: createdAt,
    revisedByActorId: "human-1",
  },
  revisionCount: 1,
  mentionedTargets: [],
  attachments: [],
  targetOutcomes: [],
};
const acceptedEvent: MessageAuthorityEvent = {
  eventId: "event-message-1",
  streamKind: "room",
  streamId: "room-1",
  streamSeq: 1,
  roomId: "room-1",
  type: "room.message.accepted",
  actorId: "human-1",
  occurredAt: createdAt,
  payload: message,
};
const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

const authoritySession = (): IdentityAuthoritySession => ({
  actorId: "human-1",
  sessionId: "session-1",
  accessToken: "main-process-token",
  expiresAt: "2026-08-19T12:00:00.000Z",
});

async function listen(
  handle: (frame: Record<string, unknown>, send: (frame: unknown) => void) => void,
): Promise<{
  endpoint: string;
  received: Record<string, unknown>[];
  send(frame: unknown): void;
  closeCodes: number[];
}> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (typeof address === "string") throw new TypeError("Expected loopback TCP server");
  const received: Record<string, unknown>[] = [];
  const closeCodes: number[] = [];
  server.on("connection", (socket) => {
    socket.on("close", (code) => closeCodes.push(code));
    socket.on("message", (raw, binary) => {
      if (binary) return socket.close(1002, "text only");
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(frame);
      handle(frame, (response) => socket.send(JSON.stringify(response)));
    });
  });
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    received,
    send(frame) {
      for (const client of server.clients) client.send(JSON.stringify(frame));
    },
    closeCodes,
  };
}

describe("Message Authority WebSocket transport", () => {
  it("sends all closed FT-10 commands and accepts only the matching authority ACK", async () => {
    const authority = await listen((frame, send) => {
      if (frame.type === "auth.resume") return send({ type: "auth.authenticated",
        requestId: frame.requestId, accountId: "account-1", actorId: "human-1", sessionId: "session-1" });
      send({ type: "tool.safety.command.ack", requestId: frame.requestId, operation: frame.type,
        objectId: "object-1", version: 2, replayed: false });
    });
    const transport = createMessageAuthorityWebSocketTransport({ endpoint: authority.endpoint,
      session: authoritySession, webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike });
    const commands = [
      { type: "tool.confirmation.decide" as const, requestId: "tool-1", confirmationId: "c-1",
        expectedVersion: 1, decision: "confirm" as const },
      { type: "tool.confirmation.handoff.offer" as const, requestId: "tool-2", confirmationId: "c-1",
        expectedVersion: 1, targetActorId: "human-2" },
      { type: "tool.confirmation.handoff.accept" as const, requestId: "tool-3", handoffId: "h-1",
        expectedVersion: 1 },
      { type: "tool.outcome.review" as const, requestId: "tool-4", dispatchId: "d-1", expectedVersion: 1,
        resolution: "accepted_risk" as const, evidenceSummary: "Human inspected target." },
      { type: "tool.compensation.propose" as const, requestId: "tool-5", dispatchId: "d-1", expectedVersion: 1 },
    ];
    for (const command of commands) {
      await expect(transport.toolSafetyCommand(command)).resolves.toMatchObject({
        requestId: command.requestId, operation: command.type, version: 2, replayed: false,
      });
    }
    expect(authority.received.filter((frame) => String(frame.type).startsWith("tool."))).toEqual(commands);
    transport.close();
  });

  it("validates loopback endpoints and parses only exact closed server frames", () => {
    expect(() => validateMessageAuthorityWebSocketEndpoint("wss://authority.example.test"))
      .toThrow("endpoint is not allowed");
    expect(() => validateMessageAuthorityWebSocketEndpoint(
      "ws://user:secret@127.0.0.1:8787",
    )).toThrow("endpoint is not allowed");
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "auth.authenticated",
      requestId: "auth-1",
      accountId: "account-1",
      actorId: "human-1",
      sessionId: "session-1",
      accessToken: "must-not-cross",
    }))).toBeUndefined();
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "message.accepted",
      requestId: "send-1",
      messageId: "message-1",
      persistedAt: createdAt,
      targetOutcomes: [],
      delivered: true,
    }))).toBeUndefined();
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "room.event",
      event: acceptedEvent,
    }))).toMatchObject({ type: "room.event", event: acceptedEvent });
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "agent.execution.preview", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, streamSeq: 2, delta: "partial", authoritative: false,
    }))).toEqual({
      type: "agent.execution.preview", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, streamSeq: 2, delta: "partial", authoritative: false,
    });
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "agent.execution.preview.reset", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, reason: "human_cancelled", authoritative: false,
    }))).toEqual({
      type: "agent.execution.preview.reset", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, reason: "human_cancelled", authoritative: false,
    });
    for (const reason of [
      "execution_terminal", "attempt_rolled_over", "access_revoked",
    ] as const) {
      expect(parseMessageAuthorityServerFrame(JSON.stringify({
        type: "agent.execution.preview.reset", roomId: "room-1", executionId: "execution-1",
        attemptSeq: 1, reason, authoritative: false,
      }))).toEqual({
        type: "agent.execution.preview.reset", roomId: "room-1", executionId: "execution-1",
        attemptSeq: 1, reason, authoritative: false,
      });
    }
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "agent.execution.preview", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, streamSeq: 2, delta: "partial", authoritative: true,
    }))).toBeUndefined();
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "agent.execution.preview.reset", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, reason: "principal_revoked", authoritative: false,
    }))).toBeUndefined();
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "error", requestId: "send-archived", status: 409,
      code: "room_archived", message: "must not be parsed by the UI",
    }))).toMatchObject({
      type: "error", requestId: "send-archived",
      error: { closedError: { status: 403, code: "room_forbidden" } },
    });
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "error", requestId: "project-archived", status: 410,
      code: "room_archived", message: "archived",
    }))).toMatchObject({
      type: "error", requestId: "project-archived",
      error: { projectError: { status: 410, code: "room_archived" } },
    });
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "error", requestId: "project-invalid", status: 400,
      code: "invalid_request", message: "invalid",
    }))).toMatchObject({
      type: "error", requestId: "project-invalid",
      error: { projectError: { status: 400, code: "invalid_request" } },
    });
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "room.memory.status.v1",
      requestId: "memory-status-1",
      roomId: "room-1",
      status: { roomId: "room-1", health: { state: "healthy", reason: "none",
        memoryWatermark: 0, corpusHead: 0, lag: 0, lastAttemptAt: null,
        retryable: false, recoveryRequired: false }, recoveryGeneration: 0,
      updatedAt: createdAt },
    }))).toMatchObject({ type: "room.memory.status.v1", requestId: "memory-status-1" });
    expect(parseMessageAuthorityServerFrame(JSON.stringify({
      type: "error", requestId: "memory-1", status: 409,
      code: "memory_version_conflict", message: "Conflict", objectId: "memory-1",
      retryable: false,
    }))).toMatchObject({ type: "error", requestId: "memory-1",
      error: { memoryError: { code: "memory_version_conflict" } } });
  });

  it("dispatches every closed runtime reset without dropping the socket or Room subscription", async () => {
    const authority = await listen((frame, send) => {
      const requestId = frame.requestId as string;
      if (frame.type === "auth.resume") {
        send({ type: "auth.authenticated", requestId, accountId: "account-1",
          actorId: "human-1", sessionId: "session-1" });
      } else if (frame.type === "room.subscribe.v2") {
        send({ type: "room.sync.result", requestId, mode: "delta", events: [],
          nextCursor: { version: 1, roomId: "room-1", afterSeq: 0 },
          watermark: 0, hasMore: false });
        send({ type: "room.subscribed.v2", requestId, roomId: "room-1",
          cursor: { version: 1, roomId: "room-1", afterSeq: 0 }, watermark: 0 });
      }
    });
    const transport = createMessageAuthorityWebSocketTransport({
      endpoint: authority.endpoint,
      session: authoritySession,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
      timeoutMs: 2_000,
    });
    const resets: unknown[] = [];
    const failures: MessageAuthorityTransportError[] = [];
    const events: string[] = [];
    transport.onAgentPreview((input) => resets.push(input));
    transport.onConnectionFailure((error) => failures.push(error));
    const subscription = await transport.subscribeRoom("room-1", {
      version: 1, roomId: "room-1", afterSeq: 0,
    }, {
      async events(batch) { events.push(...batch.map(({ eventId }) => eventId)); },
      async retry() { throw new Error("not expected"); },
    });

    for (const reason of [
      "execution_terminal", "attempt_rolled_over", "access_revoked",
    ] as const) {
      authority.send({
        type: "agent.execution.preview.reset", roomId: "room-1",
        executionId: `execution-${reason}`, attemptSeq: 1, reason, authoritative: false,
      });
    }
    await vi.waitFor(() => expect(resets).toHaveLength(3));
    expect(resets.map((reset) => (reset as { reason: string }).reason)).toEqual([
      "execution_terminal", "attempt_rolled_over", "access_revoked",
    ]);

    authority.send({ type: "room.event", event: acceptedEvent });
    await vi.waitFor(() => expect(events).toEqual(["event-message-1"]));
    expect(subscription.cursor.afterSeq).toBe(1);
    expect(failures).toEqual([]);
    expect(authority.closeCodes).toEqual([]);

    authority.send({
      type: "agent.execution.preview.reset", roomId: "room-1",
      executionId: "execution-unknown", attemptSeq: 1,
      reason: "principal_revoked", authoritative: false,
    });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]).toMatchObject({ code: "protocol_error" });
    await vi.waitFor(() => expect(authority.closeCodes).toEqual([1002]));
    expect(resets).toHaveLength(3);
    transport.close();
  });

  it("authenticates once, sends the five exact operations, and delivers event-before-ACK", async () => {
    const authority = await listen((frame, send) => {
      const requestId = frame.requestId as string;
      switch (frame.type) {
        case "auth.resume":
          send({ type: "auth.authenticated", requestId, accountId: "account-1",
            actorId: "human-1", sessionId: "session-1" });
          return;
        case "room.subscribe.v2":
          send({ type: "room.sync.result", requestId, mode: "delta", events: [],
            nextCursor: { version: 1, roomId: "room-1", afterSeq: 0 },
            watermark: 0, hasMore: false });
          send({ type: "room.subscribed.v2", requestId, roomId: "room-1",
            cursor: { version: 1, roomId: "room-1", afterSeq: 0 }, watermark: 0 });
          return;
        case "room.history.v2":
          send({ type: "room.history.v2", requestId, roomId: "room-1",
            messages: [message], hasMore: false, lifecycle: "active",
            actors: [
              { actorId: "human-1", kind: "human", displayName: "Sam",
                secondaryLabel: "Owner" },
              { actorId: "agent-1", kind: "agent", displayName: "Sam",
                secondaryLabel: "On-mention Agent" },
            ] });
          return;
        case "message.revisions.query":
          send({ type: "message.revisions", requestId, roomId: "room-1",
            messageId: "message-1", revisions: [message.currentRevision], hasMore: false });
          return;
        case "message.send.v2":
          send({ type: "room.event", event: acceptedEvent });
          send({ type: "message.accepted", requestId, messageId: "message-1",
            persistedAt: createdAt, targetOutcomes: [] });
          return;
        case "message.revise":
          send({ type: "message.revision.accepted", requestId, messageId: "message-1",
            revision: 2, persistedAt: createdAt });
          return;
        case "message.recall":
          send({ type: "message.recall.accepted", requestId, messageId: "message-1",
            revision: 2, recalledAt: createdAt });
          return;
      }
    });
    const transport = createMessageAuthorityWebSocketTransport({
      endpoint: authority.endpoint,
      session: authoritySession,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
      timeoutMs: 2_000,
    });
    const order: string[] = [];
    const subscription = await transport.subscribeRoom(
      "room-1",
      { version: 1, roomId: "room-1", afterSeq: 0 },
      {
        async events(events) { order.push(...events.map(({ eventId }) => eventId)); },
        async retry() { throw new Error("not expected"); },
      },
    );
    await expect(transport.historyV2({
      type: "room.history.v2", requestId: "history-1", roomId: "room-1",
    })).resolves.toMatchObject({
      messages: [message], lifecycle: "active",
      actors: [
        { actorId: "human-1", kind: "human", displayName: "Sam", secondaryLabel: "Owner" },
        { actorId: "agent-1", kind: "agent", displayName: "Sam",
          secondaryLabel: "On-mention Agent" },
      ],
    });
    await expect(transport.revisionsQuery({
      type: "message.revisions.query", requestId: "revisions-1",
      roomId: "room-1", messageId: "message-1",
    })).resolves.toMatchObject({ revisions: [message.currentRevision] });
    await expect(transport.sendV2({
      type: "message.send.v2", requestId: "send-1",
      message: { messageId: "message-1", roomId: "room-1", body: "Hello",
        mentionedTargets: [], attachments: [] },
    })).resolves.toMatchObject({ type: "message.accepted", requestId: "send-1" });
    order.push("ack");
    expect(order).toEqual(["event-message-1", "ack"]);
    await expect(transport.revise({ type: "message.revise", requestId: "revise-1",
      roomId: "room-1", messageId: "message-1", expectedRevision: 1, body: "Revised" }))
      .resolves.toMatchObject({ type: "message.revision.accepted", revision: 2 });
    await expect(transport.recall({ type: "message.recall", requestId: "recall-1",
      roomId: "room-1", messageId: "message-1", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "message.recall.accepted", revision: 2 });

    expect(authority.received.filter(({ type }) => type === "auth.resume")).toHaveLength(1);
    expect(authority.received.filter(({ type }) => type !== "auth.resume")
      .every((frame) => !Object.hasOwn(frame, "accessToken") &&
        !Object.hasOwn(frame, "actorId") && !Object.hasOwn(frame, "idempotencyKey"))).toBe(true);
    subscription.close();
    transport.close();
  });

  it("round-trips closed Memory Authority success and error frames", async () => {
    const authority = await listen((frame, send) => {
      const requestId = frame.requestId as string;
      if (frame.type === "auth.resume") {
        send({ type: "auth.authenticated", requestId, accountId: "account-1",
          actorId: "human-1", sessionId: "session-1" });
      } else if (frame.type === "room.memory.status.query.v1") {
        send({ type: "room.memory.status.v1", requestId, roomId: "room-1",
          status: { roomId: "room-1", health: { state: "healthy", reason: "none",
            memoryWatermark: 0, corpusHead: 0, lag: 0, lastAttemptAt: null,
            retryable: false, recoveryRequired: false }, recoveryGeneration: 0,
          updatedAt: createdAt } });
      } else if (frame.type === "room.memory.context.dispute.v1") {
        send({ type: "error", requestId, status: 409, code: "memory_version_conflict",
          message: "Conflict", objectId: "memory-1", retryable: false });
      }
    });
    const transport = createMessageAuthorityWebSocketTransport({
      endpoint: authority.endpoint, session: authoritySession,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
    });
    await expect(transport.memoryRequest({ type: "room.memory.status.query.v1",
      requestId: "memory-status-1", roomId: "room-1" })).resolves.toMatchObject({
      type: "room.memory.status.v1", roomId: "room-1",
    });
    await expect(transport.memoryRequest({ type: "room.memory.context.dispute.v1",
      requestId: "memory-dispute-1", roomId: "room-1", memoryRecordId: "memory-1",
      expectedVersion: 1, reason: "Wrong context" })).resolves.toMatchObject({
      type: "error", status: 409, code: "memory_version_conflict",
    });
    transport.close();
  });

  it("bounds pending requests and makes session revoke terminal", async () => {
    let revoke: (() => void) | undefined;
    const authority = await listen((frame, send) => {
      const requestId = frame.requestId as string;
      if (frame.type === "auth.resume") {
        send({ type: "auth.authenticated", requestId, accountId: "account-1",
          actorId: "human-1", sessionId: "session-1" });
      } else if (frame.type === "room.history.v2") {
        revoke = () => send({ type: "auth.session-revoked", eventId: "revoke-1" });
      }
    });
    const transport = createMessageAuthorityWebSocketTransport({
      endpoint: authority.endpoint,
      session: authoritySession,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
      timeoutMs: 2_000,
      maxPendingRequests: 2,
    });
    const terminal = vi.fn();
    transport.onTerminalRevoked(terminal);
    const pending = transport.historyV2({
      type: "room.history.v2", requestId: "history-pending-1", roomId: "room-1",
    });
    await vi.waitFor(() => expect(revoke).toBeTypeOf("function"));
    const secondPending = transport.historyV2({
      type: "room.history.v2", requestId: "history-pending-2", roomId: "room-1",
    });
    await vi.waitFor(() => expect(authority.received.filter(
      ({ type }) => type === "room.history.v2",
    )).toHaveLength(2));
    await expect(transport.historyV2({
      type: "room.history.v2", requestId: "history-over-capacity", roomId: "room-1",
    })).rejects.toMatchObject({ code: "request_capacity_exceeded" });
    revoke!();
    await expect(pending).rejects.toMatchObject({
      name: "MessageAuthorityTransportError", code: "session_revoked",
    });
    await expect(secondPending).rejects.toMatchObject({ code: "session_revoked" });
    expect(terminal).toHaveBeenCalledOnce();
    await expect(transport.historyV2({
      type: "room.history.v2", requestId: "history-after-revoke", roomId: "room-1",
    })).rejects.toBeInstanceOf(MessageAuthorityTransportError);
    transport.close();
  });

  it("keeps the live subscription authoritative when an ACK is lost", async () => {
    const authority = await listen((frame, send) => {
      const requestId = frame.requestId as string;
      if (frame.type === "auth.resume") {
        send({ type: "auth.authenticated", requestId, accountId: "account-1",
          actorId: "human-1", sessionId: "session-1" });
      } else if (frame.type === "room.subscribe.v2") {
        send({ type: "room.sync.result", requestId, mode: "delta", events: [],
          nextCursor: { version: 1, roomId: "room-1", afterSeq: 0 },
          watermark: 0, hasMore: false });
        send({ type: "room.subscribed.v2", requestId, roomId: "room-1",
          cursor: { version: 1, roomId: "room-1", afterSeq: 0 }, watermark: 0 });
      } else if (frame.type === "message.send.v2") {
        send({ type: "room.event", event: acceptedEvent });
        // Deliberately drop the durable ACK while the stable event remains deliverable.
      }
    });
    const transport = createMessageAuthorityWebSocketTransport({
      endpoint: authority.endpoint,
      session: authoritySession,
      webSocketFactory: (endpoint) =>
        new WebSocket(endpoint) as unknown as MessageAuthorityWebSocketLike,
      timeoutMs: 50,
    });
    const events: string[] = [];
    await transport.subscribeRoom("room-1", {
      version: 1, roomId: "room-1", afterSeq: 0,
    }, {
      async events(batch) { events.push(...batch.map(({ eventId }) => eventId)); },
      async retry() { throw new Error("not expected"); },
    });
    await expect(transport.sendV2({
      type: "message.send.v2", requestId: "send-lost-ack",
      message: { messageId: "message-1", roomId: "room-1", body: "Hello",
        mentionedTargets: [], attachments: [] },
    })).rejects.toMatchObject({ code: "request_timeout" });
    expect(events).toEqual(["event-message-1"]);
    expect(authority.received.filter(({ type }) => type === "auth.resume")).toHaveLength(1);
    transport.close();
  });
});
