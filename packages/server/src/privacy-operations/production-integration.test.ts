import { describe, expect, it, vi } from "vitest";
import {
  createPrivacyOperationsProductionIntegration,
  PrivacyOperationsRuntimeError,
} from "./production-integration.js";
import type { DiagnosticsServiceAuthority } from "./diagnostics-service.js";
import type { HostedRetentionBatchPort } from "./operations-runtime.js";
import type { RoomExportAuthorityPorts } from "./room-export-authority-adapter.js";

const NOW = "2026-08-31T12:00:00.000Z";

function diagnosticsAuthority(
  calls: string[],
): DiagnosticsServiceAuthority {
  return {
    async authorize(input) {
      calls.push("diagnostics.authorize");
      return { ...input, principalKind: "tenant_administrator" };
    },
    async readClosedEntries() {
      calls.push("diagnostics.read");
      return [{ category: "worker", code: "healthy", occurredAt: NOW }];
    },
    async commitArtifact(input) {
      calls.push("diagnostics.commit");
      return { artifactId: "diagnostics-1", byteLength: input.bytes.byteLength };
    },
    async discardArtifact() { calls.push("diagnostics.discard"); },
    async audit() {
      calls.push("diagnostics.audit");
    },
  };
}

function roomExportAuthority(calls: string[]): RoomExportAuthorityPorts {
  return {
    sessions: { async inspect(input) {
      calls.push("export.session");
      return { ...input, tenantId: "tenant-1", principalKind: "human", active: true };
    } },
    roomAccess: { async inspect(input) {
      calls.push("export.access");
      return { ...input, tenantId: "tenant-1", membershipRole: "owner",
        lifecycle: "active", accessRevision: 7, exportAllowed: true };
    } },
    snapshots: { async begin(input) {
      calls.push("export.begin");
      return { exportId: "export-1", roomId: input.roomId, watermark: 42,
        accessRevision: input.accessRevision, startedAt: NOW };
    }, async reauthorize() {} },
    projections: { async readPage(input) {
      calls.push("export.read");
      return { records: input.after === undefined ? [{
        tenantId: "tenant-1", roomId: input.roomId, category: "message" as const,
        entityId: "message-1", revision: 1, payload: { body: "owner export corpus" },
      }] : [] };
    } },
    audit: { async append() { calls.push("export.audit"); } },
  };
}

function integration(input: Readonly<{
  calls: string[];
  retentionBatchPort: HostedRetentionBatchPort;
}>) {
  return createPrivacyOperationsProductionIntegration({
    diagnosticsAuthority: diagnosticsAuthority(input.calls),
    roomExportAuthority: roomExportAuthority(input.calls),
    retentionBatchPort: input.retentionBatchPort,
    now: () => new Date(NOW),
    retentionTimeoutMs: 1_000,
    shutdownDrainMs: 1_000,
  });
}

