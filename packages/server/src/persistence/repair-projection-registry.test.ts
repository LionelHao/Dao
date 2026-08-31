import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  RepairProjectionRegistryError,
  createClosedRepairProjectionRegistry,
  createGuardedClosedRepairProjectionRegistry,
  createToolSafetyRepairProjectionRegistry,
  isPublicToolSafetyRepairRecord,
  TOOL_SAFETY_REPAIR_KINDS,
  type PublicToolSafetyRepairRecord,
  type RoomRepairSegmentDescriptor,
  type ToolSafetyRepairKind,
} from "./repair-projection-registry.js";

type Kind = "lifecycle" | "message";
type RecordValue = Readonly<{ kind: Kind; id: string }>;

function descriptor(
  kind: Kind,
  order: number,
  descriptorId = `dao.repair.${kind}.v1`,
): RoomRepairSegmentDescriptor<Kind, RecordValue> {
  return {
    descriptorId,
    descriptorVersion: 1,
    kind,
    order,
    readKeysetPage({ database, roomId, afterKey, limit }) {
      return database.prepare(`
        SELECT kind, id
        FROM repair_records
        WHERE room_id = ? AND kind = ? AND id > ?
        ORDER BY id ASC
        LIMIT ?
      `).all(roomId, kind, afterKey ?? "", limit);
    },
    mapRow(row) {
      const candidate = row as { kind: Kind; id: string };
      return Object.freeze({ kind: candidate.kind, id: candidate.id });
    },
    stableKey(record) {
      return record.id;
    },
  };
}

