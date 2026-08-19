import {
  buildMentionPickerOptions,
  messageControls,
  replyLabel,
  type MessageActorOption,
  type MessageAuthorityState,
  type MessageClosedError,
  type MessageDraft,
  type TimelineMessage,
} from "./view-model.js";

export interface MessageAuthoritySurfaceActions {
  readonly onDraftBodyChange: (body: string) => void;
  readonly onSend: (draft: MessageDraft) => void;
  readonly onRetry: (draft: MessageDraft) => void;
  readonly onSelectMention: (actor: MessageActorOption) => void;
  readonly onRevise: (messageId: string) => void;
  readonly onRecall: (messageId: string) => void;
  readonly onRetryRepair: () => void;
  readonly onReauthenticate: () => void;
  readonly onRefreshProjection: () => void;
  readonly onDismissReply: () => void;
}

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  return value;
}

function text<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  content: string,
  className?: string,
): HTMLElementTagNameMap[Tag] {
  const value = element(tag, className);
  value.textContent = content;
  return value;
}

function button(label: string, action: string): HTMLButtonElement {
  const value = text("button", label, "message-authority__button");
  value.type = "button";
  value.dataset.action = action;
  return value;
}

function actorLabel(state: MessageAuthorityState, actorId: string): string {
  const actor = state.actors.find((entry) => entry.actorId === actorId);
  return actor === undefined ? actorId : `${actor.displayName} · ${actor.secondaryLabel}`;
}

function connectionBanner(
  state: MessageAuthorityState,
  actions: MessageAuthoritySurfaceActions,
): HTMLElement | undefined {
  if (state.lifecycle === "archived") {
    const banner = text(
      "section",
      "ARCHIVED · Room lifecycle projection 已归档；历史只读，发送、编辑与撤回已禁用。",
      "message-authority__banner message-authority__banner--archived",
    );
    banner.dataset.connectionBanner = "archived";
    return banner;
  }
  const connection = state.connection;
  if (connection.status === "online") return undefined;
  const banner = element("section", "message-authority__banner");
  banner.dataset.connectionBanner = connection.status;
  if (connection.status === "offline") {
    banner.append(text("strong", "离线 · 只读完整缓存"));
    banner.append(text("span", `数据截至 ${connection.asOf}；所有消息写入已禁用，不进入队列。`));
  } else if (connection.status === "repairing") {
    banner.append(text("strong", "REPAIR 进行中"));
    banner.append(text("span", `固定 watermark ${connection.watermark}；staging 不可见，继续显示旧完整 projection。`));
  } else if (connection.status === "repair-failed") {
    banner.append(text("strong", "REPAIR FAILED"));
    banner.append(text("span", `${connection.errorCode}；新 generation 未提交，旧完整 projection 保持只读。`));
    const retry = button("重试完整 repair", "retry-repair");
    retry.addEventListener("click", actions.onRetryRepair);
    banner.append(retry);
  } else if (connection.status === "fatal") {
    banner.append(text("strong", "FATAL · FAIL CLOSED"));
    banner.append(text("span", `${connection.errorCode}；无法安全显示或修改 Room。`));
    const auth = button("重新认证并重建", "reauthenticate");
    auth.addEventListener("click", actions.onReauthenticate);
    banner.append(auth);
  }
  return banner;
}

function outcomeLabel(status: string): string {
  if (status === "request-created") return "请求意图已登记";
  if (status === "invocation-intent-created") return "Agent调用意图已登记";
  return "目标不可用";
}

function renderReply(
  state: MessageAuthorityState,
  replyToMessageId: string,
  className: string,
): HTMLElement {
  const reply = text("aside", replyLabel(state.timeline, replyToMessageId), className);
  reply.dataset.replyToMessageId = replyToMessageId;
  return reply;
}

