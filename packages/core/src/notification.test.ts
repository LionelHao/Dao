import { describe, expect, it } from "vitest";
import * as core from "./index.js";
import {
  isNotificationExecutionResultAcknowledgeAck,
  isNotificationExecutionResultAcknowledgeCommand,
  NOTIFICATION_KINDS,
  NOTIFICATION_SOURCE_KINDS,
  isNotificationProjection,
  isNotificationReadAck,
  isNotificationRepairRecord,
  isNotificationStableEvent,
} from "./notification.js";

const createdAt = "2026-08-31T08:00:00.000Z";

const projection = Object.freeze({
  recordVersion: "notification.v1" as const,
  notificationId: "notification-1",
  roomId: "room-1",
  recipientActorId: "human-1",
  notificationKind: "human_request" as const,
  source: Object.freeze({
    sourceKind: "project_request" as const,
    sourceId: "request-1",
    sourceRevision: 1,
    sourceBoundaryId: "request-1:target:human-1:revision:1",
    ordinal: 0,
  }),
  dedupeKey: "a".repeat(64),
  createdAt,
  readAt: null,
  readRevision: 0,
  handled: false,
  handledAt: null,
  sourceAccessible: true as const,
  deepLink: Object.freeze({ kind: "request" as const, targetId: "request-1" }),
  safeProjection: Object.freeze({ titleKey: "human_request" as const, actorId: "human-2" }),
});

function hidden(value: object, key: PropertyKey, injected: unknown): object {
  Object.defineProperty(value, key, { configurable: true, enumerable: false, value: injected });
  return value;
}

describe("FT-12 Notification Core closed contracts", () => {
  it("exports the Notification contract and its exact closed kind sets", () => {
    expect(core.isNotificationProjection).toBe(isNotificationProjection);
    expect(core.isNotificationRepairRecord).toBe(isNotificationRepairRecord);
    expect(core.isNotificationStableEvent).toBe(isNotificationStableEvent);
    expect(core.isNotificationReadAck).toBe(isNotificationReadAck);
    expect(core.isNotificationExecutionResultAcknowledgeCommand)
      .toBe(isNotificationExecutionResultAcknowledgeCommand);
    expect(core.isNotificationExecutionResultAcknowledgeAck)
      .toBe(isNotificationExecutionResultAcknowledgeAck);
    expect(NOTIFICATION_KINDS).toEqual([
      "human_mention", "human_request", "tool_confirmation", "project_due",
      "tool_result", "agent_execution_completed", "agent_execution_failed",
      "cannot_answer_escalation",
    ]);
    expect(NOTIFICATION_SOURCE_KINDS).toEqual([
      "message_mention", "project_request", "tool_confirmation", "project_boundary",
      "tool_call", "agent_execution", "project_obstacle",
    ]);
  });

  it("accepts the minimal safe projection and repair record", () => {
    expect(isNotificationProjection(projection)).toBe(true);
    expect(isNotificationRepairRecord({ kind: "notification", value: projection })).toBe(true);
  });

  it("rejects raw corpus, forged kinds, mismatched links, and hidden keys", () => {
    expect(isNotificationProjection({ ...projection, body: "raw room corpus" })).toBe(false);
    expect(isNotificationProjection({ ...projection, notificationKind: "os_push" })).toBe(false);
    expect(isNotificationProjection({ ...projection,
      deepLink: { kind: "message", targetId: "request-1" } })).toBe(false);
    expect(isNotificationProjection({ ...projection, sourceAccessible: false })).toBe(false);
    expect(isNotificationProjection({ ...projection, readAt: createdAt, readRevision: 0 })).toBe(false);
    expect(isNotificationProjection({ ...projection, handled: false, handledAt: createdAt })).toBe(false);
    expect(isNotificationProjection(hidden({ ...projection }, "secret", "sentinel"))).toBe(false);
    expect(isNotificationProjection(hidden({ ...projection }, Symbol("raw"), "sentinel"))).toBe(false);
  });

  it("accepts recipient identity stable events and rejects cross-recipient payloads", () => {
    const event = {
      eventId: "event-1",
      streamKind: "identity",
      streamId: "human-1",
      streamSeq: 7,
      type: "notification.created",
      occurredAt: createdAt,
      payload: projection,
    };
    expect(isNotificationStableEvent(event)).toBe(true);
    expect(isNotificationStableEvent({ ...event, streamId: "human-2" })).toBe(false);
    expect(isNotificationStableEvent({ ...event, type: "notification.os-push" })).toBe(false);
    expect(isNotificationStableEvent({ ...event, roomId: "room-1" })).toBe(false);

    const revoked = {
      eventId: "event-2", streamKind: "identity", streamId: "human-1", streamSeq: 8,
      type: "notification.revoked", occurredAt: createdAt,
      payload: { notificationId: "notification-1", roomId: "room-1",
        recipientActorId: "human-1", reason: "source_inaccessible" },
    };
    expect(isNotificationStableEvent(revoked)).toBe(true);
    expect(isNotificationStableEvent({ ...revoked,
      payload: { ...revoked.payload, title: "leak" } })).toBe(false);
  });

  it("closes the request-correlated read ACK and preserves idempotent outcome", () => {
    const ack = {
      type: "notification.read.ack",
      requestId: "request-read-1",
      notificationId: "notification-1",
      roomId: "room-1",
      recipientActorId: "human-1",
      outcome: "read",
      readAt: createdAt,
      readRevision: 1,
      eventId: "event-read-1",
    };
    expect(isNotificationReadAck(ack)).toBe(true);
    expect(isNotificationReadAck({ ...ack, outcome: "opened" })).toBe(false);
    expect(isNotificationReadAck({ ...ack, readRevision: 0 })).toBe(false);
    expect(isNotificationReadAck({ ...ack, handled: true })).toBe(false);
  });

  it("closes execution-result acknowledge to a terminal agent execution projection", () => {
    const command = { type: "notification.execution-result.acknowledge",
      requestId: "execution-ack-1", notificationId: "notification-execution-1" };
    expect(isNotificationExecutionResultAcknowledgeCommand(command)).toBe(true);
    expect(isNotificationExecutionResultAcknowledgeCommand({ ...command, handled: true })).toBe(false);
    const executionProjection = { ...projection, notificationId: "notification-execution-1",
      notificationKind: "agent_execution_completed" as const,
      source: { sourceKind: "agent_execution" as const, sourceId: "execution-1",
        sourceRevision: 2, sourceBoundaryId: "execution-1", ordinal: 0 },
      handled: true, handledAt: createdAt,
      deepLink: { kind: "agent_execution" as const, targetId: "execution-1" },
      safeProjection: { titleKey: "agent_execution_completed" as const, actorId: "agent-1" } };
    const ack = { type: "notification.execution-result.ack", requestId: "execution-ack-1",
      outcome: "acknowledged", projection: executionProjection };
    expect(isNotificationExecutionResultAcknowledgeAck(ack)).toBe(true);
    expect(isNotificationExecutionResultAcknowledgeAck({ ...ack,
      projection: { ...executionProjection, handled: false, handledAt: null } })).toBe(false);
    expect(isNotificationExecutionResultAcknowledgeAck({ ...ack,
      projection: { ...executionProjection, notificationKind: "tool_result" } })).toBe(false);
  });
});
