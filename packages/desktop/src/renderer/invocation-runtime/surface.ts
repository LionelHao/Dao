import type {
  InvocationBridge,
  InvocationClosedError,
  InvocationExecutionProjection,
  InvocationOperationState,
  InvocationSurfaceState,
} from "../../invocation-runtime/contracts.js";

const STATUS_LABEL = {
  accepted: "已接受",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
} as const;
const STATUS_SYMBOL = { accepted: "◌", running: "▶", completed: "✓", failed: "!", cancelled: "⊘" } as const;
const PHASE_LABEL: Record<string, string> = {
  queued: "排队中", retry_scheduled: "已安排重试", recovery_queued: "恢复排队",
  awaiting_capacity: "等待容量", claiming: "领取执行", snapshot_frozen: "快照已冻结",
  model_generation: "模型生成", read_tool: "读取工具", waiting_confirmation: "运行中 · 等待确认",
  side_effect_claimed: "副作用已领取", final_committing: "提交最终结果",
  completed: "完成", failed: "失败", cancelled: "取消",
};
const ERROR_LABEL: Record<InvocationClosedError["status"], string> = {
  401: "登录已失效，请重新认证。", 403: "Room 访问已撤销，请申请访问。",
  409: "执行版本已变化，请刷新权威状态。", 410: "协议版本已过期，请升级客户端。",
  429: "请求过于频繁，请稍后重试。", 503: "服务暂不可用，请修复 Room 同步。",
};

export type InvocationHostAction =
  | "reauthenticate"
  | "request-access"
  | "upgrade-client"
  | "review-required";

export interface InvocationSurfaceActions {
  readonly onHostAction: (action: InvocationHostAction, context: Readonly<{
    roomId: string;
    executionId: string;
  }>) => void;
}

function operationFor(state: InvocationSurfaceState, executionId: string): InvocationOperationState | undefined {
  return state.operations.find((operation) => operation.status !== "idle" && operation.executionId === executionId);
}

