import { describe, expect, it } from "vitest";
import {
  createMemoryAuthorityViewModel,
  type MemoryPanelInput,
  type MemoryPanelVisibleState,
} from "./view-model.js";

function input(overrides: Partial<MemoryPanelInput> = {}): MemoryPanelInput {
  return {
    roomId: "room-1",
    lifecycle: "active",
    connection: { status: "online" },
    query: { status: "ready" },
    health: {
      status: "healthy", memoryWatermark: 12, corpusHead: 12, lag: 0,
      retryable: false, recoveryRequired: false,
    },
    memories: [],
    operation: { status: "idle" },
    viewer: { actorId: "human-1", currentHuman: true },
    reducedMotion: false,
    ...overrides,
  };
}

describe("FT-05 Memory panel authority-state mapping", () => {
  it.each([
    ["loading", input({ query: { status: "loading" } })],
    ["empty", input()],
    ["healthy", input({ memories: [{
      memoryRecordId: "memory-1", version: 1, kind: "context", state: "active",
      derivedText: "Release review happens Friday.", sources: [],
    }] })],
    ["catching-up", input({ health: {
      status: "catching_up", memoryWatermark: 12, corpusHead: 15, lag: 3,
      retryable: false, recoveryRequired: false,
    } })],
    ["noauth", input({ health: {
      status: "noauth", memoryWatermark: 12, corpusHead: 15, lag: 3,
      retryable: true, recoveryRequired: false,
    } })],
    ["degraded", input({ health: {
      status: "degraded", memoryWatermark: 12, corpusHead: 15, lag: 3,
      retryable: true, recoveryRequired: false,
    } })],
    ["recovery-required", input({ health: {
      status: "failed", memoryWatermark: 12, corpusHead: 15, lag: 3,
      retryable: false, recoveryRequired: true,
    } })],
    ["offline", input({ connection: { status: "offline" } })],
    ["repairing", input({ connection: { status: "repairing" } })],
    ["repair-failed", input({ connection: { status: "repair_failed" } })],
    ["archived-read-only", input({ lifecycle: "archived" })],
    ["revoked", input({ connection: { status: "revoked" } })],
  ] satisfies readonly (readonly [MemoryPanelVisibleState, MemoryPanelInput])[])(
    "maps to %s without manufacturing authority",
    (expected, value) => {
      const model = createMemoryAuthorityViewModel(value);
      expect(model.visibleState).toBe(expected);
      expect(model.statusLabel.length).toBeGreaterThan(0);
      expect(model.nonColourCue).toMatch(/ICON|TEXT|LOCK/u);
    },
  );

  it("shows watermark/lag from projection and never announces per-source progress", () => {
    const model = createMemoryAuthorityViewModel(input({ health: {
      status: "catching_up", memoryWatermark: 1203, corpusHead: 1206, lag: 3,
      retryable: false, recoveryRequired: false,
    } }));
    expect(model.watermarkLabel).toBe("STEWARD · #1203 · 落后 3 条");
    expect(model.liveAnnouncement).toBe("重要记忆正在追赶，聊天和显式调用仍可继续。");
    expect(model.liveAnnouncement).not.toMatch(/1203|1206|3 条/u);
  });

  it("keeps Context active/disputed and non-Context proposal authority distinct", () => {
    const model = createMemoryAuthorityViewModel(input({ memories: [
      { memoryRecordId: "context-active", version: 2, kind: "context", state: "active", derivedText: "Use the migration plan.", sources: [] },
      { memoryRecordId: "context-disputed", version: 4, kind: "context", state: "disputed", derivedText: "Old release date.", disputedBy: "human-2", sources: [] },
      { memoryRecordId: "decision-proposal", version: 1, kind: "decision", state: "proposal", derivedText: "Consider SQLite WAL.", sources: [] },
    ] }));
    expect(model.cards.map((card) => [card.memoryRecordId, card.authorityLabel, card.injectable])).toEqual([
      ["context-active", "CONTEXT · ACTIVE", true],
      ["context-disputed", "CONTEXT · DISPUTED", false],
      ["decision-proposal", "DECISION · PROPOSAL", false],
    ]);
    expect(model.cards[2]?.authorityLabel).not.toContain("CONFIRMED");
  });

  it("fails closed for revised/recalled/unavailable sources without carrying raw content", () => {
    const model = createMemoryAuthorityViewModel(input({ memories: [{
      memoryRecordId: "memory-source-state", version: 3, kind: "context", state: "review_required",
      derivedText: "Re-evaluation required.", sources: [
        { sourceId: "message:1", sourceKind: "message", revision: 2, availability: "active", navigation: { kind: "message", messageId: "message-1" } },
        { sourceId: "message:2", sourceKind: "message_tombstone", revision: 1, availability: "recalled", navigation: { kind: "tombstone", messageId: "message-2" } },
        { sourceId: "attachment:3", sourceKind: "attachment_extraction", revision: 4, availability: "unavailable", navigation: { kind: "attachment", messageId: "message-3", attachmentId: "attachment-3" } },
      ],
    }] }));
    expect(model.cards[0]?.injectable).toBe(false);
    expect(model.cards[0]?.sources.map((source) => source.availabilityLabel)).toEqual([
      "SOURCE · ACTIVE", "SOURCE · RECALLED TOMBSTONE", "SOURCE · UNAVAILABLE",
    ]);
    expect(JSON.stringify(model)).not.toMatch(/rawBody|extraction|provider|secret/iu);
  });

  it("maps closed errors to finite safe recovery and preserves request correlation", () => {
    const cases = [
      [401, "reauthenticate"], [403, "purge"], [404, "refresh"], [409, "repair"],
      [410, "refresh"], [429, "retry"], [503, "retry"],
    ] as const;
    for (const [status, recovery] of cases) {
      const model = createMemoryAuthorityViewModel(input({
        query: { status: "failed", requestId: `request-${status}`, error: { status, code: `memory_${status}` } },
      }));
      expect(model.error).toMatchObject({ status, requestId: `request-${status}`, recovery });
      expect(model.focusTarget).toBe("error-summary");
    }
  });

  it("locks all writes for offline/repair/archive/revoke while retaining authorized read-only cache", () => {
    for (const next of [
      input({ connection: { status: "offline" } }),
      input({ connection: { status: "repairing" } }),
      input({ lifecycle: "archived" }),
      input({ connection: { status: "revoked" } }),
    ]) {
      expect(createMemoryAuthorityViewModel(next).writeLocked).toBe(true);
    }
  });
});
