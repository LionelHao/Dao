import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationService } from "../auth.js";
import type { MessageService } from "../service.js";
import {
  ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES,
  isRoomExportTransportServerFrame,
} from "@native-im/core";
import {
  startMessageWebSocketServer,
  type MessageWebSocketServer,
  type RoomExportAuthorityTransport,
} from "../websocket.js";
import { createPrivacyOperationsProductionIntegration } from "./production-integration.js";

type Frame = Record<string, unknown>;

class Client {
  readonly frames: Frame[] = [];
  readonly waiters: Array<Readonly<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    deadline: ReturnType<typeof setTimeout>;
  }>> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(frame)) continue;
        clearTimeout(waiter.deadline);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
  }

  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new Client(socket);
  }

  send(frame: unknown): void { this.socket.send(JSON.stringify(frame)); }

  waitFor(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        deadline: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error("Timed out waiting for WebSocket frame"));
        }, 2_000),
      };
      this.waiters.push(waiter);
    });
  }

  request(frame: Readonly<{ requestId: string } & Record<string, unknown>>): Promise<Frame> {
    this.send(frame);
    return this.waitFor((candidate) => candidate.requestId === frame.requestId);
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

function authentication(overrides: Readonly<{ revokedAfter?: number }> = {}): AuthenticationService {
  let sessionChecks = 0;
  let authenticationChecks = 0;
  const principal = Object.freeze({ accountId: "account-owner", actorId: "owner" });
  return {
    async authenticate(accessToken: string) {
      authenticationChecks += 1;
      if (accessToken !== "access-owner" ||
          (overrides.revokedAfter !== undefined && authenticationChecks > overrides.revokedAfter)) {
        throw Object.assign(new Error("revoked"), { status: 401, code: "invalid_token" });
      }
      return principal;
    },
    async authenticateSession(accessToken: string) {
      sessionChecks += 1;
      if (accessToken !== "access-owner" ||
          (overrides.revokedAfter !== undefined && sessionChecks > overrides.revokedAfter)) {
        throw Object.assign(new Error("revoked"), { status: 401, code: "invalid_token" });
      }
      return Object.freeze({
        sessionId: "access-hash-owner", sessionFamilyId: "family-owner", principal,
      });
    },
    async listSessions() {
      return [Object.freeze({
        id: "public-session-owner", deviceLabel: "Test device", platform: "unknown" as const,
        refreshExpiresAt: "2026-10-01T00:00:00.000Z", current: true,
      })];
    },
  } as AuthenticationService;
}

async function start(
  roomExportAuthority: RoomExportAuthorityTransport | undefined,
  auth: AuthenticationService = authentication(),
  limits: Readonly<{ maxQueuedFrameCount?: number; maxQueuedFrameBytes?: number }> = {},
): Promise<Readonly<{ server: MessageWebSocketServer; client: Client }>> {
  const server = await startMessageWebSocketServer({
    auth,
    service: {} as MessageService,
    host: "127.0.0.1",
    port: 0,
    ...limits,
    ...(roomExportAuthority === undefined ? {} : { roomExportAuthority }),
  });
  servers.add(server);
  const client = await Client.connect(server.url);
  clients.add(client);
  return { server, client };
}

async function resume(client: Client): Promise<void> {
  const frame = await client.request({
    type: "auth.resume", requestId: "resume", accessToken: "access-owner",
  });
  expect(frame).toMatchObject({ type: "auth.authenticated", actorId: "owner" });
}

describe("Room export authenticated WebSocket transport", () => {
  it("streams bounded chunks with offset conflicts, capacity, EOF, and gone states", async () => {
    const source = Buffer.alloc(ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES + 4_096, 23);
    const authority: RoomExportAuthorityTransport = {
      async *streamRoomExport(accessToken, roomId) {
        expect(accessToken).toBe("access-owner");
        expect(roomId).toBe("room-1");
        yield source;
      },
    };
    const { client } = await start(authority);

    expect(await client.request({
      type: "room-export.open", requestId: "unauthenticated", roomId: "room-1",
    })).toMatchObject({ type: "error", status: 401, code: "unauthenticated" });
    await resume(client);
    const opened = await client.request({
      type: "room-export.open", requestId: "open", roomId: "room-1",
    });
    expect(isRoomExportTransportServerFrame(opened)).toBe(true);
    const streamId = String(opened.streamId);
    expect(await client.request({
      type: "room-export.open", requestId: "over-capacity", roomId: "room-1",
    })).toMatchObject({ type: "error", status: 429, code: "room_export_capacity_limited" });
    expect(await client.request({
      type: "room-export.read", requestId: "wrong-offset", streamId, offset: 1,
    })).toMatchObject({ type: "error", status: 409, code: "room_export_stream_conflict" });

    const first = await client.request({
      type: "room-export.read", requestId: "read-1", streamId, offset: 0,
    });
    expect(first).toMatchObject({ type: "room-export.chunk", offset: 0,
      byteLength: ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES, eof: false });
    expect(Buffer.from(String(first.base64), "base64")).toEqual(source.subarray(0,
      ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES));
    const second = await client.request({
      type: "room-export.read", requestId: "read-2", streamId,
      offset: ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES,
    });
    expect(second).toMatchObject({ type: "room-export.chunk",
      offset: ROOM_EXPORT_TRANSPORT_MAX_CHUNK_BYTES, byteLength: 4_096, eof: false });
    expect(await client.request({
      type: "room-export.read", requestId: "read-eof", streamId, offset: source.byteLength,
    })).toMatchObject({ type: "room-export.chunk", offset: source.byteLength,
      byteLength: 0, base64: "", eof: true });
    expect(await client.request({
      type: "room-export.read", requestId: "after-eof", streamId, offset: source.byteLength,
    })).toMatchObject({ type: "error", status: 410, code: "room_export_stream_gone" });
  });

  it("maps initial authority failures to 403/429/timeout/503 and missing composition to 503", async () => {
    const authority: RoomExportAuthorityTransport = {
      async *streamRoomExport(_accessToken, roomId) {
        if (roomId === "forbidden") {
          throw Object.assign(new Error("forbidden"), {
            status: 403, code: "room_export_forbidden",
          });
        }
        if (roomId === "unavailable") {
          throw Object.assign(new Error("unavailable"), {
            status: 503, code: "storage_unavailable",
          });
        }
        if (roomId === "capacity") {
          throw Object.assign(new Error("capacity"), {
            status: 429, code: "operations_capacity_limited",
          });
        }
        if (roomId === "timeout") {
          throw Object.assign(new Error("timeout"), {
            status: 503, code: "operations_timeout",
          });
        }
        yield new Uint8Array();
      },
    };
    const first = await start(authority);
    await resume(first.client);
    expect(await first.client.request({
      type: "room-export.open", requestId: "forbidden", roomId: "forbidden",
    })).toMatchObject({ type: "error", status: 403, code: "room_export_forbidden" });
    expect(await first.client.request({
      type: "room-export.open", requestId: "unavailable", roomId: "unavailable",
    })).toMatchObject({ type: "error", status: 503, code: "storage_unavailable" });
    expect(await first.client.request({
      type: "room-export.open", requestId: "capacity", roomId: "capacity",
    })).toMatchObject({ type: "error", status: 429, code: "room_export_capacity_limited" });
    expect(await first.client.request({
      type: "room-export.open", requestId: "timeout", roomId: "timeout",
    })).toMatchObject({ type: "error", status: 503, code: "room_export_timeout" });

    const second = await start(undefined);
    await resume(second.client);
    expect(await second.client.request({
      type: "room-export.open", requestId: "not-composed", roomId: "room-1",
    })).toMatchObject({ type: "error", status: 503, code: "storage_unavailable" });
  });

  it("aborts iterators on explicit abort, exact-session revocation, and disconnect", async () => {
    const finalized = vi.fn();
    const aborted = vi.fn();
    const header = new TextEncoder().encode("header\n");
    const authority: RoomExportAuthorityTransport = {
      async *streamRoomExport(_accessToken, _roomId, signal) {
        let rejectPending!: (error: unknown) => void;
        const pending = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
        void pending.catch(() => undefined);
        const onAbort = () => {
          aborted();
          rejectPending(signal?.reason);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          yield header;
          if (signal?.aborted === true) throw signal.reason;
          await pending;
        }
        finally {
          signal?.removeEventListener("abort", onAbort);
          finalized();
        }
      },
    };
    const first = await start(authority);
    await resume(first.client);
    const opened = await first.client.request({
      type: "room-export.open", requestId: "open-abort", roomId: "room-1",
    });
    const streamId = String(opened.streamId);
    expect(await first.client.request({
      type: "room-export.read", requestId: "read-header", streamId, offset: 0,
    })).toMatchObject({ type: "room-export.chunk", byteLength: header.byteLength });
    const hungRead = first.client.request({
      type: "room-export.read", requestId: "read-hung", streamId, offset: header.byteLength,
    });
    const unmatchedAbort = first.client.request({
      type: "room-export.abort", requestId: "abort-wrong", streamId: `${streamId}-wrong`,
    });
    expect(await first.client.request({
      type: "room-export.abort", requestId: "abort", streamId,
    })).toMatchObject({ type: "room-export.aborted", streamId });
    await expect(hungRead).resolves.toMatchObject({
      requestId: "read-hung", type: "error", status: 410, code: "room_export_stream_gone",
    });
    await expect(unmatchedAbort).resolves.toMatchObject({
      requestId: "abort-wrong", status: 410, code: "room_export_stream_gone",
    });
    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
    expect(aborted).toHaveBeenCalledTimes(1);

    const revoked = await start(authority, authentication({ revokedAfter: 2 }));
    await resume(revoked.client);
    const revokedOpen = await revoked.client.request({
      type: "room-export.open", requestId: "open-revoked", roomId: "room-1",
    });
    expect(await revoked.client.request({
      type: "room-export.read", requestId: "revoked-read",
      streamId: String(revokedOpen.streamId), offset: 0,
    })).toMatchObject({ type: "error", status: 401, code: "invalid_token" });
    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(2));

    const disconnected = await start(authority);
    await resume(disconnected.client);
    await disconnected.client.request({
      type: "room-export.open", requestId: "open-disconnect", roomId: "room-1",
    });
    await disconnected.client.close();
    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(3));
    expect(aborted).toHaveBeenCalledTimes(3);
  });

  it("preempts a non-cooperative pending read and releases the socket queue and stream slot", async () => {
    const readEntered = vi.fn();
    let calls = 0;
    const header = new TextEncoder().encode("header\n");
    const authority: RoomExportAuthorityTransport = {
      async *streamRoomExport() {
        calls += 1;
        yield header;
        if (calls === 1) {
          readEntered();
          // Deliberately ignores AbortSignal and never settles.
          await new Promise<never>(() => undefined);
        }
      },
    };
    const { client } = await start(authority);
    await resume(client);
    const opened = await client.request({
      type: "room-export.open", requestId: "open-non-cooperative", roomId: "room-1",
    });
    const streamId = String(opened.streamId);
    await client.request({
      type: "room-export.read", requestId: "read-non-cooperative-header", streamId, offset: 0,
    });
    const reading = client.request({
      type: "room-export.read", requestId: "read-non-cooperative", streamId,
      offset: header.byteLength,
    });
    await vi.waitFor(() => expect(readEntered).toHaveBeenCalledTimes(1));

    expect(await client.request({
      type: "room-export.abort", requestId: "abort-non-cooperative", streamId,
    })).toMatchObject({ type: "room-export.aborted", streamId });
    await expect(reading).resolves.toMatchObject({
      type: "error", requestId: "read-non-cooperative", status: 410,
      code: "room_export_stream_gone",
    });
    expect(await client.request({
      type: "room-export.open", requestId: "open-after-read-abort", roomId: "room-1",
    })).toMatchObject({ type: "room-export.opened" });
  });

  it.each(["resolve", "reject"] as const)(
    "observes a late authority next %s after local abort cleanup",
    async (settlement) => {
      let settle!: (result: IteratorResult<Uint8Array>) => void;
      let fail!: (error: Error) => void;
      const late = new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      void late.catch(() => undefined);
      const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
      const header = new TextEncoder().encode("header\n");
      const authority: RoomExportAuthorityTransport = {
        streamRoomExport() {
          let nextCalls = 0;
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  nextCalls += 1;
                  return nextCalls === 1
                    ? Promise.resolve({ done: false as const, value: header })
                    : late;
                },
                return: returned,
              };
            },
          };
        },
      };
      const { client } = await start(authority);
      await resume(client);
      const opened = await client.request({
        type: "room-export.open", requestId: `open-late-${settlement}`, roomId: "room-1",
      });
      const streamId = String(opened.streamId);
      await client.request({
        type: "room-export.read", requestId: `header-late-${settlement}`, streamId, offset: 0,
      });
      const reading = client.request({
        type: "room-export.read", requestId: `read-late-${settlement}`, streamId,
        offset: header.byteLength,
      });
      await client.request({
        type: "room-export.abort", requestId: `abort-late-${settlement}`, streamId,
      });
      await expect(reading).resolves.toMatchObject({
        status: 410, code: "room_export_stream_gone",
      });
      if (settlement === "resolve") settle({ done: true, value: undefined });
      else fail(new Error("late authority rejection"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toHaveBeenCalledTimes(1);
      expect(await client.request({
        type: "room-export.open", requestId: `open-after-late-${settlement}`,
        roomId: "room-1",
      })).toMatchObject({ type: "room-export.opened" });
    },
  );

  it("bounds unmatched abort floods while a source read never resolves", async () => {
    const readEntered = vi.fn();
    const finalized = vi.fn();
    const authority: RoomExportAuthorityTransport = {
      async *streamRoomExport(_accessToken, _roomId, signal) {
        let rejectPending!: (error: unknown) => void;
        const pending = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
        void pending.catch(() => undefined);
        const onAbort = () => rejectPending(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          yield new TextEncoder().encode("header\n");
          readEntered();
          if (signal?.aborted === true) throw signal.reason;
          await pending;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          finalized();
        }
      },
    };
    const { client } = await start(authority, authentication(), { maxQueuedFrameCount: 2 });
    await resume(client);
    const opened = await client.request({
      type: "room-export.open", requestId: "open-flood", roomId: "room-1",
    });
    const streamId = String(opened.streamId);
    const header = await client.request({
      type: "room-export.read", requestId: "read-flood-header", streamId, offset: 0,
    });
    client.send({
      type: "room-export.read", requestId: "read-flood-hung", streamId,
      offset: Number(header.byteLength),
    });
    await vi.waitFor(() => expect(readEntered).toHaveBeenCalledTimes(1));
    const closed = new Promise<void>((resolve) => client.socket.once("close", () => resolve()));
    client.send({
      type: "room-export.abort", requestId: "wrong-flood-1", streamId: `${streamId}-1`,
    });
    client.send({
      type: "room-export.abort", requestId: "wrong-flood-2", streamId: `${streamId}-2`,
    });
    await closed;
    await vi.waitFor(() => expect(finalized).toHaveBeenCalledTimes(1));
  });

  it("preempts a non-cooperative pending open by its provisional alias", async () => {
    const entered = vi.fn();
    let calls = 0;
    const authority: RoomExportAuthorityTransport = {
      async *streamRoomExport() {
        calls += 1;
        if (calls === 1) {
          entered();
          // Deliberately ignores AbortSignal and never settles.
          await new Promise<never>(() => undefined);
        }
        yield new TextEncoder().encode("header\n");
      },
    };
    const { client } = await start(authority);
    await resume(client);
    const opening = client.request({
      type: "room-export.open", requestId: "provisional-open", roomId: "room-1",
    });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));

    expect(await client.request({
      type: "room-export.abort", requestId: "abort-provisional",
      streamId: "provisional-open",
    })).toMatchObject({
      type: "room-export.aborted", streamId: "provisional-open",
    });
    await expect(opening).resolves.toMatchObject({
      type: "error", requestId: "provisional-open", status: 410,
      code: "room_export_stream_gone",
    });
    const reopened = await client.request({
      type: "room-export.open", requestId: "open-after-abort", roomId: "room-1",
    });
    expect(reopened).toMatchObject({ type: "room-export.opened" });
  });

  it("disconnects through the real adapter and releases with a terminal metadata-only audit", async () => {
    const audits: Array<Record<string, unknown>> = [];
    const readPageEntered = vi.fn();
    const runtime = createPrivacyOperationsProductionIntegration({
      diagnosticsAuthority: {
        async authorize(input) { return { ...input, principalKind: "tenant_administrator" }; },
        async readClosedEntries() { return []; },
        async commitArtifact(input) {
          return { artifactId: "diagnostics-unused", byteLength: input.bytes.byteLength };
        },
        async discardArtifact() {}, async audit() {},
      },
      roomExportAuthority: {
        sessions: { async inspect(input) {
          return { ...input, tenantId: "tenant-1", principalKind: "human", active: true };
        } },
        roomAccess: { async inspect(input) {
          return { ...input, tenantId: "tenant-1", membershipRole: "owner",
            lifecycle: "active", accessRevision: 7, exportAllowed: true };
        } },
        snapshots: {
          async begin(input) {
            return { exportId: "export-real", roomId: input.roomId, watermark: 42,
              accessRevision: input.accessRevision, startedAt: "2026-09-01T00:00:00.000Z" };
          },
          async reauthorize() {},
        },
        projections: { async readPage() {
          readPageEntered();
          return await new Promise<never>(() => undefined);
        } },
        audit: { async append(event) { audits.push(event); } },
      },
      retentionBatchPort: { async runBatch() {
        return { processed: 0, purged: 0, retained: 0, retried: 0, deadLettered: 0,
          hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
      } },
    });
    const transport: RoomExportAuthorityTransport = {
      async *streamRoomExport(_accessToken, roomId, signal) {
        yield* runtime.streamRoomExport({
          actorId: "owner", roomId, sessionFamilyId: "family-owner",
          sessionId: "access-hash-owner",
        }, signal);
      },
    };
    const { client } = await start(transport);
    await resume(client);
    const opened = await client.request({
      type: "room-export.open", requestId: "open-real", roomId: "room-1",
    });
    expect(opened).toMatchObject({ type: "room-export.opened" });
    const streamId = String(opened.streamId);
    const header = await client.request({
      type: "room-export.read", requestId: "read-real-header", streamId, offset: 0,
    });
    expect(header).toMatchObject({ type: "room-export.chunk" });
    client.send({
      type: "room-export.read", requestId: "read-real-hung", streamId,
      offset: Number(header.byteLength),
    });
    await vi.waitFor(() => expect(readPageEntered).toHaveBeenCalledTimes(1));
    await client.close();

    await vi.waitFor(() => expect(audits).toContainEqual(expect.objectContaining({
      exportId: "export-real", result: "aborted", failureCode: "client_aborted",
    })));
    expect(JSON.stringify(audits)).not.toContain("payload");
    await runtime.shutdown();
  });
});
