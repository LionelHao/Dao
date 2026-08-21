import { describe, expect, it, vi } from "vitest";
import {
  createRoomMemoryReadTool,
  RoomMemoryReadError,
  type RoomMemoryReadAuthorization,
  type RoomMemoryReadAuthority,
  type RoomMemoryReadPage,
} from "./room-memory-read-tool.js";

const authorization: RoomMemoryReadAuthorization = {
  executionId: "execution-1", attemptSeq: 1, roomId: "room-1", agentId: "agent-1",
  snapshotId: "snapshot-1", snapshotGeneration: 2,
  sourceLabel: "source-1", sourceKind: "message_revision", sourceId: "message-1", sourceRevision: 3,
  authorizationEpoch: 4, callCount: 0, cumulativeBytes: 0, pageSize: 8,
  readerCapability: "opaque-reader-capability",
};

const page: RoomMemoryReadPage = {
  items: [{
    ordinal: 1,
    text: "bounded source",
    provenance: { sourceKind: "message_revision", sourceLabel: "source-1", sourceRevision: 3 },
  }],
  continuation: null,
};
const receiptLabel = `read:${Buffer.alloc(32, 7).toString("base64url")}`;

function authority(overrides: Partial<RoomMemoryReadAuthority> = {}): RoomMemoryReadAuthority {
  return {
    authorize: vi.fn(async () => authorization),
    sealContinuation: vi.fn(async () => null),
    ...overrides,
  };
}

function invocation(parameters: Readonly<Record<string, unknown>>) {
  return {
    executionId: "execution-1", attemptSeq: 1, roomId: "room-1", agentId: "agent-1",
    callId: "call-1", grantId: "grant-1", dispatchId: "dispatch-1", toolId: "room-memory.read" as const,
    parameters, signal: new AbortController().signal,
  };
}

