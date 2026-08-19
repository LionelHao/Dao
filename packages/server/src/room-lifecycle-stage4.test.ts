import { describe, expect, it } from "vitest";
import { isRoomAuditRecord } from "./room-lifecycle.js";

describe("stage 4 closed room audit records", () => {
  it("accepts truthful leave, reopen, and ownership-transfer facts without sensitive extras", () => {
    const base = {
      id: "audit-1",
      roomId: "room-1",
      actorId: "human-1",
      timestamp: "2026-08-19T00:00:00.000Z",
    };
    expect(isRoomAuditRecord({
      ...base,
      type: "room.member.left",
      result: "left",
      targetActorId: "human-1",
    })).toBe(true);
    expect(isRoomAuditRecord({
      ...base,
      type: "room.reopened",
      result: "reopened",
    })).toBe(true);
    expect(isRoomAuditRecord({
      ...base,
      type: "room.ownership.transferred",
      result: "ownership-transferred",
      previousOwnerActorId: "human-1",
      targetActorId: "human-2",
      previousGovernanceRevision: 2,
      governanceRevision: 3,
    })).toBe(true);
    expect(isRoomAuditRecord({
      ...base,
      type: "room.member.left",
      result: "left",
      targetActorId: "human-1",
      messageBody: "secret",
    })).toBe(false);
  });
});
