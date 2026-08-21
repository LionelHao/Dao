import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CitationReceiptError,
  createCitationReceiptAuthority,
  type CitationReceiptRecord,
  type CitationReceiptStore,
} from "./citation-receipt-authority.js";

function store(): CitationReceiptStore & { readonly records: CitationReceiptRecord[] } {
  const records: CitationReceiptRecord[] = [];
  return {
    records,
    insert: vi.fn(async (record) => {
      if (records.some((existing) => existing.labelHash === record.labelHash)) return false;
      records.push(record);
      return true;
    }),
    findByLabelHash: vi.fn(async (labelHash) => records.find((record) => record.labelHash === labelHash)),
  };
}

const binding = {
  roomId: "room-1", executionId: "execution-1", snapshotId: "snapshot-1",
  snapshotGeneration: 2, sourceLabel: "source-1", sourceKind: "message_revision",
  sourceId: "message-1", sourceRevision: 3, authorizationEpoch: 4,
  representation: "source", range: "item:1", contentSha256: "a".repeat(64), contentBytes: 12,
} as const;

describe("citation receipt authority", () => {
  it("stores only a hash of a random execution-scoped receipt label", async () => {
    const receipts = store();
    const authority = createCitationReceiptAuthority({
      store: receipts,
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    });
    const issued = await authority.issue(binding);
    expect(issued.citationLabel).toMatch(/^read:/);
    expect(receipts.records).toHaveLength(1);
    expect(receipts.records[0]).toMatchObject({ ...binding, state: "successful" });
    expect(receipts.records[0]!.labelHash).toBe(
      createHash("sha256").update(issued.citationLabel, "utf8").digest("hex"),
    );
    expect(JSON.stringify(receipts.records[0])).not.toContain(issued.citationLabel);
  });

  it("accepts only current manifest labels or matching successful receipts, then deduplicates and sorts", async () => {
    const receipts = store();
    const authority = createCitationReceiptAuthority({
      store: receipts,
      randomBytes: () => new Uint8Array(32).fill(7),
    });
    const issued = await authority.issue(binding);
    await expect(authority.validateDeclarations({
      roomId: "room-1", executionId: "execution-1", snapshotId: "snapshot-1", snapshotGeneration: 2,
      declarations: [issued.citationLabel, "manifest-b", "manifest-a", issued.citationLabel],
      manifestLabels: ["manifest-a", "manifest-b"],
      revalidate: async () => true,
    })).resolves.toEqual(["manifest-a", "manifest-b", issued.citationLabel].sort());
  });

  it("rejects non-canonical base64url receipt declarations before store lookup", async () => {
    const receipts = store();
    const authority = createCitationReceiptAuthority({ store: receipts });
    await expect(authority.validateDeclarations({
      roomId: "room-1", executionId: "execution-1", snapshotId: "snapshot-1", snapshotGeneration: 2,
      declarations: [`read:${"A".repeat(42)}B`],
      manifestLabels: [],
      revalidate: async () => true,
    })).rejects.toMatchObject({ status: 409, code: "citation_declaration_invalid" });
    expect(receipts.findByLabelHash).not.toHaveBeenCalled();
  });

  it.each([
    ["roomId", "room-2"], ["executionId", "execution-2"], ["snapshotId", "snapshot-2"],
    ["snapshotGeneration", 3],
  ] as const)("rejects a receipt rebound through foreign %s", async (field, value) => {
    const receipts = store();
    const authority = createCitationReceiptAuthority({
      store: receipts, randomBytes: () => new Uint8Array(32).fill(9),
    });
    const issued = await authority.issue(binding);
    await expect(authority.validateDeclarations({
      roomId: "room-1", executionId: "execution-1", snapshotId: "snapshot-1", snapshotGeneration: 2,
      declarations: [issued.citationLabel], manifestLabels: [], revalidate: async () => true,
      [field]: value,
    })).rejects.toBeInstanceOf(CitationReceiptError);
  });

  it("fails closed when a source changes before final validation", async () => {
    const receipts = store();
    const authority = createCitationReceiptAuthority({
      store: receipts, randomBytes: () => new Uint8Array(32).fill(11),
    });
    const issued = await authority.issue(binding);
    const revalidate = vi.fn(async () => false);
    await expect(authority.validateDeclarations({
      roomId: "room-1", executionId: "execution-1", snapshotId: "snapshot-1", snapshotGeneration: 2,
      declarations: [issued.citationLabel], manifestLabels: [], revalidate,
    })).rejects.toMatchObject({ code: "citation_source_invalidated", status: 410 });
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("rejects forged natural-language or arbitrary labels without leaking authority facts", async () => {
    const authority = createCitationReceiptAuthority({
      store: store(), randomBytes: () => new Uint8Array(32).fill(13),
    });
    await expect(authority.validateDeclarations({
      roomId: "room-1", executionId: "execution-1", snapshotId: "snapshot-1", snapshotGeneration: 2,
      declarations: ["message-1", "[source: source-1]"], manifestLabels: ["source-1"],
      revalidate: async () => true,
    })).rejects.toMatchObject({ code: "citation_declaration_invalid", status: 409 });
  });
});
