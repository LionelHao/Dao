import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationService } from "../auth.js";
import type { CompleteWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type {
  PrivacyDataAuthorityOperation,
  PrivacyDataAuthorityResult,
} from "./data-authority-protocol.js";
import { createDiagnosticsBundle } from "./diagnostics.js";
import {
  createAuthenticatedPrivacyOperationsTransport,
  createDiagnosticsArtifactMaintenance,
  createPrivacyOperationsMetadataAuditFileSink,
  createServerPrivateDiagnosticsArtifactStore,
} from "./authoritative-host.js";

const directories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dao-privacy-host-"));
  directories.add(directory);
  return directory;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
  directories.clear();
});

describe("server-private diagnostics artifact storage", () => {
  it("persists exact-session-bound artifacts and enforces the bound after restart", async () => {
    const root = await temporaryDirectory();
    const bundle = createDiagnosticsBundle({ generatedAt: "2026-09-01T00:00:00.000Z", entries: [] });
    const principal = Object.freeze({
      actorId: "admin", sessionFamilyId: "family-admin", sessionId: "session-admin",
      principalKind: "tenant_administrator" as const,
    });
    const first = await createServerPrivateDiagnosticsArtifactStore(root, {
      maxArtifacts: 1, maxStorageBytes: 1_048_576,
    });
    const committed = await first.commit({
      principal, filename: bundle.filename, mediaType: bundle.mediaType, bytes: bundle.bytes,
      manifest: bundle.manifest, expiresAtMs: Date.now() + 60_000,
    });

    await expect(first.read({
      actorId: "admin", sessionFamilyId: "family-admin", sessionId: "session-peer",
      artifactId: committed.artifactId, nowMs: Date.now(),
    })).rejects.toMatchObject({ status: 404 });

    const restarted = await createServerPrivateDiagnosticsArtifactStore(root, {
      maxArtifacts: 1, maxStorageBytes: 1_048_576,
    });
    const restored = await restarted.read({
      actorId: "admin", sessionFamilyId: "family-admin", sessionId: "session-admin",
      artifactId: committed.artifactId, nowMs: Date.now(),
    });
    expect(restored.filename).toBe(bundle.filename);
    expect(Buffer.from(restored.bytes)).toEqual(Buffer.from(bundle.bytes));
    await expect(restarted.commit({
      principal, filename: bundle.filename, mediaType: bundle.mediaType, bytes: bundle.bytes,
      manifest: bundle.manifest, expiresAtMs: Date.now() + 60_000,
    })).rejects.toThrow("storage is full");

    const modes = await Promise.all((await readdir(root)).map(async (entry) =>
      (await stat(join(root, entry))).mode & 0o777));
    expect(modes).toEqual([0o600, 0o600]);
  });

  it("performs a bounded startup sweep and schedules a one-second tail retry without a timer", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    vi.setSystemTime(nowMs);
    const root = await temporaryDirectory();
    const artifactRoot = join(root, "artifacts");
    const bundle = createDiagnosticsBundle({ generatedAt: new Date(nowMs).toISOString(), entries: [] });
    const principal = Object.freeze({
      actorId: "admin", sessionFamilyId: "family-admin", sessionId: "session-admin",
      principalKind: "tenant_administrator" as const,
    });
    const store = await createServerPrivateDiagnosticsArtifactStore(artifactRoot, {
      maxArtifacts: 40, maxStorageBytes: 32 * 1_048_576,
    });
    for (let index = 0; index < 33; index += 1) {
      await store.commit({
        principal, filename: bundle.filename, mediaType: bundle.mediaType, bytes: bundle.bytes,
        manifest: bundle.manifest, expiresAtMs: nowMs + 1,
      });
    }
    vi.setSystemTime(nowMs + 2);
    const transport = await createAuthenticatedPrivacyOperationsTransport({
      auth: { async authenticateSession() { throw new Error("unused"); } },
      worker: {} as CompleteWorkerDatabaseClient,
      artifactRoot,
      auditPath: join(root, "audit.jsonl"),
    });

    expect((await readdir(artifactRoot)).filter((entry) => entry.endsWith(".json")))
      .toHaveLength(1);
    await expect(transport.runMaintenance(nowMs + 1_001)).resolves.toEqual({
      status: "not_due", removed: 0, hasMore: true,
    });
    await expect(transport.runMaintenance(nowMs + 1_002)).resolves.toEqual({
      status: "swept", removed: 1, hasMore: false,
    });
    expect(await readdir(artifactRoot)).toEqual([]);
    await transport.close();
  });

  it("retries a failed periodic sweep after one second and stays hourly when caught up", async () => {
    let calls = 0;
    const sweepExpired = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("temporary artifact storage failure");
      return { removed: 0, hasMore: false };
    });
    const nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const maintenance = await createDiagnosticsArtifactMaintenance({ sweepExpired }, nowMs);

    await expect(maintenance.run(nowMs + 60 * 60 * 1_000))
      .rejects.toThrow("temporary artifact storage failure");
    await expect(maintenance.run(nowMs + 60 * 60 * 1_000 + 999)).resolves.toEqual({
      status: "not_due", removed: 0, hasMore: false,
    });
    await expect(maintenance.run(nowMs + 60 * 60 * 1_000 + 1_000)).resolves.toEqual({
      status: "swept", removed: 0, hasMore: false,
    });
    expect(sweepExpired).toHaveBeenCalledTimes(3);
    expect(sweepExpired).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 32 }));
  });
});

