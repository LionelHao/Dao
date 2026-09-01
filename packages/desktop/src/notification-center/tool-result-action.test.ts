import { describe, expect, it, vi } from "vitest";
import type { NotificationProjection } from "@native-im/core";

import {
  NOTIFICATION_TOOL_RESULT_IPC_CHANNELS,
  isNotificationToolResultAcknowledgeIntent,
} from "./tool-result-action-contracts.js";
import { registerNotificationToolResultActionIpc } from "./tool-result-action-ipc.js";
import { createNotificationToolResultActionBridge } from "./tool-result-action-preload.js";
import { createNotificationToolResultActionRuntime } from "./tool-result-action-runtime.js";

const now = "2026-09-01T00:00:00.000Z";
const projection: NotificationProjection = {
  recordVersion: "notification.v1", notificationId: "notification-tool-1", roomId: "room-1",
  recipientActorId: "human-1", notificationKind: "tool_result",
  source: { sourceKind: "tool_call", sourceId: "tool-call-1", sourceRevision: 1,
    sourceBoundaryId: "dispatch-1", ordinal: 0 }, dedupeKey: "a".repeat(64), createdAt: now,
  readAt: null, readRevision: 0, handled: true, handledAt: now, sourceAccessible: true,
  deepLink: { kind: "tool_call", targetId: "tool-call-1" },
  safeProjection: { titleKey: "tool_result", actorId: null },
};

describe("notification tool-result source action", () => {
  it("accepts only notificationId and exposes no generic handled/source action", () => {
    expect(isNotificationToolResultAcknowledgeIntent({ notificationId: "notification-tool-1" }))
      .toBe(true);
    for (const input of [
      { notificationId: "notification-tool-1", handled: true },
      { notificationId: "notification-tool-1", recipientActorId: "human-other" },
      { notificationId: "notification-tool-1", sourceId: "tool-call-1" },
      { notificationId: "notification-tool-1", action: "mark-handled" },
    ]) expect(isNotificationToolResultAcknowledgeIntent(input)).toBe(false);
  });

  it("calls the source-specific authority command and returns only the closed outcome", async () => {
    const transport = { notificationAcknowledgeToolResult: vi.fn(async (command: {
      requestId: string;
    }) => ({ type: "notification.tool-result.ack" as const, requestId: command.requestId,
      outcome: "acknowledged" as const, projection })) };
    const runtime = createNotificationToolResultActionRuntime({ transport,
      session: () => ({ actorId: "human-1", sessionId: "session-1", accessToken: "token",
        expiresAt: "2026-09-02T00:00:00.000Z" }), createRequestId: () => "tool-result-ack-1" });
    await expect(runtime.acknowledge({ notificationId: "notification-tool-1" })).resolves.toEqual({
      notificationId: "notification-tool-1", outcome: "acknowledged",
    });
    expect(transport.notificationAcknowledgeToolResult).toHaveBeenCalledWith({
      type: "notification.tool-result.acknowledge", requestId: "tool-result-ack-1",
      notificationId: "notification-tool-1",
    });
  });

  it("keeps IPC/preload main-frame-only and sanitizes authority failures", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)), removeHandler: vi.fn() };
    const frame = {}; const webContents = { mainFrame: frame };
    const runtime = { acknowledge: vi.fn(async () => ({
      notificationId: "notification-tool-1", outcome: "already_acknowledged" as const,
    })) };
    const dispose = registerNotificationToolResultActionIpc({ ipcMain, webContents, runtime });
    expect([...handlers.keys()]).toEqual([NOTIFICATION_TOOL_RESULT_IPC_CHANNELS.acknowledge]);
    const handler = handlers.get(NOTIFICATION_TOOL_RESULT_IPC_CHANNELS.acknowledge)!;
    await expect(handler({ sender: {}, senderFrame: frame }, {
      notificationId: "notification-tool-1",
    })).rejects.toThrow("trusted main frame");
    await expect(handler({ sender: webContents, senderFrame: frame }, {
      notificationId: "notification-tool-1", handled: true,
    })).rejects.toThrow("Invalid notification tool-result acknowledge intent");
    runtime.acknowledge.mockRejectedValueOnce(Object.assign(new Error("private worker/path"), {
      notificationError: { status: 409, code: "notification_revision_conflict" },
    }));
    const failed = handler({ sender: webContents, senderFrame: frame }, {
      notificationId: "notification-tool-1",
    });
    await expect(failed).rejects.toMatchObject({
      notificationError: { status: 409, code: "notification_revision_conflict" },
    });
    await expect(failed).rejects.not.toThrow("private worker/path");
    dispose();

    const ipc = { invoke: vi.fn(async () => ({ notificationId: "notification-tool-1",
      outcome: "acknowledged" })) };
    const bridge = createNotificationToolResultActionBridge(ipc);
    expect(Object.keys(bridge)).toEqual(["acknowledge"]);
    await expect(bridge.acknowledge({ notificationId: "notification-tool-1" })).resolves.toEqual({
      notificationId: "notification-tool-1", outcome: "acknowledged",
    });
    expect(ipc.invoke).toHaveBeenCalledWith(NOTIFICATION_TOOL_RESULT_IPC_CHANNELS.acknowledge,
      { notificationId: "notification-tool-1" });
  });
});
