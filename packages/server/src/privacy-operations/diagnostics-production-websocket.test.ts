import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationService } from "../auth.js";
import type { MessageService } from "../service.js";
import { isDiagnosticsTransportServerFrame } from "@native-im/core";
import { startMessageWebSocketServer, type MessageWebSocketServer } from "../websocket.js";
import type { DiagnosticsAuthenticatedArtifactTransport } from
  "./diagnostics-websocket-transport.js";

type Frame = Record<string, unknown>;

class Client {
  private readonly frames: Frame[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.frames.push(JSON.parse(raw.toString()) as Frame));
  }
  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new Client(socket);
  }
  async request(frame: Frame & { requestId: string }): Promise<Frame> {
    this.socket.send(JSON.stringify(frame));
    await vi.waitFor(() => expect(this.frames.some(
      (candidate) => candidate.requestId === frame.requestId,
    )).toBe(true));
    return this.frames.find((candidate) => candidate.requestId === frame.requestId)!;
  }
  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await closed;
  }
}

const servers = new Set<MessageWebSocketServer>();
const clients = new Set<Client>();

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.close()));
  clients.clear();
  await Promise.all([...servers].map((server) => server.close()));
  servers.clear();
});

function authentication(): AuthenticationService {
  const principal = Object.freeze({ accountId: "account-admin", actorId: "admin" });
  return {
    async authenticate(token: string) {
      if (token !== "admin-token") throw Object.assign(new Error("revoked"), { status: 401 });
      return principal;
    },
    async authenticateSession(token: string) {
      if (token !== "admin-token") throw Object.assign(new Error("revoked"), { status: 401 });
      return Object.freeze({ sessionId: "session-admin", sessionFamilyId: "family-admin",
        principal });
    },
    async listSessions() { return [Object.freeze({
      id: "session-admin", deviceLabel: "Test device", platform: "unknown" as const,
      refreshExpiresAt: "2026-10-01T00:00:00.000Z", current: true,
    })]; },
  } as AuthenticationService;
}

async function start(authority: DiagnosticsAuthenticatedArtifactTransport, limits: Readonly<{
  maxQueuedFrameCount?: number;
  maxQueuedFrameBytes?: number;
}> = {}) {
  const server = await startMessageWebSocketServer({
    auth: authentication(), service: {} as MessageService,
    host: "127.0.0.1", port: 0, diagnosticsAuthority: authority, ...limits,
  });
  servers.add(server);
  const client = await Client.connect(server.url);
  clients.add(client);
  return client;
}

async function resume(client: Client): Promise<void> {
  await expect(client.request({ type: "auth.resume", requestId: "resume",
    accessToken: "admin-token" })).resolves.toMatchObject({ type: "auth.authenticated" });
}

describe("FT-14 diagnostics production Message Authority WebSocket", () => {
  it("uses the authenticated socket and reauthorizes every artifact read", async () => {
    const bytes = Buffer.from("{\"category\":\"schema\"}\n", "utf8");
    let reads = 0;
    const authority: DiagnosticsAuthenticatedArtifactTransport = {
      async generateDiagnostics(token, signal) {
        expect(token).toBe("admin-token");
        expect(signal.aborted).toBe(false);
        return { artifactId: "artifact-1",
          filename: "dao-diagnostics-2026-09-01T00-00-00.000Z.ndjson",
          mediaType: "application/x-ndjson", expiresAt: "2026-09-01T00:10:00.000Z",
          manifest: { byteLength: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex") } };
      },
      async readDiagnosticsArtifact(token) {
        expect(token).toBe("admin-token");
        reads += 1;
        if (reads > 1) throw Object.assign(new Error("role revoked"), { status: 403 });
        return { filename: "dao-diagnostics-2026-09-01T00-00-00.000Z.ndjson",
          mediaType: "application/x-ndjson", bytes,
          expiresAt: "2026-09-01T00:10:00.000Z" };
      },
    };
    const client = await start(authority);
    expect(await client.request({ type: "diagnostics.generate", requestId: "before-auth" }))
      .toMatchObject({ type: "error", status: 401, code: "unauthenticated" });
    await resume(client);
    const generated = await client.request({ type: "diagnostics.generate",
      requestId: "generate" });
    expect(isDiagnosticsTransportServerFrame(generated)).toBe(true);
    const streamId = String(generated.streamId);
    const firstRead = await client.request({ type: "diagnostics.read", requestId: "read-1",
      streamId, offset: 0 });
    expect(firstRead).toEqual(expect.objectContaining({ type: "diagnostics.chunk", eof: true }));

    const second = await client.request({ type: "diagnostics.generate", requestId: "generate-2" });
    expect(await client.request({ type: "diagnostics.read", requestId: "revoked-read",
      streamId: String(second.streamId), offset: 0 }))
      .toMatchObject({ type: "error", status: 403, code: "administrator_required" });
  });

  it("propagates socket disconnect into active diagnostics generation", async () => {
    let aborted = false;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const authority: DiagnosticsAuthenticatedArtifactTransport = {
      generateDiagnostics: (_token, signal) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }, { once: true });
      }),
      async readDiagnosticsArtifact() { throw new Error("not reached"); },
    };
    const client = await start(authority);
    await resume(client);
    client.socket.send(JSON.stringify({ type: "diagnostics.generate", requestId: "generate" }));
    await began;
    await client.close();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it("processes diagnostics abort outside the per-socket frame queue", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const authority: DiagnosticsAuthenticatedArtifactTransport = {
      generateDiagnostics: (_token, signal) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
      async readDiagnosticsArtifact() { throw new Error("not reached"); },
    };
    const client = await start(authority);
    await resume(client);
    const generation = client.request({ type: "diagnostics.generate", requestId: "generate-live" });
    await began;
    await expect(client.request({ type: "diagnostics.abort", requestId: "abort-live",
      streamId: "generate-live" })).resolves.toMatchObject({
      type: "diagnostics.aborted", streamId: "generate-live",
    });
    await expect(generation).resolves.toMatchObject({
      type: "error", status: 410, code: "diagnostics_artifact_gone",
    });
  });

  it("keeps the abort fast lane inside per-connection queue bounds under flood", async () => {
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const authority: DiagnosticsAuthenticatedArtifactTransport = {
      generateDiagnostics: () => new Promise(() => { started(); }),
      async readDiagnosticsArtifact() { throw new Error("not reached"); },
    };
    const client = await start(authority, { maxQueuedFrameCount: 2 });
    await resume(client);
    client.socket.send(JSON.stringify({ type: "diagnostics.generate", requestId: "flood-stream" }));
    await began;
    const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
    client.socket.send(JSON.stringify({ type: "diagnostics.abort", requestId: "abort-flood-1",
      streamId: "flood-stream" }));
    client.socket.send(JSON.stringify({ type: "diagnostics.abort", requestId: "abort-flood-2",
      streamId: "flood-stream" }));
    await closed;
    expect(client.socket.readyState).toBe(WebSocket.CLOSED);
  });
});
