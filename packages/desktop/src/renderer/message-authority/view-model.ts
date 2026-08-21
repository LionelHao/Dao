export type ActorKind = "human" | "agent";
export type MentionKind = "human-request" | "agent-invocation";

export interface MessageActorOption {
  readonly actorId: string;
  readonly kind: ActorKind;
  readonly displayName: string;
  readonly secondaryLabel: string;
}

export interface MentionPickerOption extends MessageActorOption {
  readonly accessibleLabel: string;
}

export interface Utf16Range {
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface MentionTarget {
  readonly id: string;
  readonly kind: MentionKind;
  readonly targetActorId: string;
  readonly range: Utf16Range;
}

export interface AttachmentReference {
  readonly attachmentId: string;
}

export interface MessageDraft {
  readonly messageId: string;
  readonly roomId: string;
  readonly body: string;
  readonly mentionedTargets: readonly MentionTarget[];
  readonly replyToMessageId?: string;
  readonly attachments: readonly AttachmentReference[];
}

export type MessageTargetOutcome =
  | {
      readonly targetId: string;
      readonly targetActorId: string;
      readonly kind: "human-request";
      readonly status: "request-created";
      readonly requestIntentId: string;
    }
  | {
      readonly targetId: string;
      readonly targetActorId: string;
      readonly kind: "agent-invocation";
      readonly status: "invocation-intent-created";
      readonly invocationIntentId: string;
    }
  | {
      readonly targetId: string;
      readonly targetActorId: string;
      readonly kind: MentionKind;
      readonly status: "rejected";
      readonly code:
        | "target_not_member"
        | "target_kind_mismatch"
        | "target_assignment_inactive"
        | "target_room_archived";
    };

interface TimelineMessageBase {
  readonly messageId: string;
  readonly roomId: string;
  readonly authorId: string;
  readonly createdAt: string;
}

export interface ActiveHumanTimelineMessage extends TimelineMessageBase {
  readonly kind: "human";
  readonly body: string;
  readonly revision: number;
  readonly revisionCount: number;
  readonly mentionedTargets: readonly MentionTarget[];
  readonly replyToMessageId?: string;
  readonly attachments: readonly AttachmentReference[];
  readonly targetOutcomes: readonly MessageTargetOutcome[];
}

export interface AgentFinalTimelineMessage extends TimelineMessageBase {
  readonly kind: "agent-final";
  readonly finalBody: string;
  readonly sourceInvocationIntentId: string;
  readonly sourceExecutionId: string;
  readonly citations: readonly AgentMessageCitationProjection[];
  readonly correctsMessageId?: string;
  readonly replyToMessageId?: never;
}

export interface AgentMessageCitationProjection {
  readonly ordinal: number;
  readonly sourceKind: "message" | "message_revision" | "message_tombstone" |
    "attachment_extraction" | "memory" | "project_fact_checkpoint";
  readonly sourceId: string;
  readonly sourceRevision: number;
}

export interface MessageTombstone extends TimelineMessageBase {
  readonly kind: "tombstone";
  readonly recalledAt: string;
  readonly revisionCount: number;
  readonly replyToMessageId?: never;
}

export type TimelineMessage =
  | ActiveHumanTimelineMessage
  | AgentFinalTimelineMessage
  | MessageTombstone;

export interface AgentExecutionProjection {
  readonly executionId: string;
  readonly agentId: string;
  readonly sourceInvocationIntentId: string;
  readonly status: "accepted" | "running" | "completed" | "failed" | "cancelled";
  readonly failureCode?: string;
}

export interface AgentPreview {
  readonly executionId: string;
  readonly agentId: string;
  readonly attemptSeq: number;
  readonly delta: string;
  readonly authoritative: false;
}

export type MessageConnectionState =
  | { readonly status: "online" }
  | { readonly status: "offline"; readonly asOf: string }
  | { readonly status: "repairing"; readonly watermark: number }
  | { readonly status: "repair-failed"; readonly errorCode: string }
  | { readonly status: "revoked"; readonly scope: "room" | "session"; readonly purgeCompleted: boolean }
  | { readonly status: "fatal"; readonly errorCode: string };

export type MessageClosedError =
  | { readonly status: 400; readonly code: "invalid_request" | "invalid_message" | "mention_entity_invalid" | "author_fields_forbidden" }
  | { readonly status: 401; readonly code: "unauthenticated" | "identity_forbidden" }
  | { readonly status: 403; readonly code: "room_forbidden" }
  | { readonly status: 404; readonly code: "reply_target_not_found" }
  | { readonly status: 409; readonly code: "message_version_conflict" | "message_recalled" | "agent_final_immutable" | "idempotency_conflict" }
  | { readonly status: 410; readonly code: "protocol_upgrade_required" | "snapshot_expired" }
  | { readonly status: 429; readonly code: "rate_limited"; readonly retryAfterSeconds?: number }
  | { readonly status: 503; readonly code: "service_unavailable" | "dependency_unavailable" | "repair_unavailable" };

export type MessageSubmissionState =
  | { readonly status: "idle" }
  | { readonly status: "submitting"; readonly requestId: string; readonly payload: MessageDraft }
  | { readonly status: "accepted"; readonly requestId: string; readonly payload: MessageDraft; readonly targetOutcomes: readonly MessageTargetOutcome[] }
  | { readonly status: "accepted-via-event"; readonly requestId: string; readonly payload: MessageDraft }
  | { readonly status: "retryable-failure"; readonly requestId: string; readonly payload: MessageDraft; readonly error: MessageClosedError }
  | { readonly status: "nonretryable-failure"; readonly requestId: string; readonly payload: MessageDraft; readonly error: MessageClosedError };

export type MessageMutationState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly kind: "revise" | "recall"; readonly requestId: string;
      readonly messageId: string; readonly expectedRevision: number; readonly body?: string }
  | { readonly status: "event-observed"; readonly kind: "revise" | "recall";
      readonly requestId: string; readonly messageId: string; readonly expectedRevision: number;
      readonly body?: string }
  | { readonly status: "acknowledged"; readonly kind: "revise" | "recall";
      readonly requestId: string; readonly messageId: string; readonly expectedRevision: number;
      readonly body?: string }
  | { readonly status: "failed"; readonly kind: "revise" | "recall"; readonly requestId: string;
      readonly messageId: string; readonly expectedRevision: number; readonly body?: string;
      readonly error: MessageClosedError };

