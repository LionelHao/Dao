import {
  isAttachmentError,
  isAttachmentFormat,
  isAttachmentMetadata,
  type AttachmentDetectedMime,
  type AttachmentError,
  type AttachmentFormat,
  type AttachmentMetadata,
  type AttachmentSourceEligibility,
} from "@native-im/core";

export const ATTACHMENT_AUTHORITY_IPC_CHANNELS = Object.freeze({
  select: "attachment-authority:select",
  upload: "attachment-authority:upload",
  cancel: "attachment-authority:cancel",
  retryProcessing: "attachment-authority:retry-processing",
  status: "attachment-authority:status",
  preview: "attachment-authority:preview",
  download: "attachment-authority:download",
  removeSelection: "attachment-authority:remove-selection",
  authorityInput: "attachment-authority:authority-input",
} as const);

export type AttachmentSelection = Readonly<{
  selectionHandle: string;
  displayName: string;
  format: AttachmentFormat;
  declaredMime: AttachmentDetectedMime;
  byteSize: number;
  expiresAt: string;
}>;

export type AttachmentSelectResult =
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "selected"; selection: AttachmentSelection }>;

export type AttachmentUploadIntent = Readonly<{
  type: "attachment.upload";
  roomId: string;
  selectionHandle: string;
}>;
export type AttachmentCancelIntent = Readonly<{
  type: "attachment.cancel";
  operationId: string;
}>;
export type AttachmentRetryIntent = Readonly<{
  type: "attachment.processing.retry";
  attachmentId: string;
  expectedGeneration: number;
}>;
export type AttachmentStatusQuery = Readonly<{
  type: "attachment.status.query";
  attachmentId: string;
}>;
export type AttachmentPreviewIntent = Readonly<{
  type: "attachment.preview";
  attachmentId: string;
  representation: "safe-rendered" | "extracted-text";
}>;
export type AttachmentDownloadIntent = Readonly<{
  type: "attachment.download";
  attachmentId: string;
}>;
export type AttachmentRemoveSelectionIntent = Readonly<{
  type: "attachment.selection.remove";
  selectionHandle: string;
}>;
export type AttachmentOperationReceipt = Readonly<{ operationId: string }>;

export type AttachmentStatusResult = Readonly<{
  type: "attachment.status";
  attachment: AttachmentMetadata;
  sourceEligibility: AttachmentSourceEligibility;
  accessProjection: "authorized" | "archived-read-only";
}>;

export type AttachmentPreviewPolicy = Readonly<{
  type: "attachment.preview.policy";
  attachmentId: string;
  representation: "safe-rendered" | "extracted-text";
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  allowNavigation: false;
  allowWindowOpen: false;
  allowPermissions: false;
  allowExternalProtocols: false;
  allowNetwork: false;
  ariaLive: "off";
}>;

export type AttachmentDownloadResult =
  | Readonly<{ type: "attachment.download.cancelled"; attachmentId: string }>
  | Readonly<{ type: "attachment.download.saved"; attachmentId: string }>;

export type AttachmentAuthorityBridgeInput =
  | Readonly<{
      type: "attachment.upload.progress";
      operationId: string;
      acknowledgedBytes: number;
      totalBytes: number;
    }>
  | Readonly<{
      type: "attachment.upload.accepted";
      operationId: string;
      attachmentId: string;
      processingStatus: "accepted-quarantined";
    }>
  | Readonly<{
      type: "attachment.operation.error";
      operationId: string;
      error: AttachmentError;
    }>
  | Readonly<{
      type: "attachment.operation.cancelled";
      operationId: string;
    }>
  | AttachmentStatusResult
  | Readonly<{
      type: "attachment.authority.revoked";
      reason: "session_revoked" | "membership_revoked" | "terminal_auth_failure";
    }>;

