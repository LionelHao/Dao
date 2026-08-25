import { describe, expect, it, vi } from "vitest";

import {
  MESSAGE_AUTHORITY_IPC_CHANNELS,
  type MessageAuthorityHistoryResult,
} from "./contracts.js";
import { createMessageAuthorityBridge } from "./preload-bridge.js";

const lockedHistory: MessageAuthorityHistoryResult = {
  type: "room.history.v2",
  requestId: "history-1",
  roomId: "room-1",
  status: "locked",
  connection: { status: "fatal", errorCode: "dependency_unavailable" },
};

describe("Message Authority preload bridge", () => {
  it("exposes only five exact operations plus a closed subscription", async () => {
    const listeners = new Map<string, (event: unknown, value: unknown) => void>();
    const ipc = {
      invoke: vi.fn(async (channel: string) => channel === MESSAGE_AUTHORITY_IPC_CHANNELS.historyV2
        ? lockedHistory
        : { requestId: "request-1" }),
      on: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) => {
        listeners.set(channel, listener);
      }),
      removeListener: vi.fn(),
    };
    const bridge = createMessageAuthorityBridge(ipc);

    expect(Object.keys(bridge).sort()).toEqual([
      "historyV2", "onAuthorityInput", "recall", "revise", "revisionsQuery", "sendV2",
    ]);
    expect(JSON.stringify(bridge)).not.toMatch(/token|secret|ipcRenderer|WebSocket|generic/u);

    await expect(bridge.historyV2({
      type: "room.history.v2", roomId: "room-1", token: "forbidden",
    } as never)).rejects.toThrow("Invalid Message Authority history query");
    await expect(bridge.sendV2({
      type: "message.send.v2",
      message: {
        messageId: "message-1", roomId: "room-1", body: "Hello",
        mentionedTargets: [], attachments: [], authorId: "forged",
      },
    } as never)).rejects.toThrow("Invalid Message Authority send intent");
    await expect(bridge.historyV2({ type: "room.history.v2", roomId: "room-1" }))
      .resolves.toEqual(lockedHistory);

    const listener = vi.fn();
    const dispose = bridge.onAuthorityInput(listener);
    listeners.get(MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput)?.({}, {
      type: "room.cursor.advanced",
      roomId: "room-1",
      cursorBefore: 4,
      generation: 2,
      eventId: "room-renamed-5",
      streamSeq: 5,
    });
    expect(listener).toHaveBeenCalledWith({
      type: "room.cursor.advanced",
      roomId: "room-1",
      cursorBefore: 4,
      generation: 2,
      eventId: "room-renamed-5",
      streamSeq: 5,
    });
    listeners.get(MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput)?.({}, {
      type: "agent.execution.preview", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, streamSeq: 1, delta: "partial", authoritative: false,
    });
    expect(listener).toHaveBeenLastCalledWith({
      type: "agent.execution.preview", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, streamSeq: 1, delta: "partial", authoritative: false,
    });
    listeners.get(MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput)?.({}, {
      type: "room.event", token: "leak",
    });
    listeners.get(MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput)?.({}, {
      type: "room.cursor.advanced",
      roomId: "room-1",
      cursorBefore: 5,
      generation: 2,
      eventId: "room-renamed-6",
      streamSeq: 6,
      token: "leak",
    });
    listeners.get(MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput)?.({}, {
      type: "agent.execution.preview", roomId: "room-1", executionId: "execution-1",
      attemptSeq: 1, streamSeq: 2, delta: "open", authoritative: false, token: "leak",
    });
    expect(listener).toHaveBeenCalledTimes(2);
    dispose();
    dispose();
    expect(ipc.removeListener).toHaveBeenCalledOnce();
  });
});
