import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  RepairProjectionRegistryError,
  createClosedRepairProjectionRegistry,
  type RoomRepairSegmentDescriptor,
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
