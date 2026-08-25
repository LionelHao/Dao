import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  createGovernanceWebSocketAuthority,
  parseGovernanceServerFrame,
  type GovernanceWebSocketLike,
} from "./websocket-authority.js";

const committedAt = "2026-08-25T00:00:05.000Z";
const cancellationReceipt = {
  requestId: "cancel-1", fenceId: "fence-1", roomId: "room-1", lineageId: "lineage-1",
  scope: { kind: "execution" as const, executionId: "execution-1", expectedVersion: 3 },
  reason: "human_cancelled" as const,
  intentOutcomes: [{ intentId: "intent-1", outcome: "already_claimed" as const }],
  executionOutcomes: [{ executionId: "execution-1", outcome: "cancelled" as const, version: 4 }],
  rejectedConfirmationIds: ["confirmation-1"], revokedGrantIds: ["grant-1"],
  preservedDispatchIds: [], committedAt,
};
const retryReceipt = {
  requestId: "retry-1", sourceExecutionId: "execution-1", executionId: "execution-2",
  intentId: "intent-1", lineageId: "lineage-1", roomId: "room-1", executionOrdinal: 2,
  snapshotId: "snapshot-1", status: "accepted" as const, createdAt: committedAt,
};
const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

const session = (): IdentityAuthoritySession => ({
  actorId: "human-1", sessionId: "session-1", accessToken: "main-process-token",
  expiresAt: "2026-08-25T12:00:00.000Z",
});

describe("Invocation wire ACK decoder", () => {
  it("accepts only exact canonical cancellation and retry receipts", () => {
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "invocation.cancel.ack", requestId: "cancel-1", receipt: cancellationReceipt,
    }))).toEqual({
      type: "invocation.cancel.ack", requestId: "cancel-1", receipt: cancellationReceipt,
    });
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "invocation.retry.ack", requestId: "retry-1", receipt: retryReceipt, replayed: true,
    }))).toEqual({
      type: "invocation.retry.ack", requestId: "retry-1", receipt: retryReceipt, replayed: true,
    });
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "invocation.cancel.ack", requestId: "cancel-1",
      receipt: { ...cancellationReceipt, extra: "open" },
    }))).toBeUndefined();
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "invocation.cancel.ack", requestId: "cancel-other", receipt: cancellationReceipt,
    }))).toBeUndefined();
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "invocation.retry.ack", requestId: "retry-1", execution: retryReceipt, replayed: false,
    }))).toBeUndefined();
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "invocation.retry.ack", requestId: "retry-1",
      receipt: { ...retryReceipt, status: "queued" }, replayed: false,
    }))).toBeUndefined();
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "error", requestId: "retry-rate-1", status: 429, code: "rate_limited",
      message: "bounded", retryAfterSeconds: 7,
    }))).toMatchObject({ requestId: "retry-rate-1",
      error: { code: "rate_limited", status: 429, retryAfterSeconds: 7 } });
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "error", requestId: "retry-context-1", status: 410,
      code: "context_snapshot_invalidated", message: "closed",
    }))).toMatchObject({ requestId: "retry-context-1",
      error: { code: "context_unavailable", status: 410 } });
    expect(parseGovernanceServerFrame(JSON.stringify({
      type: "error", requestId: "retry-access-1", status: 403,
      code: "permission_denied", message: "closed",
    }))).toMatchObject({ requestId: "retry-access-1",
      error: { code: "access_revoked", status: 403 } });
  });

  it("round-trips the canonical receipts over a real WebSocket", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string") throw new TypeError("Expected loopback TCP server");
    server.on("connection", (socket) => socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      const requestId = frame.requestId as string;
      if (frame.type === "auth.resume") {
        socket.send(JSON.stringify({ type: "auth.authenticated", requestId,
          accountId: "account-1", actorId: "human-1", sessionId: "session-1" }));
      } else if (frame.type === "invocation.cancel") {
        socket.send(JSON.stringify({ type: "invocation.cancel.ack", requestId,
          receipt: cancellationReceipt }));
      } else if (frame.type === "invocation.retry") {
        if (requestId === "retry-denied") {
          socket.send(JSON.stringify({ type: "error", requestId, status: 403,
            code: "permission_denied", message: "permission_denied" }));
          return;
        }
        socket.send(JSON.stringify({ type: "invocation.retry.ack", requestId,
          receipt: retryReceipt, replayed: false }));
      }
    }));
    const transport = createGovernanceWebSocketAuthority({
      endpoint: `ws://127.0.0.1:${address.port}`, session,
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as GovernanceWebSocketLike,
      timeoutMs: 2_000,
    });
    await expect(transport.controlInvocation({ type: "invocation.cancel", requestId: "cancel-1",
      executionId: "execution-1", expectedVersion: 3 })).resolves.toEqual({
      type: "invocation.cancel.ack", requestId: "cancel-1", receipt: cancellationReceipt,
    });
    await expect(transport.controlInvocation({ type: "invocation.retry", requestId: "retry-1",
      executionId: "execution-1", expectedVersion: 4 })).resolves.toEqual({
      type: "invocation.retry.ack", requestId: "retry-1", receipt: retryReceipt, replayed: false,
    });
    await expect(transport.controlInvocation({ type: "invocation.retry", requestId: "retry-denied",
      executionId: "execution-1", expectedVersion: 4 })).rejects.toMatchObject({
        code: "access_revoked", status: 403,
      });
    transport.close();
  });
});
