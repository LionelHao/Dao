import { describe, expect, it, vi } from "vitest";
import type { NotificationProjection } from "@native-im/core";

import {
  NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS,
  isNotificationExecutionResultAcknowledgeIntent,
} from "./execution-result-action-contracts.js";
import { registerNotificationExecutionResultActionIpc } from "./execution-result-action-ipc.js";
import { createNotificationExecutionResultActionBridge } from "./execution-result-action-preload.js";
import { createNotificationExecutionResultActionRuntime } from "./execution-result-action-runtime.js";

const now = "2026-09-01T00:00:00.000Z";
const projection: NotificationProjection = {
  recordVersion: "notification.v1", notificationId: "notification-execution-1", roomId: "room-1",
  recipientActorId: "human-1", notificationKind: "agent_execution_completed",
  source: { sourceKind: "agent_execution", sourceId: "execution-1", sourceRevision: 2,
    sourceBoundaryId: "execution-1", ordinal: 0 }, dedupeKey: "c".repeat(64), createdAt: now,
  readAt: null, readRevision: 0, handled: true, handledAt: now, sourceAccessible: true,
  deepLink: { kind: "agent_execution", targetId: "execution-1" },
  safeProjection: { titleKey: "agent_execution_completed", actorId: "agent-1" },
};

describe("notification execution-result source action", () => {
  it("accepts only notificationId and exposes no generic handled/source action", () => {
    expect(isNotificationExecutionResultAcknowledgeIntent({
      notificationId: "notification-execution-1",
    })).toBe(true);
    for (const input of [
      { notificationId: "notification-execution-1", handled: true },
      { notificationId: "notification-execution-1", recipientActorId: "human-other" },
      { notificationId: "notification-execution-1", sourceId: "execution-1" },
      { notificationId: "notification-execution-1", action: "mark-handled" },
    ]) expect(isNotificationExecutionResultAcknowledgeIntent(input)).toBe(false);
  });

  it("uses the source-specific command and never locally projects handled", async () => {
    const transport = { notificationAcknowledgeExecutionResult: vi.fn(async (command: {
      requestId: string;
    }) => ({ type: "notification.execution-result.ack" as const, requestId: command.requestId,
      outcome: "acknowledged" as const, projection })) };
    const runtime = createNotificationExecutionResultActionRuntime({ transport,
      session: () => ({ actorId: "human-1", sessionId: "session-1", accessToken: "token",
        expiresAt: "2026-09-02T00:00:00.000Z" }), createRequestId: () => "execution-ack-1" });
    await expect(runtime.acknowledge({ notificationId: projection.notificationId })).resolves.toEqual({
      notificationId: projection.notificationId, outcome: "acknowledged",
    });
    expect(transport.notificationAcknowledgeExecutionResult).toHaveBeenCalledWith({
      type: "notification.execution-result.acknowledge", requestId: "execution-ack-1",
      notificationId: projection.notificationId,
    });
  });

  it("rejects cross-recipient/nonterminal ACKs and maps every closed authority status", async () => {
    const transport = { notificationAcknowledgeExecutionResult: vi.fn() };
    const runtime = createNotificationExecutionResultActionRuntime({ transport,
      session: () => ({ actorId: "human-1", sessionId: "session-1", accessToken: "token",
        expiresAt: "2026-09-02T00:00:00.000Z" }), createRequestId: () => "execution-ack-1" });
    for (const invalid of [
      { ...projection, recipientActorId: "human-2" },
      { ...projection, notificationKind: "human_request" as const,
        source: { ...projection.source, sourceKind: "project_request" as const },
        deepLink: { kind: "request" as const, targetId: "execution-1" },
        safeProjection: { titleKey: "human_request" as const, actorId: "agent-1" } },
    ]) {
      transport.notificationAcknowledgeExecutionResult.mockResolvedValueOnce({
        type: "notification.execution-result.ack", requestId: "execution-ack-1",
        outcome: "acknowledged", projection: invalid,
      });
      await expect(runtime.acknowledge({ notificationId: projection.notificationId }))
        .rejects.toMatchObject({ notificationError: { status: 503, code: "storage_unavailable" } });
    }
    for (const [status, code] of [
      [401, "authentication_required"], [403, "notification_forbidden"],
      [409, "notification_revision_conflict"], [410, "notification_source_gone"],
      [429, "rate_limited"], [503, "storage_unavailable"],
    ] as const) {
      transport.notificationAcknowledgeExecutionResult.mockRejectedValueOnce(Object.assign(
        new Error("private authority detail"), { notificationError: { status, code } }));
      await expect(runtime.acknowledge({ notificationId: projection.notificationId }))
        .rejects.toMatchObject({ notificationError: { status, code } });
    }
  });

  it("keeps IPC/preload main-frame-only and closed", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)), removeHandler: vi.fn() };
    const frame = {}; const webContents = { mainFrame: frame };
    const runtime = { acknowledge: vi.fn(async () => ({ notificationId: projection.notificationId,
      outcome: "already_acknowledged" as const })) };
    const dispose = registerNotificationExecutionResultActionIpc({ ipcMain, webContents, runtime });
    const handler = handlers.get(NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS.acknowledge)!;
    await expect(handler({ sender: {}, senderFrame: frame }, {
      notificationId: projection.notificationId,
    })).rejects.toThrow("trusted main frame");
    await expect(handler({ sender: webContents, senderFrame: frame }, {
      notificationId: projection.notificationId, handled: true,
    })).rejects.toThrow("Invalid notification execution-result acknowledge intent");
    const ipc = { invoke: vi.fn(async () => ({ notificationId: projection.notificationId,
      outcome: "acknowledged" })) };
    const bridge = createNotificationExecutionResultActionBridge(ipc);
    await expect(bridge.acknowledge({ notificationId: projection.notificationId })).resolves.toEqual({
      notificationId: projection.notificationId, outcome: "acknowledged",
    });
    expect(ipc.invoke).toHaveBeenCalledWith(NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS.acknowledge,
      { notificationId: projection.notificationId });
    dispose();
  });
});
