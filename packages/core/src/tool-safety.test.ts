import { describe, expect, it } from "vitest";
import {
  EXTERNAL_TOOL_IDS,
  INTERNAL_TOOL_SEAM_IDS,
  assertExternalToolCatalog,
  isExternalToolDescriptor,
  isExternalToolId,
  isInternalToolSeamDescriptor,
  isOriginalToolCallRetryEligible,
  isToolConfirmationRecord,
  isToolDispatchRecord,
  isToolGrantRecord,
  isToolReviewRecord,
} from "./tool-safety.js";

describe("FT-10 closed tool safety contracts", () => {
  it("keeps the physical adapter catalog at exactly three entries", () => {
    expect(EXTERNAL_TOOL_IDS).toEqual([
      "http-json.read",
      "repository.git-status",
      "sandbox-file.write",
    ]);
    expect(new Set(EXTERNAL_TOOL_IDS).size).toBe(3);
    expect(isExternalToolId("room-memory.read")).toBe(false);
    expect(isExternalToolId("project.query")).toBe(false);
    expect(isExternalToolId("shell.exec")).toBe(false);
  });

  it("keeps source reads and project operations in a distinct internal seam domain", () => {
    expect(INTERNAL_TOOL_SEAM_IDS).toEqual([
      "room-memory.read",
      "attachment.read",
      "project.query",
      "project.command",
    ]);
    expect(isInternalToolSeamDescriptor({
      scope: "internal",
      id: "room-memory.read",
      kind: "source-read",
    })).toBe(true);
    expect(isExternalToolDescriptor({
      scope: "internal",
      id: "room-memory.read",
      kind: "source-read",
    })).toBe(false);
  });

  it("requires exact discriminated physical descriptors", () => {
    expect(isExternalToolDescriptor({
      scope: "external",
      id: "http-json.read",
      effect: "read-only",
    })).toBe(true);
    expect(isExternalToolDescriptor({
      scope: "external",
      id: "sandbox-file.write",
      effect: "side-effect",
      reversibility: "compensatable",
    })).toBe(true);
    expect(isExternalToolDescriptor({
      scope: "external",
      id: "repository.git-status",
      effect: "read-only",
      reversibility: "compensatable",
    })).toBe(false);
    expect(isExternalToolDescriptor({
      scope: "external",
      id: "sandbox-file.write",
      effect: "side-effect",
    })).toBe(false);
  });

  it("fails startup closed for missing, duplicate, or fourth physical adapters", () => {
    const http = { scope: "external", id: "http-json.read", effect: "read-only" } as const;
    const git = { scope: "external", id: "repository.git-status", effect: "read-only" } as const;
    const write = { scope: "external", id: "sandbox-file.write", effect: "side-effect",
      reversibility: "compensatable" } as const;
    expect(assertExternalToolCatalog([write, http, git]).map(({ id }) => id)).toEqual(EXTERNAL_TOOL_IDS);
    expect(() => assertExternalToolCatalog([http, git])).toThrow(TypeError);
    expect(() => assertExternalToolCatalog([http, git, git])).toThrow(TypeError);
    expect(() => assertExternalToolCatalog([http, git, {
      scope: "external", id: "shell.exec", effect: "read-only",
    } as never])).toThrow(TypeError);
  });

  it("validates state-specific confirmation and grant records exactly", () => {
    const confirmationBase = {
      scope: "internal", confirmationId: "confirmation-1", toolCallId: "tool-call-1",
      version: 1, bindingGeneration: 1,
    } as const;
    expect(isToolConfirmationRecord({ ...confirmationBase, state: "pending" })).toBe(true);
    expect(isToolConfirmationRecord({ ...confirmationBase, state: "pending", confirmedAt: "now" })).toBe(false);
    expect(isToolConfirmationRecord({ ...confirmationBase, state: "confirmed",
      decidedByActorId: "human-1", decidedAt: "2026-08-30T00:00:00.000Z" })).toBe(true);
    expect(isToolConfirmationRecord({ ...confirmationBase, state: "rejected",
      decidedByActorId: "human-1", decidedAt: "2026-08-30T00:00:00.000Z",
      reason: "human_rejected" })).toBe(true);

    const grantBase = { scope: "internal", grantId: "grant-1", toolCallId: "tool-call-1", version: 1 } as const;
    expect(isToolGrantRecord({ ...grantBase, state: "active", expiresAt: "2026-08-30T00:01:00.000Z" })).toBe(true);
    expect(isToolGrantRecord({ ...grantBase, state: "claimed", dispatchId: "dispatch-1",
      claimedAt: "2026-08-30T00:00:01.000Z" })).toBe(true);
    expect(isToolGrantRecord({ ...grantBase, state: "revoked", reason: "room_archived",
      closedAt: "2026-08-30T00:00:01.000Z" })).toBe(true);
    expect(isToolGrantRecord({ ...grantBase, state: "expired" })).toBe(false);
  });

  it("keeps dispatch/review closed and unknown ineligible for replay", () => {
    const dispatchBase = {
      scope: "internal", dispatchId: "dispatch-1", grantId: "grant-1",
      toolCallId: "tool-call-1", version: 1,
    } as const;
    const unknown = { ...dispatchBase, state: "outcome_unknown",
      occurredAt: "2026-08-30T00:00:02.000Z", reason: "claim_committed" } as const;
    expect(isToolDispatchRecord(unknown)).toBe(true);
    expect(isOriginalToolCallRetryEligible(unknown)).toBe(false);
    expect(isToolDispatchRecord({ ...dispatchBase, state: "reviewed" })).toBe(false);
    expect(isToolReviewRecord({
      scope: "internal", reviewId: "review-1", dispatchId: "dispatch-1", version: 1,
      resolution: "accepted_risk", reviewedByActorId: "human-1",
      reviewedAt: "2026-08-30T00:00:03.000Z",
      evidenceSummarySha256: "a".repeat(64),
    })).toBe(true);
  });
});
