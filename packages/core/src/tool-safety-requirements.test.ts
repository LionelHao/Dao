import { describe, expect, it } from "vitest";

const DIRECT_FT10_REQUIREMENTS = Object.freeze([
  "REQ-AGT-009", "REQ-AGT-010", "REQ-AGT-011", "REQ-AGT-012", "REQ-AGT-013",
  "REQ-MEM-004", "REQ-NFR-011", "REQ-NFR-014", "REQ-PRIM-018", "REQ-PRJ-013",
  "REQ-ROOM-004",
] as const);

const FT10_REQUIREMENT_TRACE = Object.freeze({
  "REQ-AGT-009": { core: "outcome_unknown replay guard", authority: "restart review-only", ui: "J-05 review" },
  "REQ-AGT-010": { core: "grant/dispatch closed states", authority: "cancel/claim race", ui: "J-05 dispatch truth" },
  "REQ-AGT-011": { core: "exact physical ToolId", authority: "four-way authority intersection", ui: "read-only manifest" },
  "REQ-AGT-012": { core: "exact parameters and confirmation binding", authority: "decision/grant/claim CAS", ui: "J-05 precise confirmation" },
  "REQ-AGT-013": { core: "unknown/review states", authority: "durable claim recovery", ui: "J-05 outcome review" },
  "REQ-MEM-004": { core: "internal source seam", authority: "source read reauthorization", ui: "safe source reference" },
  "REQ-NFR-011": { core: "ToolCallBinding revisions", authority: "every-point reauthorization", ui: "closed recovery action" },
  "REQ-NFR-014": { core: "terminal confirmation/grant states", authority: "archive security expiry", ui: "expired/revoked state" },
  "REQ-PRIM-018": { core: "confirmation/grant/dispatch/review unions", authority: "tool safety state machine", ui: "J-05 full journey" },
  "REQ-PRJ-013": { core: "internal project seam", authority: "FT-09 closed dispatcher", ui: "Project projection" },
  "REQ-ROOM-004": { core: "archive-safe terminal records", authority: "archive participant transaction", ui: "archived recovery" },
} as const satisfies Record<(typeof DIRECT_FT10_REQUIREMENTS)[number], Readonly<{
  core: string; authority: string; ui: string;
}>>);

describe("FT-10 direct Requirement trace fixture", () => {
  it("maps exactly the 11 approved direct Requirements once", () => {
    expect(DIRECT_FT10_REQUIREMENTS).toHaveLength(11);
    expect(new Set(DIRECT_FT10_REQUIREMENTS).size).toBe(11);
    expect(Object.keys(FT10_REQUIREMENT_TRACE).sort()).toEqual([...DIRECT_FT10_REQUIREMENTS].sort());
  });

  it("keeps Core, authority, and UI evidence buckets for every Requirement", () => {
    for (const requirement of DIRECT_FT10_REQUIREMENTS) {
      expect(FT10_REQUIREMENT_TRACE[requirement]).toEqual({
        core: expect.any(String), authority: expect.any(String), ui: expect.any(String),
      });
    }
  });
});
