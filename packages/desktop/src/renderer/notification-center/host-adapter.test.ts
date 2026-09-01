// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { NotificationProjection } from "@native-im/core";
import type { NotificationCenterBridge } from "../../notification-center/contracts.js";
import type { NotificationToolResultActionBridge } from
  "../../notification-center/tool-result-action-contracts.js";
import type { NotificationExecutionResultActionBridge } from
  "../../notification-center/execution-result-action-contracts.js";
import type { NotificationCenterRemoteState } from "./view-model.js";
import { mountNotificationCenterShell } from "./host-adapter.js";

const notification: NotificationProjection = {
  recordVersion: "notification.v1", notificationId: "notification-1", roomId: "room-1",
  recipientActorId: "human-1", notificationKind: "human_request",
  source: { sourceKind: "project_request", sourceId: "request-1", sourceRevision: 1,
    sourceBoundaryId: "request-1:1", ordinal: 0 }, dedupeKey: "a".repeat(64),
  createdAt: "2026-08-31T08:00:00.000Z", readAt: null, readRevision: 0, handled: false,
  handledAt: null, sourceAccessible: true, deepLink: { kind: "request", targetId: "request-1" },
  safeProjection: { titleKey: "human_request", actorId: "human-2" },
};
const ready: NotificationCenterRemoteState = { status: "ready", recipientActorId: "human-1",
  notifications: [notification], roomBadges: [{ roomId: "room-1", unreadCount: 125,
    unhandledCount: 1 }], connection: { status: "online" }, operation: { status: "idle" },
  hasMore: false, page: { offset: 0, limit: 50 } };

