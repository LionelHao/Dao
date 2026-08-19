import { ATTACHMENT_AUTHORITY_LIMITS, isAttachmentSafeFilename } from "@native-im/core";
import { types as nodeTypes } from "node:util";

export type AttachmentReadAuthorization = Readonly<{
  attachmentId: string;
  generation: number;
  lifecycleGeneration: number;
  accessRevision: number;
  operation: "preview" | "download";
  representation: "original" | "safe-text" | "safe-table";
  objectKey: string;
  sha256: string;
  byteSize: number;
  originalFilename?: string;
}>;

export type AttachmentReadGrantContext = Readonly<{
  sessionFamilyId: string;
  principal: Readonly<{ accountId: string; actorId: string }>;
}>;

export class AttachmentReadGrantError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 410 | 429 | 503,
    readonly code:
      | "invalid_chunk"
      | "attachment_forbidden"
      | "upload_offset_conflict"
      | "attachment_gone"
      | "attachment_capacity_limited"
      | "storage_unavailable",
  ) {
    super(`Attachment read grant rejected: ${code}`);
    this.name = "AttachmentReadGrantError";
    delete this.stack;
  }
}

type RecordValue = Record<string, unknown>;
const SHA256 = /^[0-9a-f]{64}$/u;
const OBJECT_KEY = /^(?:object|extraction)_([0-9a-f]{64})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  const fields = new Set([...required, ...optional]);
  return required.every((field) => Object.hasOwn(value, field)) &&
    Reflect.ownKeys(value).every((field) => typeof field === "string" && fields.has(field));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= ATTACHMENT_AUTHORITY_LIMITS.maxIdentifierUtf16 &&
    value === value.trim() && value.normalize("NFC") === value && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateContext(value: AttachmentReadGrantContext): void {
  if (!record(value) || !exact(value, ["sessionFamilyId", "principal"]) ||
      !identifier(value.sessionFamilyId) || !record(value.principal) ||
      !exact(value.principal, ["accountId", "actorId"]) ||
      !identifier(value.principal.accountId) || !identifier(value.principal.actorId)) {
    throw new TypeError("Attachment read grant context is invalid");
  }
}

function validateAuthorization(value: AttachmentReadAuthorization): void {
  if (!record(value) || !exact(value, [
    "attachmentId", "generation", "lifecycleGeneration", "accessRevision", "operation",
    "representation", "objectKey", "sha256", "byteSize",
  ], ["originalFilename"]) || !identifier(value.attachmentId) || !positive(value.generation) ||
      !nonnegative(value.lifecycleGeneration) || !nonnegative(value.accessRevision) ||
      (value.operation !== "preview" && value.operation !== "download") ||
      !["original", "safe-text", "safe-table"].includes(value.representation) ||
      !SHA256.test(value.sha256) || !positive(value.byteSize) ||
      value.byteSize > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes) {
    throw new TypeError("Attachment read authorization is invalid");
  }
  const objectDigest = OBJECT_KEY.exec(value.objectKey)?.[1];
  if (objectDigest !== value.sha256 ||
      (value.representation === "original" && !value.objectKey.startsWith("object_")) ||
      (value.representation !== "original" && !value.objectKey.startsWith("extraction_")) ||
      (value.operation === "download" && value.representation !== "original") ||
      (value.operation === "download" &&
        (value.originalFilename === undefined || !isAttachmentSafeFilename(value.originalFilename))) ||
      (value.operation === "preview" && value.originalFilename !== undefined)) {
    throw new TypeError("Attachment read authorization is invalid");
  }
}

function sameContext(left: AttachmentReadGrantContext, right: AttachmentReadGrantContext): boolean {
  return left.sessionFamilyId === right.sessionFamilyId &&
    left.principal.accountId === right.principal.accountId &&
    left.principal.actorId === right.principal.actorId;
}

function sameAuthorization(left: AttachmentReadAuthorization, right: AttachmentReadAuthorization): boolean {
  return left.attachmentId === right.attachmentId && left.generation === right.generation &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.accessRevision === right.accessRevision && left.operation === right.operation &&
    left.representation === right.representation && left.objectKey === right.objectKey &&
    left.sha256 === right.sha256 && left.byteSize === right.byteSize &&
    left.originalFilename === right.originalFilename;
}

type Grant = {
  readonly streamId: string;
  readonly context: AttachmentReadGrantContext;
  readonly authorization: AttachmentReadAuthorization;
  readonly expiresAt: number;
  nextOffset: number;
};

export interface AttachmentReadGrantRegistry {
  open(context: AttachmentReadGrantContext, authorization: AttachmentReadAuthorization): Readonly<{
    streamId: string;
    byteSize: number;
    originalFilename?: string;
  }>;
  read(
    context: AttachmentReadGrantContext,
    streamId: string,
    offset: number,
    maximumBytes: number,
  ): Promise<Readonly<{
    streamId: string;
    offset: number;
    bytes: Uint8Array;
    byteSize: number;
    eof: boolean;
  }>>;
  invalidateFamily(sessionFamilyId: string): void;
  close(): void;
}

