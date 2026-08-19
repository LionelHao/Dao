import { createConnection, type Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";

export const CLAMD_LIMITS = Object.freeze({
  maxFrameBytes: 1 * 1_024 * 1_024,
  maxFileBytes: 50 * 1_024 * 1_024,
  maxResponseBytes: 64 * 1_024,
  maxTimeoutMs: 120_000,
});

export type ClamdEndpoint =
  | Readonly<{
      kind: "unix";
      socketPath: string;
    }>
  | Readonly<{
      kind: "tcp";
      host: "127.0.0.1" | "::1";
      port: number;
    }>;

export type ClamdScannerFailureReason =
  | "invalid_configuration"
  | "file_too_large"
  | "scanner_unavailable";

export class ClamdScannerError extends Error {
  readonly reason: ClamdScannerFailureReason;
  readonly retryable: boolean;

  constructor(reason: ClamdScannerFailureReason) {
    super(`Attachment scanner failed: ${reason}`);
    this.name = "ClamdScannerError";
    delete this.stack;
    this.reason = reason;
    this.retryable = reason === "scanner_unavailable";
  }
}

export type ClamdScanResult =
  | Readonly<{ status: "clean" }>
  | Readonly<{ status: "malware" }>;

export type ClamdVersionProbe =
  | Readonly<{ status: "available"; version: string }>
  | Readonly<{ status: "unavailable"; version: null }>;

export interface ClamdConnectionOptions {
  readonly endpoint: ClamdEndpoint;
  readonly timeoutMs: number;
}

export interface ClamdScanOptions extends ClamdConnectionOptions {
  readonly body: Uint8Array | AsyncIterable<Uint8Array>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}

function validTimeout(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= CLAMD_LIMITS.maxTimeoutMs;
}

function validEndpoint(value: unknown): value is ClamdEndpoint {
  if (!isRecord(value)) return false;
  if (value.kind === "tcp") {
    return hasExactKeys(value, ["kind", "host", "port"]) &&
      (value.host === "127.0.0.1" || value.host === "::1") &&
      typeof value.port === "number" && Number.isSafeInteger(value.port) &&
      value.port > 0 && value.port <= 65_535;
  }
  if (value.kind === "unix") {
    return hasExactKeys(value, ["kind", "socketPath"]) &&
      typeof value.socketPath === "string" && value.socketPath.length > 0 &&
      !value.socketPath.includes("\0") && isAbsolute(value.socketPath) &&
      resolve(value.socketPath) === value.socketPath;
  }
  return false;
}

function byteSequence(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) &&
    (value as { readonly BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1;
}

function asyncByteSource(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

async function openClamdSocket(endpoint: ClamdEndpoint, deadline: number): Promise<Socket> {
  return await new Promise<Socket>((resolvePromise, rejectPromise) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      rejectPromise(new ClamdScannerError("scanner_unavailable"));
      return;
    }
    let socket: Socket;
    try {
      socket = endpoint.kind === "unix"
        ? createConnection({ path: endpoint.socketPath })
        : createConnection({ host: endpoint.host, port: endpoint.port });
    } catch {
      rejectPromise(new ClamdScannerError("scanner_unavailable"));
      return;
    }
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectPromise(new ClamdScannerError("scanner_unavailable"));
    }, remaining);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("error", onError);
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rejectPromise(new ClamdScannerError("scanner_unavailable"));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(socket);
    });
  });
}

function receiveBoundedResponse(socket: Socket, deadline: number): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    const remaining = deadline - Date.now();
    const fail = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      rejectPromise(new ClamdScannerError("scanner_unavailable"));
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > CLAMD_LIMITS.maxResponseBytes) {
        fail();
        return;
      }
      chunks.push(Buffer.from(chunk));
      const response = Buffer.concat(chunks, receivedBytes);
      const terminator = response.indexOf(0);
      if (terminator === -1) return;
      if (terminator !== response.byteLength - 1) {
        fail();
        return;
      }
      settled = true;
      cleanup();
      socket.end();
      resolvePromise(response.subarray(0, terminator));
    };
    const onError = (): void => fail();
    const onEnd = (): void => {
      if (!settled) fail();
    };
    const timeout = setTimeout(fail, Math.max(1, remaining));
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

async function writeSocket(socket: Socket, value: Uint8Array): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    socket.write(value, (error) => {
      if (error === null || error === undefined) resolvePromise();
      else rejectPromise(new ClamdScannerError("scanner_unavailable"));
    });
  });
}

