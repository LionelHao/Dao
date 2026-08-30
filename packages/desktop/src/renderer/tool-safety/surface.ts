export type ToolSafetyConnection =
  | { readonly status: "online" }
  | { readonly status: "offline" }
  | { readonly status: "archived" }
  | { readonly status: "repairing" }
  | { readonly status: "repair-failed"; readonly errorCode: string }
  | { readonly status: "revoked" };

export type ToolSafetyCardState =
  | "pending"
  | "rejected"
  | "duplicate"
  | "params-changed"
  | "principal-revoked"
  | "confirmed"
  | "grant-revoked"
  | "dispatched"
  | "known-succeeded"
  | "known-failed"
  | "outcome-unknown"
  | "compensation-proposed"
  | "compensation-pending"
  | "compensation-confirmed"
  | "compensation-dispatched"
  | "compensation-known-succeeded"
  | "compensation-known-failed"
  | "compensation-outcome-unknown"
  | "reviewed"
  | "expired";

export interface ToolSafetyCardProjection {
  readonly confirmationId: string;
  readonly dispatchId?: string;
  readonly version: number;
  readonly state: ToolSafetyCardState;
  readonly toolId: string;
  readonly safeTarget: string;
  readonly parameterSummary: string;
  readonly impact: string;
  readonly reversibility: "none" | "compensatable" | "unknown";
  readonly expiresAt: string;
  readonly sourceRef: string;
  readonly reasonCode?: string;
  readonly namedHumanDisplayRef?: string;
  readonly reviewResolution?: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
  readonly evidenceSummary?: string;
  readonly handoffTargetActorId?: string;
  readonly handoffCandidates?: readonly Readonly<{ actorId: string; displayRef: string }>[];
  readonly handoffId?: string;
  readonly handoffVersion?: number;
  readonly compensationKnownSucceeded?: boolean;
}

export type ToolSafetySurfaceOperation =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly requestId: string; readonly action: ToolSafetyAction }
  | { readonly status: "acknowledged"; readonly requestId: string; readonly action: ToolSafetyAction }
  | { readonly status: "error"; readonly requestId: string; readonly action: ToolSafetyAction;
      readonly statusCode: 401 | 403 | 409 | 410 | 429 | 503; readonly code: string;
      readonly retryAfterSeconds?: number; readonly retainedEvidenceSummary?: string };

export type ToolSafetyAction = "confirm" | "reject" | "handoff-offer" | "handoff-accept" |
  "review" | "compensate";

export type ToolSafetySurfaceCommand =
  | Readonly<{ type: "tool.confirmation.decide"; confirmationId: string;
      expectedVersion: number; decision: "confirm" | "reject" }>
  | Readonly<{ type: "tool.confirmation.handoff.offer"; confirmationId: string;
      expectedVersion: number; targetActorId: string }>
  | Readonly<{ type: "tool.confirmation.handoff.accept"; handoffId: string;
      expectedVersion: number }>
  | Readonly<{ type: "tool.outcome.review"; dispatchId: string; expectedVersion: number;
      resolution: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
      evidenceSummary: string }>
  | Readonly<{ type: "tool.compensation.propose"; dispatchId: string; expectedVersion: number }>;

export interface ToolSafetySurfaceState {
  readonly connection: ToolSafetyConnection;
  readonly card: ToolSafetyCardProjection;
  readonly operation: ToolSafetySurfaceOperation;
  readonly focusStateHeading?: boolean;
  readonly focusRecoveryAction?: boolean;
  readonly reviewDraft?: Readonly<{ evidenceSummary: string; focusEvidence?: boolean }>;
}

export interface ToolSafetySurfaceActions {
  submit(command: ToolSafetySurfaceCommand): void;
  repair(): void;
  reauthenticate(): void;
  newInvocation(): void;
  openSource(sourceRef: string): void;
}