export interface MessageAuthorityState {
  readonly roomId: string;
  readonly viewerActorId: string;
  readonly lifecycle: "active" | "archived";
  readonly connection: MessageConnectionState;
  readonly actors: readonly MessageActorOption[];
  readonly draft: MessageDraft;
  readonly submission: MessageSubmissionState;
  readonly mutation: MessageMutationState;
  readonly timeline: readonly TimelineMessage[];
  readonly executions: readonly AgentExecutionProjection[];
  readonly previews: readonly AgentPreview[];
  readonly appliedEventIds: readonly string[];
  readonly projectionGeneration: number;
  readonly reducedMotion: boolean;
  readonly composerEnabled: boolean;
  readonly announcement: string;
}

type MessageAuthorityStateInput = Omit<MessageAuthorityState, "composerEnabled" | "announcement" | "submission" | "mutation" | "reducedMotion"> & {
  readonly submission?: MessageSubmissionState;
  readonly mutation?: MessageMutationState;
  readonly reducedMotion?: boolean;
  readonly announcement?: string;
};

export type MessageAuthorityInput =
  | {
      readonly type: "message.accepted";
      readonly requestId: string;
      readonly messageId: string;
      readonly persistedAt: string;
      readonly targetOutcomes: readonly MessageTargetOutcome[];
    }
  | { readonly type: "message.revision.accepted"; readonly requestId: string;
      readonly messageId: string; readonly revision: number; readonly persistedAt: string }
  | { readonly type: "message.recall.accepted"; readonly requestId: string;
      readonly messageId: string; readonly revision: number; readonly recalledAt: string }
  | ({ readonly type: "message.error"; readonly requestId: string } & MessageClosedError)
  | { readonly type: "room.message.accepted"; readonly eventId: string; readonly message: TimelineMessage }
  | { readonly type: "room.message.revised"; readonly eventId: string; readonly messageId: string; readonly revision: number; readonly body: string; readonly revisedAt: string }
  | { readonly type: "room.message.recalled"; readonly eventId: string; readonly tombstone: MessageTombstone }
  | ({ readonly type: "agent.preview" } & AgentPreview)
  | { readonly type: "execution.projection"; readonly eventId: string; readonly execution: AgentExecutionProjection }
  | { readonly type: "repair.started"; readonly watermark: number };

