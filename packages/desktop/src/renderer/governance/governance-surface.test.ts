import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderGovernanceSurface,
  type GovernanceSurfaceActions,
} from "./governance-surface.js";
import type {
  DepartureConflictList,
  GovernanceClosedError,
  GovernanceProjection,
  GovernanceSurfaceState,
} from "./view-model.js";

function projection(lifecycle: "active" | "archived" = "active"): GovernanceProjection {
  return {
    roomId: "room-1",
    projectId: "room-1",
    roomName: "Governed Room",
    lifecycle,
    governanceRevision: lifecycle === "active" ? 7 : 8,
    archiveGeneration: lifecycle === "active" ? 0 : 1,
    ownerActorId: "human-owner",
    ...(lifecycle === "archived" ? { archivedAt: "2026-08-19T08:00:00.000Z" } : {}),
    members: [
      { kind: "human", actorId: "human-owner", displayName: "Owner", role: "member" },
      { kind: "human", actorId: "human-admin-a", displayName: "Admin A", role: "admin" },
      { kind: "human", actorId: "human-admin-b", displayName: "Admin B", role: "admin" },
      { kind: "human", actorId: "human-member", displayName: "Member", role: "member" },
      { kind: "agent", actorId: "agent-ordinary", displayName: "Agent", ordinary: true },
    ],
  };
}

const conflicts: DepartureConflictList = {
  roomId: "room-1",
  targetActorId: "human-member",
  governanceRevision: 7,
  conflicts: [
    { conflictId: "c-request", roomId: "room-1", subjectId: "request-1", kind: "request", summary: "Request remains active", state: "accepted", sourceRef: "request-1", revision: 1, allowedResolutions: ["complete", "transfer"] },
    { conflictId: "c-action", roomId: "room-1", subjectId: "action-1", kind: "next_action", summary: "NextAction remains active", state: "in_progress", sourceRef: "action-1", revision: 1, allowedResolutions: ["complete", "transfer"] },
    { conflictId: "c-blocker", roomId: "room-1", subjectId: "blocker-1", kind: "blocker_or_open_question", summary: "Blocker still owns the Ball", state: "open", sourceRef: "blocker-1", revision: 1, allowedResolutions: ["transfer", "escalate"] },
    { conflictId: "c-accept", roomId: "room-1", subjectId: "acceptance-1", kind: "pending_acceptance", summary: "Acceptance remains pending", state: "pending", sourceRef: "acceptance-1", revision: 1, allowedResolutions: ["transfer", "reject_or_revoke"] },
    { conflictId: "c-verify", roomId: "room-1", subjectId: "verification-1", kind: "pending_verification", summary: "Verification remains pending", state: "delivered", sourceRef: "verification-1", revision: 1, allowedResolutions: ["complete", "transfer"] },
    { conflictId: "c-confirm", roomId: "room-1", subjectId: "confirmation-1", kind: "pending_confirmation", summary: "Confirmation remains pending", state: "pending", sourceRef: "confirmation-1", revision: 1, allowedResolutions: ["reject_or_revoke"] },
  ],
};

function state(
  viewerActorId = "human-owner",
  lifecycle: "active" | "archived" = "active",
): GovernanceSurfaceState {
  return {
    projection: projection(lifecycle),
    viewerActorId,
    connection: { status: "online" },
    operation: { status: "idle" },
    dialog: null,
    reducedMotion: false,
  };
}