function renderHumanMessage(
  state: MessageAuthorityState,
  message: Extract<TimelineMessage, { kind: "human" }>,
  actions: MessageAuthoritySurfaceActions,
): HTMLElement {
  const card = element("article", "message-authority__message message-authority__message--human");
  card.dataset.messageId = message.messageId;
  card.dataset.authority = "projection";
  card.append(text("p", `PROJ · HUMAN · ${actorLabel(state, message.authorId)}`, "message-authority__stamp"));
  if (message.replyToMessageId !== undefined) {
    card.append(renderReply(state, message.replyToMessageId, "message-authority__message-reply"));
  }
  card.append(text("p", message.body, "message-authority__body"));
  if (message.revisionCount > 1) {
    card.append(text("p", `已编辑 · v${message.revision}`, "message-authority__revision"));
  }
  if (message.targetOutcomes.length > 0) {
    const list = element("ul", "message-authority__outcomes");
    list.setAttribute("aria-label", "逐目标权威结果");
    for (const outcome of message.targetOutcomes) {
      const item = text(
        "li",
        `${outcomeLabel(outcome.status)} · ${actorLabel(state, outcome.targetActorId)}${outcome.status === "rejected" ? ` · ${outcome.code}` : ""}`,
      );
      item.dataset.targetId = outcome.targetId;
      item.dataset.targetStatus = outcome.status;
      list.append(item);
    }
    card.append(list);
  }
  const controls = messageControls(state, message);
  if (controls.canRevise || controls.canRecall) {
    const group = element("div", "message-authority__message-actions");
    group.setAttribute("aria-label", "消息操作");
    if (controls.canRevise) {
      const revise = button("编辑正文", "revise-message");
      revise.addEventListener("click", () => actions.onRevise(message.messageId));
      group.append(revise);
    }
    if (controls.canRecall) {
      const recall = button("撤回消息", "recall-message");
      recall.addEventListener("click", () => actions.onRecall(message.messageId));
      group.append(recall);
    }
    card.append(group);
  }
  return card;
}

function renderTombstone(
  state: MessageAuthorityState,
  message: Extract<TimelineMessage, { kind: "tombstone" }>,
): HTMLElement {
  const card = element("article", "message-authority__message message-authority__message--tombstone");
  card.dataset.messageId = message.messageId;
  card.dataset.authority = "projection";
  card.append(text("p", `PROJ · TOMBSTONE · ${actorLabel(state, message.authorId)}`, "message-authority__stamp"));
  card.append(text("p", "消息已撤回", "message-authority__body"));
  card.append(text("p", `撤回于 ${message.recalledAt} · revision ${message.revisionCount} · 原文不在 operational timeline`, "message-authority__metadata"));
  return card;
}

function renderAgentMessage(
  state: MessageAuthorityState,
  message: Extract<TimelineMessage, { kind: "agent-final" }>,
): HTMLElement {
  const correction = message.correctsMessageId !== undefined;
  const card = element("article", "message-authority__message message-authority__message--agent");
  card.dataset.messageId = message.messageId;
  card.dataset.authority = "event-projection";
  card.append(text(
    "p",
    `EVT · ${correction ? "CORRECTION" : "FINAL"} · ${actorLabel(state, message.authorId)}`,
    "message-authority__stamp",
  ));
  if (correction) {
    card.append(text("p", `更正 ${message.correctsMessageId}；原 final 保留不可变`, "message-authority__metadata"));
  }
  card.append(text("p", message.finalBody, "message-authority__body"));
  card.append(text("p", `execution ${message.sourceExecutionId} · intent ${message.sourceInvocationIntentId}`, "message-authority__metadata"));
  return card;
}

function renderTimeline(
  state: MessageAuthorityState,
  actions: MessageAuthoritySurfaceActions,
): HTMLElement {
  const timeline = element("section", "message-authority__timeline");
  timeline.setAttribute("aria-label", "Room 权威消息时间线");
  timeline.setAttribute("aria-relevant", "additions text");
  if (state.timeline.length === 0) {
    timeline.append(text("p", "还没有权威消息", "message-authority__empty"));
    return timeline;
  }
  for (const message of state.timeline) {
    timeline.append(message.kind === "human" ? renderHumanMessage(state, message, actions)
      : message.kind === "tombstone" ? renderTombstone(state, message)
      : renderAgentMessage(state, message));
  }
  return timeline;
}