export interface CompleteRepairGeneration {
  readonly generation: number;
  readonly watermark: number;
  readonly timeline: readonly TimelineMessage[];
  readonly executions: readonly AgentExecutionProjection[];
  readonly appliedEventIds: readonly string[];
}

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function nonEmpty(value: string, label: string): void {
  if (value.length === 0 || value.length > 4096) throw new TypeError(`${label} is not bounded`);
}

function validIso(value: string, label: string): void {
  if (!isoPattern.test(value) || Number.isNaN(Date.parse(value))) throw new TypeError(`${label} is not ISO`);
}

function validateDraft(draft: MessageDraft, roomId: string): void {
  nonEmpty(draft.messageId, "messageId");
  if (draft.roomId !== roomId) throw new TypeError("message draft crossed Room authority");
  if (draft.body.length > 100_000) throw new TypeError("message body is unbounded");
  const ids = new Set<string>();
  const semantic = new Set<string>();
  let previousEnd = -1;
  for (const target of draft.mentionedTargets) {
    nonEmpty(target.id, "targetId");
    nonEmpty(target.targetActorId, "targetActorId");
    if (ids.has(target.id)) throw new TypeError("target ID is duplicated");
    ids.add(target.id);
    const key = `${target.kind}\0${target.targetActorId}`;
    if (semantic.has(key)) throw new TypeError("target actor is duplicated");
    semantic.add(key);
    const { startUtf16, endUtf16 } = target.range;
    if (!Number.isSafeInteger(startUtf16) || !Number.isSafeInteger(endUtf16) ||
        startUtf16 < 0 || startUtf16 >= endUtf16 || endUtf16 > draft.body.length ||
        startUtf16 < previousEnd) {
      throw new TypeError("mention UTF-16 range is invalid");
    }
    previousEnd = endUtf16;
  }
}

function validateTimeline(timeline: readonly TimelineMessage[], roomId: string): void {
  const ids = new Set<string>();
  for (const message of timeline) {
    nonEmpty(message.messageId, "timeline messageId");
    if (message.roomId !== roomId) throw new TypeError("timeline crossed Room authority");
    if (ids.has(message.messageId)) throw new TypeError("timeline message is duplicated");
    ids.add(message.messageId);
    validIso(message.createdAt, "createdAt");
    if (message.kind === "human") {
      if (!Number.isSafeInteger(message.revision) || message.revision < 1 ||
          !Number.isSafeInteger(message.revisionCount) || message.revisionCount < message.revision) {
        throw new TypeError("message revision is invalid");
      }
    } else if (message.kind === "tombstone") {
      validIso(message.recalledAt, "recalledAt");
    } else {
      const identities = new Set<string>();
      if (message.citations.length > 128 || message.citations.some((citation, index) => {
        const identity = `${citation.sourceKind}\u0000${citation.sourceId}\u0000${citation.sourceRevision}`;
        const invalid = citation.ordinal !== index + 1 ||
          !Number.isSafeInteger(citation.sourceRevision) || citation.sourceRevision < 1 ||
          !["message", "message_revision", "message_tombstone", "attachment_extraction",
            "memory", "project_fact_checkpoint"].includes(citation.sourceKind) ||
          citation.sourceId.length === 0 || identities.has(identity);
        identities.add(identity);
        return invalid;
      })) throw new TypeError("Agent citation projection is invalid");
    }
  }
}