describe("closed repair projection registry", () => {
  it("assembles every known descriptor in stable order and validates keyset pages", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE repair_records (
          room_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (room_id, kind, id)
        ) STRICT;
        INSERT INTO repair_records VALUES
          ('room-1', 'message', 'message-2'),
          ('room-1', 'message', 'message-1'),
          ('room-1', 'lifecycle', 'lifecycle-1');
      `);

      const registry = createClosedRepairProjectionRegistry<Kind, RecordValue>({
        knownKinds: ["lifecycle", "message"],
        descriptors: [descriptor("message", 20), descriptor("lifecycle", 10)],
      });

      expect(registry.descriptors.map(({ kind }) => kind)).toEqual(["lifecycle", "message"]);
      expect(registry.readStablePage({
        database,
        roomId: "room-1",
        watermark: 7,
        kind: "message",
        afterKey: undefined,
        limit: 10,
      })).toEqual([
        { kind: "message", id: "message-1" },
        { kind: "message", id: "message-2" },
      ]);
      expect(registry.descriptorFor("lifecycle").descriptorId).toBe(
        "dao.repair.lifecycle.v1",
      );
    } finally {
      database.close();
    }
  });

  it("requires and applies the production record guard before returning mapped records", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE repair_records (
          room_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          id TEXT NOT NULL
        ) STRICT;
        INSERT INTO repair_records VALUES ('room-1', 'message', 'message-1');
      `);
      expect(() => createGuardedClosedRepairProjectionRegistry<Kind, RecordValue>({
        knownKinds: ["lifecycle", "message"],
        descriptors: [descriptor("lifecycle", 10), descriptor("message", 20)],
        recordGuard: undefined as unknown as (
          value: unknown,
          roomId: string,
        ) => value is RecordValue,
      })).toThrow(new RepairProjectionRegistryError("missing_record_guard"));

      const registry = createGuardedClosedRepairProjectionRegistry<Kind, RecordValue>({
        knownKinds: ["lifecycle", "message"],
        descriptors: [descriptor("lifecycle", 10), descriptor("message", 20)],
        recordGuard: (value, roomId): value is RecordValue =>
          typeof value === "object" && value !== null &&
          (value as { kind?: unknown }).kind === "lifecycle" && roomId === "room-1",
      });
      expect(() => registry.readStablePage({
        database,
        roomId: "room-1",
        watermark: 1,
        kind: "message",
        afterKey: undefined,
        limit: 1,
      })).toThrow(new RepairProjectionRegistryError("record_guard_rejected"));
    } finally {
      database.close();
    }
  });

  it("rejects missing, unknown, duplicate, and unstable descriptors", () => {
    const create = (descriptors: readonly RoomRepairSegmentDescriptor<Kind, RecordValue>[]) =>
      createClosedRepairProjectionRegistry<Kind, RecordValue>({
        knownKinds: ["lifecycle", "message"],
        descriptors,
      });

    expect(() => create([descriptor("lifecycle", 10)])).toThrow(
      new RepairProjectionRegistryError("missing_kind"),
    );
    expect(() => create([
      descriptor("lifecycle", 10),
      { ...descriptor("message", 20), kind: "unknown" as Kind },
    ])).toThrow(new RepairProjectionRegistryError("unknown_kind"));
    expect(() => create([
      descriptor("lifecycle", 10),
      descriptor("lifecycle", 20, "dao.repair.lifecycle.second.v1"),
      descriptor("message", 30),
    ])).toThrow(new RepairProjectionRegistryError("duplicate_kind"));
    expect(() => create([
      descriptor("lifecycle", 10, "same-id"),
      descriptor("message", 20, "same-id"),
    ])).toThrow(new RepairProjectionRegistryError("duplicate_descriptor_id"));
    expect(() => create([
      descriptor("lifecycle", 10),
      descriptor("message", 10),
    ])).toThrow(new RepairProjectionRegistryError("duplicate_order"));
  });

  it("rejects unknown lookup and non-monotonic or cross-kind mapped records", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("CREATE TABLE repair_records (room_id TEXT, kind TEXT, id TEXT) STRICT");
      const unstable = {
        ...descriptor("message", 20),
        readKeysetPage: () => [
          { kind: "message", id: "message-2" },
          { kind: "message", id: "message-1" },
        ],
      } satisfies RoomRepairSegmentDescriptor<Kind, RecordValue>;
      const registry = createClosedRepairProjectionRegistry<Kind, RecordValue>({
        knownKinds: ["lifecycle", "message"],
        descriptors: [descriptor("lifecycle", 10), unstable],
      });

      expect(() => registry.descriptorFor("unknown" as Kind)).toThrow(
        new RepairProjectionRegistryError("unknown_kind"),
      );
      expect(() => registry.readStablePage({
        database,
        roomId: "room-1",
        watermark: 1,
        kind: "message",
        afterKey: undefined,
        limit: 10,
      })).toThrow(new RepairProjectionRegistryError("unstable_page"));

      const crossKind = {
        ...descriptor("message", 20),
        readKeysetPage: () => [{ kind: "lifecycle", id: "lifecycle-1" }],
      } satisfies RoomRepairSegmentDescriptor<Kind, RecordValue>;
      const crossKindRegistry = createClosedRepairProjectionRegistry<Kind, RecordValue>({
        knownKinds: ["lifecycle", "message"],
        descriptors: [descriptor("lifecycle", 10), crossKind],
      });
      expect(() => crossKindRegistry.readStablePage({
        database,
        roomId: "room-1",
        watermark: 1,
        kind: "message",
        afterKey: undefined,
        limit: 10,
      })).toThrow(new RepairProjectionRegistryError("cross_kind_record"));
    } finally {
      database.close();
    }
  });
});