function appendText(parent: HTMLElement, tag: "p" | "h2" | "h3" | "span", text: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderExecution(
  state: InvocationSurfaceState,
  projection: InvocationExecutionProjection,
  submit: (kind: "cancel" | "retry", executionId: string, expectedVersion: number) => void,
  repair: () => void,
  hostAction: (action: InvocationHostAction, executionId: string) => void,
  scheduleRetry: (
    button: HTMLButtonElement,
    retryAfterSeconds: number,
    requestId: string,
  ) => void,
): HTMLElement {
  const { execution } = projection;
  const card = document.createElement("article");
  card.className = `invocation-card invocation-card--${execution.status}`;
  card.dataset.executionId = execution.executionId;
  card.dataset.executionRevision = String(execution.version);
  card.dataset.status = execution.status;
  card.dataset.phase = execution.phase;
  card.tabIndex = -1;
  const heading = appendText(card, "h3", `Agent ${execution.agentId}`);
  heading.id = `execution-${execution.executionId}`;
  card.setAttribute("aria-labelledby", heading.id);
  const status = appendText(card, "p", `${STATUS_SYMBOL[execution.status]} ${STATUS_LABEL[execution.status]}`);
  status.className = "invocation-card__status";
  appendText(card, "p", `阶段：${PHASE_LABEL[execution.phase] ?? execution.phase}`);
  appendText(card, "p", `尝试 ${execution.currentAttemptSeq} · 版本 ${execution.version}`);
  if (execution.reviewState === "needs_review") {
    const review = appendText(card, "p", "⚑ 结果未知，需要人工审阅；此状态不能按普通失败重试。");
    review.dataset.invocationReview = execution.executionId;
    review.tabIndex = -1;
    review.setAttribute("role", "alert");
    appendText(card, "p",
      "审阅闭合命令尚未接入当前 Desktop bridge；请勿重试原 toolCall。等待 FT-10 review authority 接线。");
    const reviewAction = document.createElement("button");
    reviewAction.type = "button";
    reviewAction.dataset.invocationReviewAction = execution.executionId;
    reviewAction.textContent = "打开人工审阅入口";
    reviewAction.addEventListener("click", () => hostAction("review-required", execution.executionId));
    card.append(reviewAction);
  } else if (execution.reviewState === "reviewed") {
    appendText(card, "p", "✓ 人工审阅已完成");
  }
  if (projection.sourceLifecycle === "revised") {
    const revised = appendText(card, "p",
      "SOURCE REVISED · 来源消息已有新 revision；本 execution 的冻结输入保持不变。");
    revised.dataset.invocationSource = "revised";
  }
  if (projection.sourceLifecycle === "recalled") appendText(card, "p", "来源消息已撤回，重试已关闭。");
  if (projection.preservedDispatchIds.length > 0) {
    appendText(card, "p", `工具 dispatch 证据已保留（${projection.preservedDispatchIds.length}）；未宣称撤销已领取的副作用。`);
  }
  if (projection.attempts.length > 0) {
    appendText(card, "p", `最近尝试：${PHASE_LABEL[projection.attempts.at(-1)!.phase] ?? projection.attempts.at(-1)!.phase}`);
  }
  const operation = operationFor(state, execution.executionId);
  if (operation?.status === "submitting" || operation?.status === "acknowledged") {
    const pending = appendText(card, "p", operation.status === "submitting"
      ? "正在提交控制意图…权威状态未改变。"
      : "服务器已确认提交，等待 stable event / repair 更新权威状态。");
    pending.setAttribute("role", "status");
    pending.setAttribute("aria-live", "polite");
  }
  if (operation?.status === "failed") {
    const failure = appendText(card, "p", `${operation.error.status} · ${ERROR_LABEL[operation.error.status]}`);
    failure.setAttribute("role", "alert");
    failure.dataset.invocationError = operation.requestId;
    failure.tabIndex = -1;
    if (operation.error.recovery === "retry-later" ||
        operation.error.recovery === "refresh-authority" ||
        operation.error.recovery === "repair-room") {
      const recover = document.createElement("button");
      recover.type = "button";
      recover.dataset.invocationRecovery = operation.error.recovery;
      recover.textContent = operation.error.recovery === "retry-later"
        ? operation.error.retryAfterSeconds === undefined ? "稍后重试"
          : `${operation.error.retryAfterSeconds} 秒后重试`
        : operation.error.recovery === "repair-room" ? "修复 Room 同步" : "刷新权威状态";
      if (operation.error.recovery === "retry-later" &&
          operation.error.retryAfterSeconds !== undefined) {
        recover.disabled = true;
        scheduleRetry(recover, operation.error.retryAfterSeconds, operation.requestId);
      }
      recover.addEventListener("click", operation.error.recovery === "retry-later"
        ? () => submit(operation.kind, operation.executionId, operation.expectedVersion)
        : repair);
      card.append(recover);
    } else {
      const recover = document.createElement("button");
      recover.type = "button";
      recover.dataset.invocationRecovery = operation.error.recovery;
      recover.textContent = operation.error.recovery === "reauthenticate"
        ? "前往重新认证"
        : operation.error.recovery === "request-access"
          ? "前往 Room 访问管理"
          : "打开客户端更新入口";
      recover.addEventListener("click", () => hostAction(
        operation.error.recovery as "reauthenticate" | "request-access" | "upgrade-client",
        operation.executionId,
      ));
      card.append(recover);
    }
  }
  const controls = document.createElement("div");
  controls.className = "invocation-card__controls";
  const online = state.connection.status === "online";
  const busy = operation?.status === "submitting" || operation?.status === "acknowledged";
  if (execution.status === "accepted" || execution.status === "running") {
    const cancel = document.createElement("button");
    cancel.dataset.invocationAction = "cancel";
    cancel.type = "button"; cancel.textContent = busy ? "提交中…" : "取消本次执行";
    cancel.disabled = !online || busy;
    cancel.addEventListener("click", () => submit("cancel", execution.executionId, execution.version));
    controls.append(cancel);
  }
  if (execution.status === "failed" || execution.status === "cancelled") {
    const retry = document.createElement("button");
    retry.dataset.invocationAction = "retry";
    retry.type = "button"; retry.textContent = busy ? "提交中…" : "重试为新执行";
    retry.disabled = !online || busy ||
      (projection.sourceLifecycle !== "active" && projection.sourceLifecycle !== "revised") ||
      execution.reviewState === "needs_review";
    retry.addEventListener("click", () => submit("retry", execution.executionId, execution.version));
    controls.append(retry);
  }
  card.append(controls);
  return card;
}

export function mountInvocationSurface(
  root: HTMLElement,
  bridge: InvocationBridge,
  roomId: string,
  actions: InvocationSurfaceActions,
): () => void {
  let disposed = false;
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const retryEligibleAtByRequestId = new Map<string, number>();
  const reviewRequired = new Set<string>();
  const reportedFailures = new Set<string>();
  const load = async (): Promise<void> => {
    try { render(await bridge.getSurface({ roomId })); }
    catch { renderFailure("503 · 无法读取执行权威状态。写操作保持关闭。"); }
  };
  const renderFailure = (message: string): void => {
    if (disposed) return;
    const alert = document.createElement("section");
    alert.className = "invocation-panel"; alert.setAttribute("role", "alert");
    appendText(alert, "h2", "Agent 执行"); appendText(alert, "p", message);
    const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "修复同步";
    retry.dataset.invocationRecovery = "repair-room";
    retry.addEventListener("click", () => void load()); alert.append(retry); root.replaceChildren(alert);
    retry.focus();
  };
  const submit = async (kind: "cancel" | "retry", executionId: string, expectedVersion: number) => {
    try { render((await bridge[kind]({ roomId, executionId, expectedVersion })).state); }
    catch { renderFailure("503 · 控制意图未能提交。权威执行状态未改变。"); }
  };
  const hostAction = (action: InvocationHostAction, executionId: string): void => {
    actions.onHostAction(action, { roomId, executionId });
  };
  const scheduleRetry = (
    button: HTMLButtonElement,
    retryAfterSeconds: number,
    requestId: string,
  ): void => {
    const eligibleAt = retryEligibleAtByRequestId.get(requestId) ??
      Date.now() + retryAfterSeconds * 1_000;
    retryEligibleAtByRequestId.set(requestId, eligibleAt);
    const update = (): void => {
      if (disposed) return;
      const remainingMs = eligibleAt - Date.now();
      if (remainingMs <= 0) {
        button.disabled = false;
        button.textContent = "重试控制意图";
        button.focus();
        return;
      }
      button.disabled = true;
      button.textContent = `${Math.ceil(remainingMs / 1_000)} 秒后重试`;
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        update();
      }, Math.min(remainingMs, 1_000));
      retryTimers.add(timer);
    };
    update();
  };
  const render = (state: InvocationSurfaceState): void => {
    if (disposed || state.roomId !== roomId) return;
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    const currentRateLimitedRequests = new Set(state.operations.flatMap((operation) =>
      operation.status === "failed" && operation.error.status === 429 &&
        operation.error.recovery === "retry-later" &&
        operation.error.retryAfterSeconds !== undefined
        ? [operation.requestId] : []));
    for (const requestId of retryEligibleAtByRequestId.keys()) {
      if (!currentRateLimitedRequests.has(requestId)) retryEligibleAtByRequestId.delete(requestId);
    }
    const active = root.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement : undefined;
    const activeCard = active?.closest<HTMLElement>("[data-execution-id]");
    const priorFocus = activeCard === null || activeCard === undefined ? undefined : {
      executionId: activeCard.dataset.executionId!,
      kind: active?.dataset.invocationAction !== undefined ? "action"
        : active?.dataset.invocationRecovery !== undefined ? "recovery"
          : active?.dataset.invocationReviewAction !== undefined ? "review" : undefined,
      value: active?.dataset.invocationAction ?? active?.dataset.invocationRecovery ??
        active?.dataset.invocationReviewAction,
    };
    const panel = document.createElement("section");
    panel.className = "invocation-panel"; panel.dataset.invocationSurface = "true";
    panel.setAttribute("aria-label", "Agent 执行权威状态");
    appendText(panel, "h2", "Agent 执行");
    const announcement = appendText(panel, "p", "");
    announcement.className = "invocation-panel__announcement";
    announcement.setAttribute("role", "status"); announcement.setAttribute("aria-live", "polite");
    if (state.connection.status !== "online") {
      const message = state.connection.status === "offline" ? `离线只读（截至 ${state.connection.asOf}）`
        : state.connection.status === "repairing" ? "正在修复权威状态，写操作已关闭"
          : state.connection.status === "revoked" ? "访问已撤销，本地权威缓存已清除"
            : `同步修复失败：${state.connection.errorCode}`;
      const banner = appendText(panel, "p", message); banner.className = "invocation-panel__offline";
      banner.setAttribute("role", "status");
    }
    const list = document.createElement("div"); list.className = "invocation-panel__list";
    for (const execution of state.executions) {
      list.append(renderExecution(
        state, execution, submit, () => void load(), hostAction, scheduleRetry,
      ));
    }
    if (state.executions.length === 0) appendText(list, "p", "当前没有 Agent 执行。 ");
    panel.append(list);
    if (state.projectBoundaries.length > 0) {
      const boundaries = document.createElement("ul"); boundaries.setAttribute("aria-label", "项目边界判定");
      for (const boundary of state.projectBoundaries) {
        const item = document.createElement("li");
        item.textContent = boundary.status === "intent-created" ? "项目边界已创建调用意图"
          : boundary.status === "execution-state"
            ? `项目边界执行：${boundary.executionStatus}`
            : `项目边界已关闭：${boundary.reason}`;
        if (boundary.status === "execution-state") {
          item.dataset.projectBoundaryExecutionStatus = boundary.executionStatus;
          item.dataset.projectBoundaryExecutionId = boundary.executionId;
        }
        boundaries.append(item);
      }
      panel.append(boundaries);
    }
    root.replaceChildren(panel);
    const newlyRequired = state.executions.find(({ execution }) =>
      execution.reviewState === "needs_review" && !reviewRequired.has(execution.executionId));
    const newFailure = state.operations.find((operation) =>
      operation.status === "failed" && !reportedFailures.has(operation.requestId));
    for (const { execution } of state.executions) {
      if (execution.reviewState === "needs_review") reviewRequired.add(execution.executionId);
    }
    for (const operation of state.operations) {
      if (operation.status === "failed") reportedFailures.add(operation.requestId);
    }
    if (newlyRequired !== undefined) {
      announcement.textContent = `Agent ${newlyRequired.execution.agentId} 的执行结果需要人工审阅。`;
      [...panel.querySelectorAll<HTMLButtonElement>("[data-invocation-review-action]")]
        .find((element) =>
          element.dataset.invocationReviewAction === newlyRequired.execution.executionId)?.focus();
      return;
    }
    if (newFailure?.status === "failed") {
      const failureCard = [...panel.querySelectorAll<HTMLElement>("[data-execution-id]")]
        .find((element) => element.dataset.executionId === newFailure.executionId);
      const recovery = [...(failureCard?.querySelectorAll<HTMLButtonElement>(
        "[data-invocation-recovery]",
      ) ?? [])].find((element) =>
        element.dataset.invocationRecovery === newFailure.error.recovery);
      const failure = [...(failureCard?.querySelectorAll<HTMLElement>(
        "[data-invocation-error]",
      ) ?? [])].find((element) => element.dataset.invocationError === newFailure.requestId);
      (recovery ?? failure ?? failureCard)?.focus();
      return;
    }
    if (priorFocus !== undefined) {
      const card = [...panel.querySelectorAll<HTMLElement>("[data-execution-id]")]
        .find((element) => element.dataset.executionId === priorFocus.executionId);
      const action = priorFocus.kind === undefined || priorFocus.value === undefined ? undefined
        : [...(card?.querySelectorAll<HTMLElement>(
          "[data-invocation-action], [data-invocation-recovery], [data-invocation-review-action]",
        ) ?? [])].find((element) =>
          (priorFocus.kind === "action" && element.dataset.invocationAction === priorFocus.value) ||
          (priorFocus.kind === "recovery" && element.dataset.invocationRecovery === priorFocus.value) ||
          (priorFocus.kind === "review" &&
            element.dataset.invocationReviewAction === priorFocus.value));
      if (action instanceof HTMLButtonElement && !action.disabled) action.focus();
      else card?.focus();
    }
  };
  const unsubscribe = bridge.onStateChanged((envelope) => render(envelope.state));
  void load();
  return () => {
    disposed = true;
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    retryEligibleAtByRequestId.clear();
    unsubscribe();
    root.replaceChildren();
  };
}
