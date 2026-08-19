import { describe, expect, it, vi } from "vitest";

import { reconcileAttachmentObjectStore } from "./object-reconciliation.js";

describe("Attachment filesystem/SQLite crash reconciliation", () => {
  it("uses only the single-writer reference snapshot and drains bounded orphan batches", async () => {
    const executeAttachment = vi.fn(async () => ({
      referencedUploadIds: ["00000000-0000-4000-8000-000000000001"],
      referencedQuarantineAttachmentIds: ["00000000-0000-4000-8000-000000000101"],
      referencedObjectKeys: [
        `extraction_${"b".repeat(64)}`,
        `object_${"a".repeat(64)}`,
      ],
    }));
    const reconcileOrphans = vi.fn()
      .mockResolvedValueOnce({ deletedEntries: 1024, deletedBytes: 2048, limitReached: true })
      .mockResolvedValueOnce({ deletedEntries: 2, deletedBytes: 64, limitReached: false });

    await expect(reconcileAttachmentObjectStore({
      database: { executeAttachment },
      objectStore: { reconcileOrphans },
      nowMs: () => 1,
      maxPasses: 4,
    })).resolves.toEqual({ deletedEntries: 1026, deletedBytes: 2112, passes: 2 });
    expect(executeAttachment).toHaveBeenCalledOnce();
    expect(reconcileOrphans).toHaveBeenCalledTimes(2);
    expect(reconcileOrphans).toHaveBeenCalledWith({
      referencedUploadIds: new Set(["00000000-0000-4000-8000-000000000001"]),
      referencedQuarantineAttachmentIds: new Set(["00000000-0000-4000-8000-000000000101"]),
      referencedObjectKeys: new Set([
        `extraction_${"b".repeat(64)}`,
        `object_${"a".repeat(64)}`,
      ]),
    });
  });

  it("fails closed when bounded reconciliation cannot drain the orphan backlog", async () => {
    await expect(reconcileAttachmentObjectStore({
      database: { executeAttachment: vi.fn(async () => ({
        referencedUploadIds: [], referencedQuarantineAttachmentIds: [], referencedObjectKeys: [],
      })) },
      objectStore: { reconcileOrphans: vi.fn(async () => ({
        deletedEntries: 1, deletedBytes: 1, limitReached: true,
      })) },
      nowMs: () => 1,
      maxPasses: 2,
    })).rejects.toThrow("attachment_reconciliation_limit");
  });
});
