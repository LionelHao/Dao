import { createHash } from "node:crypto";
import type { ToolInvocation, ToolOutcome } from "./contracts.js";
import type {
  CitationReceiptAuthority,
  CitationReceiptSourceKind,
} from "./citation-receipt-authority.js";

export const ROOM_MEMORY_READ_LIMITS = Object.freeze({
  maximumPageItems: 8,
  maximumPageBytes: 32_768,
  maximumExecutionCalls: 32,
  maximumExecutionBytes: 262_144,
  timeoutMs: 5_000,
  maximumCursorLength: 4_096,
});

export type RoomMemoryReadMode =
  | "source"
  | "neighbors"
  | "attachment_segment"
  | "memory_sources"
  | "project_object";

export type RoomMemoryReadStatus = 400 | 401 | 403 | 409 | 410 | 429 | 503;

export class RoomMemoryReadError extends Error {
  constructor(readonly status: RoomMemoryReadStatus, readonly code: string) {
    super(`Room memory read rejected: ${code}`);
    this.name = "RoomMemoryReadError";
    delete this.stack;
  }
}

export function isRoomMemoryReadError(value: unknown): value is RoomMemoryReadError {
  return value instanceof RoomMemoryReadError &&
    [400, 401, 403, 409, 410, 429, 503].includes(value.status) &&
    typeof value.code === "string" && value.code.length > 0;
}

export interface RoomMemoryReadParameters {
  readonly snapshotId: string;
  readonly sourceLabel: string;
  readonly mode: RoomMemoryReadMode;
  readonly pageSize?: number;
  readonly cursor?: string;
}

export interface RoomMemoryReadAuthorization {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly snapshotId: string;
  readonly snapshotGeneration: number;
  readonly sourceLabel: string;
  readonly sourceKind: CitationReceiptSourceKind;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly authorizationEpoch: number;
  readonly callCount: number;
  readonly cumulativeBytes: number;
  readonly pageSize: number;
  readonly readerCapability: string;
}

interface RoomMemoryAuthorizationRequest {
  readonly phase: "before" | "after";
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly callId: string;
  readonly grantId: string;
  readonly dispatchId: string;
  readonly toolId: "room-memory.read";
  readonly parameters: RoomMemoryReadParameters;
  readonly signal: AbortSignal;
  readonly expected?: RoomMemoryReadAuthorization;
}

export interface RoomMemoryReadAuthority {
  authorize(input: RoomMemoryAuthorizationRequest): Promise<RoomMemoryReadAuthorization>;
  sealContinuation(input: Readonly<{
    authorization: RoomMemoryReadAuthorization;
    continuation: string | null;
    pageBytes: number;
    signal: AbortSignal;
  }>): Promise<string | null>;
}

export interface RoomMemoryReadPageItem {
  readonly ordinal: number;
  readonly text: string;
  readonly provenance: Readonly<{
    sourceKind: CitationReceiptSourceKind;
    sourceLabel: string;
    sourceRevision: number;
  }>;
}

export interface RoomMemoryReadPage {
  readonly items: readonly RoomMemoryReadPageItem[];
  readonly continuation: string | null;
}

export interface RoomMemoryReadPort {
  readPage(input: Readonly<{
    authorization: RoomMemoryReadAuthorization;
    mode: Exclude<RoomMemoryReadMode, "project_object">;
    pageSize: number;
    cursor?: string;
    signal: AbortSignal;
  }>): Promise<RoomMemoryReadPage>;
}

export interface RoomMemoryReadToolAdapter {
  readonly descriptor: Readonly<{
    id: "room-memory.read";
    displayName: string;
    effect: "read-only";
    reversibility: "compensatable";
  }>;
  execute(invocation: ToolInvocation): Promise<ToolOutcome>;
}

type Value = Record<string, unknown>;

function record(value: unknown): value is Value {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Value, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).every((field) => typeof field === "string" && allowed.has(field));
}

function identifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value.normalize("NFC") === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function continuationCursor(value: unknown): value is string {
  return identifier(value, ROOM_MEMORY_READ_LIMITS.maximumCursorLength) &&
    /^[A-Za-z0-9_-]+$/u.test(value);
}

