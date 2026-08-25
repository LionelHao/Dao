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

  it("offers Human-owned NextAction progress, completion, and transfer intents", () => {
    const base = projectSnapshot(); const provenance = base.requests[0]!.provenance;
    const action = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
      revision: 2, provenance, createdAt: base.capturedAt, updatedAt: base.capturedAt,
      kind: "next_action" as const, nextActionId: "action-1", title: "Ship", description: "Ship safely",
      owner: { kind: "human" as const, actorId: "human-1" }, status: "accepted" as const,
      dueAt: null, deliverable: "release", acceptanceCriteria: [{ criterionId: "c-1", text: "green" }],
      verifier: { kind: "human" as const, actorId: "human-2" },
      acceptedBy: { kind: "human" as const, actorId: "human-1" },
      acceptedAt: base.capturedAt, delivery: null, completedBy: null, completedAt: null,
      statusReason: null, reassignmentChain: [] };
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { ...ready(), snapshot: { ...base, nextActions: [action],
      balls: deriveProjectBallFacts({ roomId: "room-1", projectId: "room-1", requests: base.requests,
        nextActions: [action], obstacles: [], proposals: base.proposals, confirmations: [],
        transferProposals: [] }) } }, ui, { activeCategory: "next_actions" });
    root.querySelector<HTMLButtonElement>('[data-project-control-id="next-action:action-1:start"]')?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "next_action.transition",
      factId: "action-1", action: "start", expectedRevision: 2 }));
    const target = root.querySelector<HTMLInputElement>('[data-project-transfer-target="action-1"]')!;
    target.value = "human-2";
    root.querySelector<HTMLInputElement>('[data-project-transfer-reason="action-1"]')!.value = "handoff";
    root.querySelector<HTMLButtonElement>('[data-project-control-id="next-action:action-1:transfer"]')?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "transfer.propose",
      subjectKind: "next_action", subjectId: "action-1", toOwner: { kind: "human", actorId: "human-2" } }));
    expect(root.textContent).toContain("Agent 目标由具名 Human principal human-2 确认");
    root.querySelector<HTMLSelectElement>('[data-project-transfer-target-kind="action-1"]')!.value = "agent";
    target.value = "agent-2";
    root.querySelector<HTMLButtonElement>('[data-project-control-id="next-action:action-1:transfer"]')?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "transfer.propose",
      subjectKind: "next_action", subjectId: "action-1", toOwner: { kind: "agent", actorId: "agent-2" } }));
  });

  it("preserves Project form drafts across submitting/retryable failure and clears them after ACK", () => {
    const base = projectSnapshot(); const provenance = base.requests[0]!.provenance;
    const action = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
      revision: 2, provenance, createdAt: base.capturedAt, updatedAt: base.capturedAt,
      kind: "next_action" as const, nextActionId: "action-draft", title: "Ship", description: "Ship safely",
      owner: { kind: "human" as const, actorId: "human-1" }, status: "accepted" as const,
      dueAt: null, deliverable: "release", acceptanceCriteria: [], verifier: null,
      acceptedBy: { kind: "human" as const, actorId: "human-1" }, acceptedAt: base.capturedAt,
      delivery: null, completedBy: null, completedAt: null, statusReason: null, reassignmentChain: [] };
    const snapshot = { ...base, nextActions: [action], balls: deriveProjectBallFacts({
      roomId: "room-1", projectId: "room-1", requests: base.requests, nextActions: [action],
      obstacles: base.obstacles, proposals: base.proposals, confirmations: base.confirmations,
      transferProposals: base.transferProposals,
    }) };
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { ...ready(), snapshot }, ui, { activeCategory: "next_actions" });
    root.querySelector<HTMLInputElement>('[data-project-transfer-target="action-draft"]')!.value = "agent-2";
    root.querySelector<HTMLInputElement>('[data-project-transfer-reason="action-draft"]')!.value = "specialist";

    renderProjectLoopSurface(root, { ...ready({ status: "submitting", intentId: "transfer-draft" }), snapshot }, ui,
      { activeCategory: "next_actions" });
    expect(root.querySelector<HTMLInputElement>('[data-project-transfer-target="action-draft"]')?.value)
      .toBe("agent-2");
    renderProjectLoopSurface(root, { ...ready({ status: "failed", intentId: "transfer-draft",
      error: { status: 503, code: "project_dependency_unavailable" } }), snapshot }, ui,
    { activeCategory: "next_actions" });
    expect(root.querySelector<HTMLInputElement>('[data-project-transfer-reason="action-draft"]')?.value)
      .toBe("specialist");

    renderProjectLoopSurface(root, { ...ready({ status: "acknowledged", intentId: "transfer-draft",
      acceptedRevision: 3 }), snapshot }, ui, { activeCategory: "next_actions" });
    expect(root.querySelector<HTMLInputElement>('[data-project-transfer-target="action-draft"]')?.value)
      .toBe("");
  });

  it("offers owner obstacle closure and named-principal transfer resolution", () => {
    const base = projectSnapshot(); const provenance = base.requests[0]!.provenance;
    const blocker = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
      revision: 2, provenance, createdAt: base.capturedAt, updatedAt: base.capturedAt,
      kind: "blocker" as const, obstacleId: "blocker-1", title: "Network", description: "Network down",
      impact: "release", owner: { kind: "human" as const, actorId: "human-1" }, status: "open" as const,
      dueAt: null, reviewAt: null, statusReason: null, escalationBoundaryId: null, resultSource: null,
      transferChain: [], resolutionCriteria: "reachable", question: null };
    const question = { ...blocker, kind: "open_question" as const, obstacleId: "question-1",
      title: "Network", owner: { kind: "human" as const, actorId: "human-2" },
      resolutionCriteria: null, question: "Which route?" };
    const transfer = { recordVersion: "project-loop.v1" as const, transferProposalId: "transfer-1",
      roomId: "room-1", projectId: "room-1", revision: 1, subjectKind: "open_question" as const,
      subjectId: "question-1", subjectRevision: 2, fromOwner: question.owner,
      toOwner: { kind: "human" as const, actorId: "human-1" }, proposedBy: { kind: "human" as const,
        actorId: "human-2" }, principalActorId: "human-1", reason: "handoff", status: "pending" as const,
      proposedAt: base.capturedAt, expiresAt: "2026-08-29T00:00:00.000Z", resolvedBy: null,
      resolvedAt: null, resolutionReason: null };
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { ...ready(), snapshot: { ...base, obstacles: [blocker, question],
      transferProposals: [transfer], balls: deriveProjectBallFacts({ roomId: "room-1", projectId: "room-1",
        requests: base.requests, nextActions: [], obstacles: [blocker, question], proposals: base.proposals,
        confirmations: [], transferProposals: [transfer] }) } }, ui, { activeCategory: "obstacles" });
    const visible = root.querySelector('[role="tabpanel"]')?.textContent ?? "";
    expect(visible).toContain("BLOCKER"); expect(visible).toContain("OPEN QUESTION");
    expect(root.querySelector('[data-project-obstacle-kind="blocker"]')?.getAttribute("aria-label"))
      .toContain("阻塞 Blocker");
    expect(root.querySelector('[data-project-obstacle-kind="open_question"]')?.getAttribute("aria-label"))
      .toContain("待解问题 Open Question");
    const sourceId = root.querySelector<HTMLInputElement>('[data-obstacle-result-source-id="blocker-1"]')!;
    sourceId.value = "message-result";
    root.querySelector<HTMLInputElement>('[data-obstacle-reason="blocker-1"]')!.value = "network restored";
    root.querySelector<HTMLButtonElement>('[data-project-control-id="obstacle:blocker-1:resolve"]')?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "obstacle.transition",
      obstacleKind: "blocker", factId: "blocker-1", action: "resolve",
      resultSource: expect.objectContaining({ sourceId: "message-result", roomId: "room-1" }) }));
    root.querySelector<HTMLButtonElement>('[data-project-control-id="transfer:transfer-1:accept"]')?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "transfer.resolve",
      transferProposalId: "transfer-1", resolution: "accepted", reason: null }));
  });

  it("offers obstacle reopen and non-colour Agent transfer with a named Human principal", () => {
    const base = projectSnapshot(); const provenance = base.requests[0]!.provenance;
    const blocker = { recordVersion: "project-loop.v1" as const, roomId: "room-1", projectId: "room-1",
      revision: 3, provenance, createdAt: base.capturedAt, updatedAt: base.capturedAt,
      kind: "blocker" as const, obstacleId: "blocker-resolved", title: "Network", description: "Network down",
      impact: "release", owner: { kind: "human" as const, actorId: "human-1" },
      status: "cannot_answer" as const, dueAt: null, reviewAt: null, statusReason: "vendor unknown",
      escalationBoundaryId: "boundary-vendor", resultSource: null, transferChain: [],
      resolutionCriteria: "reachable", question: null };
    const snapshot = { ...base, obstacles: [blocker], balls: deriveProjectBallFacts({
      roomId: "room-1", projectId: "room-1", requests: base.requests, nextActions: base.nextActions,
      obstacles: [blocker], proposals: base.proposals, confirmations: base.confirmations,
      transferProposals: base.transferProposals,
    }) };
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { ...ready(), snapshot }, ui, { activeCategory: "obstacles" });
    root.querySelector<HTMLInputElement>('[data-obstacle-reopen-reason="blocker-resolved"]')!.value =
      "regression observed";
    root.querySelector<HTMLButtonElement>(
      '[data-project-control-id="obstacle:blocker-resolved:reopen"]',
    )?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "obstacle.transition",
      obstacleKind: "blocker", factId: "blocker-resolved", expectedRevision: 3,
      action: "reopen", reason: "regression observed" }));

    const openBlocker = { ...blocker, revision: 4, status: "open" as const, statusReason: null,
      escalationBoundaryId: null, resultSource: null };
    const openSnapshot = { ...snapshot, obstacles: [openBlocker], balls: deriveProjectBallFacts({
      roomId: "room-1", projectId: "room-1", requests: base.requests, nextActions: base.nextActions,
      obstacles: [openBlocker], proposals: base.proposals, confirmations: base.confirmations,
      transferProposals: base.transferProposals,
    }) };
    renderProjectLoopSurface(root, { ...ready(), snapshot: openSnapshot }, ui, { activeCategory: "obstacles" });
    expect(root.textContent).toContain("Agent 目标由具名 Human principal human-1 确认");
    const kind = root.querySelector<HTMLSelectElement>(
      '[data-project-transfer-target-kind="blocker-resolved"]',
    )!;
    kind.value = "agent";
    root.querySelector<HTMLInputElement>('[data-project-transfer-target="blocker-resolved"]')!.value = "agent-2";
    root.querySelector<HTMLInputElement>('[data-project-transfer-reason="blocker-resolved"]')!.value = "specialist";
    root.querySelector<HTMLButtonElement>(
      '[data-project-control-id="obstacle:blocker-resolved:transfer"]',
    )?.click();
    expect(ui.onIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: "transfer.propose",
      subjectKind: "blocker", subjectId: "blocker-resolved", expectedRevision: 4,
      toOwner: { kind: "agent", actorId: "agent-2" }, reason: "specialist" }));
  });

  it("renders viewer-filtered NeedsAction separately from identifiable Room Ball ownership", () => {
    const base = projectSnapshot();
    const theirs = { ...base.requests[0]!, requestId: "request-other",
      requester: { kind: "human" as const, actorId: "human-2" },
      target: { kind: "human" as const, actorId: "human-3" } };
    const requests = [base.requests[0]!, theirs];
    const balls = deriveProjectBallFacts({ roomId: "room-1", projectId: "room-1", requests,
      nextActions: base.nextActions, obstacles: base.obstacles, proposals: base.proposals,
      confirmations: base.confirmations, transferProposals: base.transferProposals });
    const root = document.createElement("main"); const ui = actions();
    renderProjectLoopSurface(root, { ...ready(), snapshot: { ...base, requests, balls } }, ui,
      { activeCategory: "ball" });
    const needsAction = root.querySelector('[data-project-needs-action="viewer"]')?.textContent ?? "";
    expect(needsAction).toContain("request-1"); expect(needsAction).not.toContain("request-other");
    const ownership = root.querySelector('[data-project-ball-ownership="room"]')?.textContent ?? "";
    expect(ownership).toContain("request-1"); expect(ownership).toContain("request-other");
    expect(ownership).toContain("source request:request-other");
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
    expect(root.querySelector('[role="tabpanel"]')?.textContent).toContain("source request:request-1 r3");
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
