import type { DatabaseSync } from "node:sqlite";

export type RepairProjectionRegistryFailureReason =
  | "invalid_known_kinds"
  | "malformed_descriptor"
  | "missing_kind"
  | "unknown_kind"
  | "duplicate_kind"
  | "duplicate_descriptor_id"
  | "duplicate_order"
  | "missing_record_guard"
  | "record_guard_rejected"
  | "cross_kind_record"
  | "unstable_page";

export class RepairProjectionRegistryError extends Error {
  readonly reason: RepairProjectionRegistryFailureReason;

  constructor(reason: RepairProjectionRegistryFailureReason) {
    super(`Repair projection registry rejected: ${reason}`);
    this.name = "RepairProjectionRegistryError";
    this.reason = reason;
  }
}

export interface RepairKeysetPageInput {
  readonly database: DatabaseSync;
  readonly roomId: string;
  readonly watermark: number;
  readonly afterKey: string | undefined;
  readonly limit: number;
}

export interface RoomRepairSegmentDescriptor<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
> {
  readonly descriptorId: string;
  readonly descriptorVersion: 1;
  readonly kind: TKind;
  readonly order: number;
  readonly readKeysetPage: (input: RepairKeysetPageInput) => readonly unknown[];
  readonly mapRow: (row: unknown) => TRecord;
  readonly stableKey: (record: TRecord) => string;
}

export interface ReadRegisteredRepairPageInput<TKind extends string>
  extends RepairKeysetPageInput {
  readonly kind: TKind;
}

export interface ClosedRepairProjectionRegistry<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
> {
  readonly descriptors: readonly RoomRepairSegmentDescriptor<TKind, TRecord>[];
  descriptorFor(kind: TKind): RoomRepairSegmentDescriptor<TKind, TRecord>;
  readStablePage(input: ReadRegisteredRepairPageInput<TKind>): readonly TRecord[];
}

export const TOOL_SAFETY_REPAIR_KINDS = Object.freeze([
  "tool-call",
  "tool-confirmation",
  "tool-grant",
  "tool-dispatch",
  "tool-review",
  "tool-handoff",
  "tool-compensation",
] as const);

export type ToolSafetyRepairKind = typeof TOOL_SAFETY_REPAIR_KINDS[number];

export type PublicToolSafetyRepairRecord =
  | Readonly<{
      kind: "tool-call";
      value: Readonly<{
        toolCallId: string; toolId: string; safePreview: string;
        state: "prepared"; version: number; sourceRef: string;
      }>;
    }>
  | Readonly<{
      kind: "tool-confirmation";
      value: Readonly<{
        confirmationId: string;
        toolCallId: string;
        toolId: string;
        state: "pending" | "confirmed" | "rejected" | "expired";
        safePreview: string;
        reasonCode: string | null;
        expiresAt: string;
        version: number;
        principalActorId: string;
        namedHumanDisplayRef: string | null;
        sourceRef: string;
      }>;
    }>
  | Readonly<{
      kind: "tool-grant";
      value: Readonly<{
        grantId: string;
        toolCallId: string;
        state: "active" | "claimed" | "revoked" | "expired";
        reasonCode: string | null;
        expiresAt: string;
        version: number;
      }>;
    }>
  | Readonly<{
      kind: "tool-dispatch";
      value: Readonly<{
        dispatchId: string;
        toolCallId: string;
        state: "prepared" | "claimed" | "dispatched" | "known_succeeded" |
          "known_failed" | "outcome_unknown" | "reviewed";
        reasonCode: string | null;
        version: number;
      }>;
    }>
  | Readonly<{
      kind: "tool-review";
      value: Readonly<{
        reviewId: string;
        dispatchId: string;
        resolution: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
        evidenceSummary: string;
        namedHumanDisplayRef: string;
        compensationToolCallId: string | null;
        version: number;
      }>;
    }>
  | Readonly<{
      kind: "tool-handoff";
      value: Readonly<{
        handoffId: string; confirmationId: string;
        state: "offered" | "accepted" | "rejected" | "expired";
        targetActorId: string; targetNamedHumanDisplayRef: string; version: number;
      }>;
    }>
  | Readonly<{
      kind: "tool-compensation";
      value: Readonly<{
        lineageId: string; originalDispatchId: string; compensationInvocationId: string;
        compensationExecutionId: string; compensationToolCallId: string;
        state: "pending" | "rejected" | "expired" | "claimed" | "dispatched" |
          "known_succeeded" | "known_failed" | "outcome_unknown" | "reviewed";
        version: number;
      }>;
    }>;

const TOOL_SAFETY_FORBIDDEN_PUBLIC_KEYS = new Set([
  "rawParameters", "parameters", "canonicalParameterSha256", "parameterHash",
  "sealedPayload", "sealedParameters", "grantCapability", "capability", "dispatchPermit",
  "compensationToken", "credential", "headers", "body", "stdout", "stderr", "reasoning",
]);

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key));
}

function safeText(value: unknown, maximumBytes = 8_192): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function positiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function publicObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !Reflect.ownKeys(value).some((key) => typeof key !== "string" ||
      TOOL_SAFETY_FORBIDDEN_PUBLIC_KEYS.has(key));
}

