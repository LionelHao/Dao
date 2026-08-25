import { describe, expect, it, vi } from "vitest";
import {
  PROJECT_REMINDER_SCAN_LIMITS,
  createProjectLoopLifecycleCoordinator,
  createProjectLoopLifecycleAuthorityFromTransactionParticipant,
  currentProjectReminderOrdinal,
  remainingProjectBusinessDuration,
  resumedProjectBusinessDueAt,
  scanCurrentProjectReminderBuckets,
} from "./project-boundary-runtime-service.js";

const hour = 60 * 60 * 1_000;
const day = 24 * hour;
const dueAt = "2026-08-25T00:00:00.000Z";

function boundary(overrides: Record<string, unknown> = {}) {
  return {
    recordVersion: "project-boundary.v1" as const,
    boundaryId: "boundary-1",
    roomId: "room-1",
    projectId: "room-1",
    boundaryKind: "due" as const,
    sourceKind: "next_action" as const,
    sourceId: "action-1",
    sourceRevision: 3,
    holder: { kind: "human" as const, actorId: "human-1" },
    lifecycleGeneration: 4,
    status: "active" as const,
    confirmed: true,
    consumed: false,
    dueAt,
    reviewAt: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("FT-09 persisted Project boundaries and reminder buckets", () => {
  it("computes only the current due bucket at due, +24h, and after a long restart", () => {
    expect(currentProjectReminderOrdinal(dueAt, new Date(Date.parse(dueAt) - 1).toISOString()))
      .toBe(0);
    expect(currentProjectReminderOrdinal(dueAt, dueAt)).toBe(0);
    expect(currentProjectReminderOrdinal(dueAt, new Date(Date.parse(dueAt) + day).toISOString()))
      .toBe(1);
    expect(currentProjectReminderOrdinal(dueAt, new Date(Date.parse(dueAt) + 9 * day + hour).toISOString()))
      .toBe(9);
    expect(currentProjectReminderOrdinal("not-a-date", dueAt)).toBeNull();
  });

  it("claims one durable Human notification and one Agent invocation without a provider path", async () => {
    const claimCurrentBucket = vi.fn(async (input: { boundaryId: string; reminderOrdinal: number }) => ({
      status: "claimed" as const,
      roomId: "room-1",
      boundaryId: input.boundaryId,
      reminderOrdinal: input.reminderOrdinal,
      recipientActorId: input.boundaryId === "boundary-agent" ? "agent-1" : "human-1",
      dispatch: input.boundaryId === "boundary-agent"
        ? { kind: "agent_invocation" as const, intentId: "intent-1" }
        : { kind: "human_notification" as const, outboxId: "outbox-1" },
    }));
    const authority = {
      listEligibleBoundaries: vi.fn(async () => [
        boundary(),
        boundary({
          boundaryId: "boundary-agent",
          sourceId: "blocker-1",
          sourceKind: "blocker",
          holder: { kind: "agent" as const, actorId: "agent-1" },
        }),
      ]),
      claimCurrentBucket,
    };
    const result = await scanCurrentProjectReminderBuckets({
      authority,
      now: dueAt,
      limit: 10,
    });
    expect(result).toMatchObject({ scannedCount: 2, claimedCount: 2, duplicateCount: 0 });
    expect(claimCurrentBucket.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        boundaryId: "boundary-1", reminderKind: "human_reminder",
        reminderOrdinal: 0, recipientActorId: "human-1",
      }),
      expect.objectContaining({
        boundaryId: "boundary-agent", reminderKind: "agent_invocation",
        reminderOrdinal: 0, recipientActorId: "agent-1",
      }),
    ]);
    expect(Object.keys(authority)).toEqual(["listEligibleBoundaries", "claimCurrentBucket"]);
  });

  it("deduplicates restart scans and never claims stale, revoked, consumed, archived, or unconfirmed rows", async () => {
    const claimCurrentBucket = vi.fn(async (input: { boundaryId: string; reminderOrdinal: number }) => ({
      status: "duplicate" as const,
      roomId: "room-1",
      boundaryId: input.boundaryId,
      reminderOrdinal: input.reminderOrdinal,
      recipientActorId: "human-1",
    }));
    const result = await scanCurrentProjectReminderBuckets({
      authority: {
        listEligibleBoundaries: vi.fn(async () => [
          boundary(),
          boundary({ boundaryId: "stale", status: "stale" }),
          boundary({ boundaryId: "revoked", status: "revoked" }),
          boundary({ boundaryId: "consumed", consumed: true }),
          boundary({ boundaryId: "archived", status: "suspended" }),
          boundary({ boundaryId: "unconfirmed", confirmed: false }),
          boundary({ boundaryId: "transferred", status: "transferred" }),
          boundary({ boundaryId: "resolved", status: "resolved" }),
        ]),
        claimCurrentBucket,
      },
      now: new Date(Date.parse(dueAt) + day).toISOString(),
      limit: PROJECT_REMINDER_SCAN_LIMITS.maxBoundaries,
    });
    expect(result).toMatchObject({
      scannedCount: 8, claimedCount: 0, duplicateCount: 1, ignoredCount: 7,
    });
    expect(claimCurrentBucket).toHaveBeenCalledTimes(1);
    expect(claimCurrentBucket).toHaveBeenCalledWith(expect.objectContaining({ reminderOrdinal: 1 }));
  });

  it("fails closed on cross-room, excess, malformed authority data and invalid bounds", async () => {
    for (const candidate of [
      boundary({ projectId: "project-2" }),
      boundary({ token: "secret" }),
      boundary({ holder: { kind: "human", actorId: "" } }),
    ]) {
      await expect(scanCurrentProjectReminderBuckets({
        authority: {
          listEligibleBoundaries: vi.fn(async () => [candidate]),
          claimCurrentBucket: vi.fn(),
        },
        now: dueAt,
        limit: 10,
      })).rejects.toThrow("malformed");
    }
    await expect(scanCurrentProjectReminderBuckets({
      authority: { listEligibleBoundaries: vi.fn(), claimCurrentBucket: vi.fn() },
      now: dueAt,
      limit: PROJECT_REMINDER_SCAN_LIMITS.maxBoundaries + 1,
    })).rejects.toThrow("invalid");
  });
});

