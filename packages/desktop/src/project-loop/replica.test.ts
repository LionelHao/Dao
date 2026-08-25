import { describe, expect, it } from "vitest";
import { createProjectLoopReplica, ProjectLoopReplicaError } from "./replica.js";
import { projectSnapshot } from "./test-fixture.js";

describe("FT-09 Desktop Project Loop replica", () => {
  it("atomically replaces query and repair snapshots and preserves the last complete value on rejection", () => {
    const replica = createProjectLoopReplica("room-1");
    const first = projectSnapshot();
    expect(replica.replaceFromQuery(first)).toEqual(first);
    expect(() => replica.replaceFromRepair({ kind: "project-loop", roomId: "room-2", value: first }))
      .toThrow(ProjectLoopReplicaError);
    expect(() => replica.replaceFromQuery({ ...first, roomId: "room-2" })).toThrow(ProjectLoopReplicaError);
    expect(replica.snapshot()).toEqual(first);
    const repaired = projectSnapshot({ watermark: 8, capturedAt: "2026-08-25T03:03:04.005Z" });
    expect(replica.replaceFromRepair({ kind: "project-loop", roomId: "room-1", value: repaired })).toEqual(repaired);
  });

  it("never applies a stable event optimistically and de-duplicates events behind the watermark", () => {
    const replica = createProjectLoopReplica("room-1"); replica.replaceFromQuery(projectSnapshot());
    const request = projectSnapshot().requests[0]!;
    const event = { eventId: "event-8", streamKind: "room" as const, streamId: "room-1", streamSeq: 8,
      roomId: "room-1", projectId: "room-1", actorId: "human-2",
      occurredAt: "2026-08-25T03:03:04.005Z", type: "project.request.changed" as const, payload: request };
    expect(replica.observeStableEvent(event)).toMatchObject({ needsRefresh: true, event });
    expect(replica.snapshot()?.watermark).toBe(7);
    expect(replica.observeStableEvent({ ...event, streamSeq: 7, eventId: "event-7" })).toEqual({ needsRefresh: false });
  });
});