function isComposerEnabled(input: Pick<MessageAuthorityState, "lifecycle" | "connection">): boolean {
  return input.lifecycle === "active" && input.connection.status === "online";
}

export function createMessageAuthorityState(input: MessageAuthorityStateInput): MessageAuthorityState {
  nonEmpty(input.roomId, "roomId");
  nonEmpty(input.viewerActorId, "viewerActorId");
  validateDraft(input.draft, input.roomId);
  validateTimeline(input.timeline, input.roomId);
  if (!Number.isSafeInteger(input.projectionGeneration) || input.projectionGeneration < 0) {
    throw new TypeError("projection generation is invalid");
  }
  const actorIds = new Set<string>();
  for (const actor of input.actors) {
    nonEmpty(actor.actorId, "actorId");
    nonEmpty(actor.displayName, "displayName");
    nonEmpty(actor.secondaryLabel, "secondaryLabel");
    if (actorIds.has(actor.actorId)) throw new TypeError("actor picker projection is duplicated");
    actorIds.add(actor.actorId);
  }
  for (const preview of input.previews) {
    if (preview.authoritative !== false) throw new TypeError("preview cannot be authoritative");
  }
  const stateWithoutComputed = {
    roomId: input.roomId,
    viewerActorId: input.viewerActorId,
    lifecycle: input.lifecycle,
    connection: input.connection,
    actors: input.actors,
    draft: input.draft,
    submission: input.submission ?? { status: "idle" },
    mutation: input.mutation ?? { status: "idle" },
    timeline: input.timeline,
    executions: input.executions,
    previews: input.previews,
    appliedEventIds: input.appliedEventIds,
    projectionGeneration: input.projectionGeneration,
    reducedMotion: input.reducedMotion ?? false,
    announcement: input.announcement ?? "",
  } satisfies Omit<MessageAuthorityState, "composerEnabled">;
  return { ...stateWithoutComputed, composerEnabled: isComposerEnabled(stateWithoutComputed) };
}

function withState(
  state: MessageAuthorityState,
  patch: Partial<Omit<MessageAuthorityState, "composerEnabled">>,
): MessageAuthorityState {
  const next = { ...state, ...patch };
  return { ...next, composerEnabled: isComposerEnabled(next) };
}

function cloneDraft(draft: MessageDraft): MessageDraft {
  return {
    messageId: draft.messageId,
    roomId: draft.roomId,
    body: draft.body,
    mentionedTargets: draft.mentionedTargets.map((target) => ({ ...target, range: { ...target.range } })),
    ...(draft.replyToMessageId === undefined ? {} : { replyToMessageId: draft.replyToMessageId }),
    attachments: draft.attachments.map((attachment) => ({ ...attachment })),
  };
}

export function buildMentionPickerOptions(
  state: MessageAuthorityState,
  query: string,
): readonly MentionPickerOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  return state.actors.filter((actor) => normalized.length === 0 ||
    `${actor.displayName} ${actor.secondaryLabel} ${actor.actorId}`.toLocaleLowerCase().includes(normalized))
    .map((actor) => ({
      ...actor,
      accessibleLabel: `${actor.displayName} · ${actor.kind === "human" ? "Human" : "Agent"} · ${actor.secondaryLabel} · actorId ${actor.actorId}`,
    }));
}

export function beginMessageSubmission(
  state: MessageAuthorityState,
  requestId: string,
): MessageAuthorityState {
  nonEmpty(requestId, "requestId");
  if (!state.composerEnabled || state.submission.status === "submitting") return state;
  const payload = cloneDraft(state.draft);
  return withState(state, {
    submission: { status: "submitting", requestId, payload },
    announcement: "正在提交消息，输入已保留",
  });
}

