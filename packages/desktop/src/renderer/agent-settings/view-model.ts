import {
  isAgentSettingsAuthorityMessage,
  isAgentSettingsMutationIntent,
  type AgentProfileProjection,
  type AgentSettingsAuthorityMessage,
  type AgentSettingsClosedError,
  type AgentSettingsCommand,
  type AgentSettingsMutationIntent,
  type AgentSettingsSnapshot,
  type RoomAgentAssignmentProjection,
} from "../../agent-profile-routing/contracts.js";

export type { AgentSettingsMutationIntent } from "../../agent-profile-routing/contracts.js";

export type AgentSettingsConnection =
  | { readonly status: "online" }
  | { readonly status: "offline"; readonly asOf: string; readonly leaseExpiresAt: string }
  | { readonly status: "repairing"; readonly generation: number; readonly watermark: number }
  | { readonly status: "repair_failed"; readonly generation: number; readonly watermark: number; readonly errorCode: string }
  | { readonly status: "revoked"; readonly scope: "room" | "session"; readonly purgeCompleted: boolean };

export type AgentSettingsQuery =
  | { readonly status: "loading" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly requestId: string; readonly error: AgentSettingsClosedError };

export type AgentSettingsOperation =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly requestId: string; readonly command: AgentSettingsCommand }
  | { readonly status: "acknowledged"; readonly requestId: string; readonly command: AgentSettingsCommand; readonly eventIds: readonly string[] }
  | { readonly status: "succeeded"; readonly requestId: string; readonly command: AgentSettingsCommand }
  | { readonly status: "failed"; readonly requestId: string; readonly command: AgentSettingsCommand; readonly error: AgentSettingsClosedError };

export interface AgentSettingsState {
  readonly query: AgentSettingsQuery;
  readonly connection: AgentSettingsConnection;
  readonly snapshot?: AgentSettingsSnapshot;
  readonly operation: AgentSettingsOperation;
  readonly appliedEventIds: readonly string[];
  readonly reducedMotion: boolean;
}

export interface AgentSettingsMutationSubmission {
  readonly requestId: string;
  readonly intent: AgentSettingsMutationIntent;
}

export type AgentSettingsVisibleState =
  | "loading"
  | "empty"
  | "ready"
  | "offline"
  | "repairing"
  | "repair-failed"
  | "archived-read-only"
  | "revoked"
  | "failed";

export interface AgentSettingsActionView {
  readonly command: AgentSettingsCommand;
  readonly label: string;
  readonly destructive: boolean;
}

export interface AgentProfileCardView extends AgentProfileProjection {
  readonly statusLabel: string;
  readonly actions: readonly AgentSettingsActionView[];
}

export interface AgentAssignmentCardView extends RoomAgentAssignmentProjection {
  readonly availabilityLabel: string;
  readonly availabilityGlyph: string;
  readonly participationLabel: string;
  readonly actions: readonly AgentSettingsActionView[];
}

export type AgentSettingsErrorView = AgentSettingsClosedError & {
  readonly requestId: string;
  readonly recoveryLabel: string;
};

export interface AgentSettingsViewModel {
  readonly visibleState: AgentSettingsVisibleState;
  readonly writeLocked: boolean;
  readonly roomId?: string;
  readonly roomName?: string;
  readonly roomRevision?: number;
  readonly lifecycle?: "active" | "archived";
  readonly viewerRole: "owner" | "admin" | "member" | null;
  readonly permissions: {
    readonly canManageProfiles: boolean;
    readonly canManageAssignments: boolean;
  };
  readonly provider?: AgentSettingsSnapshot["provider"];
  readonly profiles: readonly AgentProfileCardView[];
  readonly assignments: readonly AgentAssignmentCardView[];
  readonly operation: AgentSettingsOperation;
  readonly error?: AgentSettingsErrorView;
  readonly focusTarget: "none" | "error-summary" | "revoked-recovery";
  readonly liveAnnouncement: string;
  readonly connectionLabel?: string;
  readonly motion: "standard" | "reduced";
}

const commandLabels: Readonly<Record<AgentSettingsCommand, string>> = {
  "profile.create": "创建 Global Profile",
  "profile.update": "更新 Global Profile",
  "profile.disable": "停用 Global Profile",
  "profile.enable": "启用 Global Profile",
  "assignment.create": "创建 Room Assignment",
  "assignment.update": "更新 Room Assignment",
  "assignment.pause": "暂停 Room Assignment",
  "assignment.resume": "恢复 Room Assignment",
  "assignment.remove": "移除 Room Assignment",
};