const STATE_LABELS: Readonly<Record<ToolSafetyCardState, string>> = {
  pending: "等待精确 Human 确认",
  rejected: "已拒绝 · 未执行",
  duplicate: "已由另一 session 处理",
  "params-changed": "参数已变化 · 旧确认失效",
  "principal-revoked": "确认主体已撤销",
  confirmed: "Human 决定已记录 · 尚未执行",
  "grant-revoked": "授权已撤销 · 未执行",
  dispatched: "已越过 dispatch 安全分界",
  "known-succeeded": "工具结果已知成功",
  "known-failed": "工具结果已知失败",
  "outcome-unknown": "OUTCOME UNKNOWN · 需要 Human 审查",
  "compensation-proposed": "新的补偿动作已提出",
  "compensation-pending": "新的补偿动作等待精确 Human 确认",
  "compensation-confirmed": "补偿确认已记录 · 尚未执行",
  "compensation-dispatched": "补偿动作已越过 dispatch 安全分界",
  "compensation-known-succeeded": "补偿动作结果已知成功",
  "compensation-known-failed": "补偿动作结果已知失败",
  "compensation-outcome-unknown": "补偿动作 OUTCOME UNKNOWN · 需要 Human 审查",
  reviewed: "审查已闭合",
  expired: "已过期 · 未执行",
};

