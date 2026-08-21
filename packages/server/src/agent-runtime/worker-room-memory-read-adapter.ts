import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ContextAuthorityWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type { AttachmentAgentExtractionReadPort } from "../attachment-authority/agent-extraction-reader.js";
import { AttachmentAgentExtractionReaderError } from "../attachment-authority/agent-extraction-reader.js";
import { canonicalJsonV1 } from "../context-compiler/canonical-json.js";
import type { CitationReceiptBinding } from "./citation-receipt-authority.js";
import {
  createRoomMemoryReadTool,
  isRoomMemoryReadError,
  RoomMemoryReadError,
  ROOM_MEMORY_READ_LIMITS,
  type RoomMemoryReadAuthorization,
  type RoomMemoryReadPage,
  type RoomMemoryReadParameters,
  type RoomMemoryReadToolAdapter,
} from "./room-memory-read-tool.js";
import type { ToolInvocation, ToolOutcome } from "./contracts.js";

type Value = Record<string, unknown>;

interface InternalRead {
  readonly readId: string;
  readonly executionGeneration: number;
  readonly callId: string;
  readonly dispatchId: string;
  readonly parameterSha256: string;
  readonly offset: number;
  readonly cursorSha256?: string;
  readonly mode: RoomMemoryReadParameters["mode"];
  readonly authorization: RoomMemoryReadAuthorization;
}

interface CursorPayload {
  readonly version: "context-source-cursor.v1";
  readonly executionId: string;
  readonly roomId: string;
  readonly snapshotId: string;
  readonly snapshotGeneration: number;
  readonly sourceLabel: string;
  readonly sourceKind: RoomMemoryReadAuthorization["sourceKind"];
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly authorizationEpoch: number;
  readonly mode: RoomMemoryReadParameters["mode"];
  readonly pageSize: number;
  readonly offset: number;
  readonly expiresAtMs: number;
}

const SOURCE_CURSOR_TTL_MS = 5 * 60_000;
const SOURCE_CURSOR_AAD = Buffer.from("dao.context-source-cursor.v1", "utf8");

