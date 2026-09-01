import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { NotificationProjection } from "@native-im/core";
import { renderNotificationCenter, type NotificationCenterActions } from "./surface.js";
import type { NotificationCenterRemoteState } from "./view-model.js";

const createdAt = "2026-08-31T08:00:00.000Z";
function item(overrides: Partial<NotificationProjection> = {}): NotificationProjection {
  return { recordVersion: "notification.v1", notificationId: "notification-1", roomId: "room-1",
    recipientActorId: "human-1", notificationKind: "human_request",
    source: { sourceKind: "project_request", sourceId: "request-1", sourceRevision: 1,
      sourceBoundaryId: "boundary-1", ordinal: 0 }, dedupeKey: "a".repeat(64), createdAt,
    readAt: null, readRevision: 0, handled: false, handledAt: null, sourceAccessible: true,
    deepLink: { kind: "request", targetId: "request-1" },
    safeProjection: { titleKey: "human_request", actorId: "human-2" }, ...overrides };
}
function ready(overrides: Partial<Extract<NotificationCenterRemoteState, { status: "ready" }>> = {}):
Extract<NotificationCenterRemoteState, { status: "ready" }> {
  return { status: "ready", recipientActorId: "human-1", notifications: [item()],
    roomBadges: [{ roomId: "room-1", unreadCount: 1, unhandledCount: 1 }],
    connection: { status: "online" }, operation: { status: "idle" }, page: { offset: 0, limit: 50 },
    ...overrides };
}
function actions(): NotificationCenterActions {
  return { onMarkRead: vi.fn(), onOpenDeepLink: vi.fn(), onRetry: vi.fn(), onReauthenticate: vi.fn(),
    onRefresh: vi.fn(), onRequestClose: vi.fn(), onPage: vi.fn(),
    onAcknowledgeToolResult: vi.fn(), onAcknowledgeExecutionResult: vi.fn() };
}