async function* bodyChunks(
  body: Uint8Array | AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (byteSequence(body)) {
    yield body;
    return;
  }
  for await (const chunk of body) yield chunk;
}

async function nextChunkBeforeDeadline(
  iterator: AsyncIterator<Uint8Array>,
  deadline: number,
): Promise<IteratorResult<Uint8Array>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ClamdScannerError("scanner_unavailable");
  return await new Promise<IteratorResult<Uint8Array>>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new ClamdScannerError("scanner_unavailable"));
    }, remaining);
    void iterator.next().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolvePromise(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        rejectPromise(new ClamdScannerError("scanner_unavailable"));
      },
    );
  });
}

function validateConnectionOptions(options: ClamdConnectionOptions): void {
  if (!validEndpoint(options.endpoint) || !validTimeout(options.timeoutMs)) {
    throw new ClamdScannerError("invalid_configuration");
  }
}

export async function scanWithClamd(options: ClamdScanOptions): Promise<ClamdScanResult> {
  validateConnectionOptions(options);
  if (!byteSequence(options.body) && !asyncByteSource(options.body)) {
    throw new ClamdScannerError("invalid_configuration");
  }
  if (byteSequence(options.body) && options.body.byteLength > CLAMD_LIMITS.maxFileBytes) {
    throw new ClamdScannerError("file_too_large");
  }
  const deadline = Date.now() + options.timeoutMs;
  const socket = await openClamdSocket(options.endpoint, deadline);
  const responsePromise = receiveBoundedResponse(socket, deadline);
  void responsePromise.catch(() => undefined);
  const iterator = bodyChunks(options.body)[Symbol.asyncIterator]();
  try {
    await writeSocket(socket, Buffer.from("zINSTREAM\0"));
    let totalBytes = 0;
    while (true) {
      const next = await nextChunkBeforeDeadline(iterator, deadline);
      if (next.done === true) break;
      const chunk = next.value;
      if (!byteSequence(chunk)) throw new ClamdScannerError("invalid_configuration");
      for (let offset = 0; offset < chunk.byteLength; offset += CLAMD_LIMITS.maxFrameBytes) {
        const length = Math.min(CLAMD_LIMITS.maxFrameBytes, chunk.byteLength - offset);
        totalBytes += length;
        if (totalBytes > CLAMD_LIMITS.maxFileBytes) {
          throw new ClamdScannerError("file_too_large");
        }
        const frame = Buffer.allocUnsafe(4 + length);
        frame.writeUInt32BE(length, 0);
        Buffer.from(chunk.buffer, chunk.byteOffset + offset, length).copy(frame, 4);
        await writeSocket(socket, frame);
      }
    }
    await writeSocket(socket, Buffer.alloc(4));
    const rawResponse = await responsePromise;
    const response = rawResponse.toString("utf8");
    if (/^[^\r\n\0]{1,512}: OK$/u.test(response)) return Object.freeze({ status: "clean" });
    if (/^[^\r\n\0]{1,512}: [^\r\n\0]{1,512} FOUND$/u.test(response)) {
      return Object.freeze({ status: "malware" });
    }
    throw new ClamdScannerError("scanner_unavailable");
  } catch (error) {
    socket.destroy();
    void iterator.return?.().catch(() => undefined);
    if (error instanceof ClamdScannerError) throw error;
    throw new ClamdScannerError("scanner_unavailable");
  }
}

export async function probeClamdVersion(
  options: ClamdConnectionOptions,
): Promise<ClamdVersionProbe> {
  validateConnectionOptions(options);
  const deadline = Date.now() + options.timeoutMs;
  let socket: Socket | undefined;
  try {
    socket = await openClamdSocket(options.endpoint, deadline);
    const responsePromise = receiveBoundedResponse(socket, deadline);
    void responsePromise.catch(() => undefined);
    await writeSocket(socket, Buffer.from("zVERSION\0"));
    const response = (await responsePromise).toString("utf8");
    const match = /^ClamAV (\d+\.\d+\.\d+)(?:\/|$)/u.exec(response);
    if (match?.[1] === undefined) return Object.freeze({ status: "unavailable", version: null });
    return Object.freeze({ status: "available", version: match[1] });
  } catch {
    socket?.destroy();
    return Object.freeze({ status: "unavailable", version: null });
  }
}