function record(value: unknown): value is Value {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceError(error: unknown): RoomMemoryReadError {
  if (isRoomMemoryReadError(error)) return error;
  if (error instanceof AttachmentAgentExtractionReaderError) {
    if (error.code === "attachment_forbidden") {
      return new RoomMemoryReadError(403, "attachment_forbidden");
    }
    if (error.code === "attachment_capacity_limited") {
      return new RoomMemoryReadError(429, "page_limit_exceeded");
    }
    return new RoomMemoryReadError(503, "source_unavailable");
  }
  if (record(error) && typeof error.code === "string") {
    if (error.code === "context_forbidden") return new RoomMemoryReadError(403, "source_forbidden");
    if (error.code === "context_snapshot_invalidated" || error.code === "context_source_gone") {
      return new RoomMemoryReadError(410, "source_invalidated");
    }
    if (error.code === "context_generation_conflict" || error.code === "context_snapshot_conflict") {
      return new RoomMemoryReadError(409, "stale_context");
    }
    if (error.code === "context_capacity_limited") {
      return new RoomMemoryReadError(429, "read_budget_exhausted");
    }
  }
  return new RoomMemoryReadError(503, "authority_unavailable");
}

function cursorCodec(secret: Uint8Array, nowMs: () => number) {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new TypeError("Source cursor secret must contain at least 256 bits");
  }
  const key = createHash("sha256").update(secret).digest();
  const seal = (payload: CursorPayload): string => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(SOURCE_CURSOR_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(canonicalJsonV1(payload), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  };
  const open = (cursor: string): CursorPayload => {
    try {
      const sealed = Buffer.from(cursor, "base64url");
      if (sealed.toString("base64url") !== cursor || sealed.byteLength <= 28) {
        throw new TypeError("malformed cursor");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
      decipher.setAAD(SOURCE_CURSOR_AAD);
      decipher.setAuthTag(sealed.subarray(12, 28));
      const canonical = Buffer.concat([
        decipher.update(sealed.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      const payload: unknown = JSON.parse(canonical);
      if (!record(payload) || canonicalJsonV1(payload) !== canonical) {
        throw new TypeError("malformed cursor payload");
      }
      if (payload.version !== "context-source-cursor.v1" ||
          typeof payload.executionId !== "string" || typeof payload.roomId !== "string" ||
          typeof payload.snapshotId !== "string" ||
          !positive(payload.snapshotGeneration) || typeof payload.sourceLabel !== "string" ||
          typeof payload.sourceKind !== "string" || typeof payload.sourceId !== "string" ||
          !positive(payload.sourceRevision) || !nonnegative(payload.authorizationEpoch) ||
          typeof payload.mode !== "string" || !positive(payload.pageSize) ||
          !nonnegative(payload.offset) || !positive(payload.expiresAtMs) ||
          payload.expiresAtMs <= nowMs()) {
        throw new TypeError("bad cursor payload");
      }
      return payload as unknown as CursorPayload;
    } catch {
      throw new RoomMemoryReadError(409, "stale_context");
    }
  };
  return Object.freeze({ seal, open });
}

function sourceReadResult(
  value: unknown,
  input: Readonly<{
    invocation: Readonly<{
      executionId: string;
      attemptSeq: number;
      roomId: string;
      agentId: string;
    }>;
    parameters: RoomMemoryReadParameters;
    pageSize: number;
  }>,
): RoomMemoryReadAuthorization {
  if (!record(value) || value.kind !== "context-source-read" ||
      typeof value.readId !== "string" || value.executionId !== input.invocation.executionId ||
      value.attemptSeq !== input.invocation.attemptSeq ||
      value.snapshotId !== input.parameters.snapshotId || !positive(value.snapshotGeneration) ||
      value.sourceLabel !== input.parameters.sourceLabel || typeof value.sourceKind !== "string" ||
      typeof value.sourceId !== "string" || !positive(value.sourceRevision) ||
      !nonnegative(value.authorizationEpoch) || !nonnegative(value.callCount) ||
      !nonnegative(value.cumulativeBytes) || value.readerCapability !== "room-memory.read") {
    throw new RoomMemoryReadError(503, "authority_unavailable");
  }
  return Object.freeze({
    executionId: input.invocation.executionId,
    attemptSeq: input.invocation.attemptSeq,
    roomId: input.invocation.roomId,
    agentId: input.invocation.agentId,
    snapshotId: value.snapshotId,
    snapshotGeneration: value.snapshotGeneration,
    sourceLabel: value.sourceLabel,
    sourceKind: value.sourceKind as RoomMemoryReadAuthorization["sourceKind"],
    sourceId: value.sourceId,
    sourceRevision: value.sourceRevision,
    authorizationEpoch: value.authorizationEpoch,
    callCount: value.callCount,
    cumulativeBytes: value.cumulativeBytes,
    pageSize: input.pageSize,
    readerCapability: "room-memory.read",
  });
}

function sameCursorAuthority(
  cursor: CursorPayload,
  authorization: RoomMemoryReadAuthorization,
  parameters: RoomMemoryReadParameters,
): boolean {
  return cursor.executionId === authorization.executionId &&
    cursor.roomId === authorization.roomId &&
    cursor.snapshotId === authorization.snapshotId &&
    cursor.snapshotGeneration === authorization.snapshotGeneration &&
    cursor.sourceLabel === authorization.sourceLabel && cursor.sourceKind === authorization.sourceKind &&
    cursor.sourceId === authorization.sourceId && cursor.sourceRevision === authorization.sourceRevision &&
    cursor.authorizationEpoch === authorization.authorizationEpoch && cursor.mode === parameters.mode &&
    cursor.pageSize === authorization.pageSize;
}

function parsePage(value: unknown): RoomMemoryReadPage {
  if (!record(value) || value.kind !== "context-source-page" ||
      typeof value.canonicalResultJson !== "string" || typeof value.resultSha256 !== "string" ||
      sha256(value.canonicalResultJson) !== value.resultSha256 || typeof value.hasMore !== "boolean") {
    throw new RoomMemoryReadError(503, "source_response_invalid");
  }
  let page: unknown;
  try {
    page = JSON.parse(value.canonicalResultJson);
  } catch {
    throw new RoomMemoryReadError(503, "source_response_invalid");
  }
  if (!record(page) || !Array.isArray(page.items) || page.hasMore !== value.hasMore) {
    throw new RoomMemoryReadError(503, "source_response_invalid");
  }
  const items = page.items as RoomMemoryReadPage["items"];
  const last = items.at(-1);
  return Object.freeze({
    items,
    continuation: value.hasMore && last !== undefined ? String(last.ordinal) : null,
  });
}

export function createWorkerRoomMemoryReadAdapter(options: Readonly<{
  worker: ContextAuthorityWorkerDatabaseClient;
  cursorSecret: Uint8Array;
  attachmentReader: () => AttachmentAgentExtractionReadPort | undefined |
    Promise<AttachmentAgentExtractionReadPort | undefined>;
  nowMs?: () => number;
  nextReadId?: () => string;
  nextCitationLabel?: () => string;
}>): RoomMemoryReadToolAdapter {
  const nowMs = options.nowMs ?? Date.now;
  const nextReadId = options.nextReadId ?? (() => `context-read-${randomBytes(32).toString("base64url")}`);
  const nextCitationLabel = options.nextCitationLabel ??
    (() => `read:${randomBytes(32).toString("base64url")}`);
  const codec = cursorCodec(options.cursorSecret, nowMs);
  const internals = new WeakMap<RoomMemoryReadAuthorization, InternalRead>();
  const activeByExecution = new Map<string, InternalRead>();
  const activeByDispatch = new Map<string, InternalRead>();

  const executeContext = async (
    operation: Parameters<ContextAuthorityWorkerDatabaseClient["executeContext"]>[0],
  ): Promise<unknown> => {
    try {
      return await options.worker.executeContext(operation);
    } catch (error: unknown) {
      throw sourceError(error);
    }
  };

  const inner = createRoomMemoryReadTool({
    authority: {
      async authorize(input) {
        if (input.phase === "after") {
          const existing = activeByDispatch.get(input.dispatchId);
          if (existing === undefined) throw new RoomMemoryReadError(409, "stale_context");
          const value = await executeContext({
            type: "context.source-read-claim",
            readId: existing.readId,
            executionId: input.executionId,
            attemptSeq: input.attemptSeq,
            expectedSnapshotGeneration: existing.authorization.snapshotGeneration,
            callId: input.callId,
            grantId: input.grantId,
            dispatchId: input.dispatchId,
            toolId: "room-memory.read",
            requestSha256: sha256(JSON.stringify({
              executionId: input.executionId,
              attemptSeq: input.attemptSeq,
              snapshotId: existing.authorization.snapshotId,
              snapshotGeneration: existing.authorization.snapshotGeneration,
              callId: input.callId,
              grantId: input.grantId,
              dispatchId: input.dispatchId,
              toolId: "room-memory.read",
              parameterSha256: existing.parameterSha256,
              sourceLabel: input.parameters.sourceLabel,
              mode: input.parameters.mode,
              pageSize: existing.authorization.pageSize,
              offset: existing.offset,
              cursorSha256: existing.cursorSha256 ?? null,
            })),
            sourceLabel: input.parameters.sourceLabel,
            mode: input.parameters.mode,
            pageSize: existing.authorization.pageSize,
            offset: existing.offset,
            ...(existing.cursorSha256 === undefined ? {} : { cursorSha256: existing.cursorSha256 }),
            now: nowMs(),
          });
          const authorization = sourceReadResult(value, {
            invocation: input,
            parameters: input.parameters,
            pageSize: existing.authorization.pageSize,
          });
          internals.set(authorization, existing);
          return authorization;
        }

        const prepared = await executeContext({
          type: "context.prepare",
          executionId: input.executionId,
          attemptSeq: input.attemptSeq,
          now: nowMs(),
        });
        if (!record(prepared) || prepared.kind !== "context-preparation" ||
            !record(prepared.preparation) || !record(prepared.snapshot) ||
            !positive(prepared.preparation.executionGeneration) ||
            !positive(prepared.snapshot.snapshotGeneration) ||
            prepared.snapshot.snapshotId !== input.parameters.snapshotId) {
          throw new RoomMemoryReadError(409, "stale_context");
        }
        const decoded = input.parameters.cursor === undefined
          ? undefined : codec.open(input.parameters.cursor);
        const pageSize = decoded?.pageSize ?? input.parameters.pageSize ??
          ROOM_MEMORY_READ_LIMITS.maximumPageItems;
        const offset = decoded?.offset ?? 0;
        const cursorSha256 = input.parameters.cursor === undefined
          ? undefined : sha256(input.parameters.cursor);
        const parameterSha256 = sha256(canonicalJsonV1(input.parameters));
        const readId = nextReadId();
        const requestSha256 = sha256(JSON.stringify({
          executionId: input.executionId,
          attemptSeq: input.attemptSeq,
          snapshotId: input.parameters.snapshotId,
          snapshotGeneration: prepared.snapshot.snapshotGeneration,
          callId: input.callId,
          grantId: input.grantId,
          dispatchId: input.dispatchId,
          toolId: "room-memory.read",
          parameterSha256,
          sourceLabel: input.parameters.sourceLabel,
          mode: input.parameters.mode,
          pageSize,
          offset,
          cursorSha256: cursorSha256 ?? null,
        }));
        const value = await executeContext({
          type: "context.source-read-claim",
          readId,
          executionId: input.executionId,
          attemptSeq: input.attemptSeq,
          expectedSnapshotGeneration: prepared.snapshot.snapshotGeneration,
          callId: input.callId,
          grantId: input.grantId,
          dispatchId: input.dispatchId,
          toolId: "room-memory.read",
          requestSha256,
          sourceLabel: input.parameters.sourceLabel,
          mode: input.parameters.mode,
          pageSize,
          offset,
          ...(cursorSha256 === undefined ? {} : { cursorSha256 }),
          now: nowMs(),
        });
        const authorization = sourceReadResult(value, {
          invocation: input,
          parameters: input.parameters,
          pageSize,
        });
        if (decoded !== undefined && !sameCursorAuthority(decoded, authorization, input.parameters)) {
          throw new RoomMemoryReadError(409, "stale_context");
        }
        const internal: InternalRead = Object.freeze({
          readId,
          executionGeneration: prepared.preparation.executionGeneration,
          callId: input.callId,
          dispatchId: input.dispatchId,
          parameterSha256,
          offset,
          ...(cursorSha256 === undefined ? {} : { cursorSha256 }),
          mode: input.parameters.mode,
          authorization,
        });
        internals.set(authorization, internal);
        activeByExecution.set(input.executionId, internal);
        activeByDispatch.set(input.dispatchId, internal);
        return authorization;
      },
      async sealContinuation(input) {
        const internal = internals.get(input.authorization);
        if (internal === undefined) throw new RoomMemoryReadError(409, "stale_context");
        if (input.continuation === null) return null;
        const offset = Number(input.continuation);
        if (!nonnegative(offset) || offset <= internal.offset) {
          throw new RoomMemoryReadError(503, "source_response_invalid");
        }
        return codec.seal({
          version: "context-source-cursor.v1",
          executionId: input.authorization.executionId,
          roomId: input.authorization.roomId,
          snapshotId: input.authorization.snapshotId,
          snapshotGeneration: input.authorization.snapshotGeneration,
          sourceLabel: input.authorization.sourceLabel,
          sourceKind: input.authorization.sourceKind,
          sourceId: input.authorization.sourceId,
          sourceRevision: input.authorization.sourceRevision,
          authorizationEpoch: input.authorization.authorizationEpoch,
          mode: internal.mode,
          pageSize: input.authorization.pageSize,
          offset,
          expiresAtMs: nowMs() + SOURCE_CURSOR_TTL_MS,
        });
      },
    },
    reader: {
      async readPage(input) {
        const internal = internals.get(input.authorization);
        if (internal === undefined) throw new RoomMemoryReadError(409, "stale_context");
        if (input.mode === "attachment_segment") {
          const prefix = "attachment-extraction:";
          if (!input.authorization.sourceId.startsWith(prefix)) {
            throw new RoomMemoryReadError(409, "stale_context");
          }
          const attachmentId = input.authorization.sourceId.slice(prefix.length);
          const attachmentReader = await options.attachmentReader();
          if (attachmentReader === undefined || attachmentId.length === 0) {
            throw new RoomMemoryReadError(503, "source_unavailable");
          }
          const segment = await attachmentReader.readSegment({
            executionId: input.authorization.executionId,
            executionGeneration: internal.executionGeneration,
            attachmentId,
            attachmentGeneration: input.authorization.sourceRevision,
            offset: internal.offset,
            maximumBytes: Math.min(16_384, ROOM_MEMORY_READ_LIMITS.maximumPageBytes),
          }).catch((error: unknown) => { throw sourceError(error); });
          const items = [{
            ordinal: internal.offset + 1,
            text: segment.text,
            provenance: {
              sourceKind: input.authorization.sourceKind,
              sourceLabel: input.authorization.sourceLabel,
              sourceRevision: input.authorization.sourceRevision,
            },
          }] as const;
          const value = await executeContext({
            type: "context.source-read-checkpoint",
            readId: internal.readId,
            expectedSnapshotGeneration: input.authorization.snapshotGeneration,
            expectedExecutionGeneration: internal.executionGeneration,
            canonicalItemsJson: canonicalJsonV1(items),
            artifactSha256: segment.provenance.sha256,
            artifactRangeStart: segment.segment.startByte,
            artifactRangeEnd: segment.segment.endByte,
            now: nowMs(),
          });
          const page = parsePage(value);
          return Object.freeze({
            items: page.items,
            continuation: segment.segment.eof ? null : String(segment.segment.endByte),
          });
        }
        const value = await executeContext({
          type: "context.source-read-page",
          readId: internal.readId,
          expectedSnapshotGeneration: input.authorization.snapshotGeneration,
          expectedExecutionGeneration: internal.executionGeneration,
          offset: internal.offset,
          now: nowMs(),
        });
        return parsePage(value);
      },
    },
    receipts: {
      async issue(binding: CitationReceiptBinding) {
        const internal = activeByExecution.get(binding.executionId);
        if (internal === undefined || internal.authorization.snapshotId !== binding.snapshotId ||
            internal.authorization.sourceLabel !== binding.sourceLabel ||
            internal.authorization.sourceKind !== binding.sourceKind ||
            internal.authorization.sourceId !== binding.sourceId ||
            internal.authorization.sourceRevision !== binding.sourceRevision ||
            internal.authorization.authorizationEpoch !== binding.authorizationEpoch) {
          throw new RoomMemoryReadError(409, "stale_context");
        }
        const citationLabel = nextCitationLabel();
        const value = await executeContext({
          type: "context.source-read-complete",
          readId: internal.readId,
          expectedSnapshotGeneration: binding.snapshotGeneration,
          expectedExecutionGeneration: internal.executionGeneration,
          citationLabel,
          now: nowMs(),
        });
        if (!record(value) || value.kind !== "context-source-read-receipt" ||
            value.citationLabel !== citationLabel || value.readId !== internal.readId ||
            value.callId !== internal.callId || value.dispatchId !== internal.dispatchId ||
            value.roomId !== binding.roomId || value.executionId !== binding.executionId ||
            value.snapshotId !== binding.snapshotId ||
            value.snapshotGeneration !== binding.snapshotGeneration ||
            value.sourceLabel !== binding.sourceLabel || value.sourceKind !== binding.sourceKind ||
            value.sourceId !== binding.sourceId || value.sourceRevision !== binding.sourceRevision ||
            value.authorizationEpoch !== binding.authorizationEpoch ||
            value.representation !== binding.representation || value.range !== binding.range ||
            value.contentSha256 !== binding.contentSha256 || value.contentBytes !== binding.contentBytes) {
          throw new RoomMemoryReadError(503, "receipt_unavailable");
        }
        activeByExecution.delete(binding.executionId);
        activeByDispatch.delete(internal.dispatchId);
        return Object.freeze({ citationLabel });
      },
    },
  });

  return Object.freeze({
    descriptor: inner.descriptor,
    async execute(invocation: ToolInvocation): Promise<ToolOutcome> {
      try {
        return await inner.execute(invocation);
      } catch (error: unknown) {
        const internal = activeByDispatch.get(invocation.dispatchId);
        if (internal !== undefined) {
          activeByExecution.delete(invocation.executionId);
          activeByDispatch.delete(invocation.dispatchId);
          const closed = sourceError(error);
          const errorCode = closed.code === "source_read_timeout"
            ? "source_read_timeout"
            : closed.code === "attachment_forbidden" || closed.code === "source_forbidden"
              ? "attachment_forbidden"
              : closed.code === "page_limit_exceeded" || closed.code === "read_budget_exhausted"
                ? "page_limit_exceeded"
                : invocation.signal.aborted ? "source_read_cancelled" : "source_unavailable";
          await executeContext({
            type: "context.source-read-fail",
            readId: internal.readId,
            expectedSnapshotGeneration: internal.authorization.snapshotGeneration,
            expectedExecutionGeneration: internal.executionGeneration,
            outcome: closed.status === 410 ? "invalidated" : "failed",
            errorCode,
            now: nowMs(),
          }).catch(() => undefined);
          throw closed;
        }
        throw sourceError(error);
      }
    },
  });
}
