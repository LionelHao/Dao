import { describe, expect, it, vi } from "vitest";
import {
  CONFIRMED_PROJECT_CHECKPOINT_LIMITS,
  createConfirmedProjectFactCheckpointReader,
  isConfirmedProjectFactCheckpoint,
} from "./confirmed-project-fact-checkpoint-port.js";

const source = {
  roomId: "room-1",
  kind: "message" as const,
  sourceId: "message-1",
  sourceRevision: 2,
  visibility: "room" as const,
};
const checkpoint = {
  recordVersion: "confirmed-project-checkpoint.v1" as const,
  checkpointId: "checkpoint-1",
  roomId: "room-1",
  projectId: "room-1",
  factKind: "decision" as const,
  factId: "decision-1",
  factRevision: 3,
  state: "current" as const,
  sourceRefs: [source],
  confirmingHumanActorId: "human-1",
  confirmedAt: "2026-08-25T00:00:00.000Z",
  lifecycleGeneration: 4,
};

describe("FT-09 confirmed project checkpoint read port", () => {
  it("accepts only closed Room-visible current/superseded checkpoints", () => {
    expect(isConfirmedProjectFactCheckpoint(checkpoint)).toBe(true);
    expect(isConfirmedProjectFactCheckpoint({ ...checkpoint, projectId: "project-2" })).toBe(false);
    expect(isConfirmedProjectFactCheckpoint({ ...checkpoint, sourceRefs: [{ ...source, visibility: "private" }] })).toBe(false);
    expect(isConfirmedProjectFactCheckpoint({ ...checkpoint, body: "raw message" })).toBe(false);
    expect(isConfirmedProjectFactCheckpoint({ ...checkpoint, factRevision: 0 })).toBe(false);
    expect(isConfirmedProjectFactCheckpoint({
      ...checkpoint, state: "superseded", confirmingHumanActorId: null,
    })).toBe(false);
    expect(isConfirmedProjectFactCheckpoint({
      ...checkpoint,
      factKind: "next_action",
      state: "superseded",
      confirmingHumanActorId: null,
    })).toBe(true);
  });

  it("validates, freezes, bounds, and de-duplicates authority pages", async () => {
    const listConfirmed = vi.fn(async () => ({
      roomId: "room-1",
      checkpoints: [checkpoint],
      nextCursor: null,
    }));
    const reader = createConfirmedProjectFactCheckpointReader({ authority: { listConfirmed } });
    const page = await reader.list({ roomId: "room-1", cursor: null, limit: 10 });
    expect(page).toEqual({ roomId: "room-1", checkpoints: [checkpoint], nextCursor: null });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.checkpoints)).toBe(true);
    expect(listConfirmed).toHaveBeenCalledWith({ roomId: "room-1", cursor: null, limit: 10 });

    for (const checkpoints of [[checkpoint, checkpoint], [{ ...checkpoint, roomId: "room-2", projectId: "room-2" }]]) {
      const invalid = createConfirmedProjectFactCheckpointReader({
        authority: { listConfirmed: vi.fn(async () => ({
          roomId: "room-1", checkpoints, nextCursor: null,
        })) },
      });
      await expect(invalid.list({ roomId: "room-1", cursor: null, limit: 10 }))
        .rejects.toThrow("malformed");
    }
    await expect(reader.list({
      roomId: "room-1", cursor: null, limit: CONFIRMED_PROJECT_CHECKPOINT_LIMITS.maxPage + 1,
    })).rejects.toThrow("invalid");
  });
});