function actions(): GovernanceSurfaceActions {
  return {
    onIntent: vi.fn(),
    onOpenDialog: vi.fn(),
    onRetry: vi.fn(),
    onResolveConflict: vi.fn(),
    onCloseDialog: vi.fn(),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Desktop Governance permission and conflict DOM contract", () => {
  it("uses text roles and leaves owner/peer-admin controls visibly denied for an admin", () => {
    const root = document.createElement("main");
    renderGovernanceSurface(root, state("human-admin-a"), actions());

    expect(root.querySelector("[data-viewer-role='admin']")?.textContent).toContain("admin");
    expect(root.querySelector("[data-member-id='human-owner']")?.textContent).toContain("owner");
    expect(root.querySelector<HTMLButtonElement>("[data-remove-member='human-owner']")?.disabled).toBe(true);
    expect(root.querySelector("[data-member-id='human-owner']")?.textContent).toContain("admin 不能管理 owner");
    expect(root.querySelector<HTMLButtonElement>("[data-remove-member='human-admin-b']")?.disabled).toBe(true);
    expect(root.querySelector("[data-member-id='human-admin-b']")?.textContent).toContain("admin 不能管理同级 admin");
    expect(root.querySelector<HTMLButtonElement>("[data-remove-member='human-member']")?.disabled).toBe(false);
  });

  it("renders transfer targets from current Human membership and never offers an Agent", () => {
    const root = document.createElement("main");
    renderGovernanceSurface(root, state(), actions());
    const options = [...root.querySelectorAll<HTMLOptionElement>("[data-ownership-target] option")]
      .map((option) => option.value);
    expect(options).toEqual(["", "human-admin-a", "human-admin-b", "human-member"]);
    expect(options).not.toContain("agent-ordinary");
  });

  it("emits only local dialog intents from conflict and archive triggers", () => {
    const root = document.createElement("main");
    const handlers = actions();
    renderGovernanceSurface(root, { ...state(), departureConflicts: conflicts }, handlers);
    root.querySelector<HTMLButtonElement>("[data-action='open-departure-conflicts']")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='open-archive-confirmation']")?.click();
    expect(handlers.onOpenDialog).toHaveBeenNthCalledWith(1, "departure_conflicts");
    expect(handlers.onOpenDialog).toHaveBeenNthCalledWith(2, "archive_confirmation");
    expect(handlers.onIntent).not.toHaveBeenCalled();
  });

  it("groups all departure conflicts, renders only closed resolutions, and omits unknown fields", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const unsafe = structuredClone(conflicts);
    Reflect.set(unsafe.conflicts[0]!, "rawMessageBody", "DO-NOT-RENDER-RAW-BODY");
    Reflect.set(unsafe.conflicts[0]!, "toolParams", "DO-NOT-RENDER-TOOL-PARAMS");
    renderGovernanceSurface(root, {
      ...state(), departureConflicts: unsafe, dialog: "departure_conflicts",
    }, actions());

    const sheet = root.querySelector<HTMLElement>("[role='dialog'][data-departure-conflicts]");
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelectorAll("[data-conflict-group]")).toHaveLength(6);
    expect(sheet?.querySelectorAll("[data-conflict-id]")).toHaveLength(6);
    expect(sheet?.querySelector("[data-conflict-id='c-confirm']")?.textContent)
      .toContain("拒绝或撤销");
    expect(sheet?.querySelector("[data-conflict-id='c-confirm']")?.textContent)
      .not.toMatch(/完成|升级/);
    expect(sheet?.textContent).not.toContain("DO-NOT-RENDER");
    expect(document.activeElement).toBe(sheet?.querySelector("h2"));
  });

  it("focuses the replaced conflict summary after a final departure_blocked response", () => {
    const root = document.createElement("main");
    document.body.append(root);
    renderGovernanceSurface(root, {
      ...state("human-admin-a"),
      departureConflicts: conflicts,
      dialog: "departure_conflicts",
      operation: {
        status: "failed",
        requestId: "request-remove-final",
        command: "room.member.remove",
        error: { status: 409, code: "departure_blocked", details: conflicts },
      },
    }, actions());
    expect(document.activeElement).toBe(root.querySelector("[data-departure-conflicts] h2"));
    expect(root.querySelector("[data-governance-error]")?.textContent).toContain("departure_blocked");
  });

  it("traps Tab inside the sheet and returns focus to the trigger on close", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const handlers = actions();
    renderGovernanceSurface(root, {
      ...state(), departureConflicts: conflicts, dialog: "departure_conflicts",
    }, handlers);
    const sheet = root.querySelector<HTMLElement>("[data-departure-conflicts]")!;
    const trigger = root.querySelector<HTMLButtonElement>("[data-action='open-departure-conflicts']")!;
    const focusable = [...sheet.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']")];
    focusable.at(-1)?.focus();
    sheet.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(focusable[0]);

    sheet.querySelector<HTMLButtonElement>("[data-action='close-dialog']")?.click();
    expect(handlers.onCloseDialog).toHaveBeenCalledWith("departure_conflicts");
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Desktop Governance archived/reopen and recovery DOM contract", () => {
  it("keeps an archived banner persistent, read surfaces enabled, and business controls disabled with reasons", () => {
    const root = document.createElement("main");
    renderGovernanceSurface(root, state("human-admin-a", "archived"), actions());

    expect(root.querySelector("[data-archived-banner]")?.textContent).toContain("ARCHIVED");
    expect(root.querySelector("[data-archived-banner]")?.textContent).toContain("2026-08-19T08:00:00.000Z");
    for (const surface of ["history", "attachments", "project-facts", "audit"]) {
      expect(root.querySelector<HTMLButtonElement>(`[data-read-surface='${surface}']`)?.disabled).toBe(false);
    }
    for (const control of ["composer", "project-mutation", "agent-business-controls"]) {
      const button = root.querySelector<HTMLButtonElement>(`[data-business-control='${control}']`);
      expect(button?.disabled).toBe(true);
      expect(button?.getAttribute("aria-describedby")).toBeTruthy();
    }
    expect(root.querySelector<HTMLButtonElement>("[data-action='reopen-room']")?.disabled).toBe(false);
  });

  it("keeps archived state through submit and ACK, then enables controls only from active projection", () => {
    const root = document.createElement("main");
    renderGovernanceSurface(root, {
      ...state("human-owner", "archived"),
      operation: { status: "submitting", requestId: "request-reopen-1", command: "room.reopen" },
    }, actions());
    expect(root.querySelector("[data-archived-banner]")).not.toBeNull();
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("正在提交重开");

    renderGovernanceSurface(root, {
      ...state("human-owner", "archived"),
      operation: { status: "acknowledged", requestId: "request-reopen-1", command: "room.reopen" },
    }, actions());
    expect(root.querySelector("[data-archived-banner]")).not.toBeNull();
    expect(root.querySelector("[aria-live='polite']")?.textContent).toContain("等待 stable event / projection");

    renderGovernanceSurface(root, state("human-owner", "active"), actions());
    expect(root.querySelector("[data-archived-banner]")).toBeNull();
    expect(root.querySelector<HTMLButtonElement>("[data-business-control='composer']")?.disabled).toBe(false);
  });

  it("focuses a finite success result only after the authority projection converges", () => {
    const root = document.createElement("main");
    document.body.append(root);
    renderGovernanceSurface(root, {
      ...state("human-owner", "active"),
      operation: {
        status: "succeeded",
        requestId: "request-reopen-1",
        command: "room.reopen",
      },
    }, actions());
    const success = root.querySelector<HTMLElement>("[data-governance-success]");
    expect(success?.textContent).toContain("权威状态已收敛");
    expect(document.activeElement).toBe(success);
    expect(root.querySelectorAll("[role='status']")).toHaveLength(1);
  });

  it("does not let Escape silently confirm or dismiss archive", () => {
    const root = document.createElement("main");
    document.body.append(root);
    const handlers = actions();
    renderGovernanceSurface(root, { ...state(), dialog: "archive_confirmation" }, handlers);
    const dialog = root.querySelector<HTMLElement>("[role='alertdialog']")!;
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(handlers.onCloseDialog).not.toHaveBeenCalled();
    expect(handlers.onIntent).not.toHaveBeenCalled();
    expect(root.querySelector("[role='alertdialog']")).not.toBeNull();
  });

  const closedErrors = [
    { error: { status: 401, code: "authentication_required" }, recovery: "重新认证" },
    { error: { status: 403, code: "role_forbidden" }, recovery: "查看权限" },
    { error: { status: 404, code: "member_not_found" }, recovery: "刷新治理状态" },
    { error: { status: 409, code: "room_revision_conflict" }, recovery: "载入最新版本" },
    { error: { status: 410, code: "snapshot_expired" }, recovery: "重新开始 repair" },
    { error: { status: 429, code: "rate_limited" }, recovery: "稍后重试" },
    { error: { status: 503, code: "dependency_unavailable" }, recovery: "重试" },
  ] as const satisfies readonly {
    readonly error: GovernanceClosedError;
    readonly recovery: string;
  }[];

  it.each(closedErrors)("renders $error.status/$error.code as a finite actionable non-colour error", ({ error, recovery }) => {
    const root = document.createElement("main");
    renderGovernanceSurface(root, {
      ...state(),
      operation: {
        status: "failed",
        requestId: "request-error-1",
        command: "room.member.remove",
        error,
      },
    }, actions());
    const alert = root.querySelector("[role='group'][data-governance-error]");
    expect(alert?.textContent).toContain(String(error.status));
    expect(alert?.textContent).toContain(error.code);
    expect(alert?.textContent).toContain(recovery);
  });

  it("shows offline/repair/repair-failed without a write queue and locks all Room content after revoke", () => {
    const root = document.createElement("main");
    for (const connection of [
      { status: "offline", asOf: "2026-08-19T08:00:00.000Z", leaseExpiresAt: "2026-08-19T14:00:00.000Z" },
      { status: "repairing", watermark: 42 },
      { status: "repair_failed", errorCode: "snapshot_checksum_mismatch" },
    ] as const) {
      renderGovernanceSurface(root, { ...state(), connection }, actions());
      expect(root.querySelector("[data-connection-status]")?.textContent).toMatch(/离线|repair/i);
      expect(root.querySelector<HTMLButtonElement>("[data-archive-room]")?.disabled).toBe(true);
      expect(root.textContent).not.toContain("稍后自动提交");
    }

    renderGovernanceSurface(root, {
      ...state(), connection: { status: "revoked", scope: "room", purgeCompleted: true },
    }, actions());
    expect(root.querySelector("[data-governance-locked]")?.textContent).toContain("缓存已清除");
    expect(root.textContent).not.toContain("Governed Room");
    expect(root.querySelector("[data-read-surface]")).toBeNull();
  });
});

describe("Desktop Governance accessibility/layout contract", () => {
  it("uses one finite live region, textual state labels, and a reduced-motion marker", () => {
    const root = document.createElement("main");
    renderGovernanceSurface(root, { ...state(), reducedMotion: true }, actions());
    expect(root.querySelectorAll("[aria-live='polite']")).toHaveLength(1);
    expect(root.querySelector("[data-motion='reduced']")).not.toBeNull();
    expect(root.textContent).toContain("ACTIVE");
    expect(root.textContent).toContain("owner");
  });

  it("defines reflow-safe 100%-200% structure and reduced-motion CSS without hiding core actions", () => {
    const css = readFileSync(resolve(import.meta.dirname, "governance.css"), "utf8");
    const productionCss = readFileSync(resolve(import.meta.dirname, "..", "styles.css"), "utf8");
    expect(css).toContain("max-inline-size: 100%");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/@media\s*\(max-width:\s*52\.5rem\)/u);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(css).toContain("animation-duration: 0.01ms");
    expect(css).not.toMatch(/display:\s*none[^}]*data-action/u);
    expect(productionCss).toContain(".dao-governance");
    expect(productionCss).toMatch(/@media\s*\(max-width:\s*52\.5rem\)/u);
    expect(productionCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  });
});
