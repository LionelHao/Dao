import {
  createMemoryAuthorityViewModel,
  type MemoryPanelInput,
  type MemorySourceNavigation,
} from "./view-model.js";

export interface MemorySurfaceActions {
  readonly onNavigateSource: (navigation: MemorySourceNavigation) => void;
  readonly onDispute: (intent: { readonly memoryRecordId: string; readonly expectedVersion: number; readonly reason: string }) => void;
  readonly onResolve: (intent: { readonly memoryRecordId: string; readonly expectedVersion: number; readonly reason: string }) => void;
  readonly onRetry: () => void;
}

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className?: string): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag);
  if (className !== undefined) value.className = className;
  return value;
}

function text<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, content: string, className?: string): HTMLElementTagNameMap[Tag] {
  const value = element(tag, className);
  value.textContent = content;
  return value;
}

function button(label: string): HTMLButtonElement {
  const value = text("button", label);
  value.type = "button";
  return value;
}

function trapFocus(dialog: HTMLElement): void {
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("textarea, button:not([disabled])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

function appendReasonDialog(
  shell: HTMLElement,
  trigger: HTMLButtonElement,
  mode: "dispute" | "resolve",
  memoryRecordId: string,
  expectedVersion: number,
  submit: (reason: string) => void,
): void {
  shell.querySelector("[data-memory-dialog]")?.remove();
  const dialog = element("section", "memory-dialog");
  dialog.dataset.memoryDialog = mode;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const title = text("h3", mode === "dispute" ? "争议 Context" : "解决并重新评估 Context");
  const titleId = `memory-${mode}-${memoryRecordId}`;
  title.id = titleId;
  dialog.setAttribute("aria-labelledby", titleId);
  const reason = element("textarea");
  reason.maxLength = 2_048;
  reason.setAttribute("aria-label", mode === "dispute" ? "争议理由" : "解决理由");
  const confirm = button(mode === "dispute" ? "提交争议" : "提交解决");
  confirm.dataset.action = mode === "dispute" ? "submit-dispute" : "submit-resolve";
  confirm.addEventListener("click", () => {
    const value = reason.value.trim();
    if (value.length > 0) submit(value);
  });
  const close = button("关闭");
  close.dataset.action = "close-memory-dialog";
  const closeDialog = (): void => {
    dialog.remove();
    trigger.focus();
  };
  close.addEventListener("click", closeDialog);
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    closeDialog();
  });
  dialog.append(title, reason, confirm, close);
  trapFocus(dialog);
  shell.append(dialog);
  reason.focus();
  void expectedVersion;
}

export function renderMemoryAuthoritySurface(
  root: HTMLElement,
  state: MemoryPanelInput,
  actions: MemorySurfaceActions,
): void {
  const model = createMemoryAuthorityViewModel(state);
  const shell = element("section", "memory-authority-panel");
  shell.dataset.memoryPanel = "true";
  shell.dataset.visibleState = model.visibleState;
  shell.dataset.motion = model.motion;
  shell.setAttribute("aria-label", "重要记忆 · 5 类");
  shell.append(text("h2", "重要记忆 · 5 类"));
  const health = text("p", `${model.statusLabel} · ${model.nonColourCue}`);
  health.dataset.memoryHealth = model.visibleState;
  shell.append(health);
  const watermark = text("p", model.watermarkLabel);
  watermark.dataset.memoryWatermark = "true";
  shell.append(watermark);
  const live = text("p", model.liveAnnouncement);
  live.dataset.memoryLive = "true";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  shell.append(live);

  if (model.visibleState === "revoked") {
    const revoked = text("p", "访问已撤销；当前 Room 的重要记忆已清除。");
    revoked.setAttribute("role", "alert");
    shell.append(revoked);
    root.replaceChildren(shell);
    return;
  }

  if (model.error !== undefined) {
    const error = text("section", `${model.error.status} · ${model.error.code} · ${model.error.recovery}`);
    error.dataset.memoryError = "true";
    error.setAttribute("role", "alert");
    error.tabIndex = -1;
    shell.append(error);
  }

  const list = element("div", "memory-card-list");
  list.setAttribute("role", "list");
  for (const card of model.cards) {
    const article = element("article", "memory-card");
    article.dataset.memoryRecordId = card.memoryRecordId;
    if (card.memoryVersionId !== undefined) article.dataset.memoryVersionId = card.memoryVersionId;
    article.dataset.injectable = String(card.injectable);
    article.setAttribute("role", "listitem");
    article.tabIndex = 0;
    article.setAttribute("aria-label", `${card.authorityLabel}，版本 ${card.version}`);
    article.append(text("h3", card.authorityLabel), text("p", card.derivedText));
    const sources = element("div", "memory-sources");
    sources.dataset.memorySources = "true";
    sources.setAttribute("aria-live", "off");
    for (const source of card.sources) {
      const open = button(`${source.availabilityLabel} · revision ${source.revision}`);
      open.dataset.sourceId = source.sourceId;
      open.disabled = source.availability === "unavailable";
      open.addEventListener("click", () => actions.onNavigateSource(source.navigation));
      sources.append(open);
    }
    article.append(sources);
    if (card.kind === "context" && card.state === "active") {
      const dispute = button("争议 Context");
      dispute.dataset.action = "dispute";
      dispute.disabled = !card.canDispute;
      dispute.addEventListener("click", () => appendReasonDialog(
        shell,
        dispute,
        "dispute",
        card.memoryRecordId,
        card.version,
        (reason) => actions.onDispute({ memoryRecordId: card.memoryRecordId, expectedVersion: card.version, reason }),
      ));
      article.append(dispute);
    }
    if (card.kind === "context" && card.state === "disputed" && card.canResolve) {
      const resolve = button("解决并重新评估");
      resolve.dataset.action = "resolve";
      resolve.addEventListener("click", () => appendReasonDialog(
        shell,
        resolve,
        "resolve",
        card.memoryRecordId,
        card.version,
        (reason) => actions.onResolve({ memoryRecordId: card.memoryRecordId, expectedVersion: card.version, reason }),
      ));
      article.append(resolve);
    }
    list.append(article);
  }
  shell.append(list);
  if ((state.health?.retryable === true || model.error?.recovery === "retry") && !model.writeLocked) {
    const retry = button("重试 steward");
    retry.dataset.action = "retry";
    retry.addEventListener("click", actions.onRetry);
    shell.append(retry);
  }
  root.replaceChildren(shell);
  if (model.focusTarget === "error-summary") shell.querySelector<HTMLElement>("[data-memory-error]")?.focus();
}
