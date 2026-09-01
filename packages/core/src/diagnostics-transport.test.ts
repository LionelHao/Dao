import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES,
  isDiagnosticsTransportServerFrame,
  parseDiagnosticsTransportClientFrame,
} from "./diagnostics-transport.js";

describe("FT-14 diagnostics closed transport contract", () => {
  it("accepts only generate/read/abort domain frames without tokens, paths, or generic channels", () => {
    expect(parseDiagnosticsTransportClientFrame({
      type: "diagnostics.generate", requestId: "generate-1",
    })).toMatchObject({ ok: true });
    expect(parseDiagnosticsTransportClientFrame({
      type: "diagnostics.read", requestId: "read-1", streamId: "stream-1", offset: 0,
    })).toMatchObject({ ok: true });
    expect(parseDiagnosticsTransportClientFrame({
      type: "diagnostics.abort", requestId: "abort-1", streamId: "stream-1",
    })).toMatchObject({ ok: true });
    for (const frame of [
      { type: "diagnostics.generate", requestId: "generate-1", accessToken: "secret" },
      { type: "diagnostics.read", requestId: "read-1", streamId: "stream-1", offset: 0,
        path: "/tmp/diagnostics" },
      { type: "diagnostics.invoke", requestId: "generic", channel: "fs.read" },
      { type: "diagnostics.read", requestId: "bad", streamId: "stream-1", offset: 1_048_577 },
    ]) expect(parseDiagnosticsTransportClientFrame(frame).ok).toBe(false);
  });

  it("closes metadata, filename, checksum, and canonical bounded chunks", () => {
    const generated = {
      type: "diagnostics.generated", requestId: "generate-1", streamId: "stream-1",
      artifactId: "artifact-1", filename: "dao-diagnostics-2026-09-01T00-00-00.000Z.ndjson",
      mediaType: "application/x-ndjson", byteLength: 3, sha256: "a".repeat(64),
      expiresAt: "2026-09-02T00:00:00.000Z", chunkSize: DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES,
    } as const;
    expect(isDiagnosticsTransportServerFrame(generated)).toBe(true);
    expect(isDiagnosticsTransportServerFrame({ ...generated, filename: "../../secret" })).toBe(false);
    expect(isDiagnosticsTransportServerFrame({ ...generated, sha256: "A".repeat(64) })).toBe(false);
    const bytes = Buffer.alloc(DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES, 7);
    expect(isDiagnosticsTransportServerFrame({
      type: "diagnostics.chunk", requestId: "read-1", streamId: "stream-1", offset: 0,
      byteLength: bytes.byteLength, base64: bytes.toString("base64"), eof: false,
    })).toBe(true);
    expect(isDiagnosticsTransportServerFrame({
      type: "diagnostics.chunk", requestId: "read-1", streamId: "stream-1", offset: 0,
      byteLength: 1, base64: "AA==", eof: false, bytes,
    })).toBe(false);
  });
});
