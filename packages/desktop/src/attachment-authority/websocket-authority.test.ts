import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  createAttachmentAuthorityWebSocketTransport,
  validateAttachmentAuthorityWebSocketEndpoint,
  type AttachmentAuthorityWebSocketLike,
} from "./websocket-authority.js";

const readyMetadata = {
  attachmentId: "attachment-1", roomId: "room-1", originalFilename: "安全报告.pdf",
  format: "pdf" as const, declaredMime: "application/pdf" as const,
  detectedMime: "application/pdf" as const, byteSize: 65_536, sha256: "a".repeat(64),
  uploaderActorId: "human-1", createdAt: "2026-08-19T08:00:00.000Z",
  readyAt: "2026-08-19T08:01:00.000Z", processingStatus: "ready" as const, generation: 2,
  sourceMessageId: null,
  provenance: {
    scanner: { kind: "clamav" as const, version: "1.4.3" },
    extraction: { method: "pdf-text" as const, tool: "pdftotext" as const,
      version: "25.06.0", artifactSha256: "b".repeat(64), artifactByteSize: 1_024, pageCount: 2 },
    ocr: null,
  },
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

describe("Attachment Authority WebSocket transport", () => {
  it("allows only credential-free loopback ws/wss endpoints", () => {
    expect(validateAttachmentAuthorityWebSocketEndpoint("ws://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/");
    expect(() => validateAttachmentAuthorityWebSocketEndpoint("wss://authority.example.test")).toThrow();
    expect(() => validateAttachmentAuthorityWebSocketEndpoint("ws://user:secret@127.0.0.1:8787")).toThrow();
  });

  it("authenticates privately and sends canonical bounded upload frames", async () => {
    const received: Record<string, unknown>[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string") throw new Error("expected TCP address");
    server.on("connection", (socket) => socket.on("message", (raw, binary) => {
      if (binary) return socket.close(1002, "text only");
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(frame);
      const requestId = frame.requestId as string;
      if (frame.type === "auth.resume") socket.send(JSON.stringify({
        type: "auth.authenticated", requestId, accountId: "account-1", actorId: "human-1", sessionId: "session-1",
      }));
      if (frame.type === "attachment.upload.begin") socket.send(JSON.stringify({
        type: "attachment.upload.begun", requestId, uploadId: "upload-1", acknowledgedBytes: 0,
      }));
      if (frame.type === "attachment.upload.chunk") socket.send(JSON.stringify({
        type: "attachment.upload.chunk.ack", requestId, uploadId: "upload-1", acknowledgedBytes: 3,
      }));
    }));
    const transport = createAttachmentAuthorityWebSocketTransport({
      endpoint: `ws://127.0.0.1:${address.port}`,
      session,
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as AttachmentAuthorityWebSocketLike,
      timeoutMs: 2_000,
    });
    const sha = createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex");
    await expect(transport.beginUpload({ requestId: "begin-1", roomId: "room-1", uploadKey: "stable-key",
      originalFilename: "report.pdf", format: "pdf", declaredMime: "application/pdf", byteSize: 3, sha256: sha,
    })).resolves.toEqual({ uploadId: "upload-1", acknowledgedBytes: 0 });
    await expect(transport.uploadChunk({ requestId: "chunk-1", uploadId: "upload-1", offset: 0,
      bytes: new Uint8Array([1, 2, 3]),
    })).resolves.toEqual({ uploadId: "upload-1", acknowledgedBytes: 3 });
    expect(received).toContainEqual({
      type: "attachment.upload.chunk", requestId: "chunk-1", uploadId: "upload-1", ordinal: 0,
      offset: 0, byteLength: 3, chunkSha256: sha, base64: "AQID",
    });
    expect(JSON.stringify(received[0])).toContain("main-only-token");
    expect(JSON.stringify(received.slice(1))).not.toContain("main-only-token");
    transport.close();
  });

  it("preserves guarded metadata from uploader-private events and every status reauthorization", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string") throw new Error("expected TCP address");
    server.on("connection", (socket) => socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      const requestId = frame.requestId as string;
      if (frame.type === "auth.resume") {
        socket.send(JSON.stringify({
          type: "auth.authenticated", requestId, accountId: "account-1",
          actorId: "human-1", sessionId: "session-1",
        }));
        socket.send(JSON.stringify({
          eventId: "private-event-1", streamKind: "principal", streamId: "human-1",
          streamSeq: 1, actorId: "human-1", occurredAt: "2026-08-19T08:01:00.000Z",
          type: "attachment.private.status-changed", payload: { attachment: readyMetadata },
        }));
      }
      if (frame.type === "attachment.status.query") {
        socket.send(JSON.stringify({
          type: "attachment.status", requestId,
          attachment: { ...readyMetadata, sourceMessageId: "message-1" },
          sourceEligibility: "bound-active", accessProjection: "archived-read-only",
        }));
      }
    }));
    const transport = createAttachmentAuthorityWebSocketTransport({
      endpoint: `ws://127.0.0.1:${address.port}`,
      session,
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as AttachmentAuthorityWebSocketLike,
      timeoutMs: 2_000,
    });
    const privateStatus = new Promise((resolve) => transport.subscribeStatus(resolve));
    const queried = await transport.getStatus({ requestId: "status-1", attachmentId: "attachment-1" });

    await expect(privateStatus).resolves.toEqual({
      type: "attachment.status", attachment: readyMetadata,
      sourceEligibility: "unbound", accessProjection: "authorized",
    });
    expect(queried).toEqual({
      type: "attachment.status",
      attachment: { ...readyMetadata, sourceMessageId: "message-1" },
      sourceEligibility: "bound-active", accessProjection: "archived-read-only",
    });
    expect(JSON.stringify(queried)).not.toMatch(/path|token|objectKey|raw|extractedText|base64/u);
    transport.close();
  });
});