describe("room-memory.read adapter", () => {
  it("reauthorizes before and after every bounded page and emits a receipt", async () => {
    const sourceAuthority = authority();
    const reader = { readPage: vi.fn(async () => page) };
    const receipts = { issue: vi.fn(async () => ({ citationLabel: receiptLabel })) };
    const adapter = createRoomMemoryReadTool({ authority: sourceAuthority, reader, receipts });

    const outcome = await adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source", pageSize: 8,
    }));

    expect(sourceAuthority.authorize).toHaveBeenCalledTimes(2);
    expect(sourceAuthority.authorize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: "before", callId: "call-1", grantId: "grant-1", dispatchId: "dispatch-1",
      toolId: "room-memory.read",
    }));
    expect(sourceAuthority.authorize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phase: "after", expected: authorization,
    }));
    expect(reader.readPage).toHaveBeenCalledTimes(1);
    expect(receipts.issue).toHaveBeenCalledWith(expect.objectContaining({
      executionId: "execution-1", snapshotId: "snapshot-1", snapshotGeneration: 2,
      sourceLabel: "source-1", sourceRevision: 3,
    }));
    expect(JSON.parse(outcome.modelInput)).toEqual({
      type: "room-memory.read.result.v1",
      snapshotId: "snapshot-1",
      sourceLabel: "source-1",
      mode: "source",
      sourceRevision: 3,
      items: page.items,
      nextCursor: null,
      citationLabel: receiptLabel,
    });
  });

  it("accepts a manifest-authorized delta range without disguising it as a message", async () => {
    const rangeAuthorization: RoomMemoryReadAuthorization = {
      ...authorization,
      sourceKind: "delta_range",
      sourceId: "b".repeat(64),
      sourceRevision: 4,
    };
    const rangePage: RoomMemoryReadPage = {
      items: [{
        ordinal: 1,
        text: "bounded range source index",
        provenance: {
          sourceKind: "delta_range",
          sourceLabel: rangeAuthorization.sourceLabel,
          sourceRevision: rangeAuthorization.sourceRevision,
        },
      }],
      continuation: null,
    };
    const sourceAuthority = authority({
      authorize: vi.fn(async () => rangeAuthorization),
    });
    const reader = { readPage: vi.fn(async () => rangePage) };
    const receipts = { issue: vi.fn(async () => ({ citationLabel: receiptLabel })) };
    const adapter = createRoomMemoryReadTool({ authority: sourceAuthority, reader, receipts });

    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source", pageSize: 8,
    }))).resolves.toMatchObject({ summary: { outcome: "succeeded", itemCount: 1 } });
    expect(receipts.issue).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "delta_range",
      sourceId: "b".repeat(64),
      sourceRevision: 4,
    }));
  });

  it.each([
    [{}, "invalid_request"],
    [{ snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source", extra: true }, "invalid_request"],
    [{ snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source", pageSize: 9 }, "invalid_request"],
    [{ snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source", cursor: "x", pageSize: 1 }, "invalid_request"],
    [{ snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source", cursor: "😀" }, "invalid_request"],
    [{ snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "attachment_segment", pageSize: 0 }, "invalid_request"],
    [{ snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "sql" }, "invalid_request"],
  ])("rejects non-closed parameters before authority/source calls", async (parameters, code) => {
    const sourceAuthority = authority();
    const reader = { readPage: vi.fn() };
    const receipts = { issue: vi.fn() };
    const adapter = createRoomMemoryReadTool({ authority: sourceAuthority, reader, receipts });
    await expect(adapter.execute(invocation(parameters))).rejects.toMatchObject({ code });
    expect(sourceAuthority.authorize).not.toHaveBeenCalled();
    expect(reader.readPage).not.toHaveBeenCalled();
    expect(receipts.issue).not.toHaveBeenCalled();
  });

  it.each([
    [401, "identity_invalid"], [403, "source_unavailable"], [409, "stale_context"],
    [410, "source_gone"], [429, "read_budget_exhausted"], [503, "authority_unavailable"],
  ] as const)("preserves closed %s rejection and makes zero reader calls", async (status, code) => {
    const sourceAuthority = authority({
      authorize: vi.fn(async () => { throw new RoomMemoryReadError(status, code); }),
    });
    const reader = { readPage: vi.fn() };
    const adapter = createRoomMemoryReadTool({
      authority: sourceAuthority, reader, receipts: { issue: vi.fn() },
    });
    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({ status, code });
    expect(reader.readPage).not.toHaveBeenCalled();
  });

  it("discards a page when post-read authorization changes", async () => {
    const changed = { ...authorization, authorizationEpoch: 5 };
    const sourceAuthority = authority({
      authorize: vi.fn()
        .mockResolvedValueOnce(authorization)
        .mockResolvedValueOnce(changed),
    });
    const reader = { readPage: vi.fn(async () => page) };
    const receipts = { issue: vi.fn() };
    const adapter = createRoomMemoryReadTool({ authority: sourceAuthority, reader, receipts });
    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({ status: 409, code: "stale_context" });
    expect(reader.readPage).toHaveBeenCalledTimes(1);
    expect(receipts.issue).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...authorization, callCount: 32 }, "read_budget_exhausted"],
    [{ ...authorization, cumulativeBytes: 262_144 }, "read_budget_exhausted"],
  ])("enforces execution budgets before the reader", async (authorized, code) => {
    const reader = { readPage: vi.fn() };
    const adapter = createRoomMemoryReadTool({
      authority: authority({ authorize: vi.fn(async () => authorized) }),
      reader, receipts: { issue: vi.fn() },
    });
    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({ status: 429, code });
    expect(reader.readPage).not.toHaveBeenCalled();
  });

  it("rejects pages above 8 items or 32 KiB without issuing a receipt", async () => {
    const tooLarge: RoomMemoryReadPage = {
      items: [{
        ordinal: 1, text: "x".repeat(32_769),
        provenance: { sourceKind: "message_revision", sourceLabel: "source-1", sourceRevision: 3 },
      }],
      continuation: null,
    };
    const sourceAuthority = authority();
    const receipts = { issue: vi.fn() };
    const adapter = createRoomMemoryReadTool({
      authority: sourceAuthority, reader: { readPage: vi.fn(async () => tooLarge) }, receipts,
    });
    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({ status: 429, code: "page_limit_exceeded" });
    expect(sourceAuthority.authorize).toHaveBeenCalledTimes(2);
    expect(receipts.issue).not.toHaveBeenCalled();
  });

  it.each([
    { sourceKind: "delta_range", sourceLabel: "source-1", sourceRevision: 3 },
    { sourceKind: "message_revision", sourceLabel: "foreign-source", sourceRevision: 3 },
    { sourceKind: "message_revision", sourceLabel: "source-1", sourceRevision: 4 },
  ] as const)("rejects reader provenance that is not exactly bound to the authorization", async (provenance) => {
    const reader = { readPage: vi.fn(async (): Promise<RoomMemoryReadPage> => ({
      items: [{ ordinal: 1, text: "foreign", provenance }],
      continuation: null,
    })) };
    const receipts = { issue: vi.fn() };
    const adapter = createRoomMemoryReadTool({ authority: authority(), reader, receipts });

    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({ status: 503, code: "source_response_invalid" });
    expect(receipts.issue).not.toHaveBeenCalled();
  });

  it("counts JSON escaping and provenance inside the 32 KiB page budget", async () => {
    const escaped: RoomMemoryReadPage = {
      items: [{
        ordinal: 1,
        text: "\u0000".repeat(6_000),
        provenance: { sourceKind: "message_revision", sourceLabel: "source-1", sourceRevision: 3 },
      }],
      continuation: null,
    };
    const sourceAuthority = authority();
    const receipts = { issue: vi.fn() };
    const adapter = createRoomMemoryReadTool({
      authority: sourceAuthority,
      reader: { readPage: vi.fn(async () => escaped) },
      receipts,
    });

    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({ status: 429, code: "page_limit_exceeded" });
    expect(sourceAuthority.sealContinuation).not.toHaveBeenCalled();
    expect(receipts.issue).not.toHaveBeenCalled();
  });

  it.each([
    [1, 1],
    [2, 1],
    [1, 3],
  ])("rejects duplicate, descending, or discontinuous page ordinals", async (first, second) => {
    const malformed: RoomMemoryReadPage = {
      items: [first, second].map((ordinal) => ({
        ordinal,
        text: `item-${ordinal}`,
        provenance: { sourceKind: "message_revision", sourceLabel: "source-1", sourceRevision: 3 },
      })),
      continuation: null,
    };
    const receipts = { issue: vi.fn() };
    const adapter = createRoomMemoryReadTool({
      authority: authority(), reader: { readPage: vi.fn(async () => malformed) }, receipts,
    });
    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({ status: 503, code: "source_response_invalid" });
    expect(receipts.issue).not.toHaveBeenCalled();
  });

  it("uses the cursor-bound page size and does not allow the caller to replace it", async () => {
    const sourceAuthority = authority({
      authorize: vi.fn(async () => ({ ...authorization, pageSize: 2 })),
    });
    const reader = { readPage: vi.fn(async () => page) };
    const adapter = createRoomMemoryReadTool({
      authority: sourceAuthority, reader, receipts: { issue: vi.fn(async () => ({ citationLabel: receiptLabel })) },
    });
    await adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source", cursor: "opaque-cursor",
    }));
    expect(reader.readPage).toHaveBeenCalledWith(expect.objectContaining({
      cursor: "opaque-cursor", pageSize: 2,
    }));
  });

  it.each([
    { kind: "cursor", cursor: "😀" },
    { kind: "citation", cursor: null },
  ] as const)("rejects non-closed $kind authority output without returning source content", async ({ kind, cursor }) => {
    const sourceAuthority = authority({
      sealContinuation: vi.fn(async () => cursor),
    });
    const receipts = {
      issue: vi.fn(async () => ({
        citationLabel: kind === "citation" ? "receipt-not-opaque" : receiptLabel,
      })),
    };
    const adapter = createRoomMemoryReadTool({
      authority: sourceAuthority, reader: { readPage: vi.fn(async () => page) }, receipts,
    });
    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
    }))).rejects.toMatchObject({
      status: 503,
      code: kind === "cursor" ? "authority_unavailable" : "receipt_unavailable",
    });
  });

  it("closes a stalled source read at the frozen five-second deadline", async () => {
    vi.useFakeTimers();
    try {
      const reader = { readPage: vi.fn(async () => new Promise<RoomMemoryReadPage>(() => undefined)) };
      const receipts = { issue: vi.fn() };
      const adapter = createRoomMemoryReadTool({ authority: authority(), reader, receipts });
      const pending = adapter.execute(invocation({
        snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
      }));
      const rejected = expect(pending).rejects.toMatchObject({
        status: 503, code: "source_read_timeout",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(reader.readPage).toHaveBeenCalledTimes(1);
      expect(receipts.issue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a late reader result after timeout before post-authorization or receipt writes", async () => {
    vi.useFakeTimers();
    try {
      let resolvePage: ((value: RoomMemoryReadPage) => void) | undefined;
      const reader = {
        readPage: vi.fn(async () => new Promise<RoomMemoryReadPage>((resolve) => {
          resolvePage = resolve;
        })),
      };
      const sourceAuthority = authority();
      const receipts = { issue: vi.fn() };
      const adapter = createRoomMemoryReadTool({ authority: sourceAuthority, reader, receipts });
      const pending = adapter.execute(invocation({
        snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source",
      }));
      const rejected = expect(pending).rejects.toMatchObject({
        status: 503, code: "source_read_timeout",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      resolvePage?.(page);
      await vi.runAllTimersAsync();
      await Promise.resolve();
      expect(sourceAuthority.authorize).toHaveBeenCalledTimes(1);
      expect(sourceAuthority.sealContinuation).not.toHaveBeenCalled();
      expect(receipts.issue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps FT-09 project reads disabled after current authorization", async () => {
    const reader = { readPage: vi.fn() };
    const adapter = createRoomMemoryReadTool({
      authority: authority({
        authorize: vi.fn(async () => ({
          ...authorization,
          sourceLabel: "project-1",
          sourceKind: "project_fact_checkpoint",
          sourceId: "project-1",
        })),
      }),
      reader,
      receipts: { issue: vi.fn() },
    });
    await expect(adapter.execute(invocation({
      snapshotId: "snapshot-1", sourceLabel: "project-1", mode: "project_object",
    }))).rejects.toMatchObject({ status: 503, code: "project_context_disabled" });
    expect(reader.readPage).not.toHaveBeenCalled();
  });
});
