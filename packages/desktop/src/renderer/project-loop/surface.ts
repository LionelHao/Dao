import type {
  ProjectBallFact,
  ProjectActorRef,
  ProjectCriterion,
  ProjectHumanRef,
  ProjectNextAction,
  ProjectObstacle,
  ProjectProposal,
  ProjectRequest,
  ProjectSourceRef,
  ProjectTransferProposal,
} from "@native-im/core";
import { createProjectLoopViewModel, type ProjectLoopCategory, type ProjectLoopRemoteState } from "./view-model.js";

export type ProjectLoopIntent =
  | Readonly<{ kind: "proposal.resolve"; intentId: string; proposalId: string; expectedRevision: number;
      resolution: "confirmed" | "rejected"; reason: string | null }>
  | Readonly<{ kind: "request.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "accept" }>
  | Readonly<{ kind: "request.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "reject" | "cancel"; reason: string }>
  | Readonly<{ kind: "request.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "transfer"; target: ProjectHumanRef; reason: string }>
  | Readonly<{ kind: "next_action.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "accept" | "start" }>
  | Readonly<{ kind: "next_action.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "complete"; completionNote: string; criteriaSnapshot: readonly ProjectCriterion[] }>
  | Readonly<{ kind: "next_action.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "reject" | "cancel" | "reopen"; reason: string }>
  | Readonly<{ kind: "next_action.transition"; intentId: string; factId: string; expectedRevision: number;
      action: "deliver"; source: ProjectSourceRef; summary: string }>
  | Readonly<{ kind: "obstacle.transition"; intentId: string; factId: string; expectedRevision: number;
      obstacleKind: "blocker" | "open_question"; action: "resolve"; resultSource: ProjectSourceRef; reason: string }>
  | Readonly<{ kind: "obstacle.transition"; intentId: string; factId: string; expectedRevision: number;
      obstacleKind: "blocker" | "open_question"; action: "defer"; reason: string; reviewAt: string }>
  | Readonly<{ kind: "obstacle.transition"; intentId: string; factId: string; expectedRevision: number;
      obstacleKind: "blocker" | "open_question"; action: "cannot_answer" | "reopen"; reason: string }>
  | Readonly<{ kind: "transfer.propose"; intentId: string; transferProposalId: string;
      subjectKind: "next_action" | "blocker" | "open_question"; subjectId: string; expectedRevision: number;
      toOwner: ProjectActorRef; reason: string }>
  | Readonly<{ kind: "transfer.resolve"; intentId: string; transferProposalId: string;
      subjectKind: "next_action" | "blocker" | "open_question"; subjectId: string; expectedRevision: number;
      resolution: "accepted" | "rejected"; reason: string | null }>;

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
const SURFACE_UI = new WeakMap<HTMLElement, {
  activeCategory: ProjectLoopCategory;
  escapeControlId?: string;
  externalFocus?: HTMLElement;
  drafts: Map<string, string>;
}>();
type DraftControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
function draftKey(control: DraftControl): string | undefined {
  const identity = Object.entries(control.dataset).sort(([left], [right]) => left.localeCompare(right));
  return identity.length === 0 ? undefined : `${control.tagName}:${JSON.stringify(identity)}`;
}
function button(text: string, action: () => void, disabled = false, controlId?: string): HTMLButtonElement {
  const value = document.createElement("button"); value.type = "button"; value.textContent = text;
  if (controlId !== undefined) value.dataset.projectControlId = controlId;
  value.disabled = disabled; value.addEventListener("click", action); return value;
}
function proposalTitle(proposal: ProjectProposal): string {
  return proposal.payload.kind === "decision" ? proposal.payload.statement : proposal.payload.title;
}
function requiredValue(input: HTMLInputElement, message: string): string | undefined {
  const value = input.value.trim();
  input.setCustomValidity(value.length === 0 ? message : "");
  if (value.length === 0) { input.reportValidity(); return undefined; }
  return value;
}
function currentTransferSubjectRevision(
  vm: ReturnType<typeof createProjectLoopViewModel>,
  transfer: ProjectTransferProposal,
): number | undefined {
  if (transfer.subjectKind === "next_action") {
    return vm.nextActions.find((item) => item.nextActionId === transfer.subjectId)?.revision;
  }
  return vm.obstacles.find((item) => item.obstacleId === transfer.subjectId &&
    item.kind === transfer.subjectKind)?.revision;
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
  const retained = SURFACE_UI.get(root) ?? {
    activeCategory: options.activeCategory ?? "goals", drafts: new Map<string, string>(),
  };
  if (state.operation.status === "acknowledged") retained.drafts.clear();
  else for (const control of root.querySelectorAll<DraftControl>("input, select, textarea")) {
    const key = draftKey(control);
    if (key !== undefined) retained.drafts.set(key, control.value);
  }
  if (priorFocus !== null && root.contains(priorFocus) && priorFocus.dataset.projectControlId !== undefined) {
    retained.escapeControlId = priorFocus.dataset.projectControlId;
  } else if (priorFocus !== null && priorFocus !== document.body && priorFocus !== document.documentElement &&
      !root.contains(priorFocus)) retained.externalFocus = priorFocus;
  let activeCategory = options.activeCategory ?? retained.activeCategory;
  retained.activeCategory = activeCategory; SURFACE_UI.set(root, retained);
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
  const sourceStatus = document.createElement("p"); sourceStatus.className = "project-loop__source-status";
  sourceStatus.setAttribute("role", "status"); sourceStatus.setAttribute("aria-live", "polite");
  const tabs = document.createElement("div"); tabs.className = "project-loop__tabs";
  tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Project 分类");
  const content = document.createElement("section"); content.className = "project-loop__content";
  const sourceButton = (source: ProjectSourceRef): HTMLButtonElement => {
    const value = button(`查看来源 ${source.kind}:${source.sourceId} r${source.sourceRevision}`,
      () => actions.onOpenSource(source), false,
      `source:${source.kind}:${source.sourceId}:r${source.sourceRevision}`);
    value.className = "project-loop__source"; return value;
  };
  const textInput = (parent: HTMLElement, labelText: string, dataKey: string,
    dataValue: string): HTMLInputElement => {
    const label = document.createElement("label"); label.textContent = labelText;
    const input = document.createElement("input"); input.type = "text"; input.autocomplete = "off";
    input.dataset[dataKey] = dataValue; label.append(input); parent.append(label); return input;
  };
  const sourceEditor = (parent: HTMLElement, namespace: "nextActionDelivery" | "obstacleResult",
    factId: string): (() => ProjectSourceRef | undefined) => {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend"); legend.textContent = "权威结果来源"; group.append(legend);
    const kindLabel = document.createElement("label"); kindLabel.textContent = "来源类型";
    const kind = document.createElement("select"); kind.dataset[`${namespace}SourceKind`] = factId;
    for (const sourceKind of ["message", "attachment", "agent_execution", "memory", "project_fact"] as const) {
      const option = document.createElement("option"); option.value = sourceKind; option.textContent = sourceKind;
      kind.append(option);
    }
    kindLabel.append(kind); group.append(kindLabel);
    const sourceId = textInput(group, "来源 ID", `${namespace}SourceId`, factId);
    const revisionLabel = document.createElement("label"); revisionLabel.textContent = "来源 revision";
    const sourceRevision = document.createElement("input"); sourceRevision.type = "number";
    sourceRevision.min = "1"; sourceRevision.step = "1"; sourceRevision.value = "1";
    sourceRevision.dataset[`${namespace}SourceRevision`] = factId;
    revisionLabel.append(sourceRevision); group.append(revisionLabel); parent.append(group);
    return () => {
      const id = requiredValue(sourceId, "请输入权威来源 ID");
      if (id === undefined) return undefined;
      const revision = Number(sourceRevision.value);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        sourceRevision.setCustomValidity("来源 revision 必须是正整数"); sourceRevision.reportValidity(); return undefined;
      }
      sourceRevision.setCustomValidity("");
      return { kind: kind.value as ProjectSourceRef["kind"], sourceId: id,
        sourceRevision: revision, roomId: vm.roomId, visibility: "room" };
    };
  };
  const transferComposer = (parent: HTMLElement, subjectKind: "next_action" | "blocker" | "open_question",
    subjectId: string, revision: number, prefix: "next-action" | "obstacle",
    agentPrincipalActorId: string | undefined): void => {
    const group = document.createElement("fieldset");
    group.setAttribute("aria-label", `Ball 转交；Agent 目标的 Human principal ${agentPrincipalActorId ?? "未指定"}`);
    const legend = document.createElement("legend"); legend.textContent = "Ball 转交"; group.append(legend);
    const principal = document.createElement("p");
    principal.textContent = agentPrincipalActorId === undefined
      ? "Agent 目标需要具名 Human principal；当前未指定，不能选择 Agent。"
      : `Agent 目标由具名 Human principal ${agentPrincipalActorId} 确认；Human 目标由目标本人确认。`;
    group.append(principal);
    const kindLabel = document.createElement("label"); kindLabel.textContent = "转交目标类型";
    const targetKind = document.createElement("select");
    targetKind.dataset.projectTransferTargetKind = subjectId;
    for (const candidate of ["human", "agent"] as const) {
      const option = document.createElement("option"); option.value = candidate;
      option.textContent = candidate === "human" ? "Human" : "Agent";
      option.disabled = candidate === "agent" && agentPrincipalActorId === undefined;
      targetKind.append(option);
    }
    kindLabel.append(targetKind); group.append(kindLabel);
    const target = textInput(group, "转交目标 actorId", "projectTransferTarget", subjectId);
    const reason = textInput(group, "转交原因", "projectTransferReason", subjectId);
    group.append(button("提交 Ball 转交提案", () => {
      const actorId = requiredValue(target, "请输入目标 actorId");
      const auditReason = requiredValue(reason, "请输入转交原因");
      if (actorId === undefined || auditReason === undefined) return;
      const transferProposalId = `transfer:${subjectKind}:${subjectId}:r${revision}:to:${actorId}`;
      actions.onIntent({ kind: "transfer.propose", intentId: `propose:${transferProposalId}`,
        transferProposalId, subjectKind, subjectId, expectedRevision: revision,
        toOwner: { kind: targetKind.value as ProjectActorRef["kind"], actorId }, reason: auditReason });
    }, vm.mutationDisabled, `${prefix}:${subjectId}:transfer`));
    parent.append(group);
  };
  const renderNextActionControls = (item: HTMLLIElement, fact: ProjectNextAction): void => {
    const owner = fact.owner.kind === "human" && fact.owner.actorId === state.viewerActorId;
    const verifier = fact.verifier?.actorId === state.viewerActorId;
    const humanAuthority = owner || fact.owner.kind === "agent" && verifier;
    const reason = humanAuthority || verifier
      ? textInput(item, "操作原因（拒绝、取消或重开时必填）", "nextActionReason", fact.nextActionId)
      : undefined;
    const reasonIntent = (action: "reject" | "cancel" | "reopen"): void => {
      if (reason === undefined) return;
      const value = requiredValue(reason, "请输入操作原因"); if (value === undefined) return;
      actions.onIntent({ kind: "next_action.transition",
        intentId: `${action}:${fact.nextActionId}:${fact.revision}`, factId: fact.nextActionId,
        expectedRevision: fact.revision, action, reason: value });
    };
    if (fact.status === "proposed" && humanAuthority) {
      item.append(button("接受下一步", () => actions.onIntent({ kind: "next_action.transition",
        intentId: `accept:${fact.nextActionId}:${fact.revision}`, factId: fact.nextActionId,
        expectedRevision: fact.revision, action: "accept" }), vm.mutationDisabled,
      `next-action:${fact.nextActionId}:accept`));
      item.append(button("拒绝下一步", () => reasonIntent("reject"), vm.mutationDisabled,
        `next-action:${fact.nextActionId}:reject`));
    }
    if (fact.status === "accepted" && owner) item.append(button("开始执行", () => actions.onIntent({
      kind: "next_action.transition", intentId: `start:${fact.nextActionId}:${fact.revision}`,
      factId: fact.nextActionId, expectedRevision: fact.revision, action: "start",
    }), vm.mutationDisabled, `next-action:${fact.nextActionId}:start`));
    const canComplete = fact.status === "in_progress" && owner && fact.verifier === null ||
      fact.status === "delivered" && verifier;
    if (canComplete) {
      const completionNote = textInput(item, "完成说明", "nextActionCompletionNote", fact.nextActionId);
      item.append(button("确认完成", () => {
        const note = requiredValue(completionNote, "请输入完成说明"); if (note === undefined) return;
        actions.onIntent({ kind: "next_action.transition",
          intentId: `complete:${fact.nextActionId}:${fact.revision}`, factId: fact.nextActionId,
          expectedRevision: fact.revision, action: "complete", completionNote: note,
          criteriaSnapshot: fact.acceptanceCriteria });
      }, vm.mutationDisabled, `next-action:${fact.nextActionId}:complete`));
    }
    if (fact.status === "in_progress" && owner && fact.verifier !== null) {
      const readSource = sourceEditor(item, "nextActionDelivery", fact.nextActionId);
      const summary = textInput(item, "交付摘要", "nextActionDeliverySummary", fact.nextActionId);
      item.append(button("提交交付", () => {
        const source = readSource(); const value = requiredValue(summary, "请输入交付摘要");
        if (source === undefined || value === undefined) return;
        actions.onIntent({ kind: "next_action.transition",
          intentId: `deliver:${fact.nextActionId}:${fact.revision}`, factId: fact.nextActionId,
          expectedRevision: fact.revision, action: "deliver", source, summary: value });
      }, vm.mutationDisabled, `next-action:${fact.nextActionId}:deliver`));
    }
    if (fact.status === "delivered" && verifier || fact.status === "done" && (owner || verifier)) {
      item.append(button("打回并重开", () => reasonIntent("reopen"), vm.mutationDisabled,
        `next-action:${fact.nextActionId}:reopen`));
    }
    if (humanAuthority && ["proposed", "accepted", "in_progress", "delivered"].includes(fact.status)) {
      item.append(button("取消下一步", () => reasonIntent("cancel"), vm.mutationDisabled,
        `next-action:${fact.nextActionId}:cancel`));
    }
    if (humanAuthority && ["accepted", "in_progress", "delivered"].includes(fact.status)) {
      transferComposer(item, "next_action", fact.nextActionId, fact.revision, "next-action",
        fact.verifier?.actorId);
    }
  };
  const renderObstacleControls = (item: HTMLLIElement, obstacle: ProjectObstacle): void => {
    if (obstacle.owner.kind !== "human" || obstacle.owner.actorId !== state.viewerActorId ||
        obstacle.status === "resolved") return;
    if (obstacle.status === "deferred" || obstacle.status === "cannot_answer") {
      const reopenReason = textInput(item, "重开原因", "obstacleReopenReason", obstacle.obstacleId);
      item.append(button(obstacle.kind === "blocker" ? "重开阻塞" : "重开问题", () => {
        const reason = requiredValue(reopenReason, "请输入重开原因"); if (reason === undefined) return;
        actions.onIntent({ kind: "obstacle.transition",
          intentId: `reopen:${obstacle.obstacleId}:${obstacle.revision}`, factId: obstacle.obstacleId,
          expectedRevision: obstacle.revision, obstacleKind: obstacle.kind, action: "reopen", reason });
      }, vm.mutationDisabled, `obstacle:${obstacle.obstacleId}:reopen`));
    }
    if (obstacle.status === "open" || obstacle.status === "cannot_answer") {
      const readSource = sourceEditor(item, "obstacleResult", obstacle.obstacleId);
      const reason = textInput(item, "处理原因", "obstacleReason", obstacle.obstacleId);
      item.append(button("以来源闭合", () => {
        const resultSource = readSource(); const value = requiredValue(reason, "请输入闭合原因");
        if (resultSource === undefined || value === undefined) return;
        actions.onIntent({ kind: "obstacle.transition",
          intentId: `resolve:${obstacle.obstacleId}:${obstacle.revision}`, factId: obstacle.obstacleId,
          expectedRevision: obstacle.revision, obstacleKind: obstacle.kind, action: "resolve",
          resultSource, reason: value });
      }, vm.mutationDisabled, `obstacle:${obstacle.obstacleId}:resolve`));
      if (obstacle.status === "open") {
        const reviewAt = textInput(item, "延期复核时间（ISO 8601）", "obstacleReviewAt", obstacle.obstacleId);
        item.append(button("延期复核", () => {
          const value = requiredValue(reason, "请输入延期原因");
          const timestamp = requiredValue(reviewAt, "请输入 ISO 8601 复核时间");
          if (value === undefined || timestamp === undefined) return;
          if (!Number.isFinite(Date.parse(timestamp)) || new Date(Date.parse(timestamp)).toISOString() !== timestamp) {
            reviewAt.setCustomValidity("请输入规范的 ISO 8601 时间"); reviewAt.reportValidity(); return;
          }
          reviewAt.setCustomValidity(""); actions.onIntent({ kind: "obstacle.transition",
            intentId: `defer:${obstacle.obstacleId}:${obstacle.revision}`, factId: obstacle.obstacleId,
            expectedRevision: obstacle.revision, obstacleKind: obstacle.kind, action: "defer",
            reason: value, reviewAt: timestamp });
        }, vm.mutationDisabled, `obstacle:${obstacle.obstacleId}:defer`));
        item.append(button("标记无法回答", () => {
          const value = requiredValue(reason, "请输入无法回答的原因"); if (value === undefined) return;
          actions.onIntent({ kind: "obstacle.transition",
            intentId: `cannot-answer:${obstacle.obstacleId}:${obstacle.revision}`, factId: obstacle.obstacleId,
            expectedRevision: obstacle.revision, obstacleKind: obstacle.kind,
            action: "cannot_answer", reason: value });
        }, vm.mutationDisabled, `obstacle:${obstacle.obstacleId}:cannot-answer`));
      }
    }
    transferComposer(item, obstacle.kind, obstacle.obstacleId, obstacle.revision, "obstacle",
      state.viewerActorId);
  };
  const renderRequest = (list: HTMLUListElement, request: ProjectRequest): void => {
    const item = document.createElement("li"); item.dataset.projectFactKind = request.kind;
    item.dataset.sourceId = request.requestId; item.dataset.sourceKind = "project_fact";
    item.dataset.sourceRevision = String(request.revision);
    const summary = document.createElement("p");
    summary.textContent = `${request.title} · ${request.status} · r${request.revision} · requester ${request.requester.actorId} → target ${request.target.actorId}`;
    const authority = document.createElement("p"); authority.textContent = request.status === "pending_acceptance"
      ? "PENDING_ACCEPTANCE · 接受前不形成目标 Human 的责任" : `CONFIRMED FACT · ${request.status}`;
    item.append(summary, authority, sourceButton(request.provenance.source));
    if (request.status === "pending_acceptance") {
      if (request.target.actorId === state.viewerActorId) {
        item.append(button("接受请求", () => actions.onIntent({ kind: "request.transition",
          intentId: `accept:${request.requestId}:${request.revision}`, factId: request.requestId,
          expectedRevision: request.revision, action: "accept" }), vm.mutationDisabled,
        `request:${request.requestId}:accept`));
        item.append(button("拒绝请求", () => actions.onIntent({ kind: "request.transition",
          intentId: `reject:${request.requestId}:${request.revision}`, factId: request.requestId,
          expectedRevision: request.revision, action: "reject", reason: "Rejected by target Human from Desktop" }),
        vm.mutationDisabled, `request:${request.requestId}:reject`));
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
        }, vm.mutationDisabled, `request:${request.requestId}:transfer`));
      }
      if (request.requester.actorId === state.viewerActorId) item.append(button("取消请求", () => actions.onIntent({
        kind: "request.transition", intentId: `cancel:${request.requestId}:${request.revision}`,
        factId: request.requestId, expectedRevision: request.revision, action: "cancel",
        reason: "Cancelled by requester Human from Desktop",
      }), vm.mutationDisabled, `request:${request.requestId}:cancel`));
    }
    list.append(item);
  };
  const renderBallList = (parent: HTMLElement, values: readonly ProjectBallFact[], emptyText: string): void => {
    if (values.length === 0) {
      const empty = document.createElement("p"); empty.className = "project-loop__empty";
      empty.textContent = emptyText; parent.append(empty); return;
    }
    const list = document.createElement("ul");
    for (const ball of values) {
      const item = document.createElement("li"); item.dataset.projectFactKind = "ball";
      item.dataset.sourceKind = ball.sourceKind; item.dataset.sourceId = ball.sourceId;
      item.dataset.sourceRevision = String(ball.sourceRevision);
      item.textContent = `${ball.boundaryKind} · boundary ${ball.boundaryId} · ${ball.reason}` +
        ` · holder ${ball.holder.kind}:${ball.holder.actorId}` +
        ` · source ${ball.sourceKind}:${ball.sourceId} r${ball.sourceRevision}` +
        `${ball.dueAt === null ? "" : ` · 截止 ${ball.dueAt}`}` +
        `${ball.reviewAt === null ? "" : ` · 复核 ${ball.reviewAt}`}`;
      item.append(sourceButton({ kind: "project_fact", sourceId: ball.sourceId,
        sourceRevision: ball.sourceRevision, roomId: ball.roomId, visibility: "room" }));
      list.append(item);
    }
    parent.append(list);
  };
  const renderCategory = (): void => {
    content.replaceChildren(); content.dataset.category = activeCategory;
    content.id = `project-loop-${vm.roomId}-panel-${activeCategory}`; content.setAttribute("role", "tabpanel");
    content.setAttribute("aria-labelledby", `project-loop-${vm.roomId}-tab-${activeCategory}`);
    const title = document.createElement("h3"); title.textContent = LABELS[activeCategory]; content.append(title);
    if (activeCategory === "ball") {
      const needsAction = document.createElement("section"); needsAction.dataset.projectNeedsAction = "viewer";
      needsAction.setAttribute("aria-label", `NeedsAction：${state.viewerActorId}`);
      const needsHeading = document.createElement("h4"); needsHeading.textContent = "NeedsAction（仅当前 Human）";
      needsAction.append(needsHeading); renderBallList(needsAction, vm.needsActions, "当前没有待你处理的 Ball");
      const ownership = document.createElement("section"); ownership.dataset.projectBallOwnership = "room";
      ownership.setAttribute("aria-label", "Room 全部 Ball 归属与来源");
      const ownershipHeading = document.createElement("h4"); ownershipHeading.textContent = "Room Ball 全部归属";
      ownership.append(ownershipHeading); renderBallList(ownership, vm.balls, "Room 当前没有 Ball");
      content.append(needsAction, ownership); return;
    }
    const entries = activeCategory === "goals" ? vm.goals : activeCategory === "decisions" ? vm.decisions
      : activeCategory === "requests" ? vm.requests : activeCategory === "obstacles" ? vm.obstacles
        : vm.nextActions;
    if (entries.length === 0) { const empty = document.createElement("p"); empty.className = "project-loop__empty";
      empty.textContent = `暂无${LABELS[activeCategory]}事实`; content.append(empty); return; }
    const list = document.createElement("ul");
    for (const entry of entries) {
      if ("kind" in entry && entry.kind === "request") { renderRequest(list, entry); continue; }
      const item = document.createElement("li"); item.dataset.projectFactKind = entry.kind;
      item.dataset.sourceKind = "project_fact"; item.dataset.sourceRevision = String(entry.revision);
      item.dataset.sourceId = entry.kind === "goal" ? entry.goalId : entry.kind === "decision" ? entry.decisionId
        : entry.kind === "next_action" ? entry.nextActionId : entry.obstacleId;
      const summary = document.createElement("p");
      if ("kind" in entry && (entry.kind === "blocker" || entry.kind === "open_question")) {
        const kindLabel = document.createElement("strong"); kindLabel.className = "project-loop__obstacle-kind";
        kindLabel.dataset.projectObstacleKind = entry.kind;
        kindLabel.setAttribute("aria-label", entry.kind === "blocker" ? "类型：阻塞 Blocker" : "类型：待解问题 Open Question");
        kindLabel.textContent = entry.kind === "blocker" ? "BLOCKER（阻塞）" : "OPEN QUESTION（待解问题）";
        item.append(kindLabel);
      }
      if ("title" in entry) summary.textContent = `${entry.title} · ${entry.status} · r${entry.revision}` +
        `${"owner" in entry ? ` · owner ${entry.owner.kind}:${entry.owner.actorId}` : ""}` +
        `${"verifier" in entry && entry.verifier !== null ? ` · verifier ${entry.verifier.actorId}` : ""}` +
        `${"dueAt" in entry && entry.dueAt !== null ? ` · 截止 ${entry.dueAt}` : ""}` +
        `${"reviewAt" in entry && entry.reviewAt !== null ? ` · 复核 ${entry.reviewAt}` : ""}`;
      else if ("statement" in entry) summary.textContent = `${entry.statement} · ${entry.status} · r${entry.revision}`;
      item.append(summary);
      if ("kind" in entry && (entry.kind === "goal" || entry.kind === "decision")) {
        const audit = document.createElement("p"); audit.className = "project-loop__fact-audit";
        const supersedes = entry.kind === "goal" ? entry.supersedesGoalId : entry.supersedesDecisionId;
        const supersededBy = entry.kind === "goal" ? entry.supersededByGoalId : entry.supersededByDecisionId;
        audit.textContent = [
          entry.confirmedBy === null ? null : `confirmed by ${entry.confirmedBy.actorId} at ${entry.confirmedAt}`,
          entry.rejectedBy === null ? null : `rejected by ${entry.rejectedBy.actorId} at ${entry.rejectedAt}: ${entry.rejectionReason}`,
          supersedes === null ? null : `supersedes ${supersedes}: ${entry.supersedeReason}`,
          supersededBy === null ? null : `superseded by ${supersededBy}: ${entry.supersedeReason}`,
          entry.kind === "decision" && entry.affectedFactIds.length > 0
            ? `affected facts ${entry.affectedFactIds.join(", ")}` : null,
        ].filter((value): value is string => value !== null).join(" · ") || "尚无具名确认或替代审计";
        item.append(audit);
      }
      if ("provenance" in entry) item.append(sourceButton(entry.provenance.source));
      if ("kind" in entry && entry.kind === "next_action") renderNextActionControls(item, entry);
      if ("kind" in entry && (entry.kind === "blocker" || entry.kind === "open_question")) {
        renderObstacleControls(item, entry);
      }
      list.append(item);
    }
    content.append(list);
  };
  for (const category of CATEGORIES) {
    const tab = button(LABELS[category], () => {
      activeCategory = category;
      retained.activeCategory = category;
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
  const proposalHeading = document.createElement("h3"); proposalHeading.textContent = "Proposal 与具名确认"; proposals.append(proposalHeading);
  if (vm.proposals.length === 0) { const empty = document.createElement("p");
    empty.textContent = "暂无 proposal"; proposals.append(empty); }
  for (const proposal of vm.proposals) {
    const card = document.createElement("article"); card.dataset.proposalId = proposal.proposalId;
    card.dataset.authority = "proposal-not-fact"; const title = document.createElement("h4"); title.textContent = proposalTitle(proposal);
    const authority = document.createElement("p"); authority.textContent =
      `PROPOSAL · 尚不是权威事实 · ${proposal.state} · principal ${proposal.principalActorId} · expires ${proposal.expiresAt}` +
      ` · revision r${proposal.revision} · base ${proposal.baseRevision === null ? "new" : `r${proposal.baseRevision}`}` +
      `${proposal.resolvedAt === null ? "" : ` · resolved ${proposal.resolvedAt}`}` +
      `${proposal.resolutionReason === null ? "" : ` · ${proposal.resolutionReason}`}`;
    card.append(title, authority, sourceButton(proposal.provenance.source));
    if (proposal.state === "pending" && proposal.principalActorId === state.viewerActorId) {
      card.append(button("确认成为项目事实", () => actions.onIntent({ kind: "proposal.resolve",
        intentId: `confirm:${proposal.proposalId}:${proposal.revision}`, proposalId: proposal.proposalId,
        expectedRevision: proposal.revision, resolution: "confirmed", reason: null }), vm.mutationDisabled,
      `proposal:${proposal.proposalId}:confirm`));
      card.append(button("拒绝", () => actions.onIntent({ kind: "proposal.resolve",
        intentId: `reject:${proposal.proposalId}:${proposal.revision}`, proposalId: proposal.proposalId,
        expectedRevision: proposal.revision, resolution: "rejected", reason: "Rejected by named Human from Desktop" }),
      vm.mutationDisabled, `proposal:${proposal.proposalId}:reject`));
    }
    proposals.append(card);
  }
  const confirmations = document.createElement("section"); confirmations.className = "project-loop__confirmations";
  const confirmationHeading = document.createElement("h3"); confirmationHeading.textContent = "Confirmation 审计";
  confirmations.append(confirmationHeading);
  if (vm.confirmations.length === 0) { const empty = document.createElement("p"); empty.textContent = "暂无 confirmation";
    confirmations.append(empty); }
  for (const confirmation of vm.confirmations) {
    const card = document.createElement("article"); card.dataset.confirmationId = confirmation.confirmationId;
    card.textContent = `CONFIRMATION · ${confirmation.state} · principal ${confirmation.principalActorId}` +
      `${confirmation.resolvedBy === null ? "" : ` · resolved by ${confirmation.resolvedBy.actorId}`}` +
      `${confirmation.resolvedAt === null ? "" : ` at ${confirmation.resolvedAt}`}` +
      `${confirmation.resolutionReason === null ? "" : ` · ${confirmation.resolutionReason}`}` +
      ` · revision r${confirmation.revision} · base ${confirmation.baseRevision === null ? "new" : `r${confirmation.baseRevision}`}` +
      ` · digest ${confirmation.payloadDigest}`;
    confirmations.append(card);
  }
  const transfers = document.createElement("section"); transfers.className = "project-loop__transfers";
  const transferHeading = document.createElement("h3"); transferHeading.textContent = "Ball 转交提案"; transfers.append(transferHeading);
  if (vm.transferProposals.length === 0) { const empty = document.createElement("p");
    empty.textContent = "暂无 Ball 转交提案"; transfers.append(empty); }
  for (const transfer of vm.transferProposals) { const item = document.createElement("article");
    item.dataset.transferProposalId = transfer.transferProposalId;
    const subjectRevision = currentTransferSubjectRevision(vm, transfer);
    const currentSubject = subjectRevision === transfer.subjectRevision;
    item.dataset.transferAuthority = currentSubject ? "current-subject" : "stale-subject";
    const summary = document.createElement("p");
    summary.textContent = `TRANSFER PROPOSAL · ${transfer.subjectKind}:${transfer.subjectId}` +
      ` · ${transfer.fromOwner.kind}:${transfer.fromOwner.actorId} → ${transfer.toOwner.kind}:${transfer.toOwner.actorId}` +
      ` · ${transfer.status} · revision r${transfer.revision}`;
    item.append(summary);
    if (transfer.status === "pending" && !currentSubject) {
      item.setAttribute("aria-disabled", "true");
      const stale = document.createElement("p"); stale.dataset.projectTransferStale = "true";
      stale.setAttribute("role", "status"); stale.setAttribute("aria-live", "polite");
      stale.textContent = `只读：绑定的责任版本已变化（提案绑定 r${transfer.subjectRevision}` +
        `，当前 ${subjectRevision === undefined ? "不可用" : `r${subjectRevision}`}）；接受与拒绝已禁用。`;
      item.append(stale);
    } else if (transfer.status === "pending" && transfer.principalActorId === state.viewerActorId &&
        subjectRevision !== undefined) {
      const rejectReason = textInput(item, "拒绝转交原因", "transferRejectReason", transfer.transferProposalId);
      item.append(button("接受 Ball 转交", () => actions.onIntent({ kind: "transfer.resolve",
        intentId: `accept:${transfer.transferProposalId}:${transfer.revision}`,
        transferProposalId: transfer.transferProposalId, subjectKind: transfer.subjectKind,
        subjectId: transfer.subjectId, expectedRevision: subjectRevision,
        resolution: "accepted", reason: null }), vm.mutationDisabled,
      `transfer:${transfer.transferProposalId}:accept`));
      item.append(button("拒绝 Ball 转交", () => {
        const reason = requiredValue(rejectReason, "请输入拒绝原因"); if (reason === undefined) return;
        actions.onIntent({ kind: "transfer.resolve",
          intentId: `reject:${transfer.transferProposalId}:${transfer.revision}`,
          transferProposalId: transfer.transferProposalId, subjectKind: transfer.subjectKind,
          subjectId: transfer.subjectId, expectedRevision: subjectRevision,
          resolution: "rejected", reason });
      }, vm.mutationDisabled, `transfer:${transfer.transferProposalId}:reject`));
    }
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
      const replacement = retained.escapeControlId === undefined ? null
        : [...panel.querySelectorAll<HTMLButtonElement>("[data-project-control-id]")]
          .find((candidate) => candidate.dataset.projectControlId === retained.escapeControlId && !candidate.disabled) ?? null;
      if (replacement !== null) replacement.focus();
      else if (retained.externalFocus?.isConnected && retained.externalFocus !== document.body &&
          retained.externalFocus !== document.documentElement) retained.externalFocus.focus();
      else tabs.querySelector<HTMLButtonElement>('button[aria-selected="true"]')?.focus(); }
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
  panel.append(header, announcement, sourceStatus, tabs, content, proposals, confirmations, transfers);
  for (const control of panel.querySelectorAll<DraftControl>("input, select, textarea")) {
    const key = draftKey(control); const draft = key === undefined ? undefined : retained.drafts.get(key);
    if (draft !== undefined) control.value = draft;
  }
  root.replaceChildren(panel);
  if (priorFocus !== null && root !== priorFocus && root.contains(panel)) {
    const replacement = retained.escapeControlId === undefined ? null
      : [...panel.querySelectorAll<HTMLElement>("[data-project-control-id]")]
        .find((candidate) => candidate.dataset.projectControlId === retained.escapeControlId &&
          (!(candidate instanceof HTMLButtonElement) || !candidate.disabled)) ?? null;
    if (replacement !== null) replacement.focus();
    else if (root.contains(priorFocus) || !priorFocus.isConnected) {
      tabs.querySelector<HTMLButtonElement>('button[aria-selected="true"]')?.focus();
    }
  }
}