/** Exact wire/repair guard; it intentionally has no escape hatch for internal fields. */
export function isPublicToolSafetyRepairRecord(value: unknown): value is PublicToolSafetyRepairRecord {
  if (!publicObject(value) || !publicObject(value.value) ||
      !TOOL_SAFETY_REPAIR_KINDS.includes(value.kind as ToolSafetyRepairKind)) return false;
  const body = value.value;
  if (value.kind === "tool-call") {
    return hasExactKeys(body, ["toolCallId", "toolId", "safePreview", "state", "version", "sourceRef"]) &&
      safeText(body.toolCallId) && safeText(body.toolId) && safeText(body.safePreview) &&
      body.state === "prepared" && positiveVersion(body.version) && safeText(body.sourceRef, 512);
  }
  if (value.kind === "tool-confirmation") {
    return hasExactKeys(body, [
      "confirmationId", "toolCallId", "toolId", "state", "safePreview", "reasonCode",
      "expiresAt", "version", "principalActorId", "namedHumanDisplayRef", "sourceRef",
    ]) && safeText(body.confirmationId) && safeText(body.toolCallId) && safeText(body.toolId) &&
      ["pending", "confirmed", "rejected", "expired"].includes(body.state as string) &&
      safeText(body.safePreview) && (body.reasonCode === null || safeText(body.reasonCode, 256)) &&
      safeText(body.expiresAt, 64) && positiveVersion(body.version) && safeText(body.principalActorId) &&
      (body.namedHumanDisplayRef === null || safeText(body.namedHumanDisplayRef, 256)) &&
      safeText(body.sourceRef, 512);
  }
  if (value.kind === "tool-grant") {
    return hasExactKeys(body, ["grantId", "toolCallId", "state", "reasonCode", "expiresAt", "version"]) &&
      safeText(body.grantId) && safeText(body.toolCallId) &&
      ["active", "claimed", "revoked", "expired"].includes(body.state as string) &&
      (body.reasonCode === null || safeText(body.reasonCode, 256)) &&
      safeText(body.expiresAt, 64) && positiveVersion(body.version);
  }
  if (value.kind === "tool-dispatch") {
    return hasExactKeys(body, ["dispatchId", "toolCallId", "state", "reasonCode", "version"]) &&
      safeText(body.dispatchId) && safeText(body.toolCallId) &&
      ["prepared", "claimed", "dispatched", "known_succeeded", "known_failed",
        "outcome_unknown", "reviewed"].includes(body.state as string) &&
      (body.reasonCode === null || safeText(body.reasonCode, 256)) && positiveVersion(body.version);
  }
  if (value.kind === "tool-review") {
    return hasExactKeys(body, [
      "reviewId", "dispatchId", "resolution", "evidenceSummary", "namedHumanDisplayRef",
      "compensationToolCallId", "version",
    ]) && safeText(body.reviewId) && safeText(body.dispatchId) &&
      ["known_succeeded", "known_failed", "compensated", "accepted_risk"].includes(body.resolution as string) &&
      safeText(body.evidenceSummary, 2_048) && safeText(body.namedHumanDisplayRef, 256) &&
      (body.compensationToolCallId === null || safeText(body.compensationToolCallId)) &&
      positiveVersion(body.version);
  }
  if (value.kind === "tool-handoff") {
    return hasExactKeys(body, ["handoffId", "confirmationId", "state", "targetActorId",
      "targetNamedHumanDisplayRef", "version"]) && safeText(body.handoffId) &&
      safeText(body.confirmationId) && ["offered", "accepted", "rejected", "expired"]
        .includes(body.state as string) && safeText(body.targetActorId) &&
      safeText(body.targetNamedHumanDisplayRef, 256) &&
      positiveVersion(body.version);
  }
  return value.kind === "tool-compensation" && hasExactKeys(body,
    ["lineageId", "originalDispatchId", "compensationInvocationId",
      "compensationExecutionId", "compensationToolCallId", "state", "version"]) &&
    safeText(body.lineageId) && safeText(body.originalDispatchId) &&
    safeText(body.compensationInvocationId) && safeText(body.compensationExecutionId) &&
    safeText(body.compensationToolCallId) && ["pending", "rejected", "expired", "claimed",
      "dispatched", "known_succeeded", "known_failed", "outcome_unknown", "reviewed"]
      .includes(body.state as string) && positiveVersion(body.version);
}

export function createToolSafetyRepairProjectionRegistry(
  descriptors: readonly RoomRepairSegmentDescriptor<ToolSafetyRepairKind, PublicToolSafetyRepairRecord>[],
): ClosedRepairProjectionRegistry<ToolSafetyRepairKind, PublicToolSafetyRepairRecord> {
  return createClosedRepairProjectionRegistry({
    knownKinds: TOOL_SAFETY_REPAIR_KINDS,
    descriptors: descriptors.map((descriptor) => ({
      ...descriptor,
      mapRow(row: unknown): PublicToolSafetyRepairRecord {
        const record = descriptor.mapRow(row);
        if (!isPublicToolSafetyRepairRecord(record)) reject("malformed_descriptor");
        return record;
      },
    })),
  });
}

