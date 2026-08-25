import { describe, expect, it, vi } from "vitest";
import { isDepartureConflict } from "@native-im/core";
import { mintAuthorityTransactionView } from
  "../room-governance/private-participant-contracts.js";
import { createCanonicalDepartureResponsibilityContributor } from
  "./canonical-departure-responsibility-contributor.js";

const sourceRef = {
  roomId: "room-1",
  kind: "project_fact" as const,
  sourceId: "decision-1",
  sourceRevision: 2,
  visibility: "room" as const,
};

function responsibility(overrides: Record<string, unknown> = {}) {
  return {
    roomId: "room-1",
    subjectKind: "next_action" as const,
    subjectId: "action-1",
    subjectRevision: 3,
    responsibilityRole: "owner" as const,
    responsibleActorId: "human-1",
    state: "in_progress" as const,
    safeSummaryCode: "project.next_action.owner",
    sourceRef,
    ...overrides,
  };
}

describe("FT-09 canonical departure responsibility contributor", () => {
  it("maps active canonical facts and pending transfers to stable safe conflicts", () => {
    const listCanonicalResponsibilitiesInTransaction = vi.fn(() => [
      responsibility(),
      responsibility({
        subjectKind: "transfer",
        subjectId: "transfer-1",
        subjectRevision: 1,
        responsibilityRole: "transfer_target",
        state: "pending",
        safeSummaryCode: "project.transfer.pending_acceptance",
      }),
      responsibility({
        subjectKind: "blocker",
        subjectId: "blocker-1",
        state: "cannot_answer",
        safeSummaryCode: "project.blocker.owner",
      }),
    ]);
    const participant = createCanonicalDepartureResponsibilityContributor({
      authority: { listCanonicalResponsibilitiesInTransaction },
    });
    const transaction = mintAuthorityTransactionView("room-1", "tx-1");
    const result = participant.listInTransaction(transaction, {
      roomId: "room-1", targetHumanActorId: "human-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.result.conflicts).toHaveLength(3);
    expect(result.result.conflicts.every(isDepartureConflict)).toBe(true);
    expect(result.result.conflicts.map((item) => item.title).sort()).toEqual([
      "project.blocker.owner",
      "project.next_action.owner",
      "project.transfer.pending_acceptance",
    ]);
    const replay = participant.listInTransaction(transaction, {
      roomId: "room-1", targetHumanActorId: "human-1",
    });
    expect(replay).toEqual(result);
  });

  it("filters resolved/transferred responsibilities and never fabricates accepted Request conflicts", () => {
    const participant = createCanonicalDepartureResponsibilityContributor({
      authority: {
        listCanonicalResponsibilitiesInTransaction: vi.fn(() => [
          responsibility({ state: "done" }),
          responsibility({ subjectKind: "blocker", state: "resolved" }),
          responsibility({ subjectKind: "request", state: "accepted", responsibilityRole: "requester" }),
          responsibility({ subjectKind: "transfer", state: "accepted", responsibilityRole: "transfer_target" }),
        ]),
      },
    });
    const result = participant.listInTransaction(
      mintAuthorityTransactionView("room-1", "tx-2"),
      { roomId: "room-1", targetHumanActorId: "human-1" },
    );
    expect(result).toEqual({
      ok: true,
      result: { roomId: "room-1", targetHumanActorId: "human-1", conflicts: [] },
    });
  });

  it("fails closed on cross-room, wrong-actor, duplicate, excess, raw, or thrown authority results", () => {
    const transaction = mintAuthorityTransactionView("room-1", "tx-3");
    for (const values of [
      [responsibility({ roomId: "room-2", sourceRef: { ...sourceRef, roomId: "room-2" } })],
      [responsibility({ responsibleActorId: "human-2" })],
      [responsibility(), responsibility()],
      [responsibility({ body: "raw message" })],
      [responsibility({ sourceRef: { ...sourceRef, token: "secret" } })],
    ]) {
      const participant = createCanonicalDepartureResponsibilityContributor({
        authority: { listCanonicalResponsibilitiesInTransaction: vi.fn(() => values) },
      });
      expect(participant.listInTransaction(transaction, {
        roomId: "room-1", targetHumanActorId: "human-1",
      })).toMatchObject({ ok: false, error: { code: "dependency_unavailable" } });
    }
    const throwing = createCanonicalDepartureResponsibilityContributor({
      authority: { listCanonicalResponsibilitiesInTransaction: vi.fn(() => {
        throw new Error("database failed");
      }) },
    });
    expect(throwing.listInTransaction(transaction, {
      roomId: "room-1", targetHumanActorId: "human-1",
    })).toMatchObject({ ok: false, error: { reason: "participant_threw" } });
  });
});
