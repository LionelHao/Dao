import type { ProjectHumanRef, ProjectProposal, ProjectRequest, ProjectSourceRef } from "@native-im/core";
import { createProjectLoopViewModel, type ProjectLoopCategory, type ProjectLoopRemoteState } from "./view-model.js";

export type ProjectLoopIntent =
  | Readonly<{ kind: "proposal.resolve"; intentId: string; proposalId: string; expectedRevision: number;
      resolution: "confirmed" | "rejected"; reason: string | null }>
  | Readonly<{ kind: "request.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "accept" }>
  | Readonly<{ kind: "request.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "reject" | "cancel"; reason: string }>
  | Readonly<{ kind: "request.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "transfer"; target: ProjectHumanRef; reason: string }>;

export interface ProjectLoopSurfaceActions {
  onIntent(intent: ProjectLoopIntent): void;
  onRetry(): void;
  onReauthenticate(): void;
  onSearch(): void;
  onNavigateSegment(segment: "timeline" | "project" | "members"): void;
  onOpenSource(source: ProjectSourceRef): void;
}

const CATEGORIES: readonly ProjectLoopCategory[] = ["goals", "decisions", "requests", "obstacles", "next_actions", "ball"];
const LABELS: Readonly<Record<ProjectLoopCategory, string>> = {
  goals: "目标", decisions: "决策", requests: "请求", obstacles: "阻塞与问题",
  next_actions: "下一步", ball: "Ball / NeedsAction",
};
function button(text: string, action: () => void, disabled = false): HTMLButtonElement {
  const value = document.createElement("button"); value.type = "button"; value.textContent = text;
  value.disabled = disabled; value.addEventListener("click", action); return value;
}
function proposalTitle(proposal: ProjectProposal): string {
  return proposal.payload.kind === "decision" ? proposal.payload.statement : proposal.payload.title;
}
function renderLocked(root: HTMLElement, state: Extract<ProjectLoopRemoteState, { status: "locked" }>,
  actions: ProjectLoopSurfaceActions): void {
  const panel = document.createElement("section"); panel.className = "project-loop project-loop--locked";
  panel.dataset.projectLoopStatus = "locked"; panel.setAttribute("role", "alert");
  const heading = document.createElement("h2");
  heading.textContent = state.error.status === 401 ? "项目身份已失效"
    : state.error.status === 410 ? "Room 访问已移除，项目缓存已锁定" : "项目权威服务不可用";
  const explanation = document.createElement("p"); explanation.textContent = state.error.code;
  const recovery = button(state.error.status === 401 ? "重新登录" : "重试", () => {
    if (state.error.status === 401) actions.onReauthenticate(); else actions.onRetry();
  });
  panel.append(heading, explanation, recovery); root.replaceChildren(panel);
}

export function renderProjectLoopSurface(root: HTMLElement, state: ProjectLoopRemoteState,
  actions: ProjectLoopSurfaceActions,
  options: Readonly<{ activeCategory?: ProjectLoopCategory; reducedMotion?: boolean }> = {}): void {
  if (state.status === "loading") {
    const loading = document.createElement("section"); loading.className = "project-loop project-loop--loading";
    loading.dataset.projectLoopStatus = "loading"; loading.setAttribute("role", "status");
    loading.textContent = "正在载入项目权威状态"; root.replaceChildren(loading); return;
  }
  if (state.status === "locked") { renderLocked(root, state, actions); return; }
  const vm = createProjectLoopViewModel(state);
  const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let activeCategory = options.activeCategory ?? "goals";
  const panel = document.createElement("section"); panel.className = "project-loop";
  panel.dataset.projectLoopStatus = state.connection.status; panel.dataset.reducedMotion = String(options.reducedMotion === true);
  panel.dataset.roomId = vm.roomId; panel.dataset.minimumViewport = "840x560"; panel.dataset.zoomContract = "100-200";
  panel.dataset.defaultViewport = "1440x900";
  panel.tabIndex = -1; panel.setAttribute("aria-label", "Project 项目事实");
  const header = document.createElement("header"); const heading = document.createElement("h2"); heading.textContent = "Project";
  const revision = document.createElement("p"); revision.className = "project-loop__revision";
  revision.textContent = `权威水位 ${vm.revision} · ${vm.capturedAt}`; header.append(heading, revision);
  const announcement = document.createElement("p"); announcement.className = "project-loop__announcement";
  announcement.setAttribute("aria-live", "polite");
  announcement.setAttribute("role", state.operation.status === "failed" ? "alert" : "status");
  announcement.textContent = vm.announcement;
  const tabs = document.createElement("div"); tabs.className = "project-loop__tabs";
  tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Project 分类");
  const content = document.createElement("section"); content.className = "project-loop__content";
  const sourceButton = (source: ProjectSourceRef): HTMLButtonElement => {
    const value = button(`查看来源 ${source.kind}:${source.sourceId} r${source.sourceRevision}`,
      () => actions.onOpenSource(source)); value.className = "project-loop__source"; return value;
  };
  const renderRequest = (list: HTMLUListElement, request: ProjectRequest): void => {
    const item = document.createElement("li"); item.dataset.projectFactKind = request.kind;
    const summary = document.createElement("p");
    summary.textContent = `${request.title} · ${request.status} · requester ${request.requester.actorId} → target ${request.target.actorId}`;
    const authority = document.createElement("p"); authority.textContent = request.status === "pending_acceptance"
      ? "PENDING_ACCEPTANCE · 接受前不形成目标 Human 的责任" : `CONFIRMED FACT · ${request.status}`;
    item.append(summary, authority, sourceButton(request.provenance.source));
    if (request.status === "pending_acceptance") {
      if (request.target.actorId === state.viewerActorId) {
        item.append(button("接受请求", () => actions.onIntent({ kind: "request.transition",
          intentId: `accept:${request.requestId}:${request.revision}`, factId: request.requestId,
          expectedRevision: request.revision, action: "accept" }), vm.mutationDisabled));
        item.append(button("拒绝请求", () => actions.onIntent({ kind: "request.transition",
          intentId: `reject:${request.requestId}:${request.revision}`, factId: request.requestId,
          expectedRevision: request.revision, action: "reject", reason: "Rejected by target Human from Desktop" }),
        vm.mutationDisabled));
        const label = document.createElement("label"); label.textContent = "转交给 Human actorId";
        const target = document.createElement("input"); target.type = "text"; target.autocomplete = "off";
        target.dataset.requestTransferTarget = request.requestId; label.append(target);
        item.append(label, button("提交转交", () => {
          const actorId = target.value.trim();
          if (actorId.length === 0) { target.setCustomValidity("请输入目标 Human actorId"); target.reportValidity(); return; }
          target.setCustomValidity(""); actions.onIntent({ kind: "request.transition",
            intentId: `transfer:${request.requestId}:${request.revision}:${actorId}`, factId: request.requestId,
            expectedRevision: request.revision, action: "transfer", target: { kind: "human", actorId },
            reason: "Transferred by target Human from Desktop" });
        }, vm.mutationDisabled));
      }
      if (request.requester.actorId === state.viewerActorId) item.append(button("取消请求", () => actions.onIntent({
        kind: "request.transition", intentId: `cancel:${request.requestId}:${request.revision}`,
        factId: request.requestId, expectedRevision: request.revision, action: "cancel",
        reason: "Cancelled by requester Human from Desktop",
      }), vm.mutationDisabled));
    }
    list.append(item);
  };
  const renderCategory = (): void => {
    content.replaceChildren(); content.dataset.category = activeCategory;
    content.id = `project-loop-${vm.roomId}-panel-${activeCategory}`; content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", `project-loop-${vm.roomId}-tab-${activeCategory}`);
    const title = document.createElement("h3"); title.textContent = LABELS[activeCategory]; content.append(title);
    const entries = activeCategory === "goals" ? vm.goals : activeCategory === "decisions" ? vm.decisions
      : activeCategory === "requests" ? vm.requests : activeCategory === "obstacles" ? vm.obstacles
        : activeCategory === "next_actions" ? vm.nextActions : vm.balls;
    if (entries.length === 0) { const empty = document.createElement("p"); empty.className = "project-loop__empty";
      empty.textContent = `暂无${LABELS[activeCategory]}事实`; content.append(empty); return; }
    const list = document.createElement("ul");
    for (const entry of entries) {
      if ("kind" in entry && entry.kind === "request") { renderRequest(list, entry); continue; }
      const item = document.createElement("li"); item.dataset.projectFactKind = "kind" in entry ? entry.kind : entry.sourceKind;
      const summary = document.createElement("p");
      if ("title" in entry) summary.textContent = `${entry.title} · ${entry.status}` +
        `${"owner" in entry ? ` · owner ${entry.owner.kind}:${entry.owner.actorId}` : ""}` +
        `${"verifier" in entry && entry.verifier !== null ? ` · verifier ${entry.verifier.actorId}` : ""}` +
        `${"dueAt" in entry && entry.dueAt !== null ? ` · 截止 ${entry.dueAt}` : ""}` +
        `${"reviewAt" in entry && entry.reviewAt !== null ? ` · 复核 ${entry.reviewAt}` : ""}`;
      else if ("statement" in entry) summary.textContent = `${entry.statement} · ${entry.status}`;
      else summary.textContent = `${entry.boundaryKind} · ${entry.reason} · ${entry.holder.kind}:${entry.holder.actorId}` +
        `${entry.dueAt === null ? "" : ` · 截止 ${entry.dueAt}`}${entry.reviewAt === null ? "" : ` · 复核 ${entry.reviewAt}`}`;
      item.append(summary); if ("provenance" in entry) item.append(sourceButton(entry.provenance.source)); list.append(item);
    }
    content.append(list);
  };
  for (const category of CATEGORIES) {
    const tab = button(LABELS[category], () => {
      activeCategory = category;
      for (const candidate of tabs.querySelectorAll<HTMLButtonElement>("button")) {
        const selected = candidate.dataset.category === category;
        candidate.setAttribute("aria-selected", String(selected)); candidate.tabIndex = selected ? 0 : -1;
      }
      renderCategory();
    });
    tab.dataset.category = category; tab.id = `project-loop-${vm.roomId}-tab-${category}`;
    tab.setAttribute("aria-controls", `project-loop-${vm.roomId}-panel-${category}`); tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(category === activeCategory)); tab.tabIndex = category === activeCategory ? 0 : -1;
    tabs.append(tab);
  }
  renderCategory();
  const proposals = document.createElement("section"); proposals.className = "project-loop__proposals";
  const proposalHeading = document.createElement("h3"); proposalHeading.textContent = "待具名 Human 确认"; proposals.append(proposalHeading);
  if (vm.confirmableProposals.length === 0) { const empty = document.createElement("p");
    empty.textContent = "没有由你确认的 proposal"; proposals.append(empty); }
  for (const proposal of vm.confirmableProposals) {
    const card = document.createElement("article"); card.dataset.proposalId = proposal.proposalId;
    card.dataset.authority = "proposal-not-fact"; const title = document.createElement("h4"); title.textContent = proposalTitle(proposal);
    const authority = document.createElement("p"); authority.textContent = "PROPOSAL · 尚不是权威事实";
    const confirm = button("确认成为项目事实", () => actions.onIntent({ kind: "proposal.resolve",
      intentId: `confirm:${proposal.proposalId}:${proposal.revision}`, proposalId: proposal.proposalId,
      expectedRevision: proposal.revision, resolution: "confirmed", reason: null }), vm.mutationDisabled);
    const reject = button("拒绝", () => actions.onIntent({ kind: "proposal.resolve",
      intentId: `reject:${proposal.proposalId}:${proposal.revision}`, proposalId: proposal.proposalId,
      expectedRevision: proposal.revision, resolution: "rejected", reason: "Rejected by named Human from Desktop" }),
    vm.mutationDisabled);
    card.append(title, authority, sourceButton(proposal.provenance.source), confirm, reject); proposals.append(card);
  }
  const transfers = document.createElement("section"); transfers.className = "project-loop__transfers";
  const transferHeading = document.createElement("h3"); transferHeading.textContent = "Ball 转交提案"; transfers.append(transferHeading);
  if (vm.transferProposals.length === 0) { const empty = document.createElement("p");
    empty.textContent = "暂无 Ball 转交提案"; transfers.append(empty); }
  for (const transfer of vm.transferProposals) { const item = document.createElement("p");
    item.dataset.transferProposalId = transfer.transferProposalId;
    item.textContent = `TRANSFER PROPOSAL · ${transfer.fromOwner.actorId} → ${transfer.toOwner.actorId} · ${transfer.status}`;
    transfers.append(item); }
  if (state.operation.status === "failed") {
    if (state.operation.error.status === 403) { const denied = document.createElement("p"); denied.dataset.projectRecovery = "403";
      denied.textContent = "权限不足；项目事实保持只读。如需操作，请联系 Room owner 调整权限。"; panel.append(denied); }
    else { const retry = button(state.operation.error.status === 409 ? "刷新后重试"
      : state.operation.error.status === 401 ? "重新登录" : state.operation.error.status === 410
        ? "Room 已归档；查看恢复路径" : "重试",
    state.operation.error.status === 401 ? actions.onReauthenticate : actions.onRetry);
      retry.dataset.projectRecovery = String(state.operation.error.status);
      if (state.operation.error.status === 429 && state.operation.error.retryAfterSeconds !== undefined) {
        retry.textContent = `${retry.textContent ?? "重试"}（${state.operation.error.retryAfterSeconds} 秒后）`;
      }
      panel.append(retry); }
  }
  panel.addEventListener("keydown", (event) => {
    if (event.metaKey && event.key === "1") { event.preventDefault(); actions.onNavigateSegment("timeline"); }
    else if (event.metaKey && event.key === "2") { event.preventDefault(); actions.onNavigateSegment("project"); }
    else if (event.metaKey && event.key === "3") { event.preventDefault(); actions.onNavigateSegment("members"); }
    else if (event.metaKey && event.key.toLowerCase() === "k") { event.preventDefault(); actions.onSearch(); }
    else if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault(); const current = CATEGORIES.indexOf(activeCategory); const delta = event.key === "ArrowUp" ? -1 : 1;
      activeCategory = CATEGORIES[(current + delta + CATEGORIES.length) % CATEGORIES.length]!;
      tabs.querySelector<HTMLButtonElement>(`button[data-category="${activeCategory}"]`)?.click();
    } else if (event.key === "Escape") { event.preventDefault();
      if (priorFocus?.isConnected) priorFocus.focus(); else tabs.querySelector<HTMLButtonElement>('button[aria-selected="true"]')?.focus(); }
  });
  tabs.addEventListener("keydown", (event) => {
    const values = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const focused = document.activeElement instanceof HTMLButtonElement ? values.indexOf(document.activeElement) : -1;
    if (focused < 0) return;
    const destination = event.key === "ArrowLeft" ? (focused - 1 + values.length) % values.length
      : event.key === "ArrowRight" ? (focused + 1) % values.length : event.key === "Home" ? 0
        : event.key === "End" ? values.length - 1 : -1;
    if (destination >= 0) { event.preventDefault(); values[destination]?.click(); values[destination]?.focus(); }
  });
  panel.append(header, announcement, tabs, content, proposals, transfers); root.replaceChildren(panel);
}
