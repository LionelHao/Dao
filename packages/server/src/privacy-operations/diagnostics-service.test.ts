import { describe, expect, it, vi } from "vitest";
import {
  createDiagnosticsService,
  DiagnosticsServiceError,
  type DiagnosticsServiceAuthority,
} from "./diagnostics-service.js";
import { createOperationsWorkerLimiter } from "./worker-limiter.js";

const GENERATED_AT = "2026-08-31T08:00:00.000Z";
const REQUEST = Object.freeze({
  actorId: "human-tenant-admin",
  sessionFamilyId: "family-1",
  sessionId: "session-1",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accepted, rejected) => {
    resolve = accepted;
    reject = rejected;
  });
  return { promise, resolve, reject };
}

function authority(
  overrides: Partial<DiagnosticsServiceAuthority> = {},
): DiagnosticsServiceAuthority {
  return {
    async authorize(input) {
      return {
        actorId: input.actorId,
        sessionFamilyId: input.sessionFamilyId,
        sessionId: input.sessionId,
        principalKind: "tenant_administrator",
      };
    },
    async readClosedEntries() {
      return [{
        category: "worker",
        code: "healthy",
        occurredAt: GENERATED_AT,
        queueDepth: 0,
      }];
    },
    async commitArtifact(input) {
      return { artifactId: "diagnostics-artifact-1", byteLength: input.bytes.byteLength };
    },
    async discardArtifact() {},
    async audit() {},
    ...overrides,
  };
}

