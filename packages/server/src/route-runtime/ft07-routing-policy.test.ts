import { describe, expect, it } from "vitest";
import {
  evaluateTrustedRouteSelections,
  evaluateSemanticRouteProviderGate,
  isRouteCandidateSnapshot,
  isRouteJobSourceEligible,
  isRouteProviderSelection,
  type CurrentRouteFacts,
  type RouteCandidateSnapshot,
  type RouteProviderSelection,
} from "./ft07-routing-policy.js";

const snapshot: RouteCandidateSnapshot = {
  snapshotId: "snapshot-1",
  routeJobId: "route-job-1",
  routeJobRevision: 2,
  roomId: "room-1",
  roomRevision: 7,
  sourceMessageId: "message-1",
  sourceMessageRevision: 1,
  sourceAuthorKind: "human",
  sourceMessageKind: "human",
  candidates: [
    {
      actorId: "agent-active",
      profileId: "profile-active",
      profileRevision: 3,
      assignmentId: "assignment-active",
      assignmentRevision: 5,
      accessRevision: 8,
      participation: "active",
      availability: "ready",
      roomResponsibility: "Review project delivery risks",
      effectiveCapabilities: ["room.project.read", "room.respond"],
      effectiveTools: ["repository.git-status", "room-memory.read"],
      calibrationScore: 2,
      hasBall: false,
      goalFactRevision: 11,
      projectFactRevision: 13,
      ballFactRevision: null,
    },
    {
      actorId: "agent-mention",
      profileId: "profile-mention",
      profileRevision: 1,
      assignmentId: "assignment-mention",
      assignmentRevision: 4,
      accessRevision: 9,
      participation: "on-mention",
      availability: "ready",
      roomResponsibility: "Answer direct questions",
      effectiveCapabilities: ["room.respond"],
      effectiveTools: ["room-memory.read"],
      calibrationScore: 0,
      hasBall: false,
      goalFactRevision: 11,
      projectFactRevision: 13,
      ballFactRevision: null,
    },
  ],
};

const facts: CurrentRouteFacts = {
  roomRevision: 7,
  goalFactRevision: 11,
  projectFactRevision: 13,
  ballFactRevisionByActorId: new Map(),
};

const activeSelection: RouteProviderSelection = {
  actorId: "agent-active",
  profileRevision: 3,
  assignmentRevision: 5,
  accessRevision: 8,
  trigger: "risk",
  reasonText: "Migration ordering is risky",
};

describe("FT-07 RouteCandidateSnapshot", () => {
  it("accepts stable IDs/revisions and rejects displayName or non-canonical candidates", () => {
    expect(isRouteCandidateSnapshot(snapshot)).toBe(true);
    expect(isRouteCandidateSnapshot({ ...snapshot, displayName: "not authority" })).toBe(false);
    expect(isRouteCandidateSnapshot({
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], displayName: "Renamed" }],
    })).toBe(false);
    expect(isRouteCandidateSnapshot({
      ...snapshot,
      candidates: [...snapshot.candidates].reverse(),
    })).toBe(false);
    expect(isRouteCandidateSnapshot({
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], roomResponsibility: "x".repeat(4_000) }],
    })).toBe(true);
    expect(isRouteCandidateSnapshot({
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], roomResponsibility: "x".repeat(4_001) }],
    })).toBe(false);
  });

  it("is metamorphically invariant to external display-name changes", () => {
    const names = new Map([["agent-active", "Before"]]);
    const before = evaluateTrustedRouteSelections(snapshot, facts, [activeSelection]);
    names.set("agent-active", "After rename");
    const after = evaluateTrustedRouteSelections(snapshot, facts, [activeSelection]);
    expect(names.get("agent-active")).toBe("After rename");
    expect(after).toEqual(before);
  });

  it("accepts the schema-defined initial access revision zero", () => {
    const zeroSnapshot = {
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], accessRevision: 0 }],
    };
    const zeroSelection = { ...activeSelection, accessRevision: 0 };
    expect(isRouteCandidateSnapshot(zeroSnapshot)).toBe(true);
    expect(isRouteProviderSelection(zeroSelection)).toBe(true);
    expect(evaluateTrustedRouteSelections(zeroSnapshot, facts, [zeroSelection]).intents[0])
      .toMatchObject({ accessRevision: 0 });
  });
});

