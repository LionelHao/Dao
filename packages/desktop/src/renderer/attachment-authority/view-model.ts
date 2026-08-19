import {
  isAttachmentFormat,
  isAttachmentReadyProvenance,
  isAttachmentSha256,
  type AttachmentFormat,
  type AttachmentMetadata,
  type AttachmentReadyProvenance,
} from "@native-im/core";

export type AttachmentVisibleState =
  | "local-selected"
  | "uploading"
  | "processing"
  | "ready"
  | "retryable-failure"
  | "nonretryable-failure"
  | "cancelled"
  | "size-type-rejected"
  | "malware-rejected"
  | "permission-revoked";

type Error400 = {
  readonly status: 400;
  readonly code: "invalid_request" | "invalid_chunk";
};

type Error401 = {
  readonly status: 401;
  readonly code: "unauthenticated";
};

type Error403 = {
  readonly status: 403;
  readonly code: "room_forbidden" | "attachment_forbidden";
};

type Error409 = {
  readonly status: 409;
  readonly code:
    | "idempotency_conflict"
    | "upload_offset_conflict"
    | "attachment_already_bound"
    | "attachment_not_ready"
    | "generation_conflict";
};

type Error410 = {
  readonly status: 410;
  readonly code: "upload_expired" | "attachment_gone" | "protocol_upgrade_required";
};

type Error413 = {
  readonly status: 413;
  readonly code: "attachment_too_large" | "chunk_too_large";
};

type Error415 = {
  readonly status: 415;
  readonly code: "attachment_type_unsupported" | "type_mismatch";
};

type Error422 = {
  readonly status: 422;
  readonly code: "attachment_malformed" | "encrypted_pdf" | "archive_bomb" | "image_bomb";
};

type Error429 = {
  readonly status: 429;
  readonly code: "attachment_capacity_limited";
  readonly retryAfterSeconds?: number;
};

type Error503 = {
  readonly status: 503;
  readonly code:
    | "storage_unavailable"
    | "scanner_unavailable"
    | "extractor_unavailable"
    | "ocr_unavailable"
    | "repair_barrier_active";
};

export type AttachmentClosedError =
  | Error400
  | Error401
  | Error403
  | Error409
  | Error410
  | Error413
  | Error415
  | Error422
  | Error429
  | Error503;

type RetryableError = Error401 | Error409 | Error429 | Error503;
type NonretryableError = Error400 | Error410 | Error413 | Error415 | Error422;
type LocalPreflightError = Error413 | Error415;

export type LocalTransportAxis =
  | { readonly status: "none" }
  | { readonly status: "selected" }
  | {
      readonly status: "uploading";
      readonly acknowledgedBytes: number;
      readonly totalBytes: number;
    }
  | { readonly status: "local-rejected"; readonly error: LocalPreflightError }
  | { readonly status: "transport-failed"; readonly error: RetryableError };

export type ServerAuthoritySource = "server-ack" | "stable-event" | "projection";

export type DurableAttachmentAxis =
  | { readonly status: "open" }
  | {
      readonly status: "accepted-quarantined";
      readonly authoritySource: ServerAuthoritySource;
    }
  | {
      readonly status: "processing";
      readonly phase: "scanning" | "extracting" | "ocr";
      readonly authoritySource: ServerAuthoritySource;
    }
  | {
      readonly status: "ready";
      readonly authoritySource: ServerAuthoritySource;
    }
  | {
      readonly status: "retryable-failed";
      readonly authoritySource: ServerAuthoritySource;
      readonly error?: RetryableError;
    }
  | {
      readonly status: "nonretryable-failed";
      readonly authoritySource: ServerAuthoritySource;
      readonly error?: NonretryableError;
    }
  | {
      readonly status: "malware-rejected";
      readonly authoritySource: "stable-event" | "projection";
    }
  | {
      readonly status: "cancelled";
      readonly authoritySource: ServerAuthoritySource;
    };