const availabilityPresentation: Readonly<Record<RoomAgentAssignmentProjection["availability"], readonly [string, string]>> = {
  ready: ["●", "ready · 可接受新工作"],
  busy: ["▶", "busy · 正在处理权威 execution"],
  paused: ["Ⅱ", "paused · Room durable override"],
  noauth: ["🔑", "noauth · Provider credential 未就绪"],
};

export function createAgentSettingsInitialState(reducedMotion = false): AgentSettingsState {
  return Object.freeze({
    query: { status: "loading" },
    connection: { status: "online" },
    operation: { status: "idle" },
    appliedEventIds: [],
    reducedMotion,
  }) as AgentSettingsState;
}

function commandAllowed(snapshot: AgentSettingsSnapshot, command: AgentSettingsCommand): boolean {
  if (command.startsWith("profile.")) return snapshot.viewer.tenantAdministrator;
  return snapshot.viewer.roomRole === "owner" || snapshot.viewer.roomRole === "admin";
}

export function beginAgentSettingsMutation(
  state: AgentSettingsState,
  submission: AgentSettingsMutationSubmission,
): AgentSettingsState {
  if (!isAgentSettingsMutationIntent(submission.intent) || submission.requestId.trim().length === 0) {
    throw new TypeError("Agent Settings mutation submission is not closed");
  }
  const snapshot = state.snapshot;
  if (snapshot === undefined || state.connection.status !== "online" ||
      !commandAllowed(snapshot, submission.intent.command)) {
    throw new Error("Agent Settings mutation is unavailable in the current authority state");
  }
  const assignmentCommand = submission.intent.command.startsWith("assignment.");
  if (assignmentCommand && (snapshot.room.status !== "available" ||
      (snapshot.room.lifecycle === "archived" && submission.intent.command !== "assignment.pause" &&
       submission.intent.command !== "assignment.remove"))) {
    throw new Error("Archived Room accepts only Assignment safety reduction");
  }
  return Object.freeze({
    ...state,
    operation: {
      status: "submitting",
      requestId: submission.requestId,
      command: submission.intent.command,
    },
  }) as AgentSettingsState;
}

function patchSnapshot(snapshot: AgentSettingsSnapshot, message: Extract<AgentSettingsAuthorityMessage, { type: "stable-event" }>): AgentSettingsSnapshot {
  if (message.cursor <= snapshot.cursor) return snapshot;
  const event = message.event;
  if (event.kind === "profile.upserted" && snapshot.profileCatalog.status === "available") {
    const profiles = snapshot.profileCatalog.profiles.filter((profile) => profile.profileId !== event.profile.profileId);
    return Object.freeze({
      ...snapshot,
      cursor: message.cursor,
      profileCatalog: Object.freeze({
        status: "available" as const,
        revision: event.catalogRevision,
        profiles: Object.freeze([...profiles, event.profile].sort((left, right) => left.profileId.localeCompare(right.profileId))),
      }),
    });
  }
  if (event.kind === "assignment.upserted" && snapshot.room.status === "available" &&
      event.assignment.roomId === snapshot.room.roomId) {
    const assignments = snapshot.room.assignments.filter((assignment) => assignment.assignmentId !== event.assignment.assignmentId);
    return Object.freeze({
      ...snapshot,
      cursor: message.cursor,
      room: Object.freeze({
        ...snapshot.room,
        roomRevision: event.roomRevision,
        assignments: Object.freeze([...assignments, event.assignment].sort((left, right) => left.assignmentId.localeCompare(right.assignmentId))),
      }),
    });
  }
  if (event.kind === "assignment.removed" && snapshot.room.status === "available" &&
      event.roomId === snapshot.room.roomId) {
    return Object.freeze({
      ...snapshot,
      cursor: message.cursor,
      room: Object.freeze({
        ...snapshot.room,
        roomRevision: event.roomRevision,
        assignments: Object.freeze(snapshot.room.assignments.filter((assignment) => assignment.assignmentId !== event.assignmentId)),
      }),
    });
  }
  return snapshot;
}

