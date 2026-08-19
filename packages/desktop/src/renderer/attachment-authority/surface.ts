import type {
  AttachmentActionKind,
  AttachmentAuthorityViewModel,
  SafeAttachmentMetadata,
} from "./view-model.js";

export interface AttachmentAuthoritySurfaceActions {
  readonly onUpload: () => void;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onBind: () => void;
  readonly onPreview: () => void;
  readonly onDownload: () => void;
  readonly onRemove: () => void;
  readonly onReauthenticate: () => void;
  readonly onRefreshProjection: () => void;
  readonly onRestartUpload: () => void;
  readonly onSelectReplacement: () => void;
  readonly onUpgradeClient: () => void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function formatByteCount(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function renderMetadata(metadata: SafeAttachmentMetadata): HTMLElement {
  const section = element("section", "attachment-authority__metadata");
  section.dataset.attachmentMetadata = "safe";
  const name = element("strong", "attachment-authority__name", metadata.displayName);
  const facts = element(
    "span",
    "attachment-authority__facts",
    `${formatByteCount(metadata.byteSize)} · ${metadata.format === undefined ? "" : `${metadata.format.toUpperCase()} · `}${metadata.mediaType}`,
  );
  section.append(name, facts);
  if (metadata.sha256 !== undefined) {
    section.append(element(
      "code", "attachment-authority__digest", `SHA-256 · ${metadata.sha256}`,
    ));
  }
  if (metadata.provenance !== undefined && metadata.provenance !== null) {
    const extraction = metadata.provenance.extraction;
    const ocr = metadata.provenance.ocr === null
      ? ""
      : ` · Tesseract ${metadata.provenance.ocr.version} · ${metadata.provenance.ocr.pageCount} pages`;
    section.append(element(
      "span",
      "attachment-authority__provenance",
      `ClamAV ${metadata.provenance.scanner.version} · ${extraction.tool} ${extraction.version} · ${extraction.method}${ocr}`,
    ));
  }
  return section;
}

function handlerFor(
  kind: AttachmentActionKind,
  actions: AttachmentAuthoritySurfaceActions,
): () => void {
  switch (kind) {
    case "upload": return actions.onUpload;
    case "cancel": return actions.onCancel;
    case "retry": return actions.onRetry;
    case "bind": return actions.onBind;
    case "preview": return actions.onPreview;
    case "download": return actions.onDownload;
    case "remove": return actions.onRemove;
    case "reauthenticate": return actions.onReauthenticate;
    case "refresh-projection": return actions.onRefreshProjection;
    case "restart-upload": return actions.onRestartUpload;
    case "select-replacement": return actions.onSelectReplacement;
    case "upgrade-client": return actions.onUpgradeClient;
  }
}

function renderActions(
  model: AttachmentAuthorityViewModel,
  handlers: AttachmentAuthoritySurfaceActions,
): HTMLElement {
  const actions = element("div", "attachment-authority__actions");
  actions.dataset.attachmentActions = "closed";
  for (const item of model.actions) {
    const button = element("button", "attachment-authority__button", item.label);
    button.type = "button";
    button.dataset.action = item.kind;
    const objectName = model.metadata?.displayName;
    button.setAttribute("aria-label", objectName === undefined ? item.label : `${item.label}：${objectName}`);
    if (item.kind === "reauthenticate") button.dataset.attachmentRecovery = "true";
    button.addEventListener("click", handlerFor(item.kind, handlers));
    actions.append(button);
  }
  return actions;
}

export function renderAttachmentAuthoritySurface(
  root: HTMLElement,
  model: AttachmentAuthorityViewModel,
  actions: AttachmentAuthoritySurfaceActions,
  options: Readonly<{
    announce?: boolean;
    actionNames?: Readonly<Partial<Record<AttachmentActionKind, string>>>;
  }> = {},
): void {
  root.className = "attachment-authority";
  root.dataset.attachmentState = model.visibleState;
  root.dataset.attachmentVisibility = model.visibility;
  root.dataset.motion = model.motion;
  root.dataset.readOnly = String(model.readOnly);
  root.replaceChildren();

  if (model.visibility === "excluded") return;

  const live = element("p", "attachment-authority__live-status", model.liveAnnouncement);
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");

  const card = element("article", `attachment-authority__card attachment-authority__card--${model.visibleState}`);
  const header = element("header", "attachment-authority__header");
  const glyph = element("span", "attachment-authority__glyph", model.statusGlyph);
  glyph.dataset.statusIcon = model.nonColourCue;
  glyph.setAttribute("aria-hidden", "true");
  const status = element("strong", "attachment-authority__status", model.statusLabel);
  status.dataset.statusLabel = model.visibleState;
  header.append(glyph, status);

  const description = element("p", "attachment-authority__description", model.description);
  const authority = element("p", "attachment-authority__authority", model.authority.label);
  authority.dataset.authoritySource = model.authority.kind;
  const access = element("p", "attachment-authority__access", model.accessLabel);
  access.dataset.accessProjection = model.readOnly ? "read-only" : "authorized";
  card.append(header, description, authority, access);

  if (model.metadata !== undefined) card.append(renderMetadata(model.metadata));

  if (model.progress !== undefined) {
    const progressRegion = element("section", "attachment-authority__progress");
    const progress = element("progress", "attachment-authority__progress-meter");
    progress.value = model.progress.acknowledgedBytes;
    progress.max = model.progress.totalBytes;
    progress.setAttribute("aria-label", "服务端已确认的上传字节进度");
    const progressText = element(
      "span",
      "attachment-authority__progress-text",
      `${formatByteCount(model.progress.acknowledgedBytes)} / ${formatByteCount(model.progress.totalBytes)} · ${model.progress.percentage}%`,
    );
    progressRegion.append(progress, progressText);
    card.append(progressRegion);
  }

  if (model.error !== undefined) {
    const error = element(
      "section",
      "attachment-authority__error",
      `ERROR · HTTP ${model.error.httpStatus} · ${model.error.code}。${model.error.recoveryLabel}。`,
    );
    error.dataset.attachmentError = "closed";
    error.tabIndex = -1;
    card.append(error);
  }

  const previewPolicy = element(
    "p",
    "attachment-authority__preview-policy",
    "预览内容不进入状态通告，并且每次打开都重新授权。",
  );
  previewPolicy.dataset.attachmentPreviewPolicy = "bounded";
  previewPolicy.setAttribute("aria-live", model.previewLive);
  card.append(previewPolicy, renderActions(model, actions));
  for (const button of card.querySelectorAll<HTMLElement>("[data-action]")) {
    const action = button.dataset.action as AttachmentActionKind | undefined;
    if (action !== undefined && options.actionNames?.[action] !== undefined) {
      button.dataset.action = options.actionNames[action];
    }
  }
  root.append(...(options.announce === false ? [card] : [live, card]));

  if (model.focusTarget === "error-summary") {
    root.querySelector<HTMLElement>("[data-attachment-error]")?.focus();
  } else if (model.focusTarget === "recovery-action") {
    root.querySelector<HTMLElement>("[data-attachment-recovery]")?.focus();
  }
}