export type SourceEligibilityAxis = "unbound" | "bound-active" | "excluded-recalled";

export type AccessProjectionAxis =
  | "authorized"
  | "permission-revoked"
  | "archived-read-only"
  | "offline"
  | "repairing";

export interface SafeAttachmentMetadata {
  readonly displayName: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly format?: AttachmentFormat;
  readonly sha256?: string;
  readonly provenance?: AttachmentReadyProvenance | null;
}

export interface AttachmentAuthorityInput {
  readonly localTransport: LocalTransportAxis;
  readonly durable: DurableAttachmentAxis;
  readonly sourceEligibility: SourceEligibilityAxis;
  readonly accessProjection: AccessProjectionAxis;
  readonly metadata?: SafeAttachmentMetadata;
  readonly closedError?: AttachmentClosedError;
  readonly allowCancel?: boolean;
  readonly reducedMotion?: boolean;
}

export function mapAttachmentMetadataForView(
  attachment: AttachmentMetadata,
): SafeAttachmentMetadata {
  return Object.freeze({
    displayName: attachment.originalFilename,
    byteSize: attachment.byteSize,
    mediaType: attachment.detectedMime,
    format: attachment.format,
    sha256: attachment.sha256,
    provenance: attachment.provenance,
  });
}

export type AttachmentActionKind =
  | "upload"
  | "cancel"
  | "retry"
  | "bind"
  | "preview"
  | "download"
  | "remove"
  | "reauthenticate"
  | "refresh-projection"
  | "restart-upload"
  | "select-replacement"
  | "upgrade-client";

export interface AttachmentAction {
  readonly kind: AttachmentActionKind;
  readonly label: string;
}

export interface AttachmentProgress {
  readonly acknowledgedBytes: number;
  readonly totalBytes: number;
  readonly percentage: number;
}

export interface AttachmentAuthorityLabel {
  readonly kind: "local-transient" | ServerAuthoritySource;
  readonly label: string;
}

export interface AttachmentErrorPresentation {
  readonly httpStatus: AttachmentClosedError["status"];
  readonly code: AttachmentClosedError["code"];
  readonly recoveryLabel: string;
}

export interface AttachmentAuthorityViewModel {
  readonly visibleState: AttachmentVisibleState;
  readonly statusLabel: string;
  readonly statusGlyph: string;
  readonly nonColourCue: string;
  readonly description: string;
  readonly authority: AttachmentAuthorityLabel;
  readonly metadata?: SafeAttachmentMetadata;
  readonly progress?: AttachmentProgress;
  readonly error?: AttachmentErrorPresentation;
  readonly actions: readonly AttachmentAction[];
  readonly visibility: "visible" | "excluded";
  readonly readOnly: boolean;
  readonly accessLabel: string;
  readonly liveAnnouncement: string;
  readonly previewLive: "off";
  readonly focusTarget: "none" | "error-summary" | "recovery-action";
  readonly motion: "standard" | "reduced";
}

const actionLabels: Readonly<Record<AttachmentActionKind, string>> = {
  upload: "开始上传",
  cancel: "取消",
  retry: "重试",
  bind: "随消息发送",
  preview: "预览",
  download: "下载",
  remove: "移除",
  reauthenticate: "重新认证",
  "refresh-projection": "载入最新状态",
  "restart-upload": "新建上传",
  "select-replacement": "选择其他文件",
  "upgrade-client": "升级客户端",
};

