import { describe, expect, it } from "vitest";
import {
  deriveNotificationProducerIntent,
  type NotificationProducerEvidence,
} from "./producer-matrix.js";

const now = "2026-08-31T08:00:00.000Z";

function base<T extends NotificationProducerEvidence>(value: T): T { return value; }

describe("FT-12 authoritative notification producer/recipient matrix", () => {
  const cases: readonly Readonly<{
    name: string;
    evidence: NotificationProducerEvidence;
    kind: string;
    sourceKind: string;
    recipient: string;
    handled: boolean;
  }>[] = [
    { name: "structured Human mention", kind: "human_mention", sourceKind: "message_mention",
      recipient: "human-target", handled: false,
      evidence: base({ kind: "human_mention", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, messageId: "message-1", messageRevision: 1, mentionTargetId: "target-1",
        targetHumanActorId: "human-target", targetMembership: "active",
        linkedRequestId: "request-1", actorId: "human-author" }) },
    { name: "pending Human Request", kind: "human_request", sourceKind: "project_request",
      recipient: "human-target", handled: false,
      evidence: base({ kind: "human_request", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, recipientRelation: "target_pending",
        requestId: "request-1", requestRevision: 1, requestBoundaryOrdinal: 0,
        stableTargetHumanActorId: "human-target", targetMembership: "active",
        requestStatus: "pending_acceptance", actorId: "human-author" }) },
    { name: "Human Request terminal result", kind: "human_request", sourceKind: "project_request",
      recipient: "human-requester", handled: true,
      evidence: base({ kind: "human_request", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, recipientRelation: "requester_result",
        requestId: "request-1", requestRevision: 2, requestBoundaryOrdinal: 1,
        requesterHumanActorId: "human-requester", requesterMembership: "active",
        requestStatus: "accepted", actorId: "human-target" }) },
    { name: "exact confirmation principal", kind: "tool_confirmation", sourceKind: "tool_confirmation",
      recipient: "human-principal", handled: false,
      evidence: base({ kind: "tool_confirmation", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, confirmationId: "confirmation-1", confirmationRevision: 1,
        exactPrincipalHumanActorId: "human-principal", principalBinding: "current",
        confirmationState: "pending", actorId: "agent-1" }) },
    { name: "Human-held due boundary", kind: "project_due", sourceKind: "project_boundary",
      recipient: "human-holder", handled: false,
      evidence: base({ kind: "project_due", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, boundaryId: "boundary-1", sourceFactId: "action-1",
        sourceRevision: 4, lifecycleGeneration: 2, reminderOrdinal: 3,
        holder: { kind: "human", actorId: "human-holder", membership: "active" }, actorId: null }) },
    { name: "tool result authority relation", kind: "tool_result", sourceKind: "tool_call",
      recipient: "human-principal", handled: false,
      evidence: base({ kind: "tool_result", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, toolCallId: "tool-call-1", toolCallRevision: 7,
        exactRelatedHumanActorId: "human-principal", relation: "confirmation_principal",
        resultState: "known_succeeded", actorId: "agent-1" }) },
    { name: "completed Agent execution", kind: "agent_execution_completed", sourceKind: "agent_execution",
      recipient: "human-origin", handled: false,
      evidence: base({ kind: "agent_execution_completed", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, executionId: "execution-1", executionVersion: 6,
        sourceHumanRecipientActorId: "human-origin", recipientRelation: "invocation_source",
        executionStatus: "completed", actorId: "agent-1" }) },
    { name: "failed Agent execution", kind: "agent_execution_failed", sourceKind: "agent_execution",
      recipient: "human-origin", handled: false,
      evidence: base({ kind: "agent_execution_failed", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, executionId: "execution-2", executionVersion: 6,
        sourceHumanRecipientActorId: "human-origin", recipientRelation: "invocation_source",
        executionStatus: "failed", actorId: "agent-1" }) },
    { name: "cannot-answer escalation owner", kind: "cannot_answer_escalation",
      sourceKind: "project_obstacle", recipient: "human-escalation", handled: false,
      evidence: base({ kind: "cannot_answer_escalation", roomId: "room-1", roomLifecycle: "active",
        createdAt: now, obstacleId: "obstacle-1", obstacleRevision: 5,
        escalationBoundaryId: "escalation-1", exactEscalationHumanActorId: "human-escalation",
        obstacleStatus: "cannot_answer", actorId: "agent-1" }) },
  ];

  for (const item of cases) {
    it(`derives ${item.name} from authoritative evidence`, () => {
      const intent = deriveNotificationProducerIntent(item.evidence);
      expect(intent).toMatchObject({ notificationKind: item.kind,
        recipientActorId: item.recipient, handled: item.handled,
        source: { sourceKind: item.sourceKind } });
      expect(intent?.safeProjection).not.toHaveProperty("body");
      expect(intent?.dedupeKey).toMatch(/^[a-f0-9]{64}$/u);
      expect(intent?.notificationId).toBe(`notification-${intent?.dedupeKey}`);
    });
  }

  it("uses the exact due tuple and creates a new item only for a new ordinal/boundary lineage", () => {
    const evidence = cases[4]!.evidence;
    const first = deriveNotificationProducerIntent(evidence)!;
    expect(deriveNotificationProducerIntent({ ...evidence })).toEqual(first);
    expect(deriveNotificationProducerIntent({ ...evidence, reminderOrdinal: 4 })?.dedupeKey)
      .not.toBe(first.dedupeKey);
    expect(deriveNotificationProducerIntent({ ...evidence, boundaryId: "boundary-reopened" })?.dedupeKey)
      .not.toBe(first.dedupeKey);
  });

  it("suppresses archived Rooms and rejects ineligible or Agent recipients", () => {
    const request = cases[1]!.evidence;
    expect(deriveNotificationProducerIntent({ ...request, roomLifecycle: "archived" })).toBeNull();
    expect(deriveNotificationProducerIntent({ ...request, targetMembership: "revoked" })).toBeNull();
    const due = cases[4]!.evidence;
    expect(deriveNotificationProducerIntent({ ...due,
      holder: { kind: "agent", actorId: "agent-1", membership: "active" } })).toBeNull();
  });

  it("does not create from terminal/non-current producer states", () => {
    expect(deriveNotificationProducerIntent({ ...cases[1]!.evidence,
      targetMembership: "revoked" })).toBeNull();
    expect(deriveNotificationProducerIntent({ ...cases[2]!.evidence,
      requesterMembership: "revoked" })).toBeNull();
    expect(deriveNotificationProducerIntent({ ...cases[3]!.evidence,
      confirmationState: "confirmed" })).toBeNull();
    expect(deriveNotificationProducerIntent({ ...cases[8]!.evidence,
      obstacleStatus: "resolved" })).toBeNull();
    expect(deriveNotificationProducerIntent({ ...cases[5]!.evidence,
      resultState: "reviewed" })).toBeNull();
  });

  it("rejects recipient relations outside the approved routing matrix at runtime", () => {
    expect(() => deriveNotificationProducerIntent({ ...cases[5]!.evidence,
      relation: "review_principal" } as unknown as NotificationProducerEvidence))
      .toThrow("Tool result evidence was invalid");
    expect(() => deriveNotificationProducerIntent({ ...cases[6]!.evidence,
      recipientRelation: "renderer_selected" } as unknown as NotificationProducerEvidence))
      .toThrow("Agent execution notification evidence was invalid");
  });

  it("partitions pending-target and requester-result Request bindings into stable ordinals", () => {
    const pending = cases[1]!.evidence;
    const result = cases[2]!.evidence;
    expect(deriveNotificationProducerIntent(pending)?.source.ordinal).toBe(0);
    expect(deriveNotificationProducerIntent(result)).toMatchObject({
      recipientActorId: "human-requester", handled: true, handledAt: now,
      source: { sourceBoundaryId: "request-1", sourceRevision: 2, ordinal: 3 },
    });
    expect(deriveNotificationProducerIntent({ ...pending, requestRevision: 3,
      requestBoundaryOrdinal: 2 })?.source.ordinal).toBe(4);
    expect(deriveNotificationProducerIntent({ ...result, requestRevision: 4,
      requestBoundaryOrdinal: 3, requestStatus: "transferred" })?.source.ordinal).toBe(7);
  });

  it("creates a still-unhandled result for revoke-before-dispatch", () => {
    const result = cases[5]!.evidence;
    expect(deriveNotificationProducerIntent({ ...result,
      resultState: "revoked_before_dispatch" })).toMatchObject({
      notificationKind: "tool_result", recipientActorId: "human-principal",
      handled: false, handledAt: null,
    });
  });

  it("binds a mention to the durable linked Request boundary", () => {
    const mention = cases[0]!.evidence;
    const intent = deriveNotificationProducerIntent({ ...mention,
      messageId: "m".repeat(256), mentionTargetId: "t".repeat(256) });
    expect(intent?.source.sourceBoundaryId).toBe("request-1");
  });
});
