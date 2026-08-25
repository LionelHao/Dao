import { describe, expect, it } from "vitest";

const DIRECT_FT09_REQUIREMENTS = Object.freeze([
  "REQ-AGT-005",
  "REQ-AGT-006",
  "REQ-MEM-005",
  "REQ-PRIM-003",
  "REQ-PRIM-010",
  "REQ-PRIM-015",
  "REQ-PRIM-016",
  "REQ-PRIM-017",
  "REQ-PRJ-001",
  "REQ-PRJ-002",
  "REQ-PRJ-003",
  "REQ-PRJ-004",
  "REQ-PRJ-005",
  "REQ-PRJ-006",
  "REQ-PRJ-007",
  "REQ-PRJ-008",
  "REQ-PRJ-009",
  "REQ-PRJ-010",
  "REQ-PRJ-011",
  "REQ-PRJ-012",
  "REQ-PRJ-013",
  "REQ-ROOM-001",
  "REQ-ROOM-003",
  "REQ-UX-004",
] as const);

const FT09_REQUIREMENT_TRACE = Object.freeze({
  "REQ-AGT-005": { core: "ProjectProposal", authority: "agent proposal principal", ui: "J-06 proposal" },
  "REQ-AGT-006": { core: "ProjectBallFact", authority: "project boundary currentness", ui: "J-07 boundary" },
  "REQ-MEM-005": { core: "ProjectSnapshot", authority: "confirmed checkpoint port", ui: "J-06 source" },
  "REQ-PRIM-003": { core: "ProjectFact", authority: "closed dispatcher", ui: "Project panel" },
  "REQ-PRIM-010": { core: "ProjectBallFact", authority: "single holder boundary", ui: "NeedsAction" },
  "REQ-PRIM-015": { core: "ProjectProposal", authority: "proposal transaction", ui: "J-06 pending" },
  "REQ-PRIM-016": { core: "ProjectConfirmation", authority: "Human confirmation", ui: "J-06 confirm/reject" },
  "REQ-PRIM-017": { core: "ProjectEvent", authority: "stable event/outbox", ui: "ACK/event separation" },
  "REQ-PRJ-001": { core: "ProjectGoal", authority: "one active Goal", ui: "J-06 Goal" },
  "REQ-PRJ-002": { core: "ProjectDecision", authority: "Decision confirmation", ui: "J-06 Decision" },
  "REQ-PRJ-003": { core: "Decision supersession", authority: "immutable replacement", ui: "superseded state" },
  "REQ-PRJ-004": { core: "ProjectRequest", authority: "Request handshake", ui: "J-04" },
  "REQ-PRJ-005": { core: "ProjectNextAction", authority: "NextAction reducer", ui: "Project panel action" },
  "REQ-PRJ-006": { core: "ProjectActorRef", authority: "Human/Agent assignment", ui: "owner kind" },
  "REQ-PRJ-007": { core: "delivery verifier", authority: "Agent cannot write done", ui: "verification state" },
  "REQ-PRJ-008": { core: "Human direct done", authority: "verifier-aware completion", ui: "completion state" },
  "REQ-PRJ-009": { core: "Blocker/OpenQuestion", authority: "single owner/transfer", ui: "obstacle state" },
  "REQ-PRJ-010": { core: "deferred/cannot_answer", authority: "review/escalation boundary", ui: "distinct labels" },
  "REQ-PRJ-011": { core: "ProjectBallFact", authority: "boundary uniqueness", ui: "multi-source Ball" },
  "REQ-PRJ-012": { core: "due/review boundary", authority: "ordinal reminder claim", ui: "due/review state" },
  "REQ-PRJ-013": { core: "closed project facts", authority: "shared command dispatcher", ui: "authoritative projection" },
  "REQ-ROOM-001": { core: "roomId equals projectId", authority: "Room scope", ui: "Room project segment" },
  "REQ-ROOM-003": { core: "source Room binding", authority: "lifecycle/access gate", ui: "403/410" },
  "REQ-UX-004": { core: "ProjectRepairRecord", authority: "repair projection", ui: "J-04/J-06/J-07" },
} as const satisfies Record<(typeof DIRECT_FT09_REQUIREMENTS)[number], Readonly<{
  core: string;
  authority: string;
  ui: string;
}>>);

describe("FT-09 direct Requirement trace fixture", () => {
  it("keeps all 24 direct Requirement IDs mapped exactly once", () => {
    expect(DIRECT_FT09_REQUIREMENTS).toHaveLength(24);
    expect(new Set(DIRECT_FT09_REQUIREMENTS)).toHaveProperty("size", 24);
    expect(Object.keys(FT09_REQUIREMENT_TRACE).sort()).toEqual([...DIRECT_FT09_REQUIREMENTS].sort());
  });

  it("keeps every direct Requirement connected to Core, authority, and UI evidence buckets", () => {
    for (const requirement of DIRECT_FT09_REQUIREMENTS) {
      expect(FT09_REQUIREMENT_TRACE[requirement]).toEqual({
        core: expect.any(String),
        authority: expect.any(String),
        ui: expect.any(String),
      });
    }
  });
});
