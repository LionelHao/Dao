import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { projectSnapshot } from "../../project-loop/test-fixture.js";
import { deriveProjectBallFacts } from "@native-im/core";
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

  it("renders proposal, confirmation, named confirmer, rejection and supersede audit", () => {
    const base = projectSnapshot(); const source = base.requests[0]!.provenance;
    const decision = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
      revision: 6, provenance: source, createdAt: "2026-08-25T01:02:03.004Z",
      updatedAt: "2026-08-25T02:03:04.005Z", kind: "decision" as const, decisionId: "decision-1",
      statement: "Use the fixed watermark", status: "superseded" as const,
      confirmedBy: { kind: "human" as const, actorId: "human-1" },
      confirmedAt: "2026-08-25T01:03:03.004Z", rejectedBy: null, rejectedAt: null,
      rejectionReason: null, supersedesDecisionId: null, supersededByDecisionId: "decision-2",
      supersedeReason: "New evidence", affectedFactIds: ["request-1"] };
    const rejectedProposal = { ...base.proposals[0]!, state: "rejected" as const,
      resolvedAt: "2026-08-25T02:00:00.000Z", resolutionReason: "Rejected after source review" };
    const confirmation = { recordVersion: "project-loop.v1" as const, confirmationId: "confirmation-1",
      proposalId: rejectedProposal.proposalId, roomId: "room-1", projectId: "room-1", revision: 2,
      principalActorId: "human-1", baseRevision: null, payloadDigest: `sha256:${"a".repeat(64)}`,
      state: "rejected" as const, createdAt: "2026-08-25T01:02:03.004Z",
      expiresAt: "2026-08-25T03:03:04.005Z", resolvedBy: { kind: "human" as const, actorId: "human-1" },
      resolvedAt: "2026-08-25T02:00:00.000Z", resolutionReason: "Rejected after source review" };
    const snapshotInput = { ...base, decisions: [decision], proposals: [rejectedProposal],
      confirmations: [confirmation] };
    const snapshot = { ...snapshotInput, balls: deriveProjectBallFacts({ roomId: "room-1", projectId: "room-1",
      requests: snapshotInput.requests, nextActions: snapshotInput.nextActions, obstacles: snapshotInput.obstacles,
      proposals: snapshotInput.proposals, confirmations: snapshotInput.confirmations,
      transferProposals: snapshotInput.transferProposals }) };
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { ...ready(), snapshot }, ui, { activeCategory: "decisions" });
    expect(root.textContent).toContain("confirmed by human-1");
    expect(root.textContent).toContain("superseded by decision-2: New evidence");
    expect(root.textContent).toContain("affected facts request-1");
    expect(root.textContent).toContain("Use the fixed watermark · superseded · r6");
    expect(root.textContent).toContain("PROPOSAL · 尚不是权威事实 · rejected · principal human-1");
    expect(root.querySelector('[data-proposal-id="proposal-1"]')?.textContent).toContain("revision r4 · base new");
    expect(root.textContent).toContain("CONFIRMATION · rejected · principal human-1 · resolved by human-1");
    expect(root.querySelector('[data-confirmation-id="confirmation-1"]')?.textContent)
      .toContain(`revision r2 · base new · digest sha256:${"a".repeat(64)}`);
    root.querySelector<HTMLButtonElement>('[data-category="ball"]')?.click();
    expect(root.querySelector('[role="tabpanel"]')?.textContent).toContain("source r3");
    expect(root.querySelector('[data-proposal-id="proposal-1"]')?.textContent)
      .toContain("Rejected after source review");
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
    if (status === 401 || status === 403 || status === 410) {
      expect([...root.querySelectorAll<HTMLButtonElement>("button")]
        .filter((candidate) => candidate.textContent === "取消请求" || candidate.textContent === "确认成为项目事实")
        .every((candidate) => candidate.disabled)).toBe(true);
    }
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
    const css = readFileSync(resolve(process.cwd().endsWith("packages/desktop") ? "src" : "packages/desktop/src",
      "renderer/project-loop/project-loop.css"), "utf8");
    expect(css).toContain("@media (max-width: 840px)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    opener.remove(); root.remove();
  });

  it("preserves category and restores a stable action control after an authority rerender", () => {
    const root = document.createElement("main"); document.body.append(root); const ui = actions();
    renderProjectLoopSurface(root, ready(), ui, { activeCategory: "requests" });
    const cancel = root.querySelector<HTMLButtonElement>('[data-project-control-id="request:request-1:cancel"]')!;
    cancel.focus();
    renderProjectLoopSurface(root, ready({ status: "failed", intentId: "cancel:request-1:3",
      error: { status: 409, code: "revision_conflict" } }), ui);
    expect(root.querySelector('[role="tabpanel"]')?.getAttribute("data-category")).toBe("requests");
    expect(document.activeElement?.getAttribute("data-project-control-id")).toBe("request:request-1:cancel");
    root.remove();
  });

  it("moves focus to the selected category when an authority rerender removes the invoking action", () => {
    const root = document.createElement("main"); document.body.append(root); const ui = actions();
    renderProjectLoopSurface(root, ready(), ui, { activeCategory: "requests" });
    root.querySelector<HTMLButtonElement>('[data-project-control-id="request:request-1:cancel"]')?.focus();
    renderProjectLoopSurface(root, { ...ready(), viewerActorId: "human-3" }, ui);
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.getAttribute("data-category")).toBe("requests");
    root.remove();
  });
});
