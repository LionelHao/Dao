export type MemoryKind =
  | "goal"
  | "decision"
  | "context"
  | "next_action"
  | "open_question_or_blocker";

export type MemoryVersionState =
  | "proposal"
  | "active"
  | "disputed"
  | "review_required"
  | "resolved"
  | "superseded"
  | "invalidated"
  | "confirmed_project_reference";

export type MemoryHealthStatus = "healthy" | "catching_up" | "noauth" | "degraded" | "failed";
export type MemoryPanelVisibleState =
  | "loading"
  | "empty"
  | "healthy"
  | "catching-up"
  | "noauth"
  | "degraded"
  | "recovery-required"
  | "offline"
  | "repairing"
  | "repair-failed"
  | "archived-read-only"
  | "revoked";

export type MemorySourceNavigation =
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "tombstone"; readonly messageId: string }
  | { readonly kind: "attachment"; readonly attachmentId: string }
  | { readonly kind: "project_fact"; readonly projectFactId: string };

export interface MemorySourceProjection {
  readonly sourceId: string;
  readonly sourceKind: "message" | "message_revision" | "message_tombstone" | "attachment_extraction" | "project_fact_checkpoint";
  readonly revision: number;
  readonly availability: "active" | "revised" | "recalled" | "unavailable";
  readonly navigation: MemorySourceNavigation;
}

export interface MemoryProjection {
  readonly memoryRecordId: string;
  readonly version: number;
  readonly kind: MemoryKind;
  readonly state: MemoryVersionState;
  readonly derivedText: string;
  readonly disputedBy?: string;
  readonly canResolve?: boolean;
  readonly projectReferenceAvailable?: boolean;
  readonly sources: readonly MemorySourceProjection[];
}

export interface MemoryHealthProjection {
  readonly status: MemoryHealthStatus;
  readonly memoryWatermark: number;
  readonly corpusHead: number;
  readonly lag: number;
  readonly retryable: boolean;
  readonly recoveryRequired: boolean;
}

export type MemoryClosedStatus = 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503;
export interface MemoryClosedError {
  readonly status: MemoryClosedStatus;
  readonly code: string;
  readonly retryAfterSeconds?: number;
}

export type MemoryPanelQuery =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly requestId: string; readonly error: MemoryClosedError };

export type MemoryPanelConnection =
  | { readonly status: "online" }
  | { readonly status: "offline" }
  | { readonly status: "repairing" }
  | { readonly status: "repair_failed" }
  | { readonly status: "revoked" };

export type MemoryPanelOperation =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly requestId: string; readonly command: "dispute" | "resolve" | "retry" }
  | { readonly status: "acknowledged"; readonly requestId: string; readonly command: "dispute" | "resolve" | "retry" }
  | { readonly status: "failed"; readonly requestId: string; readonly command: "dispute" | "resolve" | "retry"; readonly error: MemoryClosedError };

export interface MemoryPanelInput {
  readonly roomId: string;
  readonly lifecycle: "active" | "archived";
  readonly connection: MemoryPanelConnection;
  readonly query: MemoryPanelQuery;
  readonly health?: MemoryHealthProjection;
  readonly memories: readonly MemoryProjection[];
  readonly operation: MemoryPanelOperation;
  readonly viewer: { readonly actorId: string; readonly currentHuman: boolean };
  readonly reducedMotion: boolean;
}

export interface MemorySourceCardViewModel {
  readonly sourceId: string;
  readonly revision: number;
  readonly availability: MemorySourceProjection["availability"];
  readonly availabilityLabel: string;
  readonly navigation: MemorySourceNavigation;
}

export interface MemoryCardViewModel {
  readonly memoryRecordId: string;
  readonly version: number;
  readonly kind: MemoryKind;
  readonly state: MemoryVersionState;
  readonly derivedText: string;
  readonly authorityLabel: string;
  readonly injectable: boolean;
  readonly canDispute: boolean;
  readonly canResolve: boolean;
  readonly sources: readonly MemorySourceCardViewModel[];
}