describe("FT-12 J-07 notification center surface", () => {
  it("does not mark anything read merely by opening and activates deep link + read intent separately", () => {
    const root = document.createElement("main"); const ui = actions();
    renderNotificationCenter(root, ready(), ui);
    expect(ui.onMarkRead).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>("[data-notification-id='notification-1']")?.click();
    expect(ui.onMarkRead).toHaveBeenCalledWith("notification-1", 0);
    expect(ui.onOpenDeepLink).toHaveBeenCalledWith({ kind: "request", targetId: "request-1" });
  });

  it("never submits another read for read-but-unhandled and shows handled separately", () => {
    const root = document.createElement("main"); const ui = actions();
    renderNotificationCenter(root, ready({ notifications: [item({ readAt: createdAt, readRevision: 1 })],
      roomBadges: [{ roomId: "room-1", unreadCount: 0, unhandledCount: 1 }] }), ui);
    expect(root.textContent).toContain("已读"); expect(root.textContent).toContain("未处理");
    root.querySelector<HTMLButtonElement>("[data-notification-id]")?.click();
    expect(ui.onMarkRead).not.toHaveBeenCalled(); expect(ui.onOpenDeepLink).toHaveBeenCalledOnce();
  });

  it("offers only source-specific tool confirmation and execution acknowledgement actions", () => {
    const root = document.createElement("main"); const ui = actions();
    const tool = item({ notificationId: "notification-tool", notificationKind: "tool_result",
      source: { sourceKind: "tool_call", sourceId: "tool-call-1", sourceRevision: 2,
        sourceBoundaryId: "tool-call-1:2", ordinal: 0 },
      deepLink: { kind: "tool_call", targetId: "tool-call-1" },
      safeProjection: { titleKey: "tool_result", actorId: null } });
    const completed = item({ notificationId: "notification-completed",
      notificationKind: "agent_execution_completed",
      source: { sourceKind: "agent_execution", sourceId: "execution-1", sourceRevision: 3,
        sourceBoundaryId: "execution-1:3", ordinal: 0 },
      deepLink: { kind: "agent_execution", targetId: "execution-1" },
      safeProjection: { titleKey: "agent_execution_completed", actorId: "agent-1" } });
    const failed = item({ notificationId: "notification-failed",
      notificationKind: "agent_execution_failed",
      source: { sourceKind: "agent_execution", sourceId: "execution-2", sourceRevision: 4,
        sourceBoundaryId: "execution-2:4", ordinal: 0 },
      deepLink: { kind: "agent_execution", targetId: "execution-2" },
      safeProjection: { titleKey: "agent_execution_failed", actorId: "agent-1" } });
    const handledTool = { ...tool, notificationId: "notification-tool-handled",
      handled: true, handledAt: createdAt };
    renderNotificationCenter(root, ready({ notifications: [tool, completed, failed, handledTool] }), ui);
    const toolAction = root.querySelector<HTMLButtonElement>(
      "[data-notification-source-action='tool_result']",
    )!;
    const executionAction = root.querySelector<HTMLButtonElement>(
      "[data-notification-source-action='agent_execution_completed']",
    )!;
    expect(toolAction.textContent).toBe("确认工具结果");
    expect(toolAction.getAttribute("aria-label")).toContain("工具调用已有结果");
    expect(executionAction.textContent).toBe("知悉执行结果");
    const failedAction = root.querySelector<HTMLButtonElement>(
      "[data-notification-source-action='agent_execution_failed']",
    )!;
    expect(failedAction.textContent).toBe("知悉执行结果");
    expect(root.querySelector("[data-notification-card='notification-tool-handled']")
      ?.querySelector("[data-notification-source-action]")).toBeNull();
    expect(root.textContent).not.toContain("标为已处理");
    toolAction.click(); executionAction.click(); failedAction.click();
    expect(ui.onAcknowledgeToolResult).toHaveBeenCalledWith("notification-tool");
    expect(ui.onAcknowledgeExecutionResult).toHaveBeenCalledWith("notification-completed");
    expect(ui.onAcknowledgeExecutionResult).toHaveBeenCalledWith("notification-failed");
    expect(ui.onMarkRead).not.toHaveBeenCalled();
  });

  it("announces source action submit/ACK/error without locally changing handled", () => {
    const tool = item({ notificationId: "notification-tool", notificationKind: "tool_result",
      source: { sourceKind: "tool_call", sourceId: "tool-call-1", sourceRevision: 2,
        sourceBoundaryId: "tool-call-1:2", ordinal: 0 },
      deepLink: { kind: "tool_call", targetId: "tool-call-1" },
      safeProjection: { titleKey: "tool_result", actorId: null } });
    const cases = [
      { status: "submitting" as const, label: "正在确认工具结果", disabled: true },
      { status: "acknowledged" as const, label: "已提交，等待 handled 事件", disabled: true },
      { status: "failed" as const, errorStatus: 503 as const,
        label: "重试确认工具结果", disabled: false },
    ];
    for (const sourceAction of cases) {
      const root = document.createElement("main");
      renderNotificationCenter(root, ready({ notifications: [tool] }), actions(), {
        sourceActionStates: new Map([[tool.notificationId, sourceAction]]),
      });
      const action = root.querySelector<HTMLButtonElement>("[data-notification-source-action]")!;
      expect(action.textContent).toBe(sourceAction.label); expect(action.disabled).toBe(sourceAction.disabled);
      expect(root.querySelector("[data-handled-state]")?.textContent).toBe("未处理");
      expect(root.querySelector("[data-notification-source-action-status]")?.getAttribute("aria-live"))
        .toBe("polite");
      if (sourceAction.status === "failed") {
        expect(root.querySelector("[data-notification-source-action-status][role='alert']"))
          .not.toBeNull();
      }
    }
  });

  it("renders every closed source-action error without exposing a generic handled action", () => {
    const tool = item({ notificationId: "notification-tool", notificationKind: "tool_result",
      source: { sourceKind: "tool_call", sourceId: "tool-call-1", sourceRevision: 2,
        sourceBoundaryId: "tool-call-1:2", ordinal: 0 },
      deepLink: { kind: "tool_call", targetId: "tool-call-1" },
      safeProjection: { titleKey: "tool_result", actorId: null } });
    for (const errorStatus of [401, 403, 409, 410, 429, 503] as const) {
      const root = document.createElement("main");
      renderNotificationCenter(root, ready({ notifications: [tool] }), actions(), {
        sourceActionStates: new Map([[tool.notificationId, { status: "failed", errorStatus }]]),
      });
      expect(root.querySelector("[data-notification-source-action-status][role='alert']"))
        .not.toBeNull();
      expect(root.querySelector("[data-handled-state]")?.textContent).toBe("未处理");
      expect(root.textContent).not.toContain("标为已处理");
      expect(root.querySelector<HTMLButtonElement>("[data-notification-source-action]")?.disabled)
        .toBe([401, 403, 410].includes(errorStatus));
    }
  });

  it("renders recalled source as a tombstone deep link without exposing source metadata", () => {
    const root = document.createElement("main"); const ui = actions();
    renderNotificationCenter(root, ready({ sourceResolutions: [
      { notificationId: "notification-1", status: "recalled" },
    ] }), ui);
    expect(root.querySelector("[data-source-status='recalled']")?.textContent).toContain("tombstone");
    expect(root.textContent).not.toContain("boundary-1");
    root.querySelector<HTMLButtonElement>("[data-notification-id]")?.click();
    expect(ui.onOpenDeepLink).toHaveBeenCalledWith({ kind: "request", targetId: "request-1" });
  });

  it.each([
    { status: "offline" as const, asOf: createdAt },
    { status: "repairing" as const, watermark: 9 },
    { status: "repair_failed" as const, code: "checksum_mismatch" },
  ])("keeps complete items but performs zero write calls in $status", (connection) => {
    const root = document.createElement("main"); const ui = actions();
    renderNotificationCenter(root, ready({ connection }), ui);
    root.querySelector<HTMLButtonElement>("[data-notification-id]")?.click();
    expect(ui.onMarkRead).not.toHaveBeenCalled();
    expect(root.querySelector("[data-notification-connection]")?.textContent).not.toBe("");
  });

  it("renders loading/empty/archived/revoked and all closed error recovery surfaces", () => {
    const root = document.createElement("main"); const ui = actions();
    renderNotificationCenter(root, { status: "loading", recipientActorId: "human-1" }, ui);
    expect(root.querySelector("[role='status']")?.textContent).toContain("载入");
    renderNotificationCenter(root, ready({ notifications: [], roomBadges: [] }), ui);
    expect(root.textContent).toContain("没有通知");
    renderNotificationCenter(root, ready({ connection: { status: "archived", roomIds: ["room-1"] } }), ui);
    expect(root.textContent).toContain("归档");
    renderNotificationCenter(root, { status: "revoked", recipientActorId: "human-1",
      reason: "session_revoked" }, ui);
    expect(root.querySelector("[role='alert']")?.textContent).not.toContain("request-1");
    for (const status of [401, 403, 409, 410, 429, 503] as const) {
      renderNotificationCenter(root, ready({ operation: { status: "failed", requestId: "request-1",
        notificationId: "notification-1", error: { status, code: `error_${status}`,
          ...(status === 429 ? { retryAfterMs: 1000 } : {}) } } }), ui);
      expect(root.querySelector(`[data-notification-recovery='${status}']`)).not.toBeNull();
      if (status === 401 || status === 403 || status === 410) {
        expect(root.querySelector("[data-notification-id]")).toBeNull();
        expect(root.textContent).not.toContain("Human 向你发出 Request");
      }
    }
  });

  it("traps focus, closes on Escape, restores opener and exposes VoiceOver labels", () => {
    const opener = document.createElement("button"); opener.textContent = "通知"; document.body.append(opener);
    opener.focus(); const root = document.createElement("main"); document.body.append(root); const ui = actions();
    renderNotificationCenter(root, ready({ roomBadges: [{ roomId: "room-1", unreadCount: 101, unhandledCount: 1 }] }),
      ui, { opener });
    const dialog = root.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(root.querySelector("[data-notification-badge]")?.getAttribute("aria-label")).toContain("101 条未读");
    const focusable = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    focusable.at(-1)?.focus(); dialog.dispatchEvent(new KeyboardEvent("keydown",
      { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(focusable[0]);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(ui.onRequestClose).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(opener);
    opener.remove(); root.remove();
  });

  it("declares 840x560, zoom, focus, non-colour, aria-live and reduced-motion contracts", () => {
    const root = document.createElement("main"); renderNotificationCenter(root, ready(), actions());
    const dialog = root.querySelector<HTMLElement>("[role='dialog']")!;
    expect(dialog.dataset.minimumViewport).toBe("840x560");
    expect(dialog.dataset.zoomContract).toBe("100-200");
    expect(root.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
    expect(root.querySelector("[data-read-state]")?.textContent).toBe("未读");
    expect(root.querySelector("[data-handled-state]")?.textContent).toBe("未处理");
    const css = readFileSync(resolve(process.cwd().endsWith("packages/desktop") ? "src" : "packages/desktop/src",
      "renderer/notification-center/notification-center.css"), "utf8");
    expect(css).toContain("@media (max-width: 840px)"); expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(":focus-visible");
  });
});