const executionLabels: Record<MessageAuthorityState["executions"][number]["status"], string> = {
  accepted: "Agent已接受 · 尚未开始生成",
  running: "Agent执行中",
  completed: "Agent已完成",
  failed: "Agent执行失败",
  cancelled: "Agent执行已取消",
};

function renderExecutions(state: MessageAuthorityState): HTMLElement {
  const region = element("section", "message-authority__executions");
  region.setAttribute("aria-label", "Agent execution 权威状态");
  for (const execution of state.executions) {
    const card = element("article", "message-authority__execution");
    card.dataset.executionId = execution.executionId;
    card.dataset.executionStatus = execution.status;
    card.append(text("p", `EVT · ${execution.status.toUpperCase()} · ${actorLabel(state, execution.agentId)}`, "message-authority__stamp"));
    card.append(text("p", executionLabels[execution.status]));
    if (execution.failureCode !== undefined) card.append(text("p", execution.failureCode));
    region.append(card);
  }
  for (const preview of state.previews) {
    const card = element("aside", "message-authority__preview");
    card.dataset.agentPreview = preview.executionId;
    card.dataset.authority = "local-transient";
    card.setAttribute("aria-live", "off");
    card.append(text("p", "PREVIEW · 非权威 · 可丢弃", "message-authority__stamp"));
    card.append(text("p", preview.delta));
    region.append(card);
  }
  return region;
}

function recovery(error: MessageClosedError): string {
  switch (error.status) {
    case 400: return "修改消息或结构化 mention";
    case 401: return "重新认证";
    case 403: return "返回 Room 列表并刷新权限";
    case 404: return "移除或重新选择引用";
    case 409: return "载入最新版本后处理冲突";
    case 410: return error.code === "protocol_upgrade_required" ? "升级客户端" : "重新开始 repair";
    case 429: return `${error.retryAfterSeconds ?? 1} 秒后重试`;
    case 503: return "重试发送";
  }
}

function renderSubmission(
  state: MessageAuthorityState,
  actions: MessageAuthoritySurfaceActions,
): HTMLElement | undefined {
  const submission = state.submission;
  if (submission.status === "idle") return undefined;
  if (submission.status === "submitting") {
    const status = text("section", "LOCAL · 正在提交；输入已保留，尚无成功事实。", "message-authority__submission");
    status.dataset.submissionStatus = "submitting";
    return status;
  }
  if (submission.status === "accepted" || submission.status === "accepted-via-event") {
    const status = element("section", "message-authority__submission");
    status.append(text(
      "strong",
      submission.status === "accepted" ? "ACK · 消息已保存" : "EVT · 消息已保存（ACK 丢失后收敛）",
    ));
    status.dataset.submissionStatus = submission.status;
    if (submission.status === "accepted" && submission.targetOutcomes.length > 0) {
      const list = element("ul", "message-authority__outcomes");
      list.setAttribute("aria-label", "ACK 逐目标持久结果");
      for (const outcome of submission.targetOutcomes) {
        const item = text(
          "li",
          `${outcomeLabel(outcome.status)} · ${actorLabel(state, outcome.targetActorId)}${outcome.status === "rejected" ? ` · ${outcome.code}` : ""}`,
        );
        item.dataset.ackTargetId = outcome.targetId;
        item.dataset.targetStatus = outcome.status;
        list.append(item);
      }
      status.append(list);
    }
    return status;
  }
  const error = submission.error;
  const panel = element("section", "message-authority__error");
  panel.dataset.messageError = error.code;
  panel.dataset.submissionStatus = submission.status;
  panel.setAttribute("role", "group");
  panel.tabIndex = -1;
  panel.append(text("strong", `${error.status} · ${error.code} · 消息未提交`));
  panel.append(text("p", `${recovery(error)}；草稿、messageId、targets、reply 与 attachments 已保留。`));
  if (submission.status === "retryable-failure") {
    const retry = button(error.status === 429 ? recovery(error) : "重试发送", "retry-message");
    retry.addEventListener("click", () => actions.onRetry(submission.payload));
    panel.append(retry);
  } else if (error.status === 401) {
    const auth = button("重新认证", "reauthenticate");
    auth.addEventListener("click", actions.onReauthenticate);
    panel.append(auth);
  } else if (error.status === 409) {
    const refresh = button("载入最新版本", "refresh-projection");
    refresh.addEventListener("click", actions.onRefreshProjection);
    panel.append(refresh);
  }
  return panel;
}

