import { describe, expect, it, vi } from "vitest";
import { MEMORY_AUTHORITY_IPC_CHANNELS } from "./contracts.js";
import { createMemoryAuthorityBridge } from "./preload-bridge.js";

describe("Memory Authority preload bridge", () => {
  it("clones closed frames and drops malformed main-process input", async () => {
    let listener: ((event: unknown, input: unknown) => void) | undefined;
    const invoke = vi.fn(async (channel: string, input: unknown) => {
      if (channel === MEMORY_AUTHORITY_IPC_CHANNELS.context) return {
        roomId: "room-1", accessEpoch: 1, lifecycle: "archived",
        viewer: { actorId: "human-1", currentHuman: true },
      };
      const request = input as { accessEpoch: number; frame: { requestId: string; roomId: string } };
      return { accessEpoch: request.accessEpoch,
        frame: { type: "room.memory.status.v1", requestId: request.frame.requestId,
          roomId: request.frame.roomId, status: { roomId: request.frame.roomId,
            health: { state: "healthy", reason: "none", memoryWatermark: 0, corpusHead: 0,
              lag: 0, lastAttemptAt: null, retryable: false, recoveryRequired: false },
            recoveryGeneration: 0, updatedAt: "2026-08-20T00:00:00.000Z" } } };
    });
    const removeListener = vi.fn();
    const bridge = createMemoryAuthorityBridge({ invoke,
      on: (_channel, next) => { listener = next; }, removeListener });
    await expect(bridge.context({ roomId: "room-1" })).resolves.toMatchObject({
      lifecycle: "archived", viewer: { currentHuman: true },
    });
    await expect(bridge.request({ accessEpoch: 1, frame: {
      type: "room.memory.status.query.v1", requestId: "request-1", roomId: "room-1",
    } })).resolves.toMatchObject({ frame: { type: "room.memory.status.v1" } });
    const received: unknown[] = [];
    const stop = bridge.onAuthorityInput((input) => received.push(input));
    listener?.({}, { type: "room.memory.connection", roomId: "room-1", accessEpoch: 1,
      connection: { status: "offline" } });
    listener?.({}, { type: "room.memory.connection", roomId: "room-1", accessEpoch: 1,
      connection: { status: "offline" }, rawBody: "forbidden" });
    expect(received).toHaveLength(1);
    stop();
    expect(removeListener).toHaveBeenCalledOnce();
  });
});