describe("Notification Center Room shell integration", () => {
  it("renders the authoritative Room badge and resolves source before local navigation", async () => {
    const workspace = document.createElement("section"); document.body.append(workspace);
    let listener: (state: NotificationCenterRemoteState) => void = () => undefined;
    const bridge: NotificationCenterBridge = { getState: vi.fn(async () => ready),
      list: vi.fn(async () => ready), markRead: vi.fn(async () => ready),
      resolveSource: vi.fn(async () => ({ status: "available" as const,
        notificationId: "notification-1", roomId: "room-1",
        deepLink: { kind: "request" as const, targetId: "request-1" } })),
      retryRepair: vi.fn(async () => ready),
      onStateChanged(next) { listener = next; return () => { listener = () => undefined; }; } };
    const onDeepLink = vi.fn();
    const dispose = mountNotificationCenterShell({ workspace, bridge, roomId: "room-1",
      toolResultAction: { acknowledge: vi.fn(async () => ({ notificationId: "notification-1",
        outcome: "acknowledged" as const })) },
      executionResultAction: { acknowledge: vi.fn(async () => ({ notificationId: "notification-1",
        outcome: "acknowledged" as const })) },
      onDeepLink, onReauthenticate: vi.fn() });
    await vi.waitFor(() => expect(workspace.querySelector("button")?.getAttribute("aria-label"))
      .toContain("125 条未读"));
    const trigger = workspace.querySelector<HTMLButtonElement>(".notification-center-trigger")!;
    expect(trigger.textContent).toContain("99+");
    trigger.click();
    await vi.waitFor(() => expect(workspace.querySelector("[data-notification-id='notification-1']"))
      .not.toBeNull());
    workspace.querySelector<HTMLButtonElement>("[data-notification-id='notification-1']")!.click();
    await vi.waitFor(() => expect(onDeepLink).toHaveBeenCalledWith({ roomId: "room-1",
      kind: "request", targetId: "request-1" }));
    expect(bridge.resolveSource).toHaveBeenCalledWith({ notificationId: "notification-1" });
    listener({ status: "revoked", recipientActorId: "human-1", reason: "session_revoked" });
    expect(trigger.getAttribute("aria-label")).toContain("无未读");
    dispose();
    expect(workspace.childElementCount).toBe(0);
  });

  it("keeps source acknowledgement local-transient until the stable handled event", async () => {
    const workspace = document.createElement("section"); document.body.append(workspace);
    let listener: (state: NotificationCenterRemoteState) => void = () => undefined;
    const toolNotification: NotificationProjection = { ...notification,
      notificationId: "notification-tool", notificationKind: "tool_result",
      source: { sourceKind: "tool_call", sourceId: "tool-call-1", sourceRevision: 2,
        sourceBoundaryId: "tool-call-1:2", ordinal: 0 },
      deepLink: { kind: "tool_call", targetId: "tool-call-1" },
      safeProjection: { titleKey: "tool_result", actorId: null } };
    const toolState: NotificationCenterRemoteState = { ...ready, notifications: [toolNotification] };
    const bridge: NotificationCenterBridge = { getState: vi.fn(async () => toolState),
      list: vi.fn(async () => toolState), markRead: vi.fn(async () => toolState),
      resolveSource: vi.fn(), retryRepair: vi.fn(async () => toolState),
      onStateChanged(next) { listener = next; return () => { listener = () => undefined; }; } };
    const toolResultAction: NotificationToolResultActionBridge = {
      acknowledge: vi.fn(async () => ({ notificationId: "notification-tool",
        outcome: "acknowledged" as const })),
    };
    const executionResultAction: NotificationExecutionResultActionBridge = {
      acknowledge: vi.fn(),
    };
    const dispose = mountNotificationCenterShell({ workspace, bridge, roomId: "room-1",
      toolResultAction, executionResultAction, onDeepLink: vi.fn(), onReauthenticate: vi.fn() });
    const trigger = workspace.querySelector<HTMLButtonElement>(".notification-center-trigger")!;
    trigger.click();
    await vi.waitFor(() => expect(workspace.querySelector("[data-notification-source-action]"))
      .not.toBeNull());
    workspace.querySelector<HTMLButtonElement>("[data-notification-source-action]")!.click();
    await vi.waitFor(() => expect(workspace.querySelector(
      "[data-notification-source-action-status='acknowledged']",
    )).not.toBeNull());
    expect(workspace.querySelector("[data-handled-state]")?.textContent).toBe("未处理");
    listener({ ...toolState, notifications: [{ ...toolNotification, handled: true,
      handledAt: "2026-08-31T08:01:00.000Z" }] });
    expect(workspace.querySelector("[data-notification-source-action]")).toBeNull();
    dispose();
  });

  it("shows a sanitized retryable source-action failure without changing handled", async () => {
    const workspace = document.createElement("section"); document.body.append(workspace);
    const toolNotification: NotificationProjection = { ...notification,
      notificationId: "notification-tool", notificationKind: "tool_result",
      source: { sourceKind: "tool_call", sourceId: "tool-call-1", sourceRevision: 2,
        sourceBoundaryId: "tool-call-1:2", ordinal: 0 },
      deepLink: { kind: "tool_call", targetId: "tool-call-1" },
      safeProjection: { titleKey: "tool_result", actorId: null } };
    const toolState: NotificationCenterRemoteState = { ...ready, notifications: [toolNotification] };
    const bridge: NotificationCenterBridge = { getState: vi.fn(async () => toolState),
      list: vi.fn(async () => toolState), markRead: vi.fn(async () => toolState),
      resolveSource: vi.fn(), retryRepair: vi.fn(async () => toolState),
      onStateChanged: () => () => undefined };
    const dispose = mountNotificationCenterShell({ workspace, bridge, roomId: "room-1",
      toolResultAction: { acknowledge: vi.fn(async () => { throw Object.assign(
        new Error("private server detail"),
        { notificationError: { status: 503, code: "storage_unavailable" } },
      ); }) },
      executionResultAction: { acknowledge: vi.fn() },
      onDeepLink: vi.fn(), onReauthenticate: vi.fn() });
    workspace.querySelector<HTMLButtonElement>(".notification-center-trigger")!.click();
    await vi.waitFor(() => expect(workspace.querySelector("[data-notification-source-action]"))
      .not.toBeNull());
    workspace.querySelector<HTMLButtonElement>("[data-notification-source-action]")!.click();
    await vi.waitFor(() => expect(workspace.querySelector("[role='alert']")?.textContent)
      .toContain("通知服务暂不可用"));
    expect(workspace.querySelector("[data-handled-state]")?.textContent).toBe("未处理");
    expect(workspace.textContent).not.toContain("private server detail");
    dispose();
  });
});
