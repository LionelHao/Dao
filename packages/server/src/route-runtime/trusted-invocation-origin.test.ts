import { describe, expect, it } from "vitest";
import {
  isTrustedInvocationOrigin,
  mintDirectInvocationOrigin,
  mintProjectBoundaryOrigin,
  mintRouteDecisionOrigin,
} from "./trusted-invocation-origin.js";

const binding = {
  roomId: "room-1",
  targetActorId: "agent-1",
  profileRevision: 3,
  assignmentRevision: 5,
  accessRevision: 8,
} as const;

const routeTarget = {
  actorId: "agent-1",
  profileId: "profile-1",
  profileRevision: 3,
  assignmentId: "assignment-1",
  assignmentRevision: 5,
  accessRevision: 8,
} as const;

describe("server-private trusted invocation origins", () => {
  it("mints the three closed origins from authority evidence", () => {
    const direct = mintDirectInvocationOrigin({
      ...binding,
      kind: "message_target",
      messageId: "message-1",
      messageRevision: 1,
      targetOutcomeId: "outcome-1",
    });
    const routed = mintRouteDecisionOrigin({
      kind: "route_decision",
      roomId: "room-1",
      routeJobId: "route-1",
      routeJobRevision: 2,
      snapshotId: "snapshot-1",
      decisionId: "decision-1",
      targets: [routeTarget],
    });
    const boundary = mintProjectBoundaryOrigin({
      ...binding,
      kind: "project_boundary",
      projectFactKind: "blocker",
      projectFactId: "blocker-1",
      projectFactRevision: 9,
    });
    expect([direct.kind, routed.kind, boundary.kind])
      .toEqual(["message_target", "route_decision", "project_boundary"]);
    expect([direct, routed, boundary].every(isTrustedInvocationOrigin)).toBe(true);
  });

  it("does not trust JSON/public lookalikes or structured clones", () => {
    const origin = mintRouteDecisionOrigin({
      kind: "route_decision",
      roomId: "room-1",
      routeJobId: "route-1",
      routeJobRevision: 2,
      snapshotId: "snapshot-1",
      decisionId: "decision-1",
      targets: [routeTarget],
    });
    expect(isTrustedInvocationOrigin({ ...origin })).toBe(false);
    expect(isTrustedInvocationOrigin(JSON.parse(JSON.stringify(origin)))).toBe(false);
    expect(isTrustedInvocationOrigin(structuredClone(origin))).toBe(false);
  });

  it("rejects incomplete or unknown authority evidence", () => {
    expect(() => mintRouteDecisionOrigin({
      kind: "route_decision",
      roomId: "room-1",
      routeJobId: "route-1",
      routeJobRevision: 0,
      snapshotId: "snapshot-1",
      decisionId: "decision-1",
      targets: [routeTarget],
    })).toThrow("Route decision evidence is invalid");
    expect(() => mintProjectBoundaryOrigin({
      ...binding,
      kind: "project_boundary",
      projectFactKind: "checkpoint",
      projectFactId: "",
      projectFactRevision: 9,
    })).toThrow("Project boundary evidence is invalid");
  });

  it("requires canonical unique decision-wide target bindings", () => {
    expect(() => mintRouteDecisionOrigin({
      kind: "route_decision", roomId: "room-1", routeJobId: "route-1",
      routeJobRevision: 2, snapshotId: "snapshot-1", decisionId: "decision-1",
      targets: [routeTarget, { ...routeTarget, profileRevision: 4 }],
    })).toThrow("Route decision evidence is invalid");
    expect(() => mintRouteDecisionOrigin({
      kind: "route_decision", roomId: "room-1", routeJobId: "route-1",
      routeJobRevision: 2, snapshotId: "snapshot-1", decisionId: "decision-1",
      targets: [
        { ...routeTarget, actorId: "agent-z" },
        { ...routeTarget, actorId: "agent-a" },
      ],
    })).toThrow("Route decision evidence is invalid");
  });
});