export function beginMessageMutation(
  state: MessageAuthorityState,
  operation: Readonly<{ kind: "revise" | "recall"; requestId: string; messageId: string;
    expectedRevision: number; body?: string }>,
): MessageAuthorityState {
  nonEmpty(operation.requestId, "requestId");
  nonEmpty(operation.messageId, "messageId");
  if (state.mutation.status !== "idle" && state.mutation.status !== "failed") return state;
  return withState(state, {
    mutation: { status: "pending", ...operation },
    announcement: operation.kind === "revise"
      ? "正在提交修订 intent；正文已保留"
      : "正在提交撤回 intent；等待 ACK 或 stable event",
  });
}

function pendingPayload(state: MessageAuthorityState): MessageDraft | undefined {
  return state.submission.status === "idle" ? undefined : state.submission.payload;
}

function targetOutcomeAnnouncement(outcomes: readonly MessageTargetOutcome[]): string {
  const parts = ["消息已保存"];
  if (outcomes.some((outcome) => outcome.status === "request-created")) parts.push("请求意图已登记");
  if (outcomes.some((outcome) => outcome.status === "invocation-intent-created")) parts.push("Agent调用意图已登记");
  if (outcomes.some((outcome) => outcome.status === "rejected")) parts.push("目标不可用");
  return parts.join("；");
}

function seenEvent(state: MessageAuthorityState, eventId: string): boolean {
  return state.appliedEventIds.includes(eventId);
}

function addEvent(state: MessageAuthorityState, eventId: string): readonly string[] {
  return [...state.appliedEventIds, eventId];
}

function upsertTimeline(
  timeline: readonly TimelineMessage[],
  message: TimelineMessage,
): readonly TimelineMessage[] {
  const index = timeline.findIndex((entry) => entry.messageId === message.messageId);
  if (index < 0) return [...timeline, message];
  const next = [...timeline];
  next[index] = message;
  return next;
}

function applyAcceptedAck(
  state: MessageAuthorityState,
  input: Extract<MessageAuthorityInput, { type: "message.accepted" }>,
): MessageAuthorityState {
  const submission = state.submission;
  if ((submission.status !== "submitting" && submission.status !== "accepted-via-event") ||
      submission.requestId !== input.requestId || submission.payload.messageId !== input.messageId) return state;
  return withState(state, {
    submission: {
      status: "accepted",
      requestId: input.requestId,
      payload: submission.payload,
      targetOutcomes: input.targetOutcomes,
    },
    announcement: targetOutcomeAnnouncement(input.targetOutcomes),
  });
}

function applyError(
  state: MessageAuthorityState,
  input: Extract<MessageAuthorityInput, { type: "message.error" }>,
): MessageAuthorityState {
  const error = { ...input } as MessageClosedError & { readonly type?: never; readonly requestId?: never };
  Reflect.deleteProperty(error, "type");
  Reflect.deleteProperty(error, "requestId");
  if ((state.mutation.status === "pending" || state.mutation.status === "event-observed") &&
      state.mutation.requestId === input.requestId) {
    return withState(state, {
      mutation: { ...state.mutation, status: "failed", error },
      announcement: `${state.mutation.kind === "revise" ? "修订" : "撤回"}失败；${input.status} ${input.code}；原 projection 与输入已保留`,
    });
  }
  if (state.submission.status !== "submitting" || state.submission.requestId !== input.requestId) return state;
  const retryable = input.status === 429 || input.status === 503;
  return withState(state, {
    submission: {
      status: retryable ? "retryable-failure" : "nonretryable-failure",
      requestId: input.requestId,
      payload: state.submission.payload,
      error,
    },
    announcement: `消息未提交；${input.status} ${input.code}；输入已保留`,
  });
}