export function applyAgentSettingsAuthorityMessage(
  state: AgentSettingsState,
  message: AgentSettingsAuthorityMessage,
): AgentSettingsState {
  if (!isAgentSettingsAuthorityMessage(message)) {
    throw new TypeError("Agent Settings authority message is not closed");
  }
  switch (message.type) {
    case "snapshot":
      return Object.freeze({ ...state, query: { status: "ready" }, connection: { status: "online" }, snapshot: message.snapshot }) as AgentSettingsState;
    case "ack":
      return state.operation.status === "submitting" && state.operation.requestId === message.requestId && state.operation.command === message.command
        ? Object.freeze({ ...state, operation: { status: "acknowledged", requestId: message.requestId, command: message.command, eventIds: message.eventIds } }) as AgentSettingsState
        : state;
    case "error":
      return (state.operation.status === "submitting" || state.operation.status === "acknowledged") &&
        state.operation.requestId === message.requestId && state.operation.command === message.command
        ? Object.freeze({ ...state, operation: { status: "failed", requestId: message.requestId, command: message.command, error: message.error } }) as AgentSettingsState
        : state;
    case "stable-event": {
      if (state.appliedEventIds.includes(message.eventId)) return state;
      const nextSnapshot = state.snapshot === undefined ? undefined : patchSnapshot(state.snapshot, message);
      const matches = message.causationRequestId !== undefined &&
        (state.operation.status === "submitting" || state.operation.status === "acknowledged") &&
        state.operation.requestId === message.causationRequestId &&
        (state.operation.status !== "acknowledged" || state.operation.eventIds.includes(message.eventId));
      return Object.freeze({
        ...state,
        ...(nextSnapshot === undefined ? {} : { snapshot: nextSnapshot }),
        appliedEventIds: Object.freeze([...state.appliedEventIds.slice(-255), message.eventId]),
        ...(matches ? { operation: { status: "succeeded" as const, requestId: state.operation.requestId, command: state.operation.command } } : {}),
      }) as AgentSettingsState;
    }
    case "offline":
      return Object.freeze({ ...state, connection: { status: "offline", asOf: message.asOf, leaseExpiresAt: message.leaseExpiresAt } }) as AgentSettingsState;
    case "online":
      return Object.freeze({ ...state, connection: { status: "online" } }) as AgentSettingsState;
    case "repair-started":
      return Object.freeze({ ...state, connection: { status: "repairing", generation: message.generation, watermark: message.watermark } }) as AgentSettingsState;
    case "repair-completed":
      return state.connection.status === "repairing" && state.connection.generation === message.generation && state.connection.watermark === message.watermark
        ? Object.freeze({ ...state, query: { status: "ready" }, connection: { status: "online" }, snapshot: message.snapshot }) as AgentSettingsState
        : state;
    case "repair-failed":
      return state.connection.status === "repairing" && state.connection.generation === message.generation && state.connection.watermark === message.watermark
        ? Object.freeze({ ...state, connection: { status: "repair_failed", generation: message.generation, watermark: message.watermark, errorCode: message.errorCode } }) as AgentSettingsState
        : state;
    case "access-revoked": {
      const retained = {
        query: state.query,
        reducedMotion: state.reducedMotion,
      };
      return Object.freeze({
        ...retained,
        connection: { status: "revoked", scope: message.scope, purgeCompleted: message.purgeCompleted },
        operation: { status: "idle" },
        appliedEventIds: [],
      }) as AgentSettingsState;
    }
  }
}

function recoveryLabel(error: AgentSettingsClosedError): string {
  switch (error.status) {
    case 400: return "修正输入";
    case 401: return "重新认证";
    case 403: return "查看权限";
    case 409: return "载入最新版本";
    case 410: return "刷新权威状态";
    case 429: return "稍后重试";
    case 503: return "重试";
  }
}

function operationAnnouncement(operation: AgentSettingsOperation): string {
  if (operation.status === "idle") return "";
  const label = commandLabels[operation.command];
  if (operation.status === "submitting") return `${label}正在提交；稳定事实尚未改变。`;
  if (operation.status === "acknowledged") return `${label}已收到 ACK；等待 stable event / projection。`;
  if (operation.status === "succeeded") return `${label}已由 stable event 收敛。`;
  return `${label}失败；${operation.error.status} ${operation.error.code}。`;
}

function connectionPresentation(connection: AgentSettingsConnection): { readonly state: AgentSettingsVisibleState; readonly label?: string } {
  switch (connection.status) {
    case "online": return { state: "ready" };
    case "offline": return { state: "offline", label: `离线只读 · 数据截至 ${connection.asOf} · lease 到期 ${connection.leaseExpiresAt}` };
    case "repairing": return { state: "repairing", label: `REPAIR 进行中 · watermark ${connection.watermark} · 保留上一份完整 projection` };
    case "repair_failed": return { state: "repair-failed", label: `REPAIR FAILED · ${connection.errorCode} · 保留上一份完整 projection` };
    case "revoked": return { state: "revoked", label: connection.purgeCompleted ? "访问已撤销 · 缓存已清除" : "访问已撤销 · 正在清除缓存" };
  }
}

function profileActions(profile: AgentProfileProjection, allowed: boolean): readonly AgentSettingsActionView[] {
  if (!allowed) return [];
  return Object.freeze([
    { command: "profile.update", label: "保存 Profile", destructive: false },
    profile.status === "enabled"
      ? { command: "profile.disable", label: "停用 Profile", destructive: true }
      : { command: "profile.enable", label: "启用 Profile", destructive: false },
  ]);
}