describe("FT-10 public-safe repair registry", () => {
  const records = {
    "tool-call": {
      kind: "tool-call",
      value: { toolCallId: "tool-call-1", toolId: "sandbox-file.write",
        safePreview: "Write config.json (12 bytes)", state: "prepared", version: 1,
        sourceRef: "message-1" },
    },
    "tool-confirmation": {
      kind: "tool-confirmation",
      value: {
        confirmationId: "confirmation-1", toolCallId: "tool-call-1",
        toolId: "sandbox-file.write", state: "pending", safePreview: "Write config.json (12 bytes)",
        reasonCode: null, expiresAt: "2026-08-30T08:10:00.000Z", version: 1,
        principalActorId: "human-1", namedHumanDisplayRef: "Human A", sourceRef: "message-1",
      },
    },
    "tool-grant": {
      kind: "tool-grant",
      value: {
        grantId: "grant-1", toolCallId: "tool-call-1", state: "active",
        reasonCode: null, expiresAt: "2026-08-30T08:06:00.000Z", version: 1,
      },
    },
    "tool-dispatch": {
      kind: "tool-dispatch",
      value: {
        dispatchId: "dispatch-1", toolCallId: "tool-call-1",
        state: "outcome_unknown", reasonCode: "adapter_timeout", version: 3,
      },
    },
    "tool-review": {
      kind: "tool-review",
      value: {
        reviewId: "review-1", dispatchId: "dispatch-1", resolution: "accepted_risk",
        evidenceSummary: "Human inspected the configured target.",
        namedHumanDisplayRef: "Human A", compensationToolCallId: null, version: 1,
      },
    },
    "tool-handoff": {
      kind: "tool-handoff",
      value: { handoffId: "handoff-1", confirmationId: "confirmation-1",
        state: "offered", targetActorId: "human-2", targetNamedHumanDisplayRef: "Human B", version: 1 },
    },
    "tool-compensation": {
      kind: "tool-compensation",
      value: { lineageId: "lineage-1", originalDispatchId: "dispatch-1",
        compensationInvocationId: "invocation-2", compensationExecutionId: "execution-2",
        compensationToolCallId: "tool-call-2", state: "pending", version: 1 },
    },
  } as const satisfies Readonly<Record<ToolSafetyRepairKind, PublicToolSafetyRepairRecord>>;

  it("registers the complete FT-10 public-safe inventory and validates mapped rows", () => {
    const descriptors = TOOL_SAFETY_REPAIR_KINDS.map((kind, index) => ({
      descriptorId: `dao.repair.${kind}.v1`, descriptorVersion: 1 as const,
      kind, order: 100 + index,
      readKeysetPage: () => [records[kind]],
      mapRow: (row: unknown) => row as PublicToolSafetyRepairRecord,
      stableKey: (record: PublicToolSafetyRepairRecord) =>
        "lineageId" in record.value ? record.value.lineageId
          : "handoffId" in record.value ? record.value.handoffId
          : "confirmationId" in record.value ? record.value.confirmationId
          : "grantId" in record.value ? record.value.grantId
            : "reviewId" in record.value ? record.value.reviewId
              : "dispatchId" in record.value ? record.value.dispatchId : record.value.toolCallId,
    })) satisfies readonly RoomRepairSegmentDescriptor<ToolSafetyRepairKind, PublicToolSafetyRepairRecord>[];
    const registry = createToolSafetyRepairProjectionRegistry(descriptors);
    expect(registry.descriptors.map(({ kind }) => kind)).toEqual(TOOL_SAFETY_REPAIR_KINDS);
    for (const kind of TOOL_SAFETY_REPAIR_KINDS) {
      expect(registry.readStablePage({
        database: new DatabaseSync(":memory:"), roomId: "room-1", watermark: 7,
        kind, afterKey: undefined, limit: 1,
      })).toEqual([records[kind]]);
    }
  });

  it("rejects internal capability, hashes, sealed/raw data and unbounded previews", () => {
    for (const field of [
      "rawParameters", "canonicalParameterSha256", "sealedPayload", "grantCapability",
      "dispatchPermit", "compensationToken", "credential", "headers", "body", "stdout",
      "stderr", "reasoning",
    ]) {
      expect(isPublicToolSafetyRepairRecord({
        ...records["tool-confirmation"],
        value: { ...records["tool-confirmation"].value, [field]: `${field}-canary` },
      })).toBe(false);
    }
    expect(isPublicToolSafetyRepairRecord({
      ...records["tool-confirmation"],
      value: { ...records["tool-confirmation"].value, safePreview: "x".repeat(8_193) },
    })).toBe(false);
    expect(isPublicToolSafetyRepairRecord(records["tool-review"])).toBe(true);
  });
});