function citationLabel(value: unknown): value is string {
  return typeof value === "string" && /^read:[A-Za-z0-9_-]{43}$/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseParameters(value: Readonly<Record<string, unknown>>): RoomMemoryReadParameters {
  if (!record(value) || !exact(value, ["snapshotId", "sourceLabel", "mode"], ["pageSize", "cursor"]) ||
      !identifier(value.snapshotId) || !identifier(value.sourceLabel) ||
      !["source", "neighbors", "attachment_segment", "memory_sources", "project_object"].includes(String(value.mode)) ||
      (Object.hasOwn(value, "pageSize") && (!positive(value.pageSize) ||
        value.pageSize > ROOM_MEMORY_READ_LIMITS.maximumPageItems)) ||
      (Object.hasOwn(value, "cursor") && (!continuationCursor(value.cursor) ||
        Object.hasOwn(value, "pageSize")))) {
    throw new RoomMemoryReadError(400, "invalid_request");
  }
  const common = {
    snapshotId: value.snapshotId,
    sourceLabel: value.sourceLabel,
    mode: value.mode as RoomMemoryReadMode,
  };
  return Object.freeze({
    ...common,
    ...(Object.hasOwn(value, "pageSize") ? { pageSize: value.pageSize as number } : {}),
    ...(Object.hasOwn(value, "cursor") ? { cursor: value.cursor as string } : {}),
  });
}

function validateAuthorization(
  value: RoomMemoryReadAuthorization,
  invocation: ToolInvocation,
  parameters: RoomMemoryReadParameters,
): void {
  if (!record(value) || !exact(value, [
    "executionId", "attemptSeq", "roomId", "agentId", "snapshotId", "snapshotGeneration",
    "sourceLabel", "sourceKind", "sourceId", "sourceRevision", "authorizationEpoch",
    "callCount", "cumulativeBytes", "pageSize", "readerCapability",
  ]) || value.executionId !== invocation.executionId || value.attemptSeq !== invocation.attemptSeq ||
      value.roomId !== invocation.roomId || value.agentId !== invocation.agentId ||
      value.snapshotId !== parameters.snapshotId || value.sourceLabel !== parameters.sourceLabel ||
      !positive(value.snapshotGeneration) || !identifier(value.sourceId) || !positive(value.sourceRevision) ||
      !nonnegative(value.authorizationEpoch) || !nonnegative(value.callCount) ||
      !nonnegative(value.cumulativeBytes) || !positive(value.pageSize) ||
      value.pageSize > ROOM_MEMORY_READ_LIMITS.maximumPageItems ||
      (parameters.pageSize !== undefined && parameters.pageSize !== value.pageSize) ||
      !identifier(value.readerCapability, 4_096) ||
      !["message_revision", "message_tombstone", "attachment_extraction", "memory", "project_fact_checkpoint", "delta_range"]
        .includes(value.sourceKind)) {
    throw new RoomMemoryReadError(409, "stale_context");
  }
}

function sameAuthorization(left: RoomMemoryReadAuthorization, right: RoomMemoryReadAuthorization): boolean {
  return left.executionId === right.executionId && left.attemptSeq === right.attemptSeq &&
    left.roomId === right.roomId && left.agentId === right.agentId && left.snapshotId === right.snapshotId &&
    left.snapshotGeneration === right.snapshotGeneration && left.sourceLabel === right.sourceLabel &&
    left.sourceKind === right.sourceKind && left.sourceId === right.sourceId &&
    left.sourceRevision === right.sourceRevision && left.authorizationEpoch === right.authorizationEpoch &&
    left.callCount === right.callCount && left.cumulativeBytes === right.cumulativeBytes &&
    left.pageSize === right.pageSize &&
    left.readerCapability === right.readerCapability;
}

function validatePage(
  page: RoomMemoryReadPage,
  pageSize: number,
  authorization: RoomMemoryReadAuthorization,
  mode: Exclude<RoomMemoryReadMode, "project_object">,
): Readonly<{ canonicalItems: string; itemBytes: number; budgetBytes: number }> {
  if (!record(page) || !exact(page, ["items", "continuation"]) || !Array.isArray(page.items) ||
      page.items.length === 0 || page.items.length > pageSize ||
      page.items.length > ROOM_MEMORY_READ_LIMITS.maximumPageItems ||
      (page.continuation !== null && !identifier(page.continuation, 4_096))) {
    throw new RoomMemoryReadError(503, "source_response_invalid");
  }
  let pageBytes = 0;
  let previousOrdinal: number | undefined;
  for (const item of page.items) {
    if (!record(item) || !exact(item, ["ordinal", "text", "provenance"]) || !positive(item.ordinal) ||
        typeof item.text !== "string" || !record(item.provenance) ||
        !exact(item.provenance, ["sourceKind", "sourceLabel", "sourceRevision"]) ||
        !["message_revision", "message_tombstone", "attachment_extraction", "memory", "project_fact_checkpoint", "delta_range"]
          .includes(String(item.provenance.sourceKind)) || !identifier(item.provenance.sourceLabel) ||
        !positive(item.provenance.sourceRevision) ||
        item.provenance.sourceKind !== authorization.sourceKind ||
        item.provenance.sourceLabel !== authorization.sourceLabel ||
        item.provenance.sourceRevision !== authorization.sourceRevision) {
      throw new RoomMemoryReadError(503, "source_response_invalid");
    }
    if (previousOrdinal !== undefined && item.ordinal !== previousOrdinal + 1) {
      throw new RoomMemoryReadError(503, "source_response_invalid");
    }
    previousOrdinal = item.ordinal;
    pageBytes += Buffer.byteLength(item.text, "utf8");
  }
  const canonicalItems = JSON.stringify(page.items);
  const itemBytes = Buffer.byteLength(canonicalItems, "utf8");
  const worstCasePayload = JSON.stringify({
    type: "room-memory.read.result.v1",
    snapshotId: authorization.snapshotId,
    sourceLabel: authorization.sourceLabel,
    mode,
    sourceRevision: authorization.sourceRevision,
    items: page.items,
    nextCursor: "x".repeat(ROOM_MEMORY_READ_LIMITS.maximumCursorLength),
    citationLabel: `read:${"x".repeat(43)}`,
  });
  const budgetBytes = Buffer.byteLength(worstCasePayload, "utf8");
  if (pageBytes > ROOM_MEMORY_READ_LIMITS.maximumPageBytes ||
      budgetBytes > ROOM_MEMORY_READ_LIMITS.maximumPageBytes) {
    throw new RoomMemoryReadError(429, "page_limit_exceeded");
  }
  return Object.freeze({ canonicalItems, itemBytes, budgetBytes });
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new RoomMemoryReadError(503, "source_read_timeout");
}

async function withinDeadline<T>(
  signal: AbortSignal,
  work: (boundedSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new RoomMemoryReadError(503, "source_read_timeout");
  const deadline = new AbortController();
  const boundedSignal = AbortSignal.any([signal, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(boundedSignal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          deadline.abort();
          reject(new RoomMemoryReadError(503, "source_read_timeout"));
        }, ROOM_MEMORY_READ_LIMITS.timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createRoomMemoryReadTool(options: Readonly<{
  authority: RoomMemoryReadAuthority;
  reader: RoomMemoryReadPort;
  receipts: Pick<CitationReceiptAuthority, "issue">;
}>): RoomMemoryReadToolAdapter {
  return Object.freeze({
    descriptor: Object.freeze({
      id: "room-memory.read",
      displayName: "Read Room memory source",
      effect: "read-only",
      reversibility: "compensatable",
    }),
    async execute(invocation: ToolInvocation) {
      if (invocation.toolId !== "room-memory.read") {
        throw new RoomMemoryReadError(409, "stale_context");
      }
      const parameters = parseParameters(invocation.parameters);
      return withinDeadline(invocation.signal, async (signal) => {
        let initial: RoomMemoryReadAuthorization;
        try {
          initial = await options.authority.authorize({
            phase: "before",
            executionId: invocation.executionId,
            attemptSeq: invocation.attemptSeq,
            roomId: invocation.roomId,
            agentId: invocation.agentId,
            callId: invocation.callId,
            grantId: invocation.grantId,
            dispatchId: invocation.dispatchId,
            toolId: "room-memory.read",
            parameters,
            signal,
          });
        } catch (error: unknown) {
          if (isRoomMemoryReadError(error)) throw error;
          throw new RoomMemoryReadError(503, "authority_unavailable");
        }
        requireActive(signal);
        validateAuthorization(initial, invocation, parameters);
        if (initial.callCount >= ROOM_MEMORY_READ_LIMITS.maximumExecutionCalls ||
            initial.cumulativeBytes >= ROOM_MEMORY_READ_LIMITS.maximumExecutionBytes) {
          throw new RoomMemoryReadError(429, "read_budget_exhausted");
        }
        if (parameters.mode === "project_object") {
          throw new RoomMemoryReadError(503, "project_context_disabled");
        }

        let page: RoomMemoryReadPage;
        try {
          page = await options.reader.readPage({
            authorization: initial,
            mode: parameters.mode,
            pageSize: initial.pageSize,
            ...(parameters.cursor === undefined ? {} : { cursor: parameters.cursor }),
            signal,
          });
        } catch (error: unknown) {
          if (isRoomMemoryReadError(error)) throw error;
          throw new RoomMemoryReadError(503, "source_unavailable");
        }
        requireActive(signal);
        let current: RoomMemoryReadAuthorization;
        try {
          current = await options.authority.authorize({
            phase: "after",
            executionId: invocation.executionId,
            attemptSeq: invocation.attemptSeq,
            roomId: invocation.roomId,
            agentId: invocation.agentId,
            callId: invocation.callId,
            grantId: invocation.grantId,
            dispatchId: invocation.dispatchId,
            toolId: "room-memory.read",
            parameters,
            signal,
            expected: initial,
          });
        } catch (error: unknown) {
          if (isRoomMemoryReadError(error)) throw error;
          throw new RoomMemoryReadError(503, "authority_unavailable");
        }
        requireActive(signal);
        validateAuthorization(current, invocation, parameters);
        if (!sameAuthorization(initial, current)) throw new RoomMemoryReadError(409, "stale_context");

        const pageAccounting = validatePage(page, initial.pageSize, initial, parameters.mode);
        if (initial.cumulativeBytes + pageAccounting.budgetBytes >
            ROOM_MEMORY_READ_LIMITS.maximumExecutionBytes) {
          throw new RoomMemoryReadError(429, "read_budget_exhausted");
        }

        let nextCursor: string | null;
        requireActive(signal);
        try {
          nextCursor = await options.authority.sealContinuation({
            authorization: current,
            continuation: page.continuation,
            pageBytes: pageAccounting.budgetBytes,
            signal,
          });
        } catch (error: unknown) {
          if (isRoomMemoryReadError(error)) throw error;
          throw new RoomMemoryReadError(503, "authority_unavailable");
        }
        requireActive(signal);
        if (nextCursor !== null && !continuationCursor(nextCursor)) {
          throw new RoomMemoryReadError(503, "authority_unavailable");
        }

        const firstOrdinal = page.items[0]!.ordinal;
        const lastOrdinal = page.items.at(-1)!.ordinal;
        const cursorBinding = parameters.cursor === undefined
          ? "initial"
          : createHash("sha256").update(parameters.cursor, "utf8").digest("hex").slice(0, 16);
        const range = `items:${firstOrdinal}-${lastOrdinal};cursor:${cursorBinding}`;
        let issued: Readonly<{ citationLabel: string }>;
        requireActive(signal);
        try {
          issued = await options.receipts.issue({
            roomId: initial.roomId,
            executionId: initial.executionId,
            snapshotId: initial.snapshotId,
            snapshotGeneration: initial.snapshotGeneration,
            sourceLabel: initial.sourceLabel,
            sourceKind: initial.sourceKind,
            sourceId: initial.sourceId,
            sourceRevision: initial.sourceRevision,
            authorizationEpoch: initial.authorizationEpoch,
            representation: parameters.mode,
            range,
            contentSha256: createHash("sha256").update(pageAccounting.canonicalItems, "utf8").digest("hex"),
            contentBytes: pageAccounting.itemBytes,
          });
        } catch (error: unknown) {
          void error;
          throw new RoomMemoryReadError(503, "receipt_unavailable");
        }
        requireActive(signal);
        if (!citationLabel(issued.citationLabel)) {
          throw new RoomMemoryReadError(503, "receipt_unavailable");
        }
        const modelResult = {
          type: "room-memory.read.result.v1",
          snapshotId: initial.snapshotId,
          sourceLabel: initial.sourceLabel,
          mode: parameters.mode,
          sourceRevision: initial.sourceRevision,
          items: page.items,
          nextCursor,
          citationLabel: issued.citationLabel,
        } as const;
        if (Buffer.byteLength(JSON.stringify(modelResult), "utf8") >
            ROOM_MEMORY_READ_LIMITS.maximumPageBytes) {
          throw new RoomMemoryReadError(429, "page_limit_exceeded");
        }
        return Object.freeze({
          summary: Object.freeze({
            outcome: "succeeded", itemCount: page.items.length,
            pageBytes: pageAccounting.budgetBytes,
          }),
          modelInput: JSON.stringify(modelResult),
        });
      });
    },
  });
}