export function createAttachmentReadGrantRegistry(options: {
  readonly nowMs: () => number;
  readonly nextGrantId: () => string;
  readonly reauthorize: (
    context: AttachmentReadGrantContext,
    authorization: AttachmentReadAuthorization,
  ) => Promise<AttachmentReadAuthorization>;
  readonly readRange: (
    objectKey: string,
    offset: number,
    maximumBytes: number,
  ) => Promise<Readonly<{ bytes: Uint8Array; byteSize: number; eof: boolean }>>;
  readonly ttlMs?: number;
  readonly maximumGrantsPerFamily?: number;
  readonly maximumGrants?: number;
}): AttachmentReadGrantRegistry {
  const ttlMs = options.ttlMs ?? 60_000;
  const maximumGrantsPerFamily = options.maximumGrantsPerFamily ?? 8;
  const maximumGrants = options.maximumGrants ?? 128;
  if (!positive(ttlMs) || ttlMs > 5 * 60_000 || !positive(maximumGrantsPerFamily) ||
      maximumGrantsPerFamily > 32 || !positive(maximumGrants) || maximumGrants > 512 ||
      maximumGrantsPerFamily > maximumGrants) {
    throw new TypeError("Attachment read grant limits are invalid");
  }
  const grants = new Map<string, Grant>();
  let closed = false;

  function time(): number {
    const value = options.nowMs();
    if (!nonnegative(value)) throw new TypeError("Attachment read grant clock is invalid");
    return value;
  }

  function sweep(now: number): void {
    for (const [id, grant] of grants) if (grant.expiresAt < now) grants.delete(id);
  }

  const registry: AttachmentReadGrantRegistry = {
    open(context, authorization) {
      if (closed) throw new AttachmentReadGrantError(503, "storage_unavailable");
      validateContext(context);
      validateAuthorization(authorization);
      const now = time();
      sweep(now);
      let familyCount = 0;
      for (const grant of grants.values()) {
        if (grant.context.sessionFamilyId === context.sessionFamilyId) familyCount += 1;
      }
      if (familyCount >= maximumGrantsPerFamily || grants.size >= maximumGrants) {
        throw new AttachmentReadGrantError(429, "attachment_capacity_limited");
      }
      const streamId = options.nextGrantId();
      if (!UUID.test(streamId) || grants.has(streamId)) {
        throw new TypeError("Attachment read grant ID factory is invalid");
      }
      grants.set(streamId, {
        streamId,
        context: Object.freeze({
          sessionFamilyId: context.sessionFamilyId,
          principal: Object.freeze({ ...context.principal }),
        }),
        authorization: Object.freeze({ ...authorization }),
        expiresAt: now + ttlMs,
        nextOffset: 0,
      });
      return Object.freeze({
        streamId,
        byteSize: authorization.byteSize,
        ...(authorization.originalFilename === undefined
          ? {}
          : { originalFilename: authorization.originalFilename }),
      });
    },
    async read(context, streamId, offset, maximumBytes) {
      if (closed) throw new AttachmentReadGrantError(503, "storage_unavailable");
      validateContext(context);
      if (!UUID.test(streamId) || !nonnegative(offset) || !positive(maximumBytes) ||
          maximumBytes > ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes) {
        throw new AttachmentReadGrantError(400, "invalid_chunk");
      }
      const grant = grants.get(streamId);
      if (grant === undefined) throw new AttachmentReadGrantError(410, "attachment_gone");
      if (!sameContext(grant.context, context)) {
        throw new AttachmentReadGrantError(403, "attachment_forbidden");
      }
      const now = time();
      if (grant.expiresAt < now) {
        grants.delete(streamId);
        throw new AttachmentReadGrantError(410, "attachment_gone");
      }
      if (offset !== grant.nextOffset || offset >= grant.authorization.byteSize) {
        throw new AttachmentReadGrantError(409, "upload_offset_conflict");
      }
      let current: AttachmentReadAuthorization;
      try {
        current = await options.reauthorize(grant.context, grant.authorization);
        validateAuthorization(current);
      } catch (error: unknown) {
        grants.delete(streamId);
        throw error;
      }
      if (!sameAuthorization(grant.authorization, current)) {
        grants.delete(streamId);
        throw new AttachmentReadGrantError(403, "attachment_forbidden");
      }
      const range = await options.readRange(
        current.objectKey,
        offset,
        Math.min(maximumBytes, current.byteSize - offset),
      );
      if (!record(range) || !exact(range, ["bytes", "byteSize", "eof"]) ||
          !nodeTypes.isUint8Array(range.bytes) || !nonnegative(range.byteSize) ||
          range.byteSize !== current.byteSize || typeof range.eof !== "boolean" ||
          range.bytes.byteLength === 0 || range.bytes.byteLength > maximumBytes ||
          offset + range.bytes.byteLength > current.byteSize ||
          range.eof !== (offset + range.bytes.byteLength === current.byteSize)) {
        grants.delete(streamId);
        throw new AttachmentReadGrantError(503, "storage_unavailable");
      }
      grant.nextOffset += range.bytes.byteLength;
      if (range.eof) grants.delete(streamId);
      return Object.freeze({
        streamId,
        offset,
        bytes: Uint8Array.from(range.bytes),
        byteSize: range.bytes.byteLength,
        eof: range.eof,
      });
    },
    invalidateFamily(sessionFamilyId) {
      if (!identifier(sessionFamilyId)) throw new TypeError("Attachment family identity is invalid");
      for (const [id, grant] of grants) {
        if (grant.context.sessionFamilyId === sessionFamilyId) grants.delete(id);
      }
    },
    close() {
      closed = true;
      grants.clear();
    },
  };
  return Object.freeze(registry);
}
