import { createHash } from "node:crypto";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  isAttachmentError,
  isAttachmentPrivateEvent,
  type AttachmentError,
} from "@native-im/core";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { AttachmentAuthorityClientPort } from "./controller.js";
import { isAttachmentStatusResult, type AttachmentStatusResult } from "./contracts.js";
import type {
  AttachmentContentAuthorityPort,
} from "./preview-download.js";

type SocketEvent = "open" | "message" | "close" | "error";
export interface AttachmentAuthorityWebSocketLike {
  readonly readyState: number;
  addEventListener(type: SocketEvent, listener: (event: unknown) => void): void;
  removeEventListener(type: SocketEvent, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type AttachmentAuthorityTransportErrorCode =
  | "authentication_required"
  | "session_revoked"
  | "connection_unavailable"
  | "request_timeout"
  | "request_capacity_exceeded"
  | "protocol_error"
  | "client_closed";

export class AttachmentAuthorityTransportError extends Error {
  readonly attachmentError: AttachmentError;
  constructor(readonly code: AttachmentAuthorityTransportErrorCode, error?: AttachmentError) {
    super(`Attachment Authority transport failed: ${code}`);
    this.name = "AttachmentAuthorityTransportError";
    this.attachmentError = error ?? { status: 503, code: "storage_unavailable" };
  }
}

export interface AttachmentAuthorityTransport
  extends AttachmentAuthorityClientPort, AttachmentContentAuthorityPort {
  onTerminalRevoked(listener: (reason: "session_revoked" | "membership_revoked" | "terminal_auth_failure") => void): () => void;
}

const encoder = new TextEncoder();
const MAX_FRAME_BYTES = 64 * 1_024;

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "::1" || host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(host);
}

export function validateAttachmentAuthorityWebSocketEndpoint(endpoint: string): string {
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch {
    throw new TypeError("Attachment Authority WebSocket endpoint is not allowed");
  }
  if ((parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    !isLoopback(parsed.hostname) || parsed.username !== "" || parsed.password !== "" ||
    parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError("Attachment Authority WebSocket endpoint is not allowed");
  }
  return parsed.toString();
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function id(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type ServerFrame =
  | Readonly<{ type: "auth.authenticated"; requestId: string; actorId: string; sessionId: string }>
  | Readonly<{ type: "auth.session-revoked"; eventId: string }>
  | Readonly<{ type: "identity.room-access.changed"; actorId: string; change: "joined" | "updated" | "removed" | "archived" }>
  | Readonly<{ type: "attachment.private.status"; status: AttachmentStatusResult }>
  | Readonly<{ type: "attachment.upload.begun"; requestId: string; uploadId: string; acknowledgedBytes: number }>
  | Readonly<{ type: "attachment.upload.chunk.ack"; requestId: string; uploadId: string; acknowledgedBytes: number }>
  | Readonly<{ type: "attachment.upload.accepted"; requestId: string; attachmentId: string; processingStatus: "accepted-quarantined" }>
  | Readonly<{ type: "attachment.upload.cancelled"; requestId: string; status: "cancelled" }>
  | (AttachmentStatusResult & Readonly<{ requestId: string }>)
  | Readonly<{ type: "attachment.preview.opened"; requestId: string; streamId: string; byteSize: number }>
  | Readonly<{ type: "attachment.download.opened"; requestId: string; streamId: string; byteSize: number; originalFilename: string }>
  | Readonly<{ type: "attachment.stream.chunk"; requestId: string; streamId: string; offset: number; byteLength: number; encodedBytes: string; eof: boolean }>
  | Readonly<{ type: "error"; requestId?: string; error: AttachmentError }>;

function parseServerFrame(raw: string): ServerFrame | undefined {
  if (encoder.encode(raw).byteLength >= MAX_FRAME_BYTES) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!record(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "auth.authenticated":
      return exact(value, ["type", "requestId", "accountId", "actorId", "sessionId"]) &&
        id(value.requestId, 128) && id(value.accountId) && id(value.actorId) && id(value.sessionId)
        ? { type: value.type, requestId: value.requestId, actorId: value.actorId, sessionId: value.sessionId }
        : undefined;
    case "auth.session-revoked":
      return exact(value, ["type", "eventId"]) && id(value.eventId) ? value as ServerFrame : undefined;
    case "identity.room-access.changed":
      return exact(value, [
        "eventId", "streamKind", "streamId", "streamSeq", "actorId", "occurredAt", "type", "payload",
      ]) && value.streamKind === "identity" && id(value.eventId) && id(value.streamId) &&
        count(value.streamSeq) && value.streamSeq > 0 && id(value.actorId) && value.actorId === value.streamId &&
        typeof value.occurredAt === "string" && !Number.isNaN(Date.parse(value.occurredAt)) &&
        record(value.payload) && exact(value.payload, ["roomId", "change"]) && id(value.payload.roomId) &&
        (value.payload.change === "joined" || value.payload.change === "updated" ||
          value.payload.change === "removed" || value.payload.change === "archived")
        ? { type: value.type, actorId: value.actorId, change: value.payload.change } : undefined;
    case "attachment.private.status-changed":
      if (!isAttachmentPrivateEvent(value)) return undefined;
      return {
        type: "attachment.private.status",
        status: {
          type: "attachment.status",
          attachment: structuredClone(value.payload.attachment),
          sourceEligibility: "unbound",
          accessProjection: "authorized",
        },
      };
    case "attachment.upload.begun":
    case "attachment.upload.chunk.ack":
      return exact(value, ["type", "requestId", "uploadId", "acknowledgedBytes"]) &&
        id(value.requestId, 128) && id(value.uploadId) && count(value.acknowledgedBytes) &&
        value.acknowledgedBytes <= ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes
        ? value as ServerFrame : undefined;
    case "attachment.upload.accepted":
      return exact(value, ["type", "requestId", "attachmentId", "processingStatus"]) &&
        id(value.requestId, 128) && id(value.attachmentId) && value.processingStatus === "accepted-quarantined"
        ? value as ServerFrame : undefined;
    case "attachment.upload.cancelled":
      return exact(value, ["type", "requestId", "status"]) && id(value.requestId, 128) && value.status === "cancelled"
        ? value as ServerFrame : undefined;
    case "attachment.status":
      if (!exact(value, [
        "type", "requestId", "attachment", "sourceEligibility", "accessProjection",
      ]) || !id(value.requestId, 128)) return undefined;
      return isAttachmentStatusResult({
        type: value.type,
        attachment: value.attachment,
        sourceEligibility: value.sourceEligibility,
        accessProjection: value.accessProjection,
      }) ? value as ServerFrame : undefined;
    case "attachment.preview.opened":
      return exact(value, ["type", "requestId", "streamId", "byteSize"]) &&
        id(value.requestId, 128) && id(value.streamId) && count(value.byteSize) &&
        value.byteSize <= ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes ? value as ServerFrame : undefined;
    case "attachment.download.opened":
      return exact(value, ["type", "requestId", "streamId", "byteSize", "originalFilename"]) &&
        id(value.requestId, 128) && id(value.streamId) && count(value.byteSize) &&
        value.byteSize <= ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes && id(value.originalFilename) &&
        !/[\\/]/u.test(value.originalFilename) ? value as ServerFrame : undefined;
    case "attachment.stream.chunk":
      return exact(value, ["type", "requestId", "streamId", "offset", "byteLength", "base64", "eof"]) &&
        id(value.requestId, 128) && id(value.streamId) && count(value.offset) && count(value.byteLength) &&
        value.byteLength <= ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes &&
        typeof value.base64 === "string" && value.base64.length <= 44_000 && typeof value.eof === "boolean"
        ? { type: value.type, requestId: value.requestId, streamId: value.streamId,
          offset: value.offset, byteLength: value.byteLength, encodedBytes: value.base64, eof: value.eof }
        : undefined;
    case "error": {
      if (!exact(value, ["type", "status", "code", "message"], ["requestId", "retryAfterSeconds"]) ||
        !id(value.code, 128) || typeof value.status !== "number" || typeof value.message !== "string" ||
        (value.requestId !== undefined && !id(value.requestId, 128))) return undefined;
      const candidate = value.status === 429
        ? { status: value.status, code: value.code, retryAfterSeconds: value.retryAfterSeconds }
        : { status: value.status, code: value.code };
      return isAttachmentError(candidate)
        ? { type: "error", ...(value.requestId === undefined ? {} : { requestId: value.requestId }), error: candidate }
        : undefined;
    }
    default: return undefined;
  }
}

type Pending = {
  readonly accept: (frame: ServerFrame) => boolean;
  readonly resolve: (frame: ServerFrame) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export function createAttachmentAuthorityWebSocketTransport(options: {
  readonly endpoint: string;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly webSocketFactory: (endpoint: string) => AttachmentAuthorityWebSocketLike;
  readonly timeoutMs?: number;
  readonly maximumPending?: number;
}): AttachmentAuthorityTransport {
  const endpoint = validateAttachmentAuthorityWebSocketEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maximumPending = options.maximumPending ?? 32;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
    !Number.isSafeInteger(maximumPending) || maximumPending < 1 || maximumPending > 64) {
    throw new TypeError("Invalid Attachment Authority transport bounds");
  }
  const pending = new Map<string, Pending>();
  const terminalListeners = new Set<(reason: "session_revoked" | "membership_revoked" | "terminal_auth_failure") => void>();
  const statusListeners = new Set<(status: AttachmentStatusResult) => void>();
  let socket: AttachmentAuthorityWebSocketLike | undefined;
  let connectPromise: Promise<void> | undefined;
  let authenticatedSessionId: string | undefined;
  let sequence = 0;
  let closed = false;
  let terminal = false;

  function rejectAll(error: unknown): void {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }
  function dispose(code = 1000, reason = "attachment transport closed"): void {
    const current = socket;
    socket = undefined;
    connectPromise = undefined;
    authenticatedSessionId = undefined;
    try { current?.close(code, reason); } catch { /* bounded close */ }
  }
  function failProtocol(): void {
    const error = new AttachmentAuthorityTransportError("protocol_error");
    rejectAll(error);
    dispose(1002, "attachment protocol error");
  }
  function receive(event: unknown): void {
    if (typeof event !== "object" || event === null || !("data" in event) ||
      typeof event.data !== "string") return failProtocol();
    const frame = parseServerFrame(event.data);
    if (!frame) return failProtocol();
    if (frame.type === "auth.session-revoked") {
      terminal = true;
      const error = new AttachmentAuthorityTransportError("session_revoked", { status: 401, code: "unauthenticated" });
      rejectAll(error);
      dispose(1000, "session revoked");
      for (const listener of [...terminalListeners]) {
        try { listener("session_revoked"); } catch { /* revocation observer is isolated */ }
      }
      return;
    }
    if (frame.type === "identity.room-access.changed") {
      const actorId = options.session()?.actorId;
      if (!actorId || frame.actorId !== actorId) return failProtocol();
      if (frame.change === "removed") {
        terminal = true;
        const error = new AttachmentAuthorityTransportError("session_revoked", { status: 403, code: "room_forbidden" });
        rejectAll(error);
        dispose(1000, "membership revoked");
        for (const listener of [...terminalListeners]) {
          try { listener("membership_revoked"); } catch { /* revocation observer is isolated */ }
        }
      }
      return;
    }
    if (frame.type === "attachment.private.status") {
      if (frame.status.attachment.uploaderActorId !== options.session()?.actorId) return failProtocol();
      for (const listener of [...statusListeners]) {
        try { listener(structuredClone(frame.status)); } catch { /* status observer is isolated */ }
      }
      return;
    }
    const requestId = "requestId" in frame ? frame.requestId : undefined;
    if (!requestId) return failProtocol();
    const item = pending.get(requestId);
    if (!item) return failProtocol();
    pending.delete(requestId);
    clearTimeout(item.timer);
    if (frame.type === "error") {
      const error = new AttachmentAuthorityTransportError(
        frame.error.status === 401 ? "session_revoked" : "protocol_error",
        frame.error,
      );
      item.reject(error);
      if (frame.error.status === 401) {
        terminal = true;
        rejectAll(error);
        dispose(1000, "terminal authentication failure");
        for (const listener of [...terminalListeners]) {
          try { listener("terminal_auth_failure"); } catch { /* revocation observer is isolated */ }
        }
      }
      return;
    }
    if (!item.accept(frame)) {
      item.reject(new AttachmentAuthorityTransportError("protocol_error"));
      return failProtocol();
    }
    item.resolve(frame);
  }
  async function connect(): Promise<void> {
    if (closed) throw new AttachmentAuthorityTransportError("client_closed");
    if (terminal) throw new AttachmentAuthorityTransportError("session_revoked", { status: 401, code: "unauthenticated" });
    if (socket?.readyState === 1) return;
    if (connectPromise) return connectPromise;
    connectPromise = new Promise<void>((resolve, reject) => {
      const next = options.webSocketFactory(endpoint);
      socket = next;
      const timer = setTimeout(() => {
        if (socket !== next) return;
        reject(new AttachmentAuthorityTransportError("connection_unavailable"));
        dispose(1000, "connect timeout");
      }, timeoutMs);
      const open = () => { if (socket === next) { clearTimeout(timer); resolve(); } };
      const failure = () => {
        if (socket !== next) return;
        clearTimeout(timer);
        const error = new AttachmentAuthorityTransportError("connection_unavailable");
        rejectAll(error);
        reject(error);
        socket = undefined;
        connectPromise = undefined;
        authenticatedSessionId = undefined;
      };
      next.addEventListener("open", open);
      next.addEventListener("message", (event) => { if (socket === next) receive(event); });
      next.addEventListener("error", failure);
      next.addEventListener("close", () => { if (!closed && !terminal) failure(); });
      if (next.readyState === 1) open();
    });
    await connectPromise;
  }
  async function send(frame: RecordValue, accept: Pending["accept"]): Promise<ServerFrame> {
    await connect();
    const requestId = frame.requestId;
    if (!id(requestId, 128) || pending.has(requestId)) throw new AttachmentAuthorityTransportError("protocol_error");
    if (pending.size >= maximumPending) throw new AttachmentAuthorityTransportError("request_capacity_exceeded", {
      status: 429, code: "attachment_capacity_limited", retryAfterSeconds: 1,
    });
    const encoded = JSON.stringify(frame);
    if (encoder.encode(encoded).byteLength >= MAX_FRAME_BYTES) {
      throw new AttachmentAuthorityTransportError("protocol_error", { status: 413, code: "chunk_too_large" });
    }
    return new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new AttachmentAuthorityTransportError("request_timeout"));
      }, timeoutMs);
      pending.set(requestId, { accept, resolve, reject, timer });
      try { socket!.send(encoded); } catch {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(new AttachmentAuthorityTransportError("connection_unavailable"));
      }
    });
  }
  async function authenticate(): Promise<void> {
    const session = options.session();
    if (!session) throw new AttachmentAuthorityTransportError("authentication_required", { status: 401, code: "unauthenticated" });
    if (authenticatedSessionId === session.sessionId && socket?.readyState === 1) return;
    if (authenticatedSessionId && authenticatedSessionId !== session.sessionId) dispose(1000, "session changed");
    const requestId = `attachment-auth-${++sequence}`;
    await send({ type: "auth.resume", requestId, accessToken: session.accessToken }, (frame) =>
      frame.type === "auth.authenticated" && frame.requestId === requestId &&
      frame.actorId === session.actorId && frame.sessionId === session.sessionId);
    authenticatedSessionId = session.sessionId;
  }
  async function rpc<T extends ServerFrame>(frame: RecordValue, type: T["type"]): Promise<T> {
    await authenticate();
    const requestId = frame.requestId;
    return await send(frame, (candidate) => candidate.type === type &&
      "requestId" in candidate && candidate.requestId === requestId) as T;
  }
  function decodeChunk(encoded: string, expected: number): Uint8Array {
    if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new AttachmentAuthorityTransportError("protocol_error");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength !== expected || decoded.toString("base64") !== encoded) {
      throw new AttachmentAuthorityTransportError("protocol_error");
    }
    return Uint8Array.from(decoded);
  }

  const transport: AttachmentAuthorityTransport = {
    async beginUpload(input) {
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.upload.begun" }>>({
        type: "attachment.upload.begin", requestId: input.requestId, roomId: input.roomId,
        uploadKey: input.uploadKey, originalFilename: input.originalFilename,
        declaredMime: input.declaredMime, expectedBytes: input.byteSize, expectedSha256: input.sha256,
      }, "attachment.upload.begun");
      return { uploadId: frame.uploadId, acknowledgedBytes: frame.acknowledgedBytes };
    },
    async uploadChunk(input) {
      if (input.bytes.byteLength < 1 || input.bytes.byteLength > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes ||
        input.offset % ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes !== 0) {
        throw new AttachmentAuthorityTransportError("protocol_error", { status: 400, code: "invalid_chunk" });
      }
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.upload.chunk.ack" }>>({
        type: "attachment.upload.chunk", requestId: input.requestId, uploadId: input.uploadId,
        ordinal: input.offset / ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes, offset: input.offset,
        byteLength: input.bytes.byteLength,
        chunkSha256: createHash("sha256").update(input.bytes).digest("hex"),
        base64: Buffer.from(input.bytes).toString("base64"),
      }, "attachment.upload.chunk.ack");
      return { uploadId: frame.uploadId, acknowledgedBytes: frame.acknowledgedBytes };
    },
    async finalizeUpload(input) {
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.upload.accepted" }>>({
        type: "attachment.upload.finalize", ...input,
      }, "attachment.upload.accepted");
      return { attachmentId: frame.attachmentId, processingStatus: frame.processingStatus };
    },
    async cancelUpload(input) {
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.upload.cancelled" }>>({
        type: "attachment.upload.cancel", ...input,
      }, "attachment.upload.cancelled");
      return { status: frame.status };
    },
    async retryProcessing(input) {
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.status" }>>({
        type: "attachment.processing.retry", ...input,
      }, "attachment.status");
      return { type: frame.type, attachment: structuredClone(frame.attachment),
        sourceEligibility: frame.sourceEligibility, accessProjection: frame.accessProjection };
    },
    async getStatus(input) {
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.status" }>>({
        type: "attachment.status.query", ...input,
      }, "attachment.status");
      return { type: frame.type, attachment: structuredClone(frame.attachment),
        sourceEligibility: frame.sourceEligibility, accessProjection: frame.accessProjection };
    },
    subscribeStatus(listener) {
      statusListeners.add(listener);
      let active = true;
      return () => { if (active) { active = false; statusListeners.delete(listener); } };
    },
    async authorizePreview(input) {
      const requestId = `attachment-preview-${++sequence}`;
      const representation = input.representation === "extracted-text" ? "safe-text" : "original";
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.preview.opened" }>>({
        type: "attachment.preview.open", requestId, attachmentId: input.attachmentId, representation,
      }, "attachment.preview.opened");
      return { grantId: frame.streamId, byteSize: frame.byteSize };
    },
    async authorizeDownload(input) {
      const requestId = `attachment-download-${++sequence}`;
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.download.opened" }>>({
        type: "attachment.download.open", requestId, attachmentId: input.attachmentId,
      }, "attachment.download.opened");
      return { grantId: frame.streamId, byteSize: frame.byteSize, displayName: frame.originalFilename };
    },
    async readGrant(grantId, offset, maximumBytes) {
      if (!id(grantId) || !count(offset) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
        maximumBytes > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes) {
        throw new AttachmentAuthorityTransportError("protocol_error");
      }
      const requestId = `attachment-stream-${++sequence}`;
      const frame = await rpc<Extract<ServerFrame, { type: "attachment.stream.chunk" }>>({
        type: "attachment.stream.read", requestId, streamId: grantId, offset, maximumBytes,
      }, "attachment.stream.chunk");
      if (frame.streamId !== grantId || frame.offset !== offset || frame.byteLength > maximumBytes) {
        throw new AttachmentAuthorityTransportError("protocol_error");
      }
      return decodeChunk(frame.encodedBytes, frame.byteLength);
    },
    onTerminalRevoked(listener) {
      terminalListeners.add(listener);
      let active = true;
      return () => { if (active) { active = false; terminalListeners.delete(listener); } };
    },
    close() {
      if (closed) return;
      closed = true;
      rejectAll(new AttachmentAuthorityTransportError("client_closed"));
      terminalListeners.clear();
      statusListeners.clear();
      dispose();
    },
  };
  return Object.freeze(transport);
}
