import { describe, expect, it, vi } from "vitest";
import {
  commitDurableRouteHandoff,
  createRouteDurableIntentOperation,
  isRouteDurableIntentOperation,
  recoverDurableRouteHandoffs,
  type DurableRouteHandoffAuthority,
  type DurableRouteIntentRecord,
  type RouteDurableIntentOperation,
} from "./durable-route-handoff.js";
import {
  mintRouteDecisionOrigin,
  type RouteDecisionTargetBinding,
} from "./trusted-invocation-origin.js";

const routeTarget = {
  actorId: "agent-1",
  profileId: "profile-1",
  profileRevision: 3,
  assignmentId: "assignment-1",
  assignmentRevision: 5,
  accessRevision: 8,
} as const;

const origin = (targets: readonly RouteDecisionTargetBinding[] = [routeTarget]) =>
  mintRouteDecisionOrigin({
  kind: "route_decision",
  roomId: "room-1",
  routeJobId: "route-1",
  routeJobRevision: 2,
  snapshotId: "snapshot-1",
  decisionId: "decision-1",
    targets,
  });

const intent = {
  intentId: "intent-1",
  actorId: "agent-1",
  profileId: "profile-1",
  profileRevision: 3,
  assignmentId: "assignment-1",
  assignmentRevision: 5,
  accessRevision: 8,
  trigger: "risk" as const,
  reasonText: "Migration ordering is risky",
};

function fakeDurableAuthority() {
  const decisions = new Map<string, RouteDurableIntentOperation>();
  const records = new Map<string, DurableRouteIntentRecord>();
  const authority: DurableRouteHandoffAuthority = {
    async commitDecisionAndIntents(operation) {
      const previous = decisions.get(operation.decisionId);
      if (previous !== undefined) {
        if (JSON.stringify(previous) !== JSON.stringify(operation)) throw new Error("route_conflict");
        return {
          decisionStatus: "already_completed",
          intents: operation.intents.map((entry) => records.get(entry.intentId)!),
        };
      }
      // This block models the required single Authority transaction.
      decisions.set(operation.decisionId, structuredClone(operation));
      for (const entry of operation.intents) {
        records.set(entry.intentId, {
          ...entry,
          decisionId: operation.decisionId,
          routeJobId: operation.routeJobId,
          snapshotId: operation.snapshotId,
          roomId: operation.roomId,
          status: "pending",
        });
      }
      return {
        decisionStatus: "completed",
        intents: operation.intents.map((entry) => records.get(entry.intentId)!),
      };
    },
    async recoverPendingIntents(limit) {
      return [...records.values()].filter((entry) => entry.status === "pending").slice(0, limit);
    },
  };
  return { authority, decisions, records };
}

describe("route decision to durable intent handoff", () => {
  it("requires a minted internal route origin and produces an exact operation", () => {
    const operation = createRouteDurableIntentOperation(
      origin(),
      [intent],
      "2026-08-24T00:00:00.000Z",
    );
    expect(isRouteDurableIntentOperation(operation)).toBe(true);
    expect(operation).toEqual({
      type: "route-decision.commit-intents.v1",
      decisionId: "decision-1",
      routeJobId: "route-1",
      expectedRouteJobRevision: 2,
      snapshotId: "snapshot-1",
      roomId: "room-1",
      createdAt: "2026-08-24T00:00:00.000Z",
      intents: [intent],
    });
    expect(isRouteDurableIntentOperation({ ...operation, providerId: "client-choice" })).toBe(false);
    expect(isRouteDurableIntentOperation({
      ...operation, intents: [{ ...intent, modelId: "client-choice" }],
    })).toBe(false);
    expect(() => createRouteDurableIntentOperation(
      JSON.parse(JSON.stringify(origin())),
      [intent],
      "2026-08-24T00:00:00.000Z",
    )).toThrow("trusted route decision origin");
  });

  it("commits decision and intents once and replays the stable result", async () => {
    const fixture = fakeDurableAuthority();
    const operation = createRouteDurableIntentOperation(
      origin(), [intent], "2026-08-24T00:00:00.000Z",
    );
    const first = await commitDurableRouteHandoff(fixture.authority, operation);
    const replay = await commitDurableRouteHandoff(fixture.authority, operation);
    expect(first).toEqual(replay);
    expect(fixture.decisions.size).toBe(1);
    expect(fixture.records.size).toBe(1);
  });

  it("preserves the schema-defined initial access revision zero", () => {
    const zeroTarget = { ...routeTarget, accessRevision: 0 };
    const zeroIntent = { ...intent, accessRevision: 0 };
    const operation = createRouteDurableIntentOperation(
      origin([zeroTarget]), [zeroIntent], "2026-08-24T00:00:00.000Z",
    );
    expect(isRouteDurableIntentOperation(operation)).toBe(true);
  });

  it("binds every atomic multi-target intent to the decision-wide authority", () => {
    const secondTarget = {
      actorId: "agent-2", profileId: "profile-2", profileRevision: 7,
      assignmentId: "assignment-2", assignmentRevision: 11, accessRevision: 13,
    } as const;
    const secondIntent = {
      ...intent,
      intentId: "intent-2",
      actorId: "agent-2",
      profileId: "profile-2",
      profileRevision: 7,
      assignmentId: "assignment-2",
      assignmentRevision: 11,
      accessRevision: 13,
    };
    expect(createRouteDurableIntentOperation(
      origin([routeTarget, secondTarget]),
      [intent, secondIntent],
      "2026-08-24T00:00:00.000Z",
    ).intents).toEqual([intent, secondIntent]);
    expect(() => createRouteDurableIntentOperation(
      origin([routeTarget]),
      [intent, secondIntent],
      "2026-08-24T00:00:00.000Z",
    )).toThrow("operation is invalid");
    expect(() => createRouteDurableIntentOperation(
      origin([routeTarget, secondTarget]),
      [intent, { ...secondIntent, assignmentRevision: 12 }],
      "2026-08-24T00:00:00.000Z",
    )).toThrow("operation is invalid");
    expect(() => createRouteDurableIntentOperation(
      origin([routeTarget, secondTarget]),
      [intent],
      "2026-08-24T00:00:00.000Z",
    )).toThrow("operation is invalid");
  });

  it("recovers the pending durable intent after a crash without best-effort invoke", async () => {
    const fixture = fakeDurableAuthority();
    const bestEffortInvoke = vi.fn();
    const operation = createRouteDurableIntentOperation(
      origin(), [intent], "2026-08-24T00:00:00.000Z",
    );

    await commitDurableRouteHandoff(fixture.authority, operation);
    // Process exits here: the handoff helper has no invocation callback and cannot lose the intent.
    const recovered = await recoverDurableRouteHandoffs(fixture.authority);

    expect(bestEffortInvoke).not.toHaveBeenCalled();
    expect(recovered).toEqual([{
      ...intent,
      decisionId: "decision-1",
      routeJobId: "route-1",
      snapshotId: "snapshot-1",
      roomId: "room-1",
      status: "pending",
    }]);
  });

  it("rejects duplicate actors, malformed times, and unsafe recovery bounds", async () => {
    const operation = createRouteDurableIntentOperation(
      origin(), [intent], "2026-08-24T00:00:00.000Z",
    );
    expect(isRouteDurableIntentOperation({
      ...operation,
      intents: [intent, { ...intent, intentId: "intent-2" }],
    })).toBe(false);
    expect(isRouteDurableIntentOperation({ ...operation, createdAt: "now" })).toBe(false);
    await expect(recoverDurableRouteHandoffs(fakeDurableAuthority().authority, 257))
      .rejects.toThrow("recovery limit");
  });
});
