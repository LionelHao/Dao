import { describe, expect, it } from "vitest";

import {
  isNotificationAuthorityOperation,
  isNotificationAuthorityResult,
} from "./authority-protocol.js";

const context = { sessionId: "session-1", sessionFamilyId: "family-1",
  principal: { accountId: "account-1", actorId: "human-1" } };
const occurredAt = "2026-09-01T00:00:00.000Z";

describe("Notification AuthorityWorker execution-result protocol", () => {
  it("accepts only the closed bounded source-revocation recovery operation and result", () => {
    const operation = { type: "notification.recover-source-revocations",
      roomId: "room-1", sourceKind: "message_mention", sourceId: "message-1", limit: 256 };
    expect(isNotificationAuthorityOperation(operation)).toBe(true);
    expect(isNotificationAuthorityOperation({ ...operation, limit: 257 })).toBe(false);
    expect(isNotificationAuthorityOperation({ ...operation, sourceKind: "project_request" }))
      .toBe(false);
    expect(isNotificationAuthorityResult({ kind: "source-revocations-recovered",
      recoveredCount: 256, hasMore: true })).toBe(true);
    expect(isNotificationAuthorityResult({ kind: "source-revocations-recovered",
      recoveredCount: 257, hasMore: false })).toBe(false);
    expect(isNotificationAuthorityResult({ kind: "source-revocations-recovered",
      recoveredCount: 0, hasMore: true })).toBe(false);
  });

  it("accepts only the closed session-bound internal command", () => {
    const operation = { type: "notification.acknowledge-execution-result", context,
      commandRequestId: "execution-ack-1", notificationId: "notification-execution-1",
      occurredAt, now: Date.parse(occurredAt) };
    expect(isNotificationAuthorityOperation(operation)).toBe(true);
    for (const injected of [
      { recipientActorId: "human-2" }, { handled: true }, { sourceId: "execution-1" },
      { sourceRevision: 2 }, { action: "mark-handled" },
    ]) expect(isNotificationAuthorityOperation({ ...operation, ...injected })).toBe(false);
  });

  it("accepts only an acknowledged projection result", () => {
    const projection = { recordVersion: "notification.v1", notificationId: "notification-execution-1",
      roomId: "room-1", recipientActorId: "human-1", notificationKind: "agent_execution_failed",
      source: { sourceKind: "agent_execution", sourceId: "execution-1", sourceRevision: 2,
        sourceBoundaryId: "execution-1", ordinal: 0 }, dedupeKey: "e".repeat(64), createdAt: occurredAt,
      readAt: null, readRevision: 0, handled: true, handledAt: occurredAt, sourceAccessible: true,
      deepLink: { kind: "agent_execution", targetId: "execution-1" },
      safeProjection: { titleKey: "agent_execution_failed", actorId: "agent-1" } };
    expect(isNotificationAuthorityResult({ kind: "acknowledged", outcome: "acknowledged",
      projection })).toBe(true);
    expect(isNotificationAuthorityResult({ kind: "acknowledged", outcome: "dismissed",
      projection })).toBe(false);
  });
});
