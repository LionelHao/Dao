import { describe, expect, it } from "vitest";
import {
  createDefaultHumanRequestProjectPayload,
  hashProjectFrozenResponsibility,
} from "./request-factory.js";

describe("FT-03 deterministic Human Request Project factory", () => {
  it("freezes a no-body open-question payload and stable digest", () => {
    const input = { roomId: "room-1", requestIntentId: "intent-1",
      sourceTargetId: "target-1", targetHumanActorId: "human-target" };
    const first = createDefaultHumanRequestProjectPayload(input);
    const replay = createDefaultHumanRequestProjectPayload(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ title: "Clarification requested",
      description: "A structured Human Request is awaiting an answer.",
      acceptanceMode: "open_question", frozenResponsibility: {
        kind: "open_question", owner: { kind: "human", actorId: "human-target" },
        dueAt: null, reviewAt: null,
      } });
    expect(first.frozenResponsibilityJson).not.toContain("displayName");
    expect(first.frozenResponsibilitySha256)
      .toBe(hashProjectFrozenResponsibility(first.frozenResponsibility));
    expect(first.frozenResponsibilitySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds the responsibility identity to Room, intent, and target", () => {
    const baseline = createDefaultHumanRequestProjectPayload({ roomId: "room-1",
      requestIntentId: "intent-1", sourceTargetId: "target-1", targetHumanActorId: "human-1" });
    for (const changed of [
      { roomId: "room-2", requestIntentId: "intent-1", sourceTargetId: "target-1", targetHumanActorId: "human-1" },
      { roomId: "room-1", requestIntentId: "intent-2", sourceTargetId: "target-1", targetHumanActorId: "human-1" },
      { roomId: "room-1", requestIntentId: "intent-1", sourceTargetId: "target-2", targetHumanActorId: "human-1" },
    ]) {
      expect(createDefaultHumanRequestProjectPayload(changed).frozenResponsibility.responsibilityId)
        .not.toBe(baseline.frozenResponsibility.responsibilityId);
    }
  });
});