describe("metadata-only durable privacy audit", () => {
  it("serializes bounded appends and rejects raw-material keys", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "audit.jsonl");
    const record = Object.freeze({
      kind: "diagnostics" as const,
      event: Object.freeze({
        actorId: "admin", occurredAt: "2026-09-01T00:00:00.000Z",
        result: "failed" as const, failureCode: "source_unavailable" as const,
      }),
    });
    const oneRecordBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    const sink = await createPrivacyOperationsMetadataAuditFileSink(path, { maxBytes: oneRecordBytes });

    const results = await Promise.allSettled([sink.append(record), sink.append(record)]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
    await expect(sink.append({ ...record, body: "raw-corpus" } as never))
      .rejects.toThrow("forbidden material");
  });
});

describe("authenticated privacy operations host transport", () => {
  it("derives the exact session, streams Room bytes, and only persists metadata audit", async () => {
    const root = await temporaryDirectory();
    const operations: PrivacyDataAuthorityOperation[] = [];
    let administratorActive = true;
    const executePrivacyData = vi.fn(async (
      operation: PrivacyDataAuthorityOperation,
    ): Promise<PrivacyDataAuthorityResult> => {
      operations.push(operation);
      switch (operation.type) {
        case "privacy.diagnostics.authorize":
          if (!administratorActive) throw Object.assign(new Error("role revoked"), { status: 403 });
          return { kind: "diagnostics-principal", actorId: operation.actorId,
            sessionFamilyId: operation.sessionFamilyId, sessionId: operation.sessionId,
            principalKind: "tenant_administrator" };
        case "privacy.diagnostics.read-closed":
          return { kind: "diagnostics-entries", entries: [{
            category: "schema", code: "current", occurredAt: "2026-09-01T00:00:00.000Z",
            metadata: { version: 29 },
          }] };
        case "privacy.room-export.inspect-session":
          return { kind: "room-export-session", session: {
            actorId: operation.actorId, sessionFamilyId: operation.sessionFamilyId,
            sessionId: operation.sessionId, tenantId: "deployment-singleton",
            principalKind: "human", active: true,
          } };
        case "privacy.room-export.inspect-access":
          return { kind: "room-export-access", access: {
            actorId: operation.actorId, tenantId: "deployment-singleton", roomId: operation.roomId,
            membershipRole: "owner", lifecycle: "active", accessRevision: 7,
            exportAllowed: true,
          } };
        case "privacy.room-export.begin":
          return { kind: "room-export-snapshot", snapshot: {
            exportId: "export-1", roomId: operation.roomId, watermark: 42,
            accessRevision: 7, startedAt: "2026-09-01T00:00:00.000Z",
          } };
        case "privacy.room-export.reauthorize":
          return { kind: "room-export-reauthorized" };
        case "privacy.room-export.read-page":
          return { kind: "room-export-page", records: [{
            tenantId: "deployment-singleton", roomId: operation.roomId, category: "project_fact",
            entityId: "fact-1", revision: 1, payload: { topicKey: "room-corpus-sentinel" },
          }] };
      }
    });
    const worker = { executePrivacyData, runBatch: vi.fn(), close: vi.fn() } as unknown as
      CompleteWorkerDatabaseClient;
    const authenticateSession = vi.fn(async (accessToken: string) => {
      const owner = accessToken.startsWith("owner");
      return {
        sessionId: accessToken.endsWith("peer") ? "session-peer" : `session-${owner ? "owner" : "admin"}`,
        sessionFamilyId: `family-${owner ? "owner" : "admin"}`,
        principal: { accountId: `account-${owner ? "owner" : "admin"}`, actorId: owner ? "owner" : "admin" },
      };
    });
    const transport = await createAuthenticatedPrivacyOperationsTransport({
      auth: { authenticateSession } as Pick<AuthenticationService, "authenticateSession">,
      worker, artifactRoot: join(root, "artifacts"), auditPath: join(root, "audit.jsonl"),
    });

    const diagnostics = await transport.generateDiagnostics("admin-token");
    const artifact = await transport.readDiagnosticsArtifact("admin-token", diagnostics.artifactId);
    expect(new TextDecoder().decode(artifact.bytes)).toContain('"category":"schema"');
    await expect(transport.readDiagnosticsArtifact("admin-peer", diagnostics.artifactId))
      .rejects.toMatchObject({ status: 404 });
    administratorActive = false;
    await expect(transport.readDiagnosticsArtifact("admin-token", diagnostics.artifactId))
      .rejects.toMatchObject({ status: 403, code: "administrator_required" });
    administratorActive = true;

    const chunks: Uint8Array[] = [];
    for await (const chunk of transport.streamRoomExport("owner-token", "room-1")) chunks.push(chunk);
    const exported = new TextDecoder().decode(Buffer.concat(chunks));
    expect(exported).toContain("room-corpus-sentinel");
    expect(operations.filter(({ actorId }) => actorId === "owner"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "session-owner" })]));
    expect(await readFile(join(root, "audit.jsonl"), "utf8")).not.toContain("room-corpus-sentinel");
    expect(await readdir(root)).toEqual(["artifacts", "audit.jsonl"]);
    expect("credentialRotation" in transport).toBe(false);
    await transport.close();
  });
});
