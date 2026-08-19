import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAMD_LIMITS,
  ClamdScannerError,
  probeClamdVersion,
  scanWithClamd,
  type ClamdEndpoint,
} from "./clamd-scanner.js";

const servers: Server[] = [];

async function loopbackServer(
  onRequest: (socket: Socket, request: Buffer) => void,
): Promise<{ endpoint: ClamdEndpoint; requests: Buffer[] }> {
  const requests: Buffer[] = [];
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const request = Buffer.concat(chunks);
      requests[0] = request;
      onRequest(socket, request);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  return {
    endpoint: { kind: "tcp", host: "127.0.0.1", port: address.port },
    requests,
  };
}

function completeInstream(request: Buffer): readonly number[] | undefined {
  const command = Buffer.from("zINSTREAM\0");
  if (request.byteLength < command.byteLength ||
      !request.subarray(0, command.byteLength).equals(command)) return undefined;
  const lengths: number[] = [];
  let offset = command.byteLength;
  while (offset + 4 <= request.byteLength) {
    const length = request.readUInt32BE(offset);
    offset += 4;
    if (length === 0) return lengths;
    if (offset + length > request.byteLength) return undefined;
    lengths.push(length);
    offset += length;
  }
  return undefined;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  })));
});

describe("FT-04 real ClamD INSTREAM adapter", () => {
  it("frames a real loopback stream into at most 1 MiB chunks and normalizes clean", async () => {
    let responded = false;
    const fixture = await loopbackServer((socket, request) => {
      const frames = completeInstream(request);
      if (frames !== undefined && !responded) {
        responded = true;
        expect(frames).toEqual([
          CLAMD_LIMITS.maxFrameBytes,
          CLAMD_LIMITS.maxFrameBytes,
          17,
        ]);
        socket.end("stream: OK\0");
      }
    });
    const body = Buffer.alloc(CLAMD_LIMITS.maxFrameBytes * 2 + 17, 0x61);
    await expect(scanWithClamd({ endpoint: fixture.endpoint, body, timeoutMs: 2_000 }))
      .resolves.toEqual({ status: "clean" });
  });

  it("normalizes malware without exposing the signature or raw daemon response", async () => {
    const signature = "EICAR_RAW_SIGNATURE_CANARY";
    let responded = false;
    const fixture = await loopbackServer((socket, request) => {
      if (completeInstream(request) !== undefined && !responded) {
        responded = true;
        socket.end(`stream: ${signature} FOUND\0`);
      }
    });
    const result = await scanWithClamd({
      endpoint: fixture.endpoint,
      body: Buffer.from("not-real-malware"),
      timeoutMs: 2_000,
    });
    expect(result).toEqual({ status: "malware" });
    expect(JSON.stringify(result)).not.toContain(signature);
  });

  it("times out a real silent socket and redacts daemon ERROR output", async () => {
    const silent = await loopbackServer(() => undefined);
    const timeout = await scanWithClamd({
      endpoint: silent.endpoint,
      body: Buffer.from("timeout"),
      timeoutMs: 40,
    }).catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(ClamdScannerError);
    expect(timeout).toMatchObject({ reason: "scanner_unavailable", retryable: true });

    const rawCanary = "CLAMD_INTERNAL_PATH_/private/quarantine";
    let responded = false;
    const errorFixture = await loopbackServer((socket, request) => {
      if (completeInstream(request) !== undefined && !responded) {
        responded = true;
        socket.end(`stream: ${rawCanary} ERROR\0`);
      }
    });
    const failure = await scanWithClamd({
      endpoint: errorFixture.endpoint,
      body: Buffer.from("error"),
      timeoutMs: 2_000,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: "scanner_unavailable", retryable: true });
    expect((failure as Error).stack).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(rawCanary);
    expect(JSON.stringify(failure)).not.toContain("/private/quarantine");
  });

  it("rejects external TCP endpoints and more than 50 MiB before a clean result", async () => {
    await expect(scanWithClamd({
      endpoint: { kind: "tcp", host: "192.0.2.1", port: 3310 },
      body: Buffer.from("x"),
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ reason: "invalid_configuration", retryable: false });

    const fixture = await loopbackServer(() => undefined);
    await expect(scanWithClamd({
      endpoint: fixture.endpoint,
      body: Buffer.alloc(CLAMD_LIMITS.maxFileBytes + 1),
      timeoutMs: 2_000,
    })).rejects.toMatchObject({ reason: "file_too_large", retryable: false });
  });

  it("probes a bounded real ClamD VERSION response without returning daemon banners", async () => {
    const fixture = await loopbackServer((socket, request) => {
      if (request.includes(Buffer.from("zVERSION\0"))) {
        socket.end("ClamAV 1.5.3/27845/Wed Aug 19 09:00:00 2026\0");
      }
    });
    const result = await probeClamdVersion({ endpoint: fixture.endpoint, timeoutMs: 2_000 });
    expect(result).toEqual({ status: "available", version: "1.5.3" });
    expect(JSON.stringify(result)).not.toContain("27845");
    expect(JSON.stringify(result)).not.toContain("Wed Aug");
  });
});