export type MemoryRecovery = "correct-input" | "reauthenticate" | "purge" | "refresh" | "repair" | "retry";
export interface MemoryErrorViewModel extends MemoryClosedError {
  readonly requestId: string;
  readonly recovery: MemoryRecovery;
}

export interface MemoryAuthorityViewModel {
  readonly visibleState: MemoryPanelVisibleState;
  readonly statusLabel: string;
  readonly nonColourCue: string;
  readonly watermarkLabel: string;
  readonly liveAnnouncement: string;
  readonly writeLocked: boolean;
  readonly cards: readonly MemoryCardViewModel[];
  readonly error?: MemoryErrorViewModel;
  readonly focusTarget: "none" | "error-summary";
  readonly motion: "standard" | "reduced";
}

const visiblePresentation: Readonly<Record<MemoryPanelVisibleState, {
  readonly label: string;
  readonly cue: string;
  readonly announcement: string;
}>> = {
  loading: { label: "LOADING", cue: "ICON WAIT + TEXT LOADING", announcement: "正在载入重要记忆。" },
  empty: { label: "EMPTY", cue: "ICON EMPTY + TEXT EMPTY", announcement: "当前 Room 尚无重要记忆。" },
  healthy: { label: "MEMORY HEALTHY", cue: "ICON CHECK + TEXT HEALTHY", announcement: "重要记忆已同步。" },
  "catching-up": { label: "MEMORY CATCHING UP", cue: "ICON SYNC + TEXT CATCHING UP", announcement: "重要记忆正在追赶，聊天和显式调用仍可继续。" },
  noauth: { label: "MEMORY NOAUTH", cue: "ICON KEY + TEXT NOAUTH", announcement: "记忆提取认证未配置；聊天和显式调用仍可继续。" },
  degraded: { label: "MEMORY DEGRADED", cue: "ICON WARNING + TEXT DEGRADED", announcement: "重要记忆已降级；语义主动路由已暂停。" },
  "recovery-required": { label: "RECOVERY REQUIRED", cue: "LOCK RECOVERY + TEXT REQUIRED", announcement: "重要记忆需要恢复处理。" },
  offline: { label: "OFFLINE READ-ONLY", cue: "ICON OFFLINE + TEXT READ-ONLY", announcement: "当前离线，仅显示最后一次完整授权缓存。" },
  repairing: { label: "REPAIRING", cue: "ICON REPAIR + TEXT REPAIRING", announcement: "正在修复重要记忆投影。" },
  "repair-failed": { label: "REPAIR FAILED", cue: "ICON WARNING + TEXT REPAIR FAILED", announcement: "修复失败，已保留上一份完整授权缓存。" },
  "archived-read-only": { label: "ARCHIVED READ-ONLY", cue: "LOCK ARCHIVED + TEXT READ-ONLY", announcement: "Room 已归档，重要记忆只读。" },
  revoked: { label: "ACCESS REVOKED", cue: "LOCK REVOKED + TEXT PURGED", announcement: "Room 访问已撤销，重要记忆缓存已清除。" },
};

const kindLabel: Readonly<Record<MemoryKind, string>> = {
  goal: "GOAL",
  decision: "DECISION",
  context: "CONTEXT",
  next_action: "NEXT ACTION",
  open_question_or_blocker: "OPEN QUESTION / BLOCKER",
};
const stateLabel: Readonly<Record<MemoryVersionState, string>> = {
  proposal: "PROPOSAL",
  active: "ACTIVE",
  disputed: "DISPUTED",
  review_required: "REVIEW REQUIRED",
  resolved: "RESOLVED",
  superseded: "SUPERSEDED",
  invalidated: "INVALIDATED",
  confirmed_project_reference: "CONFIRMED PROJECT REFERENCE",
};
const availabilityLabel: Readonly<Record<MemorySourceProjection["availability"], string>> = {
  active: "SOURCE · ACTIVE",
  revised: "SOURCE · REVISED",
  recalled: "SOURCE · RECALLED TOMBSTONE",
  unavailable: "SOURCE · UNAVAILABLE",
};

