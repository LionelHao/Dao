import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES } from "@native-im/core";
import {
  createDiagnosticsWebSocketConnection,
  type DiagnosticsAuthenticatedArtifactTransport,
} from "./diagnostics-websocket-transport.js";

const filename = "dao-diagnostics-2026-09-01T00-00-00.000Z.ndjson";
const expiresAt = "2026-09-02T00:00:00.000Z";

function fixture(bytes = Buffer.alloc(DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES + 7, 23)) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const authority: DiagnosticsAuthenticatedArtifactTransport = {
    generateDiagnostics: vi.fn(async (token) => {
      expect(token).toBe("same-authenticated-session");
      return { artifactId: "artifact-1", filename, mediaType: "application/x-ndjson",
        expiresAt, manifest: { byteLength: bytes.byteLength, sha256 } };
    }),
    readDiagnosticsArtifact: vi.fn(async (token) => {
      expect(token).toBe("same-authenticated-session");
      return { filename, mediaType: "application/x-ndjson", expiresAt, bytes };
    }),
  };
  const connection = createDiagnosticsWebSocketConnection({ authority,
    createStreamId: () => "stream-1" });
  return { authority, connection, bytes };
}

describe("FT-14 diagnostics same-session WebSocket seam", () => {
  it("generates one bounded stream and reauthorizes each checksum-verified chunk read", async () => {
    const target = fixture();
    const generated = await target.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "generate-1",
    });
    expect(generated).toMatchObject({ type: "diagnostics.generated", streamId: "stream-1",
      byteLength: target.bytes.byteLength, filename, chunkSize: 49_152 });
    await expect(target.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "over-capacity",
    })).rejects.toMatchObject({ diagnosticsError: {
      status: 429, code: "diagnostics_capacity_limited",
    } });
    const first = await target.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "read-1", streamId: "stream-1", offset: 0,
    });
    expect(first).toMatchObject({ type: "diagnostics.chunk", byteLength: 49_152, eof: false });
    await expect(target.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "read-replay", streamId: "stream-1", offset: 0,
    })).rejects.toMatchObject({ diagnosticsError: {
      status: 409, code: "diagnostics_stream_conflict",
    } });
    const last = await target.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "read-2", streamId: "stream-1", offset: 49_152,
    });
    expect(last).toMatchObject({ type: "diagnostics.chunk", byteLength: 7, eof: true });
    expect(target.authority.readDiagnosticsArtifact).toHaveBeenCalledTimes(2);
    expect(target.connection.inspect()).toMatchObject({ active: 0, generating: false });
    await expect(target.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "gone", streamId: "stream-1",
      offset: target.bytes.byteLength,
    })).rejects.toMatchObject({ diagnosticsError: {
      status: 410, code: "diagnostics_artifact_gone",
    } });
  });

  it("maps exact closed errors without leaking authority details", async () => {
    for (const [source, expected] of [
      [{ status: 401, message: "token-canary" },
        { status: 401, code: "authentication_required" }],
      [{ status: 403, message: "role-row-canary" },
        { status: 403, code: "administrator_required" }],
      [{ status: 429, code: "operations_capacity_limited", retryAfterMs: 1200 },
        { status: 429, code: "diagnostics_capacity_limited", retryAfterMs: 1200 }],
      [{ status: 503, message: "/private/artifact/path" },
        { status: 503, code: "diagnostics_unavailable" }],
    ] as const) {
      const target = fixture();
      vi.mocked(target.authority.generateDiagnostics).mockRejectedValueOnce(source);
      const request = target.connection.handle("same-authenticated-session", {
        type: "diagnostics.generate", requestId: "generate-1",
      });
      await expect(request).rejects.toMatchObject({ diagnosticsError: expected });
      await expect(request).rejects.not.toThrow(/canary|private/u);
    }
  });

  it("fails closed on offset/checksum drift and current-role revocation", async () => {
    const conflict = fixture();
    await conflict.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "generate-1",
    });
    await expect(conflict.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "conflict", streamId: "stream-1",
      offset: conflict.bytes.byteLength + 1,
    })).rejects.toMatchObject({ diagnosticsError: {
      status: 409, code: "diagnostics_stream_conflict",
    } });
    vi.mocked(conflict.authority.readDiagnosticsArtifact).mockResolvedValueOnce({
      filename, mediaType: "application/x-ndjson", expiresAt,
      bytes: Uint8Array.from([...conflict.bytes, 1]),
    });
    await expect(conflict.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "corrupt", streamId: "stream-1", offset: 0,
    })).rejects.toMatchObject({ diagnosticsError: {
      status: 503, code: "diagnostics_invalid_artifact",
    } });

    const revoked = fixture();
    await revoked.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "generate-2",
    });
    vi.mocked(revoked.authority.readDiagnosticsArtifact).mockRejectedValueOnce({ status: 403 });
    await expect(revoked.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "revoked", streamId: "stream-1", offset: 0,
    })).rejects.toMatchObject({ diagnosticsError: {
      status: 403, code: "administrator_required",
    } });
    expect(revoked.connection.inspect().active).toBe(0);
  });

  it("cleans active state on explicit abort and aborts generation on connection close", async () => {
    const target = fixture();
    await target.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "generate-1",
    });
    await expect(target.connection.handle("same-authenticated-session", {
      type: "diagnostics.abort", requestId: "abort-1", streamId: "stream-1",
    })).resolves.toMatchObject({ type: "diagnostics.aborted", streamId: "stream-1" });
    expect(target.connection.inspect().active).toBe(0);

    let observedSignal: AbortSignal | undefined;
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    vi.mocked(target.authority.generateDiagnostics).mockImplementationOnce(async (_token, signal) => {
      observedSignal = signal;
      await pending;
      throw { status: 503 };
    });
    const generating = target.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "generate-2",
    });
    await vi.waitFor(() => expect(target.connection.inspect().generating).toBe(true));
    target.connection.close();
    expect(observedSignal?.aborted).toBe(true);
    await expect(generating).rejects.toMatchObject({ diagnosticsError: { status: 410 } });
    settle();
    expect(target.connection.inspect()).toEqual({ active: 0, generating: false, closed: true });
  });

  it("lets same-connection abort preempt pending generation and read authority awaits", async () => {
    const target = fixture();
    let generationSignal: AbortSignal | undefined;
    vi.mocked(target.authority.generateDiagnostics).mockImplementationOnce((_token, signal) => {
      generationSignal = signal;
      return new Promise(() => undefined);
    });
    const generation = target.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "provisional-stream",
    });
    await vi.waitFor(() => expect(generationSignal).toBeDefined());
    await expect(target.connection.handle("same-authenticated-session", {
      type: "diagnostics.abort", requestId: "abort-generation",
      streamId: "provisional-stream",
    })).resolves.toMatchObject({ type: "diagnostics.aborted", streamId: "provisional-stream" });
    expect(generationSignal?.aborted).toBe(true);
    await expect(generation).rejects.toMatchObject({ diagnosticsError: { status: 410 } });

    const readable = fixture();
    await readable.connection.handle("same-authenticated-session", {
      type: "diagnostics.generate", requestId: "generate-read",
    });
    let readSignal: AbortSignal | undefined;
    vi.mocked(readable.authority.readDiagnosticsArtifact)
      .mockImplementationOnce((_token, _artifactId, signal) => {
        readSignal = signal;
        return new Promise(() => undefined);
      });
    const read = readable.connection.handle("same-authenticated-session", {
      type: "diagnostics.read", requestId: "read-pending", streamId: "stream-1", offset: 0,
    });
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    await expect(readable.connection.handle("same-authenticated-session", {
      type: "diagnostics.abort", requestId: "abort-read", streamId: "stream-1",
    })).resolves.toMatchObject({ type: "diagnostics.aborted", streamId: "stream-1" });
    expect(readSignal?.aborted).toBe(true);
    await expect(read).rejects.toMatchObject({ diagnosticsError: { status: 410 } });
  });
});
