import { describe, expect, it, vi } from "vitest";
import { createRoomDataExport, ROOM_EXPORT_MAX_PAGE_RECORDS, type RoomExportAuthority } from "./room-export.js";

const INPUT = Object.freeze({
  actorId: "human-1", roomId: "room-1", sessionFamilyId: "family-1", sessionId: "session-1",
});

function authority(overrides: Partial<RoomExportAuthority> = {}): RoomExportAuthority {
  return {
    async authorize(input) { return { ...input, accessRevision: 7, lifecycle: "active", role: "owner" }; },
    async begin(input) { return { exportId: "export-1", roomId: input.roomId, watermark: 42, accessRevision: input.accessRevision, startedAt: "2026-08-31T00:00:00.000Z" }; },
    async reauthorize() {},
    async readPage() { return { records: [] }; },
    async release() {},
    async audit() {},
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string[]> {
  const lines: string[] = [];
  for await (const chunk of stream) lines.push(new TextDecoder().decode(chunk));
  return lines;
}

describe("FT-14 owner Room data export", () => {
  it.each([
    { exportId: "", startedAt: "2026-08-31T00:00:00.000Z" },
    { exportId: "export-1", startedAt: "not-a-canonical-time" },
    { exportId: "export-1", startedAt: "2026-08-31T00:00:00Z" },
  ])("rejects an invalid snapshot identity/time before emitting bytes: %o", async (snapshot) => {
    const readPage = vi.fn();
    const service = createRoomDataExport({ authority: authority({
      async begin(input) {
        return { ...snapshot, roomId: input.roomId, watermark: 42, accessRevision: input.accessRevision };
      },
      readPage,
    }) });
    const iterator = service.stream(INPUT)[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("room_export_invalid_snapshot");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("emits no bytes for non-owner authorization failure", async () => {
    const readPage = vi.fn();
    const service = createRoomDataExport({ authority: authority({
      async authorize() { throw new Error("forbidden"); }, readPage,
    }) });
    const iterator = service.stream(INPUT)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("room_export_forbidden");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("reauthorizes the exact snapshot before emitting the header", async () => {
    const readPage = vi.fn();
    const audit = vi.fn(async () => {});
    const service = createRoomDataExport({ authority: authority({
      async reauthorize() { throw new Error("revoked before header"); },
      readPage,
      audit,
    }) });
    const iterator = service.stream(INPUT)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow("revoked before header");
    expect(readPage).not.toHaveBeenCalled();
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      result: "failed", failureCode: "access_revoked",
    }));
  });

  it("releases context and writes terminal aborted metadata when the consumer returns", async () => {
    const release = vi.fn(async () => {});
    const audit = vi.fn(async () => {});
    const service = createRoomDataExport({ authority: authority({ release, audit }) });
    const iterator = service.stream(INPUT)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);

    await iterator.return?.();

    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      result: "aborted", failureCode: "client_aborted",
    }));
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      exportId: "export-1",
      authorization: expect.objectContaining({ sessionId: "session-1" }),
    }));
  });

  it("releases context and writes a typed terminal failure on operation timeout", async () => {
    const controller = new AbortController();
    const release = vi.fn(async () => {});
    const audit = vi.fn(async () => {});
    const iterator = createRoomDataExport({ authority: authority({ release, audit }) })
      .stream(INPUT, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    controller.abort();
    await iterator.return?.();

    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      result: "failed", failureCode: "operation_timeout",
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases authorization on begin failure and snapshot state on audit failure", async () => {
    const beginRelease = vi.fn(async () => {});
    const beginService = createRoomDataExport({ authority: authority({
      async begin() { throw new Error("begin failed"); },
      release: beginRelease,
    }) });
    await expect(beginService.stream(INPUT)[Symbol.asyncIterator]().next())
      .rejects.toThrow("begin failed");
    expect(beginRelease).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({ sessionId: "session-1" }),
    }));

    const release = vi.fn(async () => {});
    const audits: unknown[] = [];
    let auditCalls = 0;
    const auditService = createRoomDataExport({ authority: authority({
      release,
      async audit(event) {
        auditCalls += 1;
        if (auditCalls === 1) throw new Error("audit unavailable");
        audits.push(event);
      },
    }) });
    await expect(auditService.stream(INPUT)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: "audit_unavailable", status: 503 });
    expect(audits).toContainEqual(expect.objectContaining({
      result: "failed", failureCode: "audit_unavailable",
    }));
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ exportId: "export-1" }));
  });

  it("withholds the final manifest and releases context when success audit fails", async () => {
    const release = vi.fn(async () => {});
    const audits: unknown[] = [];
    let auditCalls = 0;
    const iterator = createRoomDataExport({ authority: authority({
      release,
      async audit(event) {
        auditCalls += 1;
        if (auditCalls === 2) throw new Error("terminal audit unavailable");
        audits.push(event);
      },
    }) }).stream(INPUT)[Symbol.asyncIterator]();

    expect(JSON.parse(new TextDecoder().decode((await iterator.next()).value))).toMatchObject({
      type: "header",
    });
    await expect(iterator.next()).rejects.toMatchObject({
      code: "audit_unavailable", status: 503,
    });
    expect(audits).toContainEqual(expect.objectContaining({
      result: "failed", failureCode: "audit_unavailable",
    }));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { cancellation: "client" as const, late: "resolve" as const, expected: "succeeded" },
    { cancellation: "client" as const, late: "reject" as const, expected: "aborted" },
    { cancellation: "timeout" as const, late: "resolve" as const, expected: "succeeded" },
    { cancellation: "timeout" as const, late: "reject" as const, expected: "failed" },
  ])("keeps one terminal truth when $cancellation cancellation races a late audit $late", async ({
    cancellation, late, expected,
  }) => {
    let settle!: () => void;
    let fail!: (error: Error) => void;
    let terminalStarted!: () => void;
    const deferred = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
    const enteredTerminal = new Promise<void>((resolve) => { terminalStarted = resolve; });
    const terminals: Array<Record<string, unknown>> = [];
    const release = vi.fn(async () => {});
    const controller = new AbortController();
    const iterator = createRoomDataExport({ authority: authority({
      release,
      async audit(event) {
        if (event.result === "started") return;
        if (event.result === "succeeded") {
          terminalStarted();
          await deferred;
        }
        terminals.push(event);
      },
    }) }).stream(INPUT, controller.signal)[Symbol.asyncIterator]();

    const emitted: string[] = [];
    emitted.push(new TextDecoder().decode((await iterator.next()).value));
    const final = iterator.next();
    await enteredTerminal;
    controller.abort(cancellation === "client"
      ? Object.assign(new Error("client abort"), { code: "client_aborted" })
      : undefined);
    await expect(final).rejects.toMatchObject({
      code: cancellation === "client" ? "client_aborted" : "operations_timeout",
    });
    if (late === "resolve") settle();
    else fail(new Error("terminal append rejected"));

    await vi.waitFor(() => expect(terminals).toHaveLength(1));
    expect(terminals[0]).toMatchObject({ result: expected });
    expect(emitted.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: "header" }),
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("audits typed storage_unavailable instead of misclassifying it as revocation", async () => {
    const audit = vi.fn(async () => {});
    const service = createRoomDataExport({ authority: authority({
      async readPage() {
        throw Object.assign(new Error("storage unavailable"), {
          code: "storage_unavailable", status: 503,
        });
      },
      audit,
    }) });
    const iterator = service.stream(INPUT)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    await expect(iterator.next()).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({
      result: "failed", failureCode: "storage_unavailable",
    }));
  });

  it("uses one fixed authority watermark, bounded pages, record digests and a final manifest", async () => {
    const readPage = vi.fn(async (input: { watermark: number; limit: number; after?: string }) => {
      expect(input.watermark).toBe(42); expect(input.limit).toBe(ROOM_EXPORT_MAX_PAGE_RECORDS);
      return input.after === undefined
        ? { records: [{ category: "message" as const, entityId: "message-1", revision: 0, payload: { body: "authorized recalled original", authorId: "human-1" } }], next: "page-2" }
        : { records: [{ category: "project_fact" as const, entityId: "goal-1", revision: 2, payload: { kind: "goal", status: "active" } }] };
    });
    const audits: unknown[] = [];
    const service = createRoomDataExport({ authority: authority({ readPage, async audit(event) { audits.push(event); } }), now: () => new Date("2026-08-31T00:01:00.000Z") });
    const lines = await collect(service.stream(INPUT));
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "header", watermark: 42 });
    expect(JSON.parse(lines[3]!)).toMatchObject({ type: "manifest", watermark: 42, recordCount: 2, categories: [{ category: "message", count: 1 }, { category: "project_fact", count: 1 }] });
    expect(audits).toEqual([expect.objectContaining({ result: "started", watermark: 42 }), expect.objectContaining({ result: "succeeded", manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  });

  it("revalidates before every page and complete so revoke stops further bytes", async () => {
    let checks = 0;
    const audit = vi.fn();
    const service = createRoomDataExport({ authority: authority({
      async reauthorize() { checks += 1; if (checks === 3) throw new Error("revoked"); },
      async readPage(input) { return input.after === undefined
        ? { records: [{ category: "message" as const, entityId: "message-1", revision: 0, payload: { body: "first" } }], next: "next" }
        : { records: [] }; },
      audit,
    }) });
    const iterator = service.stream(INPUT)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false); // header
    expect((await iterator.next()).done).toBe(false); // first authorized record
    await expect(iterator.next()).rejects.toThrow("revoked");
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ result: "failed", failureCode: "access_revoked" }));
  });

  it.each([
    "credential", "sessionToken", "hiddenReasoning", "headers", "encryptionKey",
    "providerRequest", "apiKey", "privateKey",
  ])(
    "rejects forbidden %s fields from the authority adapter",
    async (key) => {
      const service = createRoomDataExport({ authority: authority({ async readPage() {
        return { records: [{ category: "message", entityId: "message-1", revision: 0, payload: { [key]: "sentinel" } }] };
      } }) });
      await expect(collect(service.stream(INPUT))).rejects.toThrow("forbidden security material");
    },
  );

  it("allows non-secret topic and provider identity metadata", async () => {
    const service = createRoomDataExport({ authority: authority({ async readPage() {
      return { records: [{
        category: "project_fact", entityId: "fact-1", revision: 1,
        payload: { topicKey: "roadmap", providerId: "provider-safe" },
      }] };
    } }) });
    await expect(collect(service.stream(INPUT))).resolves.toHaveLength(3);
  });
});