const statePresentation: Readonly<Record<AttachmentVisibleState, {
  readonly statusLabel: string;
  readonly statusGlyph: string;
  readonly nonColourCue: string;
  readonly description: string;
  readonly liveAnnouncement: string;
}>> = {
  "local-selected": {
    statusLabel: "LOCAL SELECTED",
    statusGlyph: "+",
    nonColourCue: "ICON SELECT + LINE DASHED",
    description: "仅本地选择，尚未上传或产生服务端附件事实。",
    liveAnnouncement: "已选择附件，可开始上传或移除。",
  },
  uploading: {
    statusLabel: "UPLOADING",
    statusGlyph: "↑",
    nonColourCue: "ICON UPLOAD + LINE SOLID",
    description: "进度只来自服务端分片 checkpoint；尚未产生 READY 事实。",
    liveAnnouncement: "附件上传中，可取消。",
  },
  processing: {
    statusLabel: "PROCESSING",
    statusGlyph: "…",
    nonColourCue: "ICON PROCESS + LINE SOLID",
    description: "服务端正在扫描、提取或 OCR；当前不可绑定。",
    liveAnnouncement: "附件处理中，可取消。",
  },
  ready: {
    statusLabel: "READY",
    statusGlyph: "✓",
    nonColourCue: "ICON READY + LINE DOUBLE",
    description: "服务端已确认可用；绑定与每次访问仍由当前权限决定。",
    liveAnnouncement: "附件已就绪。",
  },
  "retryable-failure": {
    statusLabel: "RETRYABLE FAILURE",
    statusGlyph: "↻",
    nonColourCue: "ICON RETRY + LINE DASHED",
    description: "没有产生新的 READY 事实；需显式恢复。",
    liveAnnouncement: "附件操作暂时失败，请使用恢复动作。",
  },
  "nonretryable-failure": {
    statusLabel: "NONRETRYABLE FAILURE",
    statusGlyph: "!",
    nonColourCue: "ICON ERROR + LINE DOUBLE",
    description: "当前文件不能安全处理；不会自动改写 metadata 或重试。",
    liveAnnouncement: "附件无法安全处理，请选择其他文件或按提示恢复。",
  },
  cancelled: {
    statusLabel: "CANCELLED",
    statusGlyph: "×",
    nonColourCue: "ICON CANCEL + LINE DOUBLE",
    description: "取消已闭合；不会显示成功或恢复迟到处理结果。",
    liveAnnouncement: "附件上传已取消。",
  },
  "size-type-rejected": {
    statusLabel: "SIZE / TYPE REJECTED",
    statusGlyph: "!",
    nonColourCue: "ICON REJECT + LINE DOUBLE",
    description: "文件大小或类型不在安全闭集；服务端拒绝会覆盖本地预检。",
    liveAnnouncement: "附件大小或类型不受支持，请选择其他文件。",
  },
  "malware-rejected": {
    statusLabel: "MALWARE REJECTED",
    statusGlyph: "⊘",
    nonColourCue: "ICON BLOCK + LINE DOUBLE",
    description: "安全扫描已隔离该附件；不可预览、下载、绑定或进入 Agent context。",
    liveAnnouncement: "附件被安全扫描拒绝，不能继续使用。",
  },
  "permission-revoked": {
    statusLabel: "PERMISSION REVOKED",
    statusGlyph: "LOCK",
    nonColourCue: "LOCK ICON + LINE DOUBLE",
    description: "当前权限已撤销；可见 metadata 与访问动作已清除。",
    liveAnnouncement: "附件权限已撤销，请重新认证。",
  },
};

function action(kind: AttachmentActionKind): AttachmentAction {
  return { kind, label: actionLabels[kind] };
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateMetadata(metadata: SafeAttachmentMetadata | undefined): void {
  if (metadata === undefined) return;
  if (metadata.displayName.length === 0 || metadata.displayName.length > 255 ||
      metadata.displayName.includes("/") || metadata.displayName.includes("\\") ||
      hasControlCharacter(metadata.displayName)) {
    throw new TypeError("displayName is not safe metadata");
  }
  if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 0) {
    throw new TypeError("byteSize is invalid");
  }
  if (metadata.mediaType.length === 0 || metadata.mediaType.length > 128 ||
      hasControlCharacter(metadata.mediaType)) {
    throw new TypeError("mediaType is invalid");
  }
  if (metadata.format !== undefined && !isAttachmentFormat(metadata.format)) {
    throw new TypeError("format is invalid");
  }
  if (metadata.sha256 !== undefined && !isAttachmentSha256(metadata.sha256)) {
    throw new TypeError("sha256 is invalid");
  }
  if (metadata.provenance !== undefined && metadata.provenance !== null &&
      !isAttachmentReadyProvenance(metadata.provenance)) {
    throw new TypeError("provenance is invalid");
  }
}

