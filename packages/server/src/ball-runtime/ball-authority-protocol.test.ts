import { describe, expect, it } from "vitest";
import { isBallAuthorityOperation } from "./ball-authority-protocol.js";

const token = Buffer.alloc(32, 7).toString("base64url");

describe("closed ball authority protocol", () => {
  it("accepts only bounded room-scoped operations and explicit deadline policy", () => {
    const query = {
      type: "ball.query",
      context: {
        sessionId: token,
        sessionFamilyId: token,
        principal: { accountId: "account-1", actorId: "human-1" },
      },
      roomId: "room-1",
      blueprintFacts: [],
      policy: { openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 120_000 },
      now: Date.parse("2026-08-17T00:01:00.000Z"),
    } as const;
    expect(isBallAuthorityOperation(query)).toBe(true);
    expect(isBallAuthorityOperation({ ...query, messageText: "我来" })).toBe(false);
    expect(isBallAuthorityOperation({
      ...query,
      blueprintFacts: [{
        sourceKind: "blueprint-blocked-mention", sourceId: "T-1", roomId: "room-1",
        mentionedActorIds: ["human-1", "human-2"], reason: "ambiguous",
        since: "2026-08-17T00:00:00.000Z",
      }],
    })).toBe(false);
  });
});
