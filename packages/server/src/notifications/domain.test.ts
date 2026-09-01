import { describe, expect, it } from "vitest";
import { deriveNotificationProducerIntent } from "./producer-matrix.js";
import {
  NotificationDomainError,
  applyNotificationHandledProjection,
  markNotificationRead,
  projectNotificationForRecipient,
} from "./domain.js";

const createdAt = "2026-08-31T08:00:00.000Z";
const readAt = "2026-08-31T08:05:00.000Z";
const handledAt = "2026-08-31T08:10:00.000Z";

function notification() {
  return deriveNotificationProducerIntent({
    kind: "human_request", roomId: "room-1", roomLifecycle: "active", createdAt,
    recipientRelation: "target_pending", requestId: "request-1", requestRevision: 1,
    requestBoundaryOrdinal: 0,
    stableTargetHumanActorId: "human-target", targetMembership: "active",
    requestStatus: "pending_acceptance", actorId: "human-author",
  })!;
}

describe("FT-12 notification read/handled/access domain", () => {
  it("marks read only for the recipient Human session and leaves handled unchanged", () => {
    const result = markNotificationRead(notification(), {
      principal: { kind: "human", actorId: "human-target" }, session: "active",
      membership: "active", sourceAccessible: true, availability: "ready",
      expectedReadRevision: 0, readAt,
    });
    expect(result.outcome).toBe("read");
    expect(result.projection).toMatchObject({ readAt, readRevision: 1,
      handled: false, handledAt: null });
  });

  it("replays an already-read command without changing authority", () => {
    const first = markNotificationRead(notification(), {
      principal: { kind: "human", actorId: "human-target" }, session: "active",
      membership: "active", sourceAccessible: true, availability: "ready",
      expectedReadRevision: 0, readAt,
    });
    const replay = markNotificationRead(first.projection, {
      principal: { kind: "human", actorId: "human-target" }, session: "active",
      membership: "active", sourceAccessible: true, availability: "ready",
      expectedReadRevision: 1, readAt: handledAt,
    });
    expect(replay).toEqual({ outcome: "already_read", projection: first.projection });
  });

  it("closes 401/403/409/410/429/503 without mutating the fact", () => {
    const fact = notification();
    const common = { principal: { kind: "human" as const, actorId: "human-target" },
      session: "active" as const, membership: "active" as const, sourceAccessible: true,
      availability: "ready" as const, expectedReadRevision: 0, readAt };
    const cases = [
      [{ ...common, principal: null }, 401, "unauthenticated"],
      [{ ...common, principal: { kind: "human" as const, actorId: "human-other" } }, 403, "forbidden"],
      [{ ...common, membership: "revoked" as const }, 403, "forbidden"],
      [{ ...common, expectedReadRevision: 2 }, 409, "revision_conflict"],
      [{ ...common, sourceAccessible: false }, 410, "source_inaccessible"],
      [{ ...common, availability: "rate_limited" as const }, 429, "rate_limited"],
      [{ ...common, availability: "unavailable" as const }, 503, "storage_unavailable"],
    ] as const;
    for (const [input, status, reason] of cases) {
      try {
        markNotificationRead(fact, input);
        expect.unreachable("expected domain rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(NotificationDomainError);
        expect(error).toMatchObject({ status, reason });
      }
      expect(fact).toMatchObject({ readAt: null, readRevision: 0, handled: false });
    }
  });

  it("derives handled only from an exact stable source terminal boundary", () => {
    const fact = notification();
    expect(applyNotificationHandledProjection(fact, {
      sourceBoundaryId: fact.source.sourceBoundaryId,
      sourceTerminal: "request_terminal", occurredAt: handledAt,
    })).toMatchObject({ handled: true, handledAt, readAt: null, readRevision: 0 });
    expect(() => applyNotificationHandledProjection(fact, {
      sourceBoundaryId: "request-other", sourceTerminal: "request_terminal", occurredAt: handledAt,
    })).toThrow("boundary");
    expect(() => applyNotificationHandledProjection(fact, {
      sourceBoundaryId: fact.source.sourceBoundaryId,
      sourceTerminal: "confirmation_terminal", occurredAt: handledAt,
    })).toThrow("terminal");
  });

  it("projects zero metadata for cross-recipient, membership revoke, or inaccessible source", () => {
    const fact = notification();
    expect(projectNotificationForRecipient(fact, {
      recipientActorId: "human-target", membership: "active", sourceAccessible: true,
    })).toBe(fact);
    expect(projectNotificationForRecipient(fact, {
      recipientActorId: "human-other", membership: "active", sourceAccessible: true,
    })).toBeNull();
    expect(projectNotificationForRecipient(fact, {
      recipientActorId: "human-target", membership: "revoked", sourceAccessible: true,
    })).toBeNull();
    expect(projectNotificationForRecipient(fact, {
      recipientActorId: "human-target", membership: "active", sourceAccessible: false,
    })).toBeNull();
  });
});
