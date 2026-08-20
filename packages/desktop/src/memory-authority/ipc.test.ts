import { describe, expect, it, vi } from "vitest";
import type { MemoryAuthorityClientApplication } from "../renderer/memory-authority/client.js";
import { MEMORY_AUTHORITY_IPC_CHANNELS } from "./contracts.js";
import { registerMemoryAuthorityIpc } from "./ipc.js";

describe("Memory Authority IPC", () => {
  it("accepts only trusted exact intents and forwards closed authority input", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const sent: unknown[] = [];
    const webContents = { mainFrame: {}, isDestroyed: () => false,
      send: (_channel: string, input: unknown) => sent.push(input) };
    let listener: ((input: MemoryAuthorityClientApplication) => void) | undefined;
    const runtime = {
      context: vi.fn(async () => ({ roomId: "room-1", accessEpoch: 1,
        lifecycle: "active" as const, viewer: { actorId: "human-1", currentHuman: true } })),
      request: vi.fn(async (input: { accessEpoch: number; frame: { requestId: string; roomId: string } }) => ({
        accessEpoch: input.accessEpoch,
        frame: { type: "room.memory.status.v1", requestId: input.frame.requestId,
          roomId: input.frame.roomId, status: { roomId: input.frame.roomId,
            health: { state: "healthy", reason: "none", memoryWatermark: 0, corpusHead: 0,
              lag: 0, lastAttemptAt: null, retryable: false, recoveryRequired: false },
            recoveryGeneration: 0, updatedAt: "2026-08-20T00:00:00.000Z" } },
      })),
      subscribe(next: typeof listener) { listener = next; return () => { listener = undefined; }; },
      invalidateAuthorizedState() {}, close() {},
    };
    const dispose = registerMemoryAuthorityIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => { handlers.delete(channel); } },
      webContents,
      runtime,
    });
    const trusted = { sender: webContents, senderFrame: webContents.mainFrame };
    await expect(handlers.get(MEMORY_AUTHORITY_IPC_CHANNELS.context)!(trusted, {
      roomId: "room-1",
    })).resolves.toMatchObject({ accessEpoch: 1 });
    await expect(handlers.get(MEMORY_AUTHORITY_IPC_CHANNELS.request)!(trusted, {
      accessEpoch: 1,
      frame: { type: "room.memory.status.query.v1", requestId: "request-1", roomId: "room-1" },
    })).resolves.toMatchObject({ frame: { type: "room.memory.status.v1" } });
    await expect(handlers.get(MEMORY_AUTHORITY_IPC_CHANNELS.context)!({
      sender: {}, senderFrame: webContents.mainFrame,
    }, { roomId: "room-1" })).rejects.toThrow("trusted main frame");
    await expect(handlers.get(MEMORY_AUTHORITY_IPC_CHANNELS.context)!(trusted, {
      roomId: "room-1", actorId: "forged",
    })).rejects.toThrow("Invalid Memory Authority context query");

    listener?.({ type: "room.memory.connection", roomId: "room-1", accessEpoch: 1,
      connection: { status: "offline" } });
    expect(sent).toEqual([{ type: "room.memory.connection", roomId: "room-1", accessEpoch: 1,
      connection: { status: "offline" } }]);
    dispose();
    expect(handlers.size).toBe(0);
  });
});