function validateInput(input: AttachmentAuthorityInput): void {
  validateMetadata(input.metadata);
  if (input.localTransport.status === "uploading") {
    const { acknowledgedBytes, totalBytes } = input.localTransport;
    if (!Number.isSafeInteger(acknowledgedBytes) || !Number.isSafeInteger(totalBytes) ||
        acknowledgedBytes < 0 || totalBytes <= 0 || acknowledgedBytes > totalBytes ||
        (input.metadata !== undefined && totalBytes !== input.metadata.byteSize)) {
      throw new TypeError("upload progress is invalid");
    }
  }
  if (input.durable.status === "ready" && input.durable.authoritySource === "server-ack") {
    throw new TypeError("ready requires a stable event or projection");
  }
  if ((input.sourceEligibility === "bound-active" || input.sourceEligibility === "excluded-recalled") &&
      input.durable.status !== "ready") {
    throw new TypeError("a source attachment must be durably ready");
  }
  const retryAfterSeconds = input.closedError?.status === 429
    ? input.closedError.retryAfterSeconds
    : undefined;
  if (retryAfterSeconds !== undefined &&
      (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 3600)) {
    throw new TypeError("retry hint is invalid");
  }
}

function resolveVisibleState(input: AttachmentAuthorityInput): AttachmentVisibleState {
  if (input.accessProjection === "permission-revoked" || input.closedError?.status === 403) {
    return "permission-revoked";
  }
  if (input.durable.status === "malware-rejected") return "malware-rejected";
  if (input.closedError?.status === 413 || input.closedError?.status === 415 ||
      input.localTransport.status === "local-rejected") {
    return "size-type-rejected";
  }
  if (input.durable.status === "nonretryable-failed") return "nonretryable-failure";
  if (input.durable.status === "cancelled") return "cancelled";
  if (input.closedError?.status === 410 || input.closedError?.status === 422) {
    return "nonretryable-failure";
  }
  if (input.closedError?.status === 400) return "nonretryable-failure";
  if (input.durable.status === "retryable-failed" ||
      input.localTransport.status === "transport-failed" ||
      input.closedError?.status === 401 || input.closedError?.status === 409 ||
      input.closedError?.status === 429 || input.closedError?.status === 503) {
    return "retryable-failure";
  }
  if (input.durable.status === "accepted-quarantined" || input.durable.status === "processing") {
    return "processing";
  }
  if (input.durable.status === "ready") return "ready";
  if (input.localTransport.status === "uploading") return "uploading";
  if (input.localTransport.status === "selected") return "local-selected";
  throw new TypeError("the four axes do not map to a visible attachment state");
}

function durableAuthority(source: ServerAuthoritySource, state: AttachmentVisibleState): AttachmentAuthorityLabel {
  if (source === "server-ack") {
    return { kind: source, label: "SERVER ACK · attachment accepted" };
  }
  if (source === "stable-event") {
    const eventFact: Readonly<Partial<Record<AttachmentVisibleState, string>>> = {
      processing: "attachment.processing",
      ready: "attachment.ready",
      "retryable-failure": "attachment.processing_failed",
      "nonretryable-failure": "attachment.rejected",
      cancelled: "attachment.cancelled",
      "malware-rejected": "attachment.malware_rejected",
    };
    return { kind: source, label: `SERVER EVT · ${eventFact[state] ?? "attachment.status"}` };
  }
  return { kind: source, label: "SERVER PROJ · canonical attachment status" };
}

