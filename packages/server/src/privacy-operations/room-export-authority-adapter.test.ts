import { describe, expect, it, vi } from "vitest";
import { createRoomDataExport } from "./room-export.js";
import {
  createRoomExportAuthorityAdapter,
  type RoomExportAuthorityPorts,
} from "./room-export-authority-adapter.js";

function ports(overrides: Partial<RoomExportAuthorityPorts> = {}): RoomExportAuthorityPorts {
  return {
    sessions: {
      async inspect(input) {
        return {
          actorId: input.actorId,
          sessionFamilyId: input.sessionFamilyId,
          sessionId: input.sessionId,
          tenantId: "tenant-1",
          principalKind: "human",
          active: true,
        };
      },
    },
    roomAccess: {
      async inspect(input) {
        return {
          actorId: input.actorId,
          tenantId: "tenant-1",
          roomId: input.roomId,
          membershipRole: "owner",
          lifecycle: "active",
          accessRevision: 7,
          exportAllowed: true,
        };
      },
    },
    snapshots: {
      async begin(input) {
        return {
          exportId: "export-1",
          roomId: input.roomId,
          watermark: 42,
          accessRevision: input.accessRevision,
          startedAt: "2026-08-31T00:00:00.000Z",
        };
      },
      async reauthorize() {},
    },
    projections: {
      async readPage(input) {
        return {
          records: [{
            tenantId: input.tenantId,
            roomId: input.roomId,
            category: "message",
            entityId: "message-1",
            revision: 0,
            payload: { body: "owner-authorized original" },
          }],
        };
      },
    },
    audit: { async append() {} },
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("FT-14 Room export production authority adapter", () => {
  it("does not grant a nonmember Tenant Administrator Room export authority", async () => {
    const readPage = vi.fn();
    const adapter = createRoomExportAuthorityAdapter(ports({
      sessions: { async inspect(input) {
        return {
          ...input,
          tenantId: "tenant-1",
          principalKind: "human",
          active: true,
        };
      } },
      roomAccess: { async inspect(input) {
        return {
          actorId: input.actorId, tenantId: "tenant-1", roomId: input.roomId,
          membershipRole: "none", lifecycle: "active", accessRevision: 7,
          exportAllowed: false,
        };
      } },
      projections: { readPage },
    }));
    const exportService = createRoomDataExport({ authority: adapter });

    const iterator = exportService.stream({
      actorId: "human-tenant-admin",
      roomId: "room-1",
      sessionFamilyId: "family-1",
      sessionId: "session-1",
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("room_export_forbidden");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("captures one fixed watermark and strips trusted tenant/Room bindings from exported records", async () => {
    const projectionRead = vi.fn(ports().projections.readPage);
    const auditAppend = vi.fn(async () => {});
    const adapter = createRoomExportAuthorityAdapter(ports({
      projections: { readPage: projectionRead },
      audit: { append: auditAppend },
    }));
    const exportService = createRoomDataExport({ authority: adapter });

    const chunks = await collect(exportService.stream({
      actorId: "human-owner",
      roomId: "room-1",
      sessionFamilyId: "family-1",
      sessionId: "session-1",
    }));
    const text = chunks.map((chunk) => new TextDecoder().decode(chunk)).join("");

    expect(projectionRead).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-1",
      roomId: "room-1",
      watermark: 42,
      accessRevision: 7,
      limit: 256,
    }));
    expect(text).toContain("owner-authorized original");
    expect(text).not.toContain("tenantId");
    expect(auditAppend).toHaveBeenCalledTimes(2);
    expect(auditAppend.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      result: "succeeded",
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("fails closed if a trusted projection page returns cross-Room or cross-tenant data", async () => {
    const adapter = createRoomExportAuthorityAdapter(ports({
      projections: { async readPage() {
        return { records: [{
          tenantId: "tenant-foreign",
          roomId: "room-foreign",
          category: "message",
          entityId: "foreign-message",
          revision: 0,
          payload: { body: "cross-room sentinel" },
        }] };
      } },
    }));

    await expect(collect(createRoomDataExport({ authority: adapter }).stream({
      actorId: "human-owner",
      roomId: "room-1",
      sessionFamilyId: "family-1",
      sessionId: "session-1",
    }))).rejects.toThrow("cross-scope");
  });

  it("rechecks session, ownership, lifecycle, access revision and export policy before each page/finalize", async () => {
    let inspection = 0;
    const readPage = vi.fn(async (input: Parameters<RoomExportAuthorityPorts["projections"]["readPage"]>[0]) => ({
      records: [{
        tenantId: input.tenantId,
        roomId: input.roomId,
        category: "message" as const,
        entityId: "message-1",
        revision: 0,
        payload: { body: "first authorized page" },
      }],
      next: "page-2",
    }));
    const baseSnapshots = ports().snapshots;
    const adapter = createRoomExportAuthorityAdapter(ports({
      snapshots: {
        begin: baseSnapshots.begin,
        async reauthorize() {
          inspection += 1;
          if (inspection >= 3) throw new Error("owner access changed");
        },
      },
      projections: { readPage },
    }));
    const iterator = createRoomDataExport({ authority: adapter }).stream({
      actorId: "human-owner", roomId: "room-1", sessionFamilyId: "family-1",
      sessionId: "session-1",
    })[Symbol.asyncIterator]();

    expect((await iterator.next()).done).toBe(false);
    expect((await iterator.next()).done).toBe(false);
    await expect(iterator.next()).rejects.toThrow("room export authorization changed");
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("isolates concurrent snapshots with the same Room and watermark by exportId", async () => {
    const adapter = createRoomExportAuthorityAdapter(ports({
      snapshots: {
        async begin(input) {
          return {
            exportId: `export-${input.sessionId}`,
            roomId: input.roomId,
            watermark: 42,
            accessRevision: input.accessRevision,
            startedAt: "2026-08-31T00:00:00.000Z",
          };
        },
        async reauthorize() {},
      },
    }));
    const first = await adapter.authorize({
      actorId: "human-owner", roomId: "room-1",
      sessionFamilyId: "family-1", sessionId: "session-1",
    });
    const second = await adapter.authorize({
      actorId: "human-owner", roomId: "room-1",
      sessionFamilyId: "family-1", sessionId: "session-2",
    });
    const firstSnapshot = await adapter.begin(first);
    const secondSnapshot = await adapter.begin(second);

    await expect(adapter.reauthorize({
      ...first, exportId: firstSnapshot.exportId, watermark: firstSnapshot.watermark,
    })).resolves.toBeUndefined();
    await expect(adapter.reauthorize({
      ...second, exportId: secondSnapshot.exportId, watermark: secondSnapshot.watermark,
    })).resolves.toBeUndefined();
  });

  it("idempotently releases authorization and snapshot contexts", async () => {
    const adapter = createRoomExportAuthorityAdapter(ports());
    const authorization = await adapter.authorize({
      actorId: "human-owner", roomId: "room-1",
      sessionFamilyId: "family-1", sessionId: "session-1",
    });
    await adapter.release({ authorization });
    await expect(adapter.begin(authorization)).rejects.toThrow("authorization is unknown");

    const nextAuthorization = await adapter.authorize({
      actorId: "human-owner", roomId: "room-1",
      sessionFamilyId: "family-1", sessionId: "session-1",
    });
    const snapshot = await adapter.begin(nextAuthorization);
    await adapter.release({ authorization: nextAuthorization, exportId: snapshot.exportId });
    await adapter.release({ authorization: nextAuthorization, exportId: snapshot.exportId });
    await expect(adapter.reauthorize({
      ...nextAuthorization, exportId: snapshot.exportId, watermark: snapshot.watermark,
    })).rejects.toThrow("snapshot authorization is unknown");
  });

  it("removes a late authorize success after cancellation", async () => {
    let resolveSession!: (value: Awaited<ReturnType<
      RoomExportAuthorityPorts["sessions"]["inspect"]
    >>) => void;
    const inspect = vi.fn(() => new Promise<Awaited<ReturnType<
      RoomExportAuthorityPorts["sessions"]["inspect"]
    >>>((resolve) => { resolveSession = resolve; }));
    const adapter = createRoomExportAuthorityAdapter(ports({ sessions: { inspect } }));
    const release = vi.fn(adapter.release);
    const controller = new AbortController();
    const input = {
      actorId: "human-owner", roomId: "room-1", sessionFamilyId: "family-1",
      sessionId: "session-late-authorize",
    } as const;
    const next = createRoomDataExport({ authority: { ...adapter, release } })
      .stream(input, controller.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: "operations_timeout" });

    resolveSession({ ...input, tenantId: "tenant-1", principalKind: "human", active: true });
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith({
      authorization: expect.objectContaining({ sessionId: input.sessionId }),
    }));
    const lateAuthorization = {
      ...input, accessRevision: 7, lifecycle: "active" as const, role: "owner" as const,
    };
    await expect(adapter.begin(lateAuthorization)).rejects.toThrow("authorization is unknown");
  });

  it("removes both maps when begin succeeds after cancellation", async () => {
    let resolveSnapshot!: (value: Awaited<ReturnType<
      RoomExportAuthorityPorts["snapshots"]["begin"]
    >>) => void;
    const begin = vi.fn(() => new Promise<Awaited<ReturnType<
      RoomExportAuthorityPorts["snapshots"]["begin"]
    >>>((resolve) => { resolveSnapshot = resolve; }));
    const adapter = createRoomExportAuthorityAdapter(ports({
      snapshots: { begin, async reauthorize() {} },
    }));
    const release = vi.fn(adapter.release);
    const controller = new AbortController();
    const input = {
      actorId: "human-owner", roomId: "room-1", sessionFamilyId: "family-1",
      sessionId: "session-late-begin",
    } as const;
    const next = createRoomDataExport({ authority: { ...adapter, release } })
      .stream(input, controller.signal)[Symbol.asyncIterator]().next();
    await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(next).rejects.toMatchObject({ code: "operations_timeout" });

    const snapshot = {
      exportId: "export-late-begin", roomId: input.roomId, watermark: 42,
      accessRevision: 7, startedAt: "2026-08-31T00:00:00.000Z",
    } as const;
    resolveSnapshot(snapshot);
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(expect.objectContaining({
      exportId: snapshot.exportId,
    })));
    const authorization = {
      ...input, accessRevision: 7, lifecycle: "active" as const, role: "owner" as const,
    };
    await expect(adapter.begin(authorization)).rejects.toThrow("authorization is unknown");
    await expect(adapter.reauthorize({
      ...authorization, exportId: snapshot.exportId, watermark: snapshot.watermark,
    })).rejects.toThrow("snapshot authorization is unknown");
  });
});