function renderComposer(
  state: MessageAuthorityState,
  actions: MessageAuthoritySurfaceActions,
): HTMLElement {
  const composer = element("section", "message-authority__composer");
  composer.setAttribute("aria-label", "消息编辑器");
  if (state.draft.replyToMessageId !== undefined) {
    const reply = renderReply(state, state.draft.replyToMessageId, "message-authority__reply-banner");
    reply.dataset.replyBanner = "true";
    const dismiss = button("取消引用", "dismiss-reply");
    dismiss.addEventListener("click", actions.onDismissReply);
    reply.append(dismiss);
    composer.append(reply);
  }
  const picker = element("section", "message-authority__mention-picker");
  picker.setAttribute("aria-label", "结构化 mention 选择器");
  picker.append(text("h3", "@ 寻址（stable actorId）"));
  for (const option of buildMentionPickerOptions(state, "")) {
    const choice = button(option.displayName, "select-mention");
    choice.dataset.mentionActorId = option.actorId;
    choice.dataset.mentionKind = option.kind;
    choice.setAttribute("aria-label", option.accessibleLabel);
    choice.disabled = !state.composerEnabled;
    choice.addEventListener("click", () => actions.onSelectMention(option));
    picker.append(choice);
  }
  composer.append(picker);
  const label = text("label", "消息正文", "message-authority__composer-label");
  const input = element("textarea", "message-authority__composer-input");
  input.dataset.messageComposer = "true";
  input.value = state.draft.body;
  input.disabled = !state.composerEnabled || state.submission.status === "submitting";
  input.addEventListener("input", () => actions.onDraftBodyChange(input.value));
  label.append(input);
  composer.append(label);
  const send = button(state.submission.status === "submitting" ? "发送中…" : "发送", "send-message");
  send.disabled = !state.composerEnabled || state.submission.status === "submitting";
  send.addEventListener("click", () => actions.onSend({ ...state.draft, body: input.value }));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !send.disabled) {
      event.preventDefault();
      actions.onSend({ ...state.draft, body: input.value });
    }
  });
  composer.append(send);
  return composer;
}

export function renderMessageAuthoritySurface(
  root: HTMLElement,
  state: MessageAuthorityState,
  actions: MessageAuthoritySurfaceActions,
): void {
  const shell = element("section", "message-authority");
  shell.dataset.roomId = state.roomId;
  shell.dataset.projectionGeneration = String(state.projectionGeneration);
  shell.dataset.motion = state.reducedMotion ? "reduced" : "standard";
  shell.setAttribute("aria-label", "Message Authority");

  const status = text("p", state.announcement, "message-authority__live-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  shell.append(status);

  if (state.connection.status === "revoked") {
    const locked = element("section", "message-authority__locked");
    locked.dataset.messageAuthorityLocked = "true";
    locked.append(text("h2", state.connection.scope === "room" ? "Room 访问已撤销" : "Session 已撤销"));
    locked.append(text("p", state.connection.purgeCompleted ? "缓存已清除" : "正在清除缓存；内容已锁定"));
    shell.append(locked);
    root.replaceChildren(shell);
    return;
  }

  const banner = connectionBanner(state, actions);
  if (banner !== undefined) shell.append(banner);
  shell.append(renderTimeline(state, actions));
  shell.append(renderExecutions(state));
  const submission = renderSubmission(state, actions);
  if (submission !== undefined) shell.append(submission);
  shell.append(renderComposer(state, actions));
  root.replaceChildren(shell);

  if (state.submission.status === "retryable-failure" || state.submission.status === "nonretryable-failure") {
    root.querySelector<HTMLElement>("[data-message-error]")?.focus();
  }
}