function resolveAuthority(input: AttachmentAuthorityInput, state: AttachmentVisibleState): AttachmentAuthorityLabel {
  if (state === "permission-revoked") {
    return input.closedError?.status === 403
      ? { kind: "server-ack", label: "SERVER ACK · access forbidden" }
      : { kind: "projection", label: "SERVER PROJ · permission revoked" };
  }
  if (state === "malware-rejected" && input.durable.status === "malware-rejected") {
    return durableAuthority(input.durable.authoritySource, state);
  }
  if (state === "nonretryable-failure" && input.durable.status === "nonretryable-failed") {
    return durableAuthority(input.durable.authoritySource, state);
  }
  if (state === "cancelled" && input.durable.status === "cancelled") {
    return durableAuthority(input.durable.authoritySource, state);
  }
  if (input.closedError !== undefined) {
    const label = input.closedError.status === 413 || input.closedError.status === 415
      ? "SERVER ACK · authoritative reject"
      : "SERVER ACK · closed attachment error";
    return { kind: "server-ack", label };
  }
  if (state === "local-selected") return { kind: "local-transient", label: "LOCAL · selection metadata" };
  if (state === "uploading") return { kind: "server-ack", label: "SERVER ACK · chunk checkpoint" };
  if (state === "size-type-rejected" && input.localTransport.status === "local-rejected") {
    return { kind: "local-transient", label: "LOCAL · preflight" };
  }
  if (input.durable.status !== "open") {
    return durableAuthority(input.durable.authoritySource, state);
  }
  if (input.localTransport.status === "transport-failed") {
    return { kind: "server-ack", label: "SERVER ACK · closed attachment error" };
  }
  return { kind: "local-transient", label: "LOCAL · transient" };
}

function effectiveError(
  input: AttachmentAuthorityInput,
  state: AttachmentVisibleState,
): AttachmentClosedError | undefined {
  if (state === "permission-revoked") {
    return input.closedError?.status === 403 ? input.closedError : undefined;
  }
  if (state === "malware-rejected" || state === "cancelled" || state === "processing" ||
      state === "ready" || state === "uploading" || state === "local-selected") {
    return undefined;
  }
  if (input.closedError !== undefined) return input.closedError;
  if ((state === "size-type-rejected" && input.localTransport.status === "local-rejected") ||
      (state === "retryable-failure" && input.localTransport.status === "transport-failed")) {
    return input.localTransport.error;
  }
  if (input.durable.status === "retryable-failed" || input.durable.status === "nonretryable-failed") {
    return input.durable.error;
  }
  return undefined;
}

function recoveryFor(error: AttachmentClosedError): { readonly kind: AttachmentActionKind; readonly label: string } {
  switch (error.status) {
    case 400:
      return { kind: "select-replacement", label: "重新选择文件并开始新的闭合上传" };
    case 401:
    case 403:
      return { kind: "reauthenticate", label: "重新认证后重新取得当前权限" };
    case 409:
      return { kind: "refresh-projection", label: "载入最新权威状态后决定下一步" };
    case 410:
      if (error.code === "protocol_upgrade_required") {
        return { kind: "upgrade-client", label: "升级客户端后重新开始" };
      }
      if (error.code === "upload_expired") {
        return { kind: "restart-upload", label: "新建上传；旧 upload 不会复活" };
      }
      return { kind: "select-replacement", label: "附件已不可用，请选择其他文件" };
    case 413:
      return error.code === "chunk_too_large"
        ? { kind: "upgrade-client", label: "客户端分片不符合协议上限，请升级后重新上传" }
        : { kind: "select-replacement", label: "选择符合安全限制的其他文件" };
    case 415:
    case 422:
      return { kind: "select-replacement", label: "选择符合安全限制的其他文件" };
    case 429:
      return {
        kind: "retry",
        label: error.retryAfterSeconds === undefined
          ? "按服务端提示后显式重试"
          : `${error.retryAfterSeconds} 秒后显式重试`,
      };
    case 503:
      return { kind: "retry", label: "依赖恢复后显式重试；当前不会 READY" };
  }
}