describe("FT-14 production-composable diagnostics service", () => {
  it("authorizes deployment operations without accepting Room scope or returning bundle bytes", async () => {
    const readClosedEntries = vi.fn(authority().readClosedEntries);
    const service = createDiagnosticsService({
      authority: authority({ readClosedEntries }),
      now: () => new Date(GENERATED_AT),
    });

    const result = await service.generate(REQUEST);

    expect(readClosedEntries).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({ principalKind: "tenant_administrator" }),
      limit: 10_000,
    }));
    expect(result).toMatchObject({
      artifactId: "diagnostics-artifact-1",
      filename: expect.stringMatching(/^dao-diagnostics-/),
      expiresAt: "2026-09-01T08:00:00.000Z",
      manifest: { entryCount: 1 },
    });
    expect(result).not.toHaveProperty("bytes");

    await expect(service.generate({
      ...REQUEST,
      roomId: "room-must-not-be-an-authority-input",
    } as never)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("produces zero artifact bytes and zero source reads when authorization fails", async () => {
    const readClosedEntries = vi.fn();
    const commitArtifact = vi.fn();
    const service = createDiagnosticsService({ authority: authority({
      async authorize() { throw new Error("not a tenant administrator"); },
      readClosedEntries,
      commitArtifact,
    }) });

    await expect(service.generate({ ...REQUEST, actorId: "human-room-owner" }))
      .rejects.toEqual(expect.objectContaining({ code: "forbidden" }));
    expect(readClosedEntries).not.toHaveBeenCalled();
    expect(commitArtifact).not.toHaveBeenCalled();
  });

  it("rejects corpus/secret canaries before the atomic artifact sink is called", async () => {
    const commitArtifact = vi.fn();
    const audit = vi.fn(async () => {});
    const service = createDiagnosticsService({ authority: authority({
      async readClosedEntries() {
        return [{
          category: "error_classification",
          code: "provider_failure",
          occurredAt: GENERATED_AT,
          metadata: { detail: "raw Room corpus sentinel" },
        }] as never;
      },
      commitArtifact,
      audit,
    }) });

    await expect(service.generate(REQUEST))
      .rejects.toBeInstanceOf(DiagnosticsServiceError);
    expect(commitArtifact).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      result: "failed",
      failureCode: "unsafe_diagnostic",
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("raw Room corpus sentinel");
  });

  it("commits a bounded artifact atomically with the 24 hour server retention boundary", async () => {
    const commitArtifact = vi.fn(authority().commitArtifact);
    const audit = vi.fn(async () => {});
    const service = createDiagnosticsService({
      authority: authority({ commitArtifact, audit }),
      now: () => new Date(GENERATED_AT),
    });

    await service.generate(REQUEST);

    expect(commitArtifact).toHaveBeenCalledTimes(1);
    expect(commitArtifact).toHaveBeenCalledWith(expect.objectContaining({
      expiresAtMs: Date.parse(GENERATED_AT) + 24 * 60 * 60 * 1_000,
      mediaType: "application/x-ndjson",
    }));
    expect(ArrayBuffer.isView(commitArtifact.mock.calls[0]?.[0].bytes)).toBe(true);
    expect(commitArtifact.mock.calls[0]?.[0].bytes.byteLength).toBeGreaterThan(0);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      result: "succeeded",
      artifactId: "diagnostics-artifact-1",
      entryCount: 1,
    }));
  });

  it("discards a committed artifact when success audit publication fails", async () => {
    const discarded: string[] = [];
    let auditAttempt = 0;
    const service = createDiagnosticsService({ authority: authority({
      async discardArtifact(input) { discarded.push(input.artifactId); },
      async audit(input) {
        auditAttempt += 1;
        if (input.result === "succeeded") throw new Error("audit unavailable");
      },
    }) });

    await expect(service.generate(REQUEST)).rejects.toMatchObject({
      code: "artifact_unavailable",
    });
    expect(discarded).toEqual(["diagnostics-artifact-1"]);
    expect(auditAttempt).toBe(2);
  });

  it("treats resolved success audit as the terminal commit point", async () => {
    const controller = new AbortController();
    const discardArtifact = vi.fn(async () => {});
    const service = createDiagnosticsService({ authority: authority({
      discardArtifact,
      async audit() {},
    }) });

    await expect(service.generate(REQUEST, controller.signal)).resolves.toMatchObject({
      artifactId: "diagnostics-artifact-1",
    });
    controller.abort();
    expect(discardArtifact).not.toHaveBeenCalled();
  });

  it("does not miss an abort raised synchronously while an authority await starts", async () => {
    const controller = new AbortController();
    const service = createDiagnosticsService({ authority: authority({
      authorize: (input) => {
        controller.abort();
        return Promise.resolve({ ...input, principalKind: "tenant_administrator" });
      },
    }) });
    await expect(service.generate(REQUEST, controller.signal)).rejects.toMatchObject({
      code: "source_unavailable",
    });
  });

  it("bounds never-resolving authorize, read, and commit authority awaits", async () => {
    for (const blocked of ["authorize", "readClosedEntries", "commitArtifact"] as const) {
      const controller = new AbortController();
      const overrides: Partial<DiagnosticsServiceAuthority> = {
        [blocked]: vi.fn(() => new Promise<never>(() => undefined)),
      };
      const service = createDiagnosticsService({ authority: authority(overrides) });
      const generation = service.generate(REQUEST, controller.signal);
      await Promise.resolve();
      controller.abort();
      await expect(generation).rejects.toMatchObject({ code: "source_unavailable" });
    }
  });

  it("observes late rejection and discards a commit which succeeds after cancellation", async () => {
    const controller = new AbortController();
    const pendingAuthorize = deferred<never>();
    const rejected = createDiagnosticsService({ authority: authority({
      authorize: () => pendingAuthorize.promise,
    }) });
    const authorization = rejected.generate(REQUEST, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(authorization).rejects.toMatchObject({ code: "source_unavailable" });
    pendingAuthorize.reject(new Error("late authority rejection"));
    await Promise.resolve();

    const commitController = new AbortController();
    const pendingCommit = deferred<{ artifactId: string; byteLength: number }>();
    const discardArtifact = vi.fn(async () => {});
    const commitArtifact = vi.fn(() => pendingCommit.promise);
    const service = createDiagnosticsService({ authority: authority({
      commitArtifact,
      discardArtifact,
    }) });
    const generation = service.generate(REQUEST, commitController.signal);
    await vi.waitFor(() => expect(commitArtifact).toHaveBeenCalledOnce());
    commitController.abort();
    await expect(generation).rejects.toMatchObject({ code: "source_unavailable" });
    pendingCommit.resolve({ artifactId: "late-artifact", byteLength: 1 });
    await vi.waitFor(() => expect(discardArtifact).toHaveBeenCalledWith({
      principal: expect.any(Object), artifactId: "late-artifact",
    }));
  });

  it("retains an artifact while success audit is pending, then follows its late truth", async () => {
    for (const outcome of ["success", "failure"] as const) {
      const controller = new AbortController();
      const pendingAudit = deferred<void>();
      const discardArtifact = vi.fn(async () => {});
      const audit = vi.fn((input: Parameters<DiagnosticsServiceAuthority["audit"]>[0]) =>
        input.result === "succeeded" ? pendingAudit.promise : Promise.resolve());
      const service = createDiagnosticsService({ authority: authority({ audit, discardArtifact }) });
      const generation = service.generate(REQUEST, controller.signal);
      await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        result: "succeeded",
      })));
      controller.abort();
      await expect(generation).rejects.toMatchObject({ code: "source_unavailable" });
      expect(discardArtifact).not.toHaveBeenCalled();
      if (outcome === "success") pendingAudit.resolve();
      else pendingAudit.reject(new Error("late audit failure"));
      await Promise.resolve();
      if (outcome === "success") {
        expect(discardArtifact).not.toHaveBeenCalled();
        expect(audit).toHaveBeenCalledTimes(1);
      } else {
        await vi.waitFor(() => expect(discardArtifact).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({
          result: "failed", failureCode: "artifact_unavailable",
        })));
      }
    }
  });

  it("releases a timed-out limiter permit so the next peer succeeds", async () => {
    let authorizationCall = 0;
    const service = createDiagnosticsService({ authority: authority({
      authorize: async (input) => {
        authorizationCall += 1;
        if (authorizationCall === 1) return new Promise<never>(() => undefined);
        return { ...input, principalKind: "tenant_administrator" };
      },
    }) });
    const limiter = createOperationsWorkerLimiter({ maxActive: 1, maxQueue: 1, timeoutMs: 20 });
    const first = limiter.run((signal) => service.generate(REQUEST, signal));
    const second = limiter.run((signal) => service.generate(REQUEST, signal));
    await expect(first).rejects.toMatchObject({ code: "operations_timeout" });
    await expect(second).resolves.toMatchObject({ artifactId: "diagnostics-artifact-1" });
    await vi.waitFor(() => expect(limiter.inspect()).toEqual({ active: 0, queued: 0 }));
  });
});