export interface AttachmentAuthorityBridge {
  select(): Promise<AttachmentSelectResult>;
  upload(intent: AttachmentUploadIntent): Promise<AttachmentOperationReceipt>;
  cancel(intent: AttachmentCancelIntent): Promise<AttachmentOperationReceipt>;
  retryProcessing(intent: AttachmentRetryIntent): Promise<AttachmentOperationReceipt>;
  status(query: AttachmentStatusQuery): Promise<AttachmentStatusResult>;
  preview(intent: AttachmentPreviewIntent): Promise<AttachmentPreviewPolicy>;
  download(intent: AttachmentDownloadIntent): Promise<AttachmentDownloadResult>;
  removeSelection(intent: AttachmentRemoveSelectionIntent): Promise<void>;
  onAuthorityInput(listener: (input: AttachmentAuthorityBridgeInput) => void): () => void;
}

type UnknownRecord = Record<string, unknown>;
function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function keys(value: UnknownRecord, required: readonly string[]): boolean {
  const allowed = new Set(required);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function filename(value: unknown): value is string {
  return id(value) && new TextEncoder().encode(value).byteLength <= 255 &&
    !/[\\/]/u.test(value) && !/^[a-z][a-z0-9+.-]*:/iu.test(value);
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0;
}

function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function mime(value: unknown): value is AttachmentDetectedMime {
  return typeof value === "string" && new Set([
    "application/pdf", "image/png", "image/jpeg",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain", "text/csv",
  ]).has(value);
}

export function isAttachmentSelection(value: unknown): value is AttachmentSelection {
  return record(value) && keys(value, [
    "selectionHandle", "displayName", "format", "declaredMime", "byteSize", "expiresAt",
  ]) && id(value.selectionHandle) && filename(value.displayName) &&
    isAttachmentFormat(value.format) && mime(value.declaredMime) &&
    positive(value.byteSize) && value.byteSize <= 52_428_800 && iso(value.expiresAt);
}

export function isAttachmentSelectResult(value: unknown): value is AttachmentSelectResult {
  return record(value) && (
    (keys(value, ["status"]) && value.status === "cancelled") ||
    (keys(value, ["status", "selection"]) && value.status === "selected" &&
      isAttachmentSelection(value.selection))
  );
}

export function isAttachmentUploadIntent(value: unknown): value is AttachmentUploadIntent {
  return record(value) && keys(value, ["type", "roomId", "selectionHandle"]) &&
    value.type === "attachment.upload" && id(value.roomId) && id(value.selectionHandle);
}
export function isAttachmentCancelIntent(value: unknown): value is AttachmentCancelIntent {
  return record(value) && keys(value, ["type", "operationId"]) &&
    value.type === "attachment.cancel" && id(value.operationId);
}
export function isAttachmentRetryIntent(value: unknown): value is AttachmentRetryIntent {
  return record(value) && keys(value, ["type", "attachmentId", "expectedGeneration"]) &&
    value.type === "attachment.processing.retry" && id(value.attachmentId) && positive(value.expectedGeneration);
}
export function isAttachmentStatusQuery(value: unknown): value is AttachmentStatusQuery {
  return record(value) && keys(value, ["type", "attachmentId"]) &&
    value.type === "attachment.status.query" && id(value.attachmentId);
}
export function isAttachmentPreviewIntent(value: unknown): value is AttachmentPreviewIntent {
  return record(value) && keys(value, ["type", "attachmentId", "representation"]) &&
    value.type === "attachment.preview" && id(value.attachmentId) &&
    (value.representation === "safe-rendered" || value.representation === "extracted-text");
}
export function isAttachmentDownloadIntent(value: unknown): value is AttachmentDownloadIntent {
  return record(value) && keys(value, ["type", "attachmentId"]) &&
    value.type === "attachment.download" && id(value.attachmentId);
}
export function isAttachmentRemoveSelectionIntent(value: unknown): value is AttachmentRemoveSelectionIntent {
  return record(value) && keys(value, ["type", "selectionHandle"]) &&
    value.type === "attachment.selection.remove" && id(value.selectionHandle);
}
export function isAttachmentOperationReceipt(value: unknown): value is AttachmentOperationReceipt {
  return record(value) && keys(value, ["operationId"]) && id(value.operationId);
}
export function isAttachmentStatusResult(value: unknown): value is AttachmentStatusResult {
  if (!record(value) || !keys(value, [
    "type", "attachment", "sourceEligibility", "accessProjection",
  ]) || value.type !== "attachment.status" || !isAttachmentMetadata(value.attachment) ||
      (value.sourceEligibility !== "unbound" && value.sourceEligibility !== "bound-active" &&
        value.sourceEligibility !== "excluded-recalled") ||
      (value.accessProjection !== "authorized" && value.accessProjection !== "archived-read-only")) {
    return false;
  }
  if (value.sourceEligibility === "unbound") return value.attachment.sourceMessageId === null;
  return value.attachment.processingStatus === "ready" && value.attachment.sourceMessageId !== null;
}
export function isAttachmentPreviewPolicy(value: unknown): value is AttachmentPreviewPolicy {
  return record(value) && keys(value, [
    "type", "attachmentId", "representation", "nodeIntegration", "contextIsolation",
    "sandbox", "webSecurity", "allowNavigation", "allowWindowOpen", "allowPermissions",
    "allowExternalProtocols", "allowNetwork", "ariaLive",
  ]) && value.type === "attachment.preview.policy" && id(value.attachmentId) &&
    (value.representation === "safe-rendered" || value.representation === "extracted-text") &&
    value.nodeIntegration === false && value.contextIsolation === true && value.sandbox === true &&
    value.webSecurity === true && value.allowNavigation === false && value.allowWindowOpen === false &&
    value.allowPermissions === false && value.allowExternalProtocols === false &&
    value.allowNetwork === false && value.ariaLive === "off";
}
export function isAttachmentDownloadResult(value: unknown): value is AttachmentDownloadResult {
  return record(value) && keys(value, ["type", "attachmentId"]) && id(value.attachmentId) &&
    (value.type === "attachment.download.cancelled" || value.type === "attachment.download.saved");
}

export function isAttachmentAuthorityBridgeInput(value: unknown): value is AttachmentAuthorityBridgeInput {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "attachment.upload.progress":
      return keys(value, ["type", "operationId", "acknowledgedBytes", "totalBytes"]) &&
        id(value.operationId) && nonnegative(value.acknowledgedBytes) && positive(value.totalBytes) &&
        value.acknowledgedBytes <= value.totalBytes;
    case "attachment.upload.accepted":
      return keys(value, ["type", "operationId", "attachmentId", "processingStatus"]) &&
        id(value.operationId) && id(value.attachmentId) && value.processingStatus === "accepted-quarantined";
    case "attachment.operation.error":
      return keys(value, ["type", "operationId", "error"]) && id(value.operationId) && isAttachmentError(value.error);
    case "attachment.operation.cancelled":
      return keys(value, ["type", "operationId"]) && id(value.operationId);
    case "attachment.status": return isAttachmentStatusResult(value);
    case "attachment.authority.revoked":
      return keys(value, ["type", "reason"]) &&
        (value.reason === "session_revoked" || value.reason === "membership_revoked" || value.reason === "terminal_auth_failure");
    default: return false;
  }
}

function clone<T>(value: unknown, guard: (input: unknown) => input is T, label: string): T {
  if (!guard(value)) throw new TypeError(`Invalid Attachment Authority ${label}`);
  return structuredClone(value);
}

export const cloneAttachmentSelectResult = (value: unknown) => clone(value, isAttachmentSelectResult, "select result");
export const cloneAttachmentOperationReceipt = (value: unknown) => clone(value, isAttachmentOperationReceipt, "operation receipt");
export const cloneAttachmentStatusResult = (value: unknown) => clone(value, isAttachmentStatusResult, "status result");
export const cloneAttachmentPreviewPolicy = (value: unknown) => clone(value, isAttachmentPreviewPolicy, "preview policy");
export const cloneAttachmentDownloadResult = (value: unknown) => clone(value, isAttachmentDownloadResult, "download result");
export const cloneAttachmentAuthorityBridgeInput = (value: unknown) => clone(value, isAttachmentAuthorityBridgeInput, "input");