function applyMutationAck(
  state: MessageAuthorityState,
  input: Extract<MessageAuthorityInput,
    { type: "message.revision.accepted" | "message.recall.accepted" }>,
): MessageAuthorityState {
  const mutation = state.mutation;
  if ((mutation.status !== "pending" && mutation.status !== "event-observed") ||
      mutation.requestId !== input.requestId ||
      mutation.messageId !== input.messageId) return state;
  if (mutation.status === "event-observed") {
    return withState(state, {
      mutation: { status: "idle" },
      announcement: `${mutation.kind === "revise" ? "修订" : "撤回"} stable event 与 ACK 已收敛`,
    });
  }
  return withState(state, {
    mutation: { ...mutation, status: "acknowledged" },
    announcement: `${mutation.kind === "revise" ? "修订" : "撤回"} ACK 已持久化；等待 stable event，ACK 不会替换 projection`,
  });
}

function applyMessageEvent(
  state: MessageAuthorityState,
  input: Extract<MessageAuthorityInput, { type: "room.message.accepted" }>,
): MessageAuthorityState {
  if (seenEvent(state, input.eventId)) return state;
  if (input.message.roomId !== state.roomId) return state;
  const payload = pendingPayload(state);
  const matchesPending = payload?.messageId === input.message.messageId &&
    (state.submission.status === "submitting" || state.submission.status === "retryable-failure");
  return withState(state, {
    timeline: upsertTimeline(state.timeline, input.message),
    appliedEventIds: addEvent(state, input.eventId),
    ...(matchesPending && payload !== undefined ? {
      submission: {
        status: "accepted-via-event" as const,
        requestId: state.submission.requestId,
        payload,
      },
      announcement: "消息已保存（stable event 已收敛）",
    } : {}),
  });
}

function applyRevisionEvent(
  state: MessageAuthorityState,
  input: Extract<MessageAuthorityInput, { type: "room.message.revised" }>,
): MessageAuthorityState {
  if (seenEvent(state, input.eventId)) return state;
  const index = state.timeline.findIndex((entry) => entry.messageId === input.messageId);
  const current = state.timeline[index];
  if (current === undefined || current.kind !== "human" || input.revision <= current.revision) {
    return withState(state, { appliedEventIds: addEvent(state, input.eventId) });
  }
  const timeline = [...state.timeline];
  timeline[index] = { ...current, body: input.body, revision: input.revision, revisionCount: input.revision };
  const mutation = state.mutation.status === "idle" ||
      state.mutation.messageId !== input.messageId
    ? undefined
    : state.mutation.status === "pending"
      ? { ...state.mutation, status: "event-observed" as const }
      : state.mutation.status === "acknowledged"
        ? { status: "idle" as const }
        : state.mutation;
  return withState(state, {
    timeline,
    appliedEventIds: addEvent(state, input.eventId),
    announcement: `消息已修订至 v${input.revision}`,
    ...(mutation === undefined ? {} : { mutation }),
  });
}

function applyRecallEvent(
  state: MessageAuthorityState,
  input: Extract<MessageAuthorityInput, { type: "room.message.recalled" }>,
): MessageAuthorityState {
  if (seenEvent(state, input.eventId)) return state;
  if (input.tombstone.roomId !== state.roomId) return state;
  const mutation = state.mutation.status === "idle" ||
      state.mutation.messageId !== input.tombstone.messageId
    ? undefined
    : state.mutation.status === "pending"
      ? { ...state.mutation, status: "event-observed" as const }
      : state.mutation.status === "acknowledged"
        ? { status: "idle" as const }
        : state.mutation;
  return withState(state, {
    timeline: upsertTimeline(state.timeline, input.tombstone),
    appliedEventIds: addEvent(state, input.eventId),
    announcement: "消息已撤回；时间线已收敛为 tombstone",
    ...(mutation === undefined ? {} : { mutation }),
  });
}

function applyExecutionEvent(
  state: MessageAuthorityState,
  input: Extract<MessageAuthorityInput, { type: "execution.projection" }>,
): MessageAuthorityState {
  if (seenEvent(state, input.eventId)) return state;
  const index = state.executions.findIndex((entry) => entry.executionId === input.execution.executionId);
  const executions = [...state.executions];
  if (index < 0) executions.push(input.execution);
  else executions[index] = input.execution;
  const stateText = input.execution.status === "running" ? "Agent执行中"
    : input.execution.status === "completed" ? "Agent已完成"
    : `Agent执行状态：${input.execution.status}`;
  return withState(state, {
    executions,
    appliedEventIds: addEvent(state, input.eventId),
    announcement: stateText,
  });
}

