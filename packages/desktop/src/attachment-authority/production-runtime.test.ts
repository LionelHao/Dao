import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopAttachmentAuthorityRuntime } from "./production-runtime.js";
import type { AttachmentAuthorityWebSocketLike } from "./websocket-authority.js";

const servers: WebSocketServer[] = [];
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production Attachment Authority composition", () => {
  it("requires real native/websocket ports and has no ready/no-op/unavailable success path", () => {
    const source = readFileSync(resolve(import.meta.dirname, "production-runtime.ts"), "utf8");
    expect(source).toContain("createAttachmentAuthorityWebSocketTransport");
    expect(source).toContain("createNativeSelectionRegistry");
    expect(source).toContain("createPreviewDownloadService");
    expect(source).toContain("registerAttachmentAuthorityIpc");
    expect(source).toContain("NODE_NATIVE_FILE_SYSTEM");
    expect(source).not.toMatch(/NOOP|fake|alwaysSafe|ready:\s*true|createUnavailable/iu);
  });

  it("smokes real no-follow reads, loopback authority ACKs, sandbox reads, and atomic native save", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dao-attachment-runtime-"));
    temporaryDirectories.push(directory);
    const selectedPath = join(directory, "report.pdf");
    const savedPath = join(directory, "saved.pdf");
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFile(selectedPath, bytes);
    const received: Record<string, unknown>[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
    const address = server.address();
    if (typeof address === "string") throw new Error("expected TCP address");
    server.on("connection", (socket) => socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(frame);
      const requestId = frame.requestId as string;
      const send = (value: unknown) => socket.send(JSON.stringify(value));
      if (frame.type === "auth.resume") send({ type: "auth.authenticated", requestId,
        accountId: "account-1", actorId: "human-1", sessionId: "session-1" });
      if (frame.type === "attachment.upload.begin") send({ type: "attachment.upload.begun",
        requestId, uploadId: "upload-1", acknowledgedBytes: 0 });
      if (frame.type === "attachment.upload.chunk") send({ type: "attachment.upload.chunk.ack",
        requestId, uploadId: "upload-1", acknowledgedBytes: frame.byteLength });
      if (frame.type === "attachment.upload.finalize") send({ type: "attachment.upload.accepted",
        requestId, attachmentId: "attachment-1", processingStatus: "accepted-quarantined" });
      if (frame.type === "attachment.preview.open") send({ type: "attachment.preview.opened",
        requestId, streamId: "preview-stream", byteSize: bytes.byteLength });
      if (frame.type === "attachment.download.open") send({ type: "attachment.download.opened",
        requestId, streamId: "download-stream", byteSize: bytes.byteLength, originalFilename: "report.pdf" });
      if (frame.type === "attachment.stream.read") send({ type: "attachment.stream.chunk",
        requestId, streamId: frame.streamId, offset: frame.offset, byteLength: bytes.byteLength,
        base64: "AQID", eof: true });
    }));
    let previewBytes: Uint8Array | undefined;
    const handlers = new Map<string, unknown>();
    const frame = {};
    const webContents = { mainFrame: frame, isDestroyed: () => false, send: vi.fn() };
    const runtime = createDesktopAttachmentAuthorityRuntime({
      endpoint: `ws://127.0.0.1:${address.port}`,
      session: () => ({ actorId: "human-1", sessionId: "session-1",
        accessToken: "main-only-token", expiresAt: "2026-08-20T00:00:00.000Z" }),
      webSocketFactory: (endpoint) => new WebSocket(endpoint) as unknown as AttachmentAuthorityWebSocketLike,
      openFileDialog: { showOpenFile: async () => ({ canceled: false, filePaths: [selectedPath] }) },
      saveDialog: { chooseDestination: async () => savedPath },
      previewHost: {
        async openSandboxed(input) {
          expect(input.policy).toMatchObject({ sandbox: true, allowNetwork: false, allowNavigation: false });
          previewBytes = await input.read(0, 3);
        },
        closeAll: vi.fn(),
      },
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: (channel) => { handlers.delete(channel); } },
      webContents,
      timeoutMs: 2_000,
    });
    const selected = await runtime.controller.select();
    if (selected.status !== "selected") throw new Error("expected native selection");
    const inputs: unknown[] = [];
    runtime.controller.subscribe((input) => inputs.push(input));
    runtime.controller.upload({ type: "attachment.upload", roomId: "room-1",
      selectionHandle: selected.selection.selectionHandle });
    await vi.waitFor(() => expect(inputs).toContainEqual(expect.objectContaining({
      type: "attachment.upload.accepted", attachmentId: "attachment-1",
    })));
    await runtime.controller.preview({ type: "attachment.preview", attachmentId: "attachment-1",
      representation: "safe-rendered" });
    expect(previewBytes).toEqual(bytes);
    await expect(runtime.controller.download({ type: "attachment.download", attachmentId: "attachment-1" }))
      .resolves.toEqual({ type: "attachment.download.saved", attachmentId: "attachment-1" });
    expect(await readFile(savedPath)).toEqual(Buffer.from(bytes));
    expect(JSON.stringify(received.slice(1))).not.toContain("main-only-token");
    runtime.close();
    expect(handlers.size).toBe(0);
  });
});