function appendText(parent: HTMLElement, tag: "p" | "div", value: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

function actionButton(label: string, action: ToolSafetyAction, disabled: boolean, invoke: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.toolSafetyAction = action;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", invoke);
  return button;
}

function recoveryFor(operation: Extract<ToolSafetySurfaceOperation, { status: "error" }>): string {
  switch (operation.statusCode) {
    case 401: return "重新认证后创建新确认；旧绑定不会自动重发";
    case 403: return "当前权限或主体已失效；刷新权威对象";
    case 409: return "对象版本已变化；载入最新 projection";
    case 410: return "确认、授权或来源已失效；创建新 invocation";
    case 429: return `服务限流；保留审查输入${operation.retryAfterSeconds === undefined ? "" : ` · ${operation.retryAfterSeconds}s 后可手动重试`}`;
    case 503: return "服务暂不可用；保留旧完整 projection 与输入";
  }
}

/** J-05 live projection renderer. It never derives preview or success from a local command. */
export function renderToolSafetySurface(
  root: HTMLElement,
  state: ToolSafetySurfaceState,
  actions: ToolSafetySurfaceActions,
): void {
  const section = document.createElement("section");
  section.className = "dao-tool-safety";
  section.dataset.toolSafetyState = state.card.state;
  section.setAttribute("aria-label", "Agent 工具安全确认与结果");

  const heading = document.createElement("h2");
  heading.tabIndex = -1;
  heading.dataset.toolSafetyStateHeading = "true";
  heading.textContent = STATE_LABELS[state.card.state];
  section.append(heading);

  const details = document.createElement("details");
  details.open = true;
  details.className = "tool-safety-details";
  details.setAttribute("aria-live", "off");
  const detailSummary = document.createElement("summary");
  detailSummary.textContent = "工具调用详情";
  details.append(detailSummary);
  details.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !details.open) return;
    event.preventDefault();
    event.stopPropagation();
    details.open = false;
    detailSummary.focus();
  });
  const redactPreview = state.card.state === "principal-revoked" || state.connection.status === "revoked";
  if (redactPreview) {
    appendText(details, "p", "敏感预览已移除；重新认证后只载入当前权威 projection");
  } else {
    appendText(details, "p", `工具：${state.card.toolId}`);
    appendText(details, "p", `安全目标：${state.card.safeTarget}`);
    appendText(details, "p", `参数摘要：${state.card.parameterSummary}`);
    appendText(details, "p", `影响：${state.card.impact}`);
    appendText(details, "p", `可逆性：${state.card.reversibility}`);
    appendText(details, "p", `过期：${state.card.expiresAt}`);
    const source = document.createElement("button");
    source.type = "button";
    source.dataset.toolSafetySource = state.card.sourceRef;
    source.textContent = "查看来源";
    source.setAttribute("aria-label", `查看工具调用来源 ${state.card.sourceRef}`);
    source.addEventListener("click", () => actions.openSource(state.card.sourceRef));
    const sourceRow = appendText(details, "p", `来源：${state.card.sourceRef} · `);
    sourceRow.append(source);
  }
  if (state.card.reasonCode !== undefined) appendText(details, "p", `原因：${state.card.reasonCode}`);
  if (state.card.namedHumanDisplayRef !== undefined) {
    appendText(details, "p", `具名 Human：${state.card.namedHumanDisplayRef}`);
  }
  if (state.card.reviewResolution !== undefined) {
    appendText(details, "p", `审查结论：${state.card.reviewResolution}`);
  }
  if (state.card.evidenceSummary !== undefined) {
    appendText(details, "p", `证据摘要：${state.card.evidenceSummary}`);
  }
  section.append(details);

  const connectionLocked = state.connection.status !== "online";
  const operationLocked = state.operation.status === "submitting" ||
    state.operation.status === "acknowledged";
  const controls = document.createElement("div");
  controls.className = "tool-safety-actions";

  if (state.card.state === "pending" || state.card.state === "compensation-pending") {
    controls.append(
      actionButton("确认执行一次", "confirm", connectionLocked || operationLocked, () => {
        if (connectionLocked || operationLocked) return;
        actions.submit({ type: "tool.confirmation.decide", confirmationId: state.card.confirmationId,
          expectedVersion: state.card.version, decision: "confirm" });
      }),
      actionButton("拒绝，不执行", "reject", connectionLocked || operationLocked, () => {
        if (connectionLocked || operationLocked) return;
        actions.submit({ type: "tool.confirmation.decide", confirmationId: state.card.confirmationId,
          expectedVersion: state.card.version, decision: "reject" });
      }),
    );
    if (state.card.handoffTargetActorId !== undefined) {
      controls.append(actionButton(
        `转交给 ${state.card.handoffTargetActorId}`,
        "handoff-offer",
        connectionLocked || operationLocked,
        () => {
          if (connectionLocked || operationLocked) return;
          actions.submit({
            type: "tool.confirmation.handoff.offer",
            confirmationId: state.card.confirmationId,
            expectedVersion: state.card.version,
            targetActorId: state.card.handoffTargetActorId!,
          });
        },
      ));
    }
    if (state.card.handoffCandidates !== undefined && state.card.handoffCandidates.length > 0) {
      const handoffLabel = document.createElement("label");
      handoffLabel.textContent = "转交精确 Human";
      const select = document.createElement("select");
      select.dataset.toolSafetyHandoffTarget = "true";
      for (const candidate of state.card.handoffCandidates) {
        const option = document.createElement("option");
        option.value = candidate.actorId;
        option.textContent = `${candidate.displayRef} · ${candidate.actorId}`;
        select.append(option);
      }
      select.disabled = connectionLocked || operationLocked;
      handoffLabel.append(select);
      controls.append(handoffLabel, actionButton("提出精确转交", "handoff-offer",
        connectionLocked || operationLocked, () => {
          if (connectionLocked || operationLocked || select.value.length === 0) return;
          actions.submit({ type: "tool.confirmation.handoff.offer",
            confirmationId: state.card.confirmationId, expectedVersion: state.card.version,
            targetActorId: select.value });
        }));
    }
    if (state.card.handoffId !== undefined) {
      controls.append(actionButton("接受精确转交", "handoff-accept", connectionLocked || operationLocked, () => {
        if (connectionLocked || operationLocked) return;
        actions.submit({ type: "tool.confirmation.handoff.accept", handoffId: state.card.handoffId!,
          expectedVersion: state.card.handoffVersion ?? state.card.version });
      }));
    }
  }
  if ((state.card.state === "outcome-unknown" || state.card.state === "compensation-outcome-unknown") &&
      state.card.dispatchId !== undefined) {
    const label = document.createElement("label");
    label.textContent = "Human 审查证据摘要";
    const evidence = document.createElement("textarea");
    evidence.dataset.toolSafetyEvidence = "true";
    evidence.maxLength = 2_048;
    evidence.value = state.reviewDraft?.evidenceSummary ?? (state.operation.status === "error"
      ? state.operation.retainedEvidenceSummary ?? "" : state.card.evidenceSummary ?? "");
    evidence.disabled = connectionLocked || operationLocked;
    label.append(evidence);
    controls.append(label);
    for (const [resolution, labelText] of [
      ["known_succeeded", "审查为已成功"],
      ["known_failed", "审查为未发生"],
      ["accepted_risk", "接受未知风险"],
    ] as const) {
      controls.append(actionButton(labelText, "review", connectionLocked || operationLocked, () => {
        if (connectionLocked || operationLocked || evidence.value.trim().length === 0) return;
        actions.submit({ type: "tool.outcome.review", dispatchId: state.card.dispatchId!,
          expectedVersion: state.card.version, resolution, evidenceSummary: evidence.value.trim() });
      }));
    }
    if (state.card.compensationKnownSucceeded === true) {
      controls.append(actionButton("补偿已知成功，闭合审查", "review", connectionLocked || operationLocked, () => {
        if (connectionLocked || operationLocked || evidence.value.trim().length === 0) return;
        actions.submit({ type: "tool.outcome.review", dispatchId: state.card.dispatchId!,
          expectedVersion: state.card.version, resolution: "compensated",
          evidenceSummary: evidence.value.trim() });
      }));
    }
    controls.append(actionButton("提出新的补偿动作", "compensate", connectionLocked || operationLocked, () => {
      if (connectionLocked || operationLocked) return;
      actions.submit({ type: "tool.compensation.propose", dispatchId: state.card.dispatchId!,
        expectedVersion: state.card.version });
    }));
  }
  if (["rejected", "params-changed", "grant-revoked", "expired"].includes(state.card.state)) {
    const next = actionButton("创建新 invocation", "compensate", connectionLocked || operationLocked, () => {
      if (!connectionLocked && !operationLocked) actions.newInvocation();
    });
    next.dataset.recoveryAction = "new-invocation";
    controls.append(next);
  }
  section.append(controls);

  const status = document.createElement("div");
  status.className = "tool-safety-status";
  status.setAttribute("aria-live", "polite");
  status.setAttribute("role", state.card.state === "outcome-unknown" ||
    state.card.state === "compensation-outcome-unknown" ||
    state.card.state === "principal-revoked" ? "alert" : "status");
  if (state.connection.status === "offline") status.textContent = "离线只读；所有写操作已关闭，未建立离线队列";
  else if (state.connection.status === "archived") status.textContent = "Room 已归档；保留工具安全事实，只读显示且所有写操作已关闭";
  else if (state.connection.status === "repairing") status.textContent = "repair 进行中；保留上一份完整只读 projection";
  else if (state.connection.status === "repair-failed") status.textContent = `repair 失败：${state.connection.errorCode}；保留上一份完整只读 projection`;
  else if (state.connection.status === "revoked") status.textContent = "Room 权限已撤销；敏感预览必须清除并重新认证";
  else if (state.operation.status === "submitting") status.textContent = state.operation.action === "review"
    ? "正在提交 Human 审查结论；保留证据草稿并等待匹配 ACK"
    : "正在提交 Human 决定；等待匹配 ACK";
  else if (state.operation.status === "acknowledged") status.textContent = "服务器已确认 authority transaction；这不表示工具执行成功，等待 stable event / repair projection";
  else if (state.operation.status === "error") status.textContent = recoveryFor(state.operation);
  else status.textContent = "当前显示来自 stable event 或 repair projection";
  section.append(status);

  if (state.operation.status === "error" && state.operation.statusCode === 401) {
    const reauth = document.createElement("button");
    reauth.type = "button";
    reauth.dataset.recoveryAction = "reauthenticate";
    reauth.textContent = "重新认证";
    reauth.addEventListener("click", actions.reauthenticate);
    section.append(reauth);
  } else if (state.operation.status === "error" && state.operation.statusCode === 410) {
    const next = document.createElement("button");
    next.type = "button";
    next.dataset.recoveryAction = "new-invocation";
    next.textContent = "创建新 invocation";
    next.disabled = connectionLocked || operationLocked;
    next.addEventListener("click", () => {
      if (!connectionLocked && !operationLocked) actions.newInvocation();
    });
    section.append(next);
  } else if (state.connection.status === "repair-failed" ||
      (state.operation.status === "error" && [403, 409, 503].includes(state.operation.statusCode))) {
    const repair = document.createElement("button");
    repair.type = "button";
    repair.dataset.recoveryAction = "repair";
    repair.textContent = "重新 repair 权威 projection";
    repair.addEventListener("click", actions.repair);
    section.append(repair);
  }

  root.replaceChildren(section);
  if (state.focusRecoveryAction === true) {
    section.querySelector<HTMLElement>("[data-recovery-action]")?.focus({ preventScroll: true });
  } else if (state.reviewDraft?.focusEvidence === true &&
      (state.card.state === "outcome-unknown" || state.card.state === "compensation-outcome-unknown")) {
    controls.querySelector<HTMLTextAreaElement>("[data-tool-safety-evidence]")?.focus({ preventScroll: true });
  } else if (state.focusStateHeading) heading.focus({ preventScroll: true });
}
