import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsWebSocketTransport } from "./websocket-transport.js";

describe("FT-14 diagnostics same-socket Desktop adapter", () => {
  it("delegates only generate/read/abort and creates no second connection", async () => {
    const shared = {
      diagnosticsGenerate: vi.fn(async (command) => ({ type: "diagnostics.generated" as const,
        requestId: command.requestId, streamId: "stream-1", artifactId: "artifact-1",
        filename: "dao-diagnostics-2026-09-01T00-00-00.000Z.ndjson",
        mediaType: "application/x-ndjson" as const, byteLength: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        expiresAt: "2026-09-02T00:00:00.000Z", chunkSize: 49_152 as const })),
      diagnosticsRead: vi.fn(async (command) => ({ type: "diagnostics.chunk" as const,
        requestId: command.requestId, streamId: command.streamId, offset: command.offset,
        byteLength: 0, base64: "", eof: true })),
      diagnosticsAbort: vi.fn(async (command) => ({ type: "diagnostics.aborted" as const,
        requestId: command.requestId, streamId: command.streamId })),
    };
    const transport = createDiagnosticsWebSocketTransport(shared);
    expect(Object.keys(transport)).toEqual(["generate", "read", "abort"]);
    await transport.generate({ type: "diagnostics.generate", requestId: "generate-1" });
    await transport.read({ type: "diagnostics.read", requestId: "read-1",
      streamId: "stream-1", offset: 0 });
    await transport.abort({ type: "diagnostics.abort", requestId: "abort-1", streamId: "stream-1" });
    expect(shared.diagnosticsGenerate).toHaveBeenCalledOnce();
    expect(shared.diagnosticsRead).toHaveBeenCalledOnce();
    expect(shared.diagnosticsAbort).toHaveBeenCalledOnce();
  });
});