describe("FT-07 trusted route selection policy", () => {
  it("keeps Provider calls at zero when Goal/project facts are missing", async () => {
    let providerCalls = 0;
    const provider = async (): Promise<void> => { providerCalls += 1; };
    const missingFacts = { ...facts, goalFactRevision: null, projectFactRevision: null };
    const gate = evaluateSemanticRouteProviderGate(snapshot, missingFacts);
    if (gate.allowed) await provider();
    expect(gate).toEqual({ allowed: false, reason: "missing_authority_facts" });
    expect(providerCalls).toBe(0);
  });

  it("keeps Provider calls at zero when every autonomous candidate is unavailable", async () => {
    let providerCalls = 0;
    const provider = async (): Promise<void> => { providerCalls += 1; };
    const unavailable = {
      ...snapshot,
      candidates: snapshot.candidates.map((entry) => ({ ...entry, availability: "busy" as const })),
    };
    const gate = evaluateSemanticRouteProviderGate(unavailable, facts);
    if (gate.allowed) await provider();
    expect(gate).toEqual({ allowed: false, reason: "candidate_unavailable" });
    expect(providerCalls).toBe(0);
  });

  it("accepts a current, active, ready candidate bound to snapshot revisions", () => {
    expect(evaluateTrustedRouteSelections(snapshot, facts, [activeSelection])).toEqual({
      intents: [{
        actorId: "agent-active",
        profileId: "profile-active",
        profileRevision: 3,
        assignmentId: "assignment-active",
        assignmentRevision: 5,
        accessRevision: 8,
        trigger: "risk",
        reasonText: "Migration ordering is risky",
      }],
      judgments: [{ actorId: "agent-active", outcome: "will_respond", reason: "selected" }],
    });
  });

  it("rejects unknown candidates and forged/stale revisions", () => {
    expect(evaluateTrustedRouteSelections(snapshot, facts, [{
      ...activeSelection, actorId: "agent-forged",
    }]).judgments).toEqual([{
      actorId: "agent-forged", outcome: "suppressed", reason: "candidate_not_found",
    }]);
    expect(evaluateTrustedRouteSelections(snapshot, facts, [{
      ...activeSelection, assignmentRevision: 6,
    }]).judgments).toEqual([{
      actorId: "agent-active", outcome: "suppressed", reason: "candidate_revision_changed",
    }]);
    expect(isRouteProviderSelection({ ...activeSelection, displayName: "forged" })).toBe(false);
    expect(() => evaluateTrustedRouteSelections(snapshot, facts, [{
      ...activeSelection, reasonText: "",
    }])).toThrow("Provider selections are invalid");
  });

  it.each(["busy", "paused", "noauth"] as const)("excludes %s candidates", (availability) => {
    const unavailable = {
      ...snapshot,
      candidates: snapshot.candidates.map((entry) =>
        entry.actorId === "agent-active" ? { ...entry, availability } : entry),
    };
    expect(evaluateTrustedRouteSelections(unavailable, facts, [activeSelection]).judgments)
      .toEqual([{
        actorId: "agent-active", outcome: "suppressed", reason: "candidate_unavailable",
      }]);
  });

  it("excludes on-mention candidates from autonomous routing", () => {
    const mentionSelection: RouteProviderSelection = {
      actorId: "agent-mention", profileRevision: 1, assignmentRevision: 4,
      accessRevision: 9, trigger: "domain", reasonText: "Looks relevant",
    };
    expect(evaluateTrustedRouteSelections(snapshot, facts, [mentionSelection]).judgments)
      .toEqual([{
        actorId: "agent-mention", outcome: "suppressed", reason: "candidate_not_active",
      }]);
  });

  it("suppresses semantic routing when Goal/project facts are missing or stale", () => {
    const missing = {
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], goalFactRevision: null }],
    };
    expect(evaluateTrustedRouteSelections(missing, facts, [activeSelection]).judgments[0])
      .toMatchObject({ reason: "missing_authority_facts" });
    expect(evaluateTrustedRouteSelections(snapshot, {
      ...facts, projectFactRevision: 14,
    }, [activeSelection]).judgments[0]).toMatchObject({ reason: "stale_authority_facts" });
  });

  it("requires a current durable Ball fact for Ball routing", () => {
    const ballSnapshot: RouteCandidateSnapshot = {
      ...snapshot,
      candidates: [{ ...snapshot.candidates[0], hasBall: true, ballFactRevision: 17 }],
    };
    const selection = { ...activeSelection, trigger: "ball" as const };
    expect(evaluateTrustedRouteSelections(ballSnapshot, facts, [selection]).judgments[0])
      .toMatchObject({ reason: "ball_fact_unavailable" });
    expect(evaluateTrustedRouteSelections(ballSnapshot, {
      ...facts, ballFactRevisionByActorId: new Map([["agent-active", 17]]),
    }, [selection]).judgments[0]).toMatchObject({ reason: "selected" });
  });

  it("never creates a RouteJob cascade from an Agent final or correction", () => {
    expect(isRouteJobSourceEligible({
      sourceAuthorKind: "agent", sourceMessageKind: "agent-final",
    })).toBe(false);
    expect(isRouteJobSourceEligible({
      sourceAuthorKind: "agent", sourceMessageKind: "agent-correction",
    })).toBe(false);
    expect(evaluateTrustedRouteSelections({
      ...snapshot, sourceAuthorKind: "agent", sourceMessageKind: "agent-final",
    }, facts, [activeSelection])).toEqual({
      intents: [],
      judgments: [{
        actorId: "agent-active", outcome: "suppressed", reason: "source_not_human",
      }],
    });
  });
});