export function applyMessageAuthorityInput(
  state: MessageAuthorityState,
  input: MessageAuthorityInput,
): MessageAuthorityState {
  switch (input.type) {
    case "message.accepted": return applyAcceptedAck(state, input);
    case "message.revision.accepted": return applyMutationAck(state, input);
    case "message.recall.accepted": return applyMutationAck(state, input);
    case "message.error": return applyError(state, input);
    case "room.message.accepted": return applyMessageEvent(state, input);
    case "room.message.revised": return applyRevisionEvent(state, input);
    case "room.message.recalled": return applyRecallEvent(state, input);
    case "execution.projection": return applyExecutionEvent(state, input);
    case "agent.preview": {
      const index = state.previews.findIndex((entry) => entry.executionId === input.executionId);
      const preview: AgentPreview = {
        executionId: input.executionId,
        agentId: input.agentId,
        attemptSeq: input.attemptSeq,
        delta: input.delta,
        authoritative: false,
      };
      const previews = [...state.previews];
      if (index < 0) previews.push(preview);
      else previews[index] = preview;
      return withState(state, { previews });
    }
    case "repair.started":
      return withState(state, {
        connection: { status: "repairing", watermark: input.watermark },
        announcement: `repair 进行中；固定 watermark ${input.watermark}`,
      });
  }
}

export function retryMessageSubmission(
  state: MessageAuthorityState,
  requestId: string,
): MessageAuthorityState {
  if (state.submission.status !== "retryable-failure" || !state.composerEnabled) return state;
  return withState(state, {
    submission: {
      status: "submitting",
      requestId,
      payload: cloneDraft(state.submission.payload),
    },
    announcement: "正在重试同一消息；canonical payload 与 messageId 保持不变",
  });
}

export function failRepairGeneration(
  state: MessageAuthorityState,
  errorCode: string,
): MessageAuthorityState {
  nonEmpty(errorCode, "repair errorCode");
  if (state.connection.status !== "repairing") return state;
  return withState(state, {
    connection: { status: "repair-failed", errorCode },
    announcement: "repair 失败；继续使用旧完整 projection",
  });
}

export function commitRepairGeneration(
  state: MessageAuthorityState,
  generation: CompleteRepairGeneration,
): MessageAuthorityState {
  if (state.connection.status !== "repairing" ||
      generation.watermark !== state.connection.watermark ||
      !Number.isSafeInteger(generation.generation) || generation.generation <= state.projectionGeneration) {
    throw new TypeError("repair generation is not a complete successor");
  }
  validateTimeline(generation.timeline, state.roomId);
  return withState(state, {
    timeline: generation.timeline,
    executions: generation.executions,
    appliedEventIds: generation.appliedEventIds,
    projectionGeneration: generation.generation,
    connection: { status: "online" },
    previews: [],
    announcement: `repair 完成；projection generation ${generation.generation} 已原子替换`,
  });
}

export function messageControls(
  state: MessageAuthorityState,
  message: TimelineMessage,
): { readonly canRevise: boolean; readonly canRecall: boolean } {
  const allowed = state.composerEnabled && message.kind === "human" &&
    message.authorId === state.viewerActorId &&
    (state.mutation.status === "idle" || state.mutation.status === "failed");
  return { canRevise: allowed, canRecall: allowed };
}

export function replyLabel(
  timeline: readonly TimelineMessage[],
  replyToMessageId: string,
): string {
  const target = timeline.find((entry) => entry.messageId === replyToMessageId);
  if (target?.kind === "tombstone") return "引用消息已撤回";
  if (target?.kind === "human") return `回复：${target.body}`;
  if (target?.kind === "agent-final") return `回复：${target.finalBody}`;
  return "引用消息不可用";
}