describe("FT-14 production integration", () => {
  it("uses external abort to release hung export slots and admit the next peer", async () => {
    const audit = vi.fn(async () => {});
    const readPage = vi.fn((input: Parameters<RoomExportAuthorityPorts["projections"]["readPage"]>[0]) =>
      input.sessionId === "session-peer"
        ? Promise.resolve({ records: [] })
        : new Promise<never>(() => undefined));
    const calls: string[] = [];
    const roomPorts = roomExportAuthority(calls);
    const runtime = createPrivacyOperationsProductionIntegration({
      diagnosticsAuthority: diagnosticsAuthority(calls),
      roomExportAuthority: {
        ...roomPorts,
        snapshots: {
          async begin(input) {
            return { exportId: `export-${input.sessionId}`, roomId: input.roomId, watermark: 42,
              accessRevision: input.accessRevision, startedAt: NOW };
          },
          async reauthorize() {},
        },
        projections: { readPage },
        audit: { append: audit },
      },
      retentionBatchPort: { async runBatch() {
        return { processed: 0, purged: 0, retained: 0, retried: 0, deadLettered: 0,
          hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
      } },
      now: () => new Date(NOW),
    });
    const open = (sessionId: string, signal?: AbortSignal) => runtime.streamRoomExport({
      actorId: "owner-1", roomId: "room-1", sessionFamilyId: "family-owner", sessionId,
    }, signal)[Symbol.asyncIterator]();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = open("session-one", firstController.signal);
    const second = open("session-two", secondController.signal);
    await expect(first.next()).resolves.toMatchObject({ done: false });
    await expect(second.next()).resolves.toMatchObject({ done: false });
    const firstPage = first.next();
    const firstFailure = expect(firstPage).rejects.toMatchObject({ code: "client_aborted" });
    const secondPage = second.next();
    const secondFailure = expect(secondPage).rejects.toMatchObject({ code: "client_aborted" });
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
    const peer = open("session-peer");
    const peerHeader = peer.next();

    firstController.abort(Object.assign(new Error("client abort"), { code: "client_aborted" }));
    await firstFailure;
    await expect(peerHeader).resolves.toMatchObject({ done: false });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      exportId: "export-session-one", result: "aborted", failureCode: "client_aborted",
    }));
    await peer.return?.();
    secondController.abort(Object.assign(new Error("disconnect"), { code: "client_aborted" }));
    await secondFailure;
    await runtime.shutdown();
  });

  it("shares the diagnostics 1-active/16-waiting bound across concurrent calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const authority = diagnosticsAuthority(calls);
    const runtime = createPrivacyOperationsProductionIntegration({
      diagnosticsAuthority: {
        ...authority,
        async readClosedEntries(input) {
          await gate;
          return authority.readClosedEntries(input);
        },
      },
      roomExportAuthority: roomExportAuthority(calls),
      retentionBatchPort: { async runBatch() {
        return { processed: 0, purged: 0, retained: 0, retried: 0, deadLettered: 0,
          hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
      } },
      now: () => new Date(NOW),
    });
    const request = () => runtime.generateDiagnostics({
      actorId: "administrator-1", sessionFamilyId: "family-admin", sessionId: "session-admin",
    });
    const admitted = Array.from({ length: 17 }, request);
    await vi.waitFor(() => expect(calls).toContain("diagnostics.authorize"));

    await expect(request()).rejects.toMatchObject({
      status: 429, code: "operations_capacity_limited",
    });
    release();
    await expect(Promise.all(admitted)).resolves.toHaveLength(17);
    await runtime.shutdown();
  });

  it("propagates an authenticated transport abort through the limiter into generation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const authority = diagnosticsAuthority(calls);
    const runtime = createPrivacyOperationsProductionIntegration({
      diagnosticsAuthority: { ...authority, async readClosedEntries(input) {
        await gate;
        return authority.readClosedEntries(input);
      } },
      roomExportAuthority: roomExportAuthority(calls),
      retentionBatchPort: { async runBatch() { return { processed: 0, purged: 0, retained: 0,
        retried: 0, deadLettered: 0, hasMore: false, queueDepth: 0, oldestAgeMs: 0 }; } },
      now: () => new Date(NOW),
    });
    const controller = new AbortController();
    const generation = runtime.generateDiagnostics({ actorId: "administrator-1",
      sessionFamilyId: "family-admin", sessionId: "session-admin" }, controller.signal);
    await vi.waitFor(() => expect(calls).toContain("diagnostics.authorize"));
    controller.abort();
    release();
    await expect(generation).rejects.toMatchObject({ code: "source_unavailable" });
    expect(calls).not.toContain("diagnostics.commit");
    await runtime.shutdown();
  });

  it("does not create a scheduler and runs exactly one bounded batch per host trigger", async () => {
    const calls: string[] = [];
    const runBatch = vi.fn(async (input: Parameters<HostedRetentionBatchPort["runBatch"]>[0]) => {
      calls.push(`retention.${input.trigger}`);
      expect(input.workerId).toBe("retention_janitor");
      expect(input.limit).toBe(100);
      return { processed: 100, purged: 100, retained: 0, retried: 0,
        deadLettered: 0, hasMore: true, queueDepth: 1, oldestAgeMs: 1 };
    });
    const runtime = integration({ calls, retentionBatchPort: { runBatch } });
    expect(calls).toEqual([]);

    await expect(runtime.runHostedRetention("startup_recovery", Date.parse(NOW)))
      .resolves.toMatchObject({ status: "needs_reschedule", processed: 100, hasMore: true });
    expect(runBatch).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(runBatch).toHaveBeenCalledTimes(1);

    await runtime.runHostedRetention("periodic", Date.parse(NOW) + 1);
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  it("keeps diagnostics and owner Room export on disjoint authority and byte paths", async () => {
    const calls: string[] = [];
    const runtime = integration({ calls, retentionBatchPort: { async runBatch() {
      return { processed: 0, purged: 0, retained: 0, retried: 0,
        deadLettered: 0, hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
    } } });

    const diagnostics = await runtime.generateDiagnostics({
      actorId: "administrator-1",
      sessionFamilyId: "family-admin",
      sessionId: "session-admin",
    });
    expect(diagnostics.artifactId).toBe("diagnostics-1");
    expect(calls).toEqual([
      "diagnostics.authorize", "diagnostics.read", "diagnostics.commit", "diagnostics.audit",
    ]);
    calls.length = 0;

    const chunks: Uint8Array[] = [];
    for await (const chunk of runtime.streamRoomExport({
      actorId: "owner-1",
      roomId: "room-1",
      sessionFamilyId: "family-owner",
      sessionId: "session-owner",
    })) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toContain("owner export corpus");
    expect(calls).not.toContain("diagnostics.authorize");
    expect(calls).toEqual(expect.arrayContaining([
      "export.session", "export.access", "export.begin", "export.read", "export.audit",
    ]));
  });

  it("keeps credential mutation unavailable and exposes no mutation method", () => {
    const runtime = integration({ calls: [], retentionBatchPort: { async runBatch() {
      return { processed: 0, purged: 0, retained: 0, retried: 0,
        deadLettered: 0, hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
    } } });
    expect(runtime.credentialRotation).toEqual({ status: "configuration_unsupported" });
    expect(runtime.credentialRotation).not.toHaveProperty("mutate");
  });

  it("uses the existing host shutdown boundary and closes every new entry point", async () => {
    const calls: string[] = [];
    const runtime = integration({ calls, retentionBatchPort: { async runBatch(input) {
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(),
        { once: true }));
      return { processed: 0, purged: 0, retained: 0, retried: 0,
        deadLettered: 0, hasMore: false, queueDepth: 0, oldestAgeMs: 0 };
    } } });
    const active = runtime.runHostedRetention("periodic", Date.parse(NOW));
    await Promise.resolve();
    await expect(runtime.shutdown()).resolves.toEqual({ status: "drained" });
    await active;
    await expect(runtime.runHostedRetention("periodic", Date.parse(NOW)))
      .resolves.toEqual({ status: "closed" });
    await expect(runtime.generateDiagnostics({
      actorId: "administrator-1", sessionFamilyId: "family-admin", sessionId: "session-admin",
    })).rejects.toBeInstanceOf(PrivacyOperationsRuntimeError);
    const iterator = runtime.streamRoomExport({ actorId: "owner-1", roomId: "room-1",
      sessionFamilyId: "family-owner", sessionId: "session-owner" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(PrivacyOperationsRuntimeError);
    await expect(runtime.shutdown()).resolves.toEqual({ status: "drained" });
  });
});
