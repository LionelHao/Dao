import { describe, expect, it, vi } from "vitest";
import { createBallRuntimeService } from "./ball-runtime-service.js";

const context = {
  sessionId: Buffer.alloc(32, 1).toString("base64url"),
  sessionFamilyId: Buffer.alloc(32, 2).toString("base64url"),
  principal: { accountId: "account-1", actorId: "human-1" },
} as const;

describe("bounded BallInCourt runtime", () => {
  it("recovers rooms, consumes a read-only Blueprint adapter, and returns a room-scoped query", async () => {
    const executeBall = vi.fn(async (operation: { readonly type: string }) => {
      if (operation.type === "ball.list-rooms") return { kind: "ball-rooms", roomIds: ["room-1"] };
      if (operation.type === "ball.scan-overdue") {
        return { kind: "ball-overdue-scan", agentTriggers: [], reminders: [], ballSummaries: [] };
      }
      return { kind: "ball-query", balls: [], needsAction: [], reminders: [] };
    });
    const readRoom = vi.fn(async (roomId: string) => [{
      sourceKind: "blueprint-awaiting" as const, sourceId: "T-1", roomId,
      assigneeId: "agent-1", reason: "authoritative awaiting", since: "2026-08-10T00:00:00.000Z",
    }]);
    const runtime = createBallRuntimeService({
      worker: { executeBall }, blueprint: { readRoom },
      policy: { openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 60_000 },
      scanIntervalMs: 60_000,
    });
    try {
      await runtime.recover();
      await expect(runtime.query(context, "room-1")).resolves.toEqual({
        balls: [], needsAction: [], reminders: [],
      });
      expect(readRoom).toHaveBeenCalledWith("room-1", expect.any(AbortSignal));
      expect(executeBall.mock.calls.map(([operation]) => operation.type))
        .toEqual(["ball.list-rooms", "ball.scan-overdue", "ball.scan-overdue", "ball.query"]);
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when the Blueprint port crosses rooms", async () => {
    const runtime = createBallRuntimeService({
      worker: { executeBall: vi.fn(async () => ({
        kind: "ball-overdue-scan", agentTriggers: [], reminders: [], ballSummaries: [],
      })) },
      blueprint: { async readRoom() { return [{
        sourceKind: "blueprint-task", sourceId: "T-2", roomId: "room-other",
        assigneeId: "agent-1", reason: "crossed", since: "2026-08-10T00:00:00.000Z",
      }]; } },
      policy: { openItemDeadlineMs: 60_000, lightTaskDeadlineMs: 60_000 },
      scanIntervalMs: 60_000,
    });
    try {
      await expect(runtime.scan("room-1")).rejects.toThrow(/crossed/i);
    } finally {
      await runtime.close();
    }
  });
});