function visibleState(input: MemoryPanelInput): MemoryPanelVisibleState {
  if (input.connection.status === "revoked") return "revoked";
  if (input.lifecycle === "archived") return "archived-read-only";
  if (input.connection.status === "offline") return "offline";
  if (input.connection.status === "repairing") return "repairing";
  if (input.connection.status === "repair_failed") return "repair-failed";
  if (input.query.status === "loading") return "loading";
  if (input.query.status === "failed") return "degraded";
  if (input.health?.status === "failed" || input.health?.recoveryRequired === true) return "recovery-required";
  if (input.health?.status === "noauth") return "noauth";
  if (input.health?.status === "degraded") return "degraded";
  if (input.health?.status === "catching_up") return "catching-up";
  return input.memories.length === 0 ? "empty" : "healthy";
}

function recoveryFor(status: MemoryClosedStatus): MemoryRecovery {
  if (status === 400) return "correct-input";
  if (status === 401) return "reauthenticate";
  if (status === 403) return "purge";
  if (status === 409) return "repair";
  if (status === 404 || status === 410) return "refresh";
  return "retry";
}

function queryError(query: MemoryPanelQuery): MemoryErrorViewModel | undefined {
  if (query.status !== "failed") return undefined;
  return Object.freeze({
    ...query.error,
    requestId: query.requestId,
    recovery: recoveryFor(query.error.status),
  });
}

export function createMemoryAuthorityViewModel(input: MemoryPanelInput): MemoryAuthorityViewModel {
  const state = visibleState(input);
  const presentation = visiblePresentation[state];
  const writeLocked = input.lifecycle === "archived" || input.connection.status !== "online";
  const cards = state === "revoked" ? [] : input.memories.map((memory): MemoryCardViewModel => Object.freeze({
    memoryRecordId: memory.memoryRecordId,
    version: memory.version,
    kind: memory.kind,
    state: memory.state,
    derivedText: memory.derivedText,
    authorityLabel: `${kindLabel[memory.kind]} · ${stateLabel[memory.state]}`,
    injectable: memory.kind === "context" && memory.state === "active",
    canDispute: memory.kind === "context" && memory.state === "active" && input.viewer.currentHuman && !writeLocked,
    canResolve: memory.kind === "context" && memory.state === "disputed" && memory.canResolve === true && !writeLocked,
    sources: memory.sources.map((source): MemorySourceCardViewModel => Object.freeze({
      sourceId: source.sourceId,
      revision: source.revision,
      availability: source.availability,
      availabilityLabel: availabilityLabel[source.availability],
      navigation: source.navigation,
    })),
  }));
  const health = input.health;
  const watermarkLabel = health === undefined
    ? "STEWARD · 状态不可用"
    : `STEWARD · #${health.memoryWatermark} · ${health.lag === 0 ? "已同步" : `落后 ${health.lag} 条`}`;
  const error = queryError(input.query) ?? (input.operation.status === "failed"
    ? Object.freeze({
        ...input.operation.error,
        requestId: input.operation.requestId,
        recovery: recoveryFor(input.operation.error.status),
      })
    : undefined);
  return Object.freeze({
    visibleState: state,
    statusLabel: presentation.label,
    nonColourCue: presentation.cue,
    watermarkLabel,
    liveAnnouncement: presentation.announcement,
    writeLocked,
    cards: Object.freeze(cards),
    ...(error === undefined ? {} : { error }),
    focusTarget: error === undefined ? "none" : "error-summary",
    motion: input.reducedMotion ? "reduced" : "standard",
  });
}