function actionsFor(
  input: AttachmentAuthorityInput,
  state: AttachmentVisibleState,
  error: AttachmentClosedError | undefined,
): readonly AttachmentAction[] {
  if (input.sourceEligibility === "excluded-recalled") return [];
  if (state === "permission-revoked") return [action("reauthenticate")];
  if (input.accessProjection === "offline" || input.accessProjection === "repairing") return [];
  if (input.accessProjection === "archived-read-only") {
    return state === "ready" && input.sourceEligibility === "bound-active"
      ? [action("preview"), action("download")]
      : [];
  }
  if (state === "local-selected") return [action("upload"), action("remove")];
  if (state === "uploading" || state === "processing") {
    return input.allowCancel === false ? [] : [action("cancel")];
  }
  if (state === "ready") {
    return input.sourceEligibility === "unbound"
      ? [action("bind"), action("remove")]
      : [action("preview"), action("download")];
  }
  if (state === "malware-rejected") return [action("remove")];
  if (state === "cancelled") return [action("select-replacement"), action("remove")];
  if (state === "retryable-failure" && error === undefined) {
    return [action("retry"), action("remove")];
  }
  if (state === "nonretryable-failure" && error === undefined) {
    return [action("select-replacement"), action("remove")];
  }
  if (error !== undefined) {
    const recovery = recoveryFor(error);
    return recovery.kind === "retry" || recovery.kind === "select-replacement"
      ? [action(recovery.kind), action("remove")]
      : [action(recovery.kind)];
  }
  return [action("remove")];
}

function accessLabel(access: AccessProjectionAxis): string {
  switch (access) {
    case "authorized": return "ONLINE · authorized projection";
    case "permission-revoked": return "REVOKED · projection purge required";
    case "archived-read-only": return "ARCHIVED · read-only projection";
    case "offline": return "OFFLINE · last complete projection · access not revalidated";
    case "repairing": return "REPAIRING · old complete projection · staging hidden";
  }
}

export function createAttachmentAuthorityViewModel(
  input: AttachmentAuthorityInput,
): AttachmentAuthorityViewModel {
  validateInput(input);
  const visibleState = resolveVisibleState(input);
  const presentation = statePresentation[visibleState];
  const error = effectiveError(input, visibleState);
  const visibility = input.sourceEligibility === "excluded-recalled" ? "excluded" : "visible";
  const progress = visibleState === "uploading" && input.localTransport.status === "uploading"
    ? {
        acknowledgedBytes: input.localTransport.acknowledgedBytes,
        totalBytes: input.localTransport.totalBytes,
        percentage: Math.floor((input.localTransport.acknowledgedBytes / input.localTransport.totalBytes) * 100),
      }
    : undefined;
  const errorPresentation = error === undefined
    ? undefined
    : {
        httpStatus: error.status,
        code: error.code,
        recoveryLabel: recoveryFor(error).label,
      };
  const visibleMetadata = visibility === "visible" && visibleState !== "permission-revoked" && input.metadata !== undefined
    ? { ...input.metadata }
    : undefined;

  return {
    visibleState,
    ...presentation,
    statusLabel: visibleState === "processing" && input.durable.status === "processing" && input.durable.phase === "ocr"
      ? "PROCESSING / OCR"
      : presentation.statusLabel,
    authority: resolveAuthority(input, visibleState),
    ...(visibleMetadata === undefined ? {} : { metadata: visibleMetadata }),
    ...(progress === undefined ? {} : { progress }),
    ...(errorPresentation === undefined ? {} : { error: errorPresentation }),
    actions: actionsFor(input, visibleState, error),
    visibility,
    readOnly: input.accessProjection !== "authorized",
    accessLabel: accessLabel(input.accessProjection),
    previewLive: "off",
    focusTarget: visibleState === "permission-revoked"
      ? "recovery-action"
      : errorPresentation === undefined ? "none" : "error-summary",
    motion: input.reducedMotion === true ? "reduced" : "standard",
  };
}