function reject(reason: RepairProjectionRegistryFailureReason): never {
  throw new RepairProjectionRegistryError(reason);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type RepairRecordGuard<TRecord> = (
  value: unknown,
  roomId: string,
) => value is TRecord;

function createRegistry<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
>(options: Readonly<{
  knownKinds: readonly TKind[];
  descriptors: readonly RoomRepairSegmentDescriptor<TKind, TRecord>[];
}>, recordGuard?: RepairRecordGuard<TRecord>): ClosedRepairProjectionRegistry<TKind, TRecord> {
  if (!Array.isArray(options.knownKinds) || options.knownKinds.length === 0 ||
    !options.knownKinds.every(isNonEmptyString) ||
    new Set(options.knownKinds).size !== options.knownKinds.length) {
    reject("invalid_known_kinds");
  }

  const knownKinds = new Set<string>(options.knownKinds);
  const descriptorIds = new Set<string>();
  const descriptorKinds = new Set<string>();
  const orders = new Set<number>();
  const indexed = new Map<TKind, RoomRepairSegmentDescriptor<TKind, TRecord>>();

  for (const descriptor of options.descriptors) {
    if (typeof descriptor !== "object" || descriptor === null ||
      !isNonEmptyString(descriptor.descriptorId) || descriptor.descriptorVersion !== 1 ||
      !isNonEmptyString(descriptor.kind) || !isNonNegativeSafeInteger(descriptor.order) ||
      typeof descriptor.readKeysetPage !== "function" || typeof descriptor.mapRow !== "function" ||
      typeof descriptor.stableKey !== "function") {
      reject("malformed_descriptor");
    }
    if (!knownKinds.has(descriptor.kind)) reject("unknown_kind");
    if (descriptorIds.has(descriptor.descriptorId)) reject("duplicate_descriptor_id");
    if (descriptorKinds.has(descriptor.kind)) reject("duplicate_kind");
    if (orders.has(descriptor.order)) reject("duplicate_order");
    descriptorIds.add(descriptor.descriptorId);
    descriptorKinds.add(descriptor.kind);
    orders.add(descriptor.order);
    indexed.set(descriptor.kind as TKind, Object.freeze({ ...descriptor }));
  }

  if (options.knownKinds.some((kind) => !indexed.has(kind as TKind))) reject("missing_kind");

  const descriptors = Object.freeze([...indexed.values()].sort((left, right) =>
    left.order - right.order || left.kind.localeCompare(right.kind)));

  const descriptorFor = (kind: TKind): RoomRepairSegmentDescriptor<TKind, TRecord> => {
    const descriptor = indexed.get(kind);
    if (descriptor === undefined) reject("unknown_kind");
    return descriptor;
  };

  return Object.freeze({
    descriptors,
    descriptorFor,
    readStablePage(input: ReadRegisteredRepairPageInput<TKind>): readonly TRecord[] {
      if (!isNonEmptyString(input.roomId) || !isNonNegativeSafeInteger(input.watermark) ||
        !Number.isSafeInteger(input.limit) || input.limit <= 0 ||
        (input.afterKey !== undefined && !isNonEmptyString(input.afterKey))) {
        reject("unstable_page");
      }
      const descriptor = descriptorFor(input.kind);
      const rows = descriptor.readKeysetPage(input);
      if (!Array.isArray(rows) || rows.length > input.limit) reject("unstable_page");

      const records: TRecord[] = [];
      let previousKey = input.afterKey;
      for (const row of rows) {
        const record = descriptor.mapRow(row);
        if (typeof record !== "object" || record === null || record.kind !== input.kind) {
          reject("cross_kind_record");
        }
        if (recordGuard !== undefined && !recordGuard(record, input.roomId)) {
          reject("record_guard_rejected");
        }
        const key = descriptor.stableKey(record);
        if (!isNonEmptyString(key) || (previousKey !== undefined && key <= previousKey)) {
          reject("unstable_page");
        }
        previousKey = key;
        records.push(record);
      }
      return Object.freeze(records);
    },
  });
}

export function createClosedRepairProjectionRegistry<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
>(options: Readonly<{
  knownKinds: readonly TKind[];
  descriptors: readonly RoomRepairSegmentDescriptor<TKind, TRecord>[];
}>): ClosedRepairProjectionRegistry<TKind, TRecord> {
  return createRegistry(options);
}

export function createGuardedClosedRepairProjectionRegistry<
  TKind extends string,
  TRecord extends Readonly<{ kind: TKind }>,
>(options: Readonly<{
  knownKinds: readonly TKind[];
  descriptors: readonly RoomRepairSegmentDescriptor<TKind, TRecord>[];
  recordGuard: RepairRecordGuard<TRecord>;
}>): ClosedRepairProjectionRegistry<TKind, TRecord> {
  if (typeof options.recordGuard !== "function") reject("missing_record_guard");
  return createRegistry({
    knownKinds: options.knownKinds,
    descriptors: options.descriptors,
  }, options.recordGuard);
}