describe("FT-09 Project Loop lifecycle coordinator", () => {
  it("freezes remaining duration and reopens from the new time without a reminder burst", async () => {
    const archivedAt = "2026-08-25T00:00:00.000Z";
    const originalDue = "2026-08-27T12:00:00.000Z";
    const reopenedAt = "2026-09-25T00:00:00.000Z";
    const remaining = remainingProjectBusinessDuration(originalDue, archivedAt);
    expect(remaining).toBe(60 * hour);
    expect(resumedProjectBusinessDueAt(remaining, reopenedAt))
      .toBe("2026-09-27T12:00:00.000Z");
    expect(currentProjectReminderOrdinal(
      resumedProjectBusinessDueAt(remaining, reopenedAt), reopenedAt,
    )).toBe(0);

    const participant = {
      archiveInTransaction: vi.fn(() => ({ roomId: "room-1", archiveGeneration: 5,
        lifecycleGeneration: 5, state: "archived" as const,
        suspendedBoundaryCount: 1, terminalBoundaryCount: 0 })),
      reopenInTransaction: vi.fn(() => ({ roomId: "room-1", archiveGeneration: 5,
        lifecycleGeneration: 5, state: "active" as const,
        resumedBoundaryCount: 1, replacementBoundaryCount: 1 })),
    };
    const authority = createProjectLoopLifecycleAuthorityFromTransactionParticipant(participant);
    await authority.archive({ roomId: "room-1", archiveGeneration: 5,
      previousLifecycleGeneration: 4, occurredAt: archivedAt });
    await authority.reopen({ roomId: "room-1", archiveGeneration: 5,
      previousLifecycleGeneration: 5, occurredAt: reopenedAt });
    expect(participant.archiveInTransaction).toHaveBeenCalledTimes(1);
    expect(participant.reopenInTransaction).toHaveBeenCalledTimes(1);
  });
  it("requires monotonic lifecycle generations and returns validated archive/reopen facts", async () => {
    const coordinator = createProjectLoopLifecycleCoordinator({
      authority: {
        archive: vi.fn(async () => ({
          roomId: "room-1", archiveGeneration: 5, lifecycleGeneration: 5,
          state: "archived" as const, suspendedBoundaryCount: 3, terminalBoundaryCount: 2,
        })),
        reopen: vi.fn(async () => ({
          roomId: "room-1", archiveGeneration: 5, lifecycleGeneration: 5,
          state: "active" as const, resumedBoundaryCount: 3, replacementBoundaryCount: 3,
        })),
      },
    });
    await expect(coordinator.archive({
      roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 4,
      occurredAt: dueAt,
    })).resolves.toMatchObject({ state: "archived", lifecycleGeneration: 5 });
    await expect(coordinator.reopen({
      roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 5,
      occurredAt: new Date(Date.parse(dueAt) + hour).toISOString(),
    })).resolves.toMatchObject({
      state: "active", lifecycleGeneration: 5, resumedBoundaryCount: 3,
      replacementBoundaryCount: 3,
    });
  });

  it("rejects wrong-room and non-monotonic lifecycle authority results", async () => {
    const coordinator = createProjectLoopLifecycleCoordinator({
      authority: {
        archive: vi.fn(async () => ({
          roomId: "room-2", archiveGeneration: 5, lifecycleGeneration: 5,
          state: "archived" as const, suspendedBoundaryCount: 0, terminalBoundaryCount: 0,
        })),
        reopen: vi.fn(async () => ({
          roomId: "room-1", archiveGeneration: 5, lifecycleGeneration: 4,
          state: "active" as const, resumedBoundaryCount: 0, replacementBoundaryCount: 0,
        })),
      },
    });
    await expect(coordinator.archive({
      roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 4, occurredAt: dueAt,
    })).rejects.toThrow("malformed");
    await expect(coordinator.reopen({
      roomId: "room-1", archiveGeneration: 5, previousLifecycleGeneration: 5, occurredAt: dueAt,
    })).rejects.toThrow("malformed");
  });
});
