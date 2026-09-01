import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDesktopDiagnosticsRuntime } from "./runtime.js";

const filename = "dao-diagnostics-2026-09-01T00-00-00.000Z.ndjson";
const expiresAt = "2026-09-02T00:00:00.000Z";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function diagnostic(overrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(`${canonical({
    category: "worker", code: "healthy", occurredAt: "2026-09-01T00:00:00.000Z",
    stableId: "retention_janitor", state: "ready", queueDepth: 0,
    metadata: { maxActive: 1, maxBatch: 256, maxQueue: 0 }, ...overrides,
  })}\n`);
}

function fixture(bytes = diagnostic()) {
  let sequence = 0;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const transport = {
    generate: vi.fn(async (command: { requestId: string }) => ({
      type: "diagnostics.generated" as const, requestId: command.requestId,
      streamId: "stream-1", artifactId: "artifact-1", filename,
      mediaType: "application/x-ndjson" as const, byteLength: bytes.byteLength,
      sha256, expiresAt, chunkSize: 49_152 as const,
    })),
    read: vi.fn(async (command: { requestId: string; streamId: string; offset: number }) => {
      const chunk = bytes.subarray(command.offset, Math.min(command.offset + 49_152, bytes.byteLength));
      return { type: "diagnostics.chunk" as const, requestId: command.requestId,
        streamId: command.streamId, offset: command.offset, byteLength: chunk.byteLength,
        base64: Buffer.from(chunk).toString("base64"), eof: command.offset + chunk.byteLength === bytes.byteLength };
    }),
    abort: vi.fn(async (command: { requestId: string; streamId: string }) => ({
      type: "diagnostics.aborted" as const, requestId: command.requestId,
      streamId: command.streamId,
    })),
  };
  const order: string[] = [];
  const file = { write: vi.fn(async () => { order.push("write"); }),
    sync: vi.fn(async () => { order.push("sync"); }),
    close: vi.fn(async () => { order.push("close"); }) };
  const fs = { openTemporary: vi.fn(async () => { order.push("temp"); return file; }),
    rename: vi.fn(async () => { order.push("rename"); }),
    remove: vi.fn(async () => { order.push("remove"); }) };
  const saveDialog = { chooseDestination: vi.fn(async () => {
    order.push("dialog"); return "/native-selected/diagnostics.ndjson";
  }) };
  const runtime = createDesktopDiagnosticsRuntime({ transport, saveDialog, fs,
    randomId: () => "opaque-temp", createRequestId: (kind) => `${kind}-${++sequence}` });
  return { runtime, transport, saveDialog, fs, file, order, bytes };
}