function assignmentActions(
  assignment: RoomAgentAssignmentProjection,
  allowed: boolean,
  lifecycle: "active" | "archived",
): readonly AgentSettingsActionView[] {
  if (!allowed) return [];
  if (lifecycle === "archived") {
    return Object.freeze([
      ...(assignment.paused ? [] : [{ command: "assignment.pause" as const, label: "暂停（paused）", destructive: false }]),
      { command: "assignment.remove", label: "移除 Assignment", destructive: true },
    ]);
  }
  return Object.freeze([
    { command: "assignment.update", label: "保存 Assignment", destructive: false },
    assignment.paused
      ? { command: "assignment.resume", label: "恢复 Assignment", destructive: false }
      : { command: "assignment.pause", label: "暂停（paused）", destructive: false },
    { command: "assignment.remove", label: "移除 Assignment", destructive: true },
  ]);
}

export function createAgentSettingsViewModel(state: AgentSettingsState): AgentSettingsViewModel {
  const connection = connectionPresentation(state.connection);
  const snapshot = state.snapshot;
  const revoked = state.connection.status === "revoked";
  const queryError = state.query.status === "failed" ? { requestId: state.query.requestId, error: state.query.error } : undefined;
  const operationError = state.operation.status === "failed" ? { requestId: state.operation.requestId, error: state.operation.error } : undefined;
  const sourceError = queryError ?? operationError;
  const error = sourceError === undefined ? undefined : Object.freeze({
    ...sourceError.error,
    requestId: sourceError.requestId,
    recoveryLabel: recoveryLabel(sourceError.error),
  });
  const online = state.connection.status === "online";
  const canManageProfiles = snapshot?.viewer.tenantAdministrator === true;
  const canManageAssignments = snapshot?.viewer.roomRole === "owner" || snapshot?.viewer.roomRole === "admin";
  const profiles = !revoked && snapshot?.profileCatalog.status === "available"
    ? snapshot.profileCatalog.profiles.map((profile): AgentProfileCardView => Object.freeze({
        ...profile,
        statusLabel: profile.status === "enabled" ? "ENABLED · 可被 Room 分配" : "DISABLED · 不接受新工作",
        actions: profileActions(profile, canManageProfiles),
      }))
    : [];
  const availableRoom = snapshot?.room.status === "available" ? snapshot.room : undefined;
  const assignments = !revoked && availableRoom !== undefined
    ? availableRoom.assignments.map((assignment): AgentAssignmentCardView => {
        const [glyph, label] = availabilityPresentation[assignment.availability];
        return Object.freeze({
          ...assignment,
          availabilityGlyph: glyph,
          availabilityLabel: label,
          participationLabel: assignment.participation === "active" ? "active · 可受控主动参与" : "on-mention · 仅结构化点名/直接调用",
          actions: assignmentActions(assignment, canManageAssignments, availableRoom.lifecycle),
        });
      })
    : [];
  let visibleState: AgentSettingsVisibleState = connection.state;
  if (!revoked && state.query.status === "loading" && snapshot === undefined) visibleState = "loading";
  else if (!revoked && state.query.status === "failed" && snapshot === undefined) visibleState = "failed";
  else if (connection.state === "ready" && snapshot?.room.status === "available" && snapshot.room.lifecycle === "archived") visibleState = "archived-read-only";
  else if (connection.state === "ready" && profiles.length === 0 && assignments.length === 0) visibleState = "empty";
  return Object.freeze({
    visibleState,
    writeLocked: !online,
    ...(snapshot?.room.status !== "available" ? {} : {
      roomId: snapshot.room.roomId,
      roomName: snapshot.room.roomName,
      roomRevision: snapshot.room.roomRevision,
      lifecycle: snapshot.room.lifecycle,
    }),
    ...(snapshot === undefined ? {} : { provider: snapshot.provider }),
    viewerRole: snapshot?.viewer.roomRole ?? null,
    permissions: Object.freeze({ canManageProfiles, canManageAssignments }),
    profiles: Object.freeze(profiles),
    assignments: Object.freeze(assignments),
    operation: state.operation,
    ...(error === undefined ? {} : { error }),
    focusTarget: revoked ? "revoked-recovery" : error === undefined ? "none" : "error-summary",
    liveAnnouncement: revoked ? "Agent Settings 访问已撤销，缓存已清理。" : operationAnnouncement(state.operation),
    ...(connection.label === undefined ? {} : { connectionLabel: connection.label }),
    motion: state.reducedMotion ? "reduced" : "standard",
  });
}
