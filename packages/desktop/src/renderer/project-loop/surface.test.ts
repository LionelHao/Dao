import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectSnapshot } from "../../project-loop/test-fixture.js";
import { renderProjectLoopSurface, type ProjectLoopSurfaceActions } from "./surface.js";

function actions() {
  return { onIntent: vi.fn(), onRetry: vi.fn(), onReauthenticate: vi.fn(), onSearch: vi.fn(),
    onNavigateSegment: vi.fn(), onOpenSource: vi.fn() } satisfies ProjectLoopSurfaceActions;
}
function ready(operation: Extract<import("./view-model.js").ProjectLoopRemoteState,
  { status: "ready" }> ["operation"] = { status: "idle" }) {
  return { status: "ready" as const, roomId: "room-1", snapshot: projectSnapshot(), viewerActorId: "human-1",
    connection: { status: "online" as const }, operation };
}

describe("FT-09 J-04/J-06/J-07 Project surface", () => {
  it("renders loading and six empty categories without inventing facts", () => {
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { status: "loading", roomId: "room-1" }, ui);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("载入");
    const empty = { ...projectSnapshot(), requests: [], proposals: [], balls: [] };
    renderProjectLoopSurface(root, { ...ready(), snapshot: empty }, ui);
    expect(root.querySelectorAll('[role="tab"]')).toHaveLength(6);
    expect(root.textContent).toContain("暂无目标事实");
  });

  it("uses proposal revision CAS and exposes explicit named-Human confirmation with source", () => {
    const root = document.createElement("main"); const ui = actions(); renderProjectLoopSurface(root, ready(), ui);
    root.querySelector<HTMLButtonElement>("[data-proposal-id] button:nth-of-type(2)")?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "proposal.resolve",
      proposalId: "proposal-1", expectedRevision: 4, resolution: "confirmed", reason: null }));
    expect(root.textContent).toContain("PROPOSAL · 尚不是权威事实");
    expect(root.textContent).toContain("查看来源 agent_execution:message-1 r1");
  });

  it("offers the J-04 target/requester actions and keeps them as submitted intents", () => {
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { ...ready(), viewerActorId: "human-2" }, ui, { activeCategory: "requests" });
    const accept = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "接受请求");
    accept?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "request.transition",
      factId: "request-1", expectedRevision: 3, action: "accept" }));
    const input = root.querySelector<HTMLInputElement>('[data-request-transfer-target="request-1"]')!;
    input.value = "human-3";
    [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "提交转交")?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "transfer",
      target: { kind: "human", actorId: "human-3" } }));
  });

  it.each([401, 403, 409, 410, 429, 503] as const)("announces and exposes a non-colour %s recovery contract", (status) => {
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, ready({ status: "failed", intentId: "intent-1",
      error: { status, code: status === 429 ? "rate_limited" : `error_${status}`,
        ...(status === 429 ? { retryAfterSeconds: 12 } : {}) } }), ui);
    expect(root.querySelector('[role="alert"]')?.textContent).not.toBe("");
    expect(root.querySelector(`[data-project-recovery="${status}"]`)).not.toBeNull();
    if (status === 403) expect(root.querySelector(`[data-project-recovery="${status}"]`)?.tagName).toBe("P");
    if (status === 429) expect(root.textContent).toContain("12 秒后");
  });

  it("links tabs, supports roving keyboard focus, restores external focus on Escape and declares view contracts", () => {
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const root = document.createElement("main"); document.body.append(root); const ui = actions();
    renderProjectLoopSurface(root, ready(), ui, { reducedMotion: true });
    const first = root.querySelector<HTMLButtonElement>('[role="tab"]')!;
    expect(first.getAttribute("aria-controls")).toBe(root.querySelector('[role="tabpanel"]')?.id);
    first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("决策");
    root.querySelector(".project-loop")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(opener);
    expect(root.querySelector(".project-loop")?.getAttribute("data-minimum-viewport")).toBe("840x560");
    expect(root.querySelector(".project-loop")?.getAttribute("data-default-viewport")).toBe("1440x900");
    expect(root.querySelector(".project-loop")?.getAttribute("data-zoom-contract")).toBe("100-200");
    const css = readFileSync(resolve("packages/desktop/src/renderer/project-loop/project-loop.css"), "utf8");
    expect(css).toContain("@media (max-width: 840px)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    opener.remove(); root.remove();
  });
});