describe("FT-14 Desktop diagnostics native save runtime", () => {
  it("streams a closed bundle to a native-selected atomic destination and verifies checksum", async () => {
    const bytes = Uint8Array.from([...diagnostic(), ...diagnostic({
      category: "schema", code: "current", stableId: "schema-v29",
      metadata: { configured: true, schemaVersion: 29, version: 29 },
    })]);
    const target = fixture(bytes);
    await expect(target.runtime.save()).resolves.toEqual({ status: "saved" });
    expect(target.saveDialog.chooseDestination).toHaveBeenCalledWith(filename);
    expect(target.fs.openTemporary).toHaveBeenCalledWith(
      "/native-selected/diagnostics.ndjson.part-opaque-temp",
    );
    expect(target.file.write).toHaveBeenCalled();
    expect(target.fs.rename).toHaveBeenCalledWith(
      "/native-selected/diagnostics.ndjson.part-opaque-temp",
      "/native-selected/diagnostics.ndjson",
    );
    expect(target.order.indexOf("sync")).toBeLessThan(target.order.indexOf("rename"));
    expect(target.transport.abort).not.toHaveBeenCalled();
  });

  it("cancels with no partial file and releases the remote stream", async () => {
    const target = fixture();
    target.saveDialog.chooseDestination.mockResolvedValueOnce(undefined);
    await expect(target.runtime.save()).resolves.toEqual({ status: "cancelled" });
    expect(target.fs.openTemporary).not.toHaveBeenCalled();
    expect(target.transport.abort).toHaveBeenCalledOnce();
  });

  it("rejects noncanonical, corpus/secret-shaped, and checksum-drift artifacts", async () => {
    const unsafe = [
      new TextEncoder().encode('{"code":"healthy", "category":"worker"}\n'),
      diagnostic({ body: "raw-message-canary" }),
      diagnostic({ metadata: { retryable: "provider-secret-canary" } }),
    ];
    for (const bytes of unsafe) {
      const target = fixture(bytes);
      await expect(target.runtime.save()).rejects.toMatchObject({ diagnosticsError: {
        status: 503, code: "diagnostics_invalid_artifact",
      } });
      expect(target.fs.remove).toHaveBeenCalledWith(
        "/native-selected/diagnostics.ndjson.part-opaque-temp",
      );
      expect(target.fs.rename).not.toHaveBeenCalled();
      expect(target.transport.abort).toHaveBeenCalledOnce();
    }

    const drift = fixture();
    drift.transport.generate.mockImplementationOnce(async (command) => ({
      type: "diagnostics.generated" as const, requestId: command.requestId,
      streamId: "stream-1", artifactId: "artifact-1", filename,
      mediaType: "application/x-ndjson" as const, byteLength: drift.bytes.byteLength,
      sha256: "0".repeat(64), expiresAt, chunkSize: 49_152 as const,
    }));
    await expect(drift.runtime.save()).rejects.toMatchObject({ diagnosticsError: {
      status: 503, code: "diagnostics_invalid_artifact",
    } });
    expect(drift.fs.remove).toHaveBeenCalledOnce();
  });

  it("preserves only the closed 401/403/409/410/429/503 recovery classification", async () => {
    for (const diagnosticsError of [
      { status: 401, code: "authentication_required" },
      { status: 403, code: "administrator_required" },
      { status: 409, code: "diagnostics_stream_conflict" },
      { status: 410, code: "diagnostics_artifact_gone" },
      { status: 429, code: "diagnostics_capacity_limited", retryAfterMs: 1_000 },
      { status: 503, code: "diagnostics_unavailable" },
    ] as const) {
      const target = fixture();
      target.transport.generate.mockRejectedValueOnce(Object.assign(
        new Error("token-path-canary /private/db"), { diagnosticsError },
      ));
      const result = target.runtime.save();
      await expect(result).rejects.toMatchObject({ diagnosticsError });
      await expect(result).rejects.not.toThrow(/token-path|private\/db/u);
    }
  });

  it("aborts and removes a partial output when authorized state is invalidated", async () => {
    const target = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    target.transport.read.mockImplementationOnce(async (command) => {
      await gate;
      return { type: "diagnostics.chunk" as const, requestId: command.requestId,
        streamId: command.streamId, offset: command.offset, byteLength: 0,
        base64: "", eof: true };
    });
    const saving = target.runtime.save();
    await vi.waitFor(() => expect(target.transport.read).toHaveBeenCalledOnce());
    await target.runtime.invalidateAuthorizedState();
    release();
    await expect(saving).rejects.toMatchObject({ diagnosticsError: {
      status: 410, code: "diagnostics_artifact_gone",
    } });
    expect(target.fs.remove).toHaveBeenCalledOnce();
    expect(target.transport.abort).toHaveBeenCalledOnce();
  });

  it("uses the generate request as a provisional stream so invalidation can preempt generation", async () => {
    const target = fixture();
    let resolveGeneration!: (value: Awaited<ReturnType<typeof target.transport.generate>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof target.transport.generate>>>((resolve) => {
      resolveGeneration = resolve;
    });
    target.transport.generate.mockImplementationOnce(() => pending);
    const saving = target.runtime.save();
    await vi.waitFor(() => expect(target.transport.generate).toHaveBeenCalledOnce());
    await target.runtime.invalidateAuthorizedState();
    expect(target.transport.abort).toHaveBeenCalledWith(expect.objectContaining({
      streamId: "generate-1",
    }));
    resolveGeneration({
      type: "diagnostics.generated", requestId: "generate-1", streamId: "stream-1",
      artifactId: "artifact-1", filename, mediaType: "application/x-ndjson",
      byteLength: target.bytes.byteLength,
      sha256: createHash("sha256").update(target.bytes).digest("hex"),
      expiresAt, chunkSize: 49_152,
    });
    await expect(saving).rejects.toMatchObject({ diagnosticsError: {
      status: 410, code: "diagnostics_artifact_gone",
    } });
    expect(target.saveDialog.chooseDestination).not.toHaveBeenCalled();
  });
});
