import type {
  HumanMessageSubmit,
  MessageAuthorityEvent,
  TimelineMessage as CoreTimelineMessage,
} from "@native-im/core";

import type {
  MessageAuthorityBridge,
  MessageAuthorityBridgeInput,
  MessageAuthorityReadyHistory,
} from "../../message-authority/contracts.js";
import type {
  AttachmentAuthorityBridge,
  AttachmentStatusResult,
} from "../../attachment-authority/contracts.js";
import {
  isMemoryAuthorityEpochResponse,
  type MemoryAuthorityBridge,
} from "../../memory-authority/contracts.js";
import {
  advanceMessageAuthorityCursor,
  applyMessageAuthorityEvent,
  beginMessageAuthorityRepair,
  commitMessageAuthorityRepair,
  createMessageAuthorityReplica,
  markMessageAuthorityOfflineReadOnly,
  revokeMessageAuthorityRoom,
  stageMessageAuthorityRepairRecord,
  type MessageAuthorityReplica,
} from "../../sync/message-authority-replica.js";
import {
  applyMessageAuthorityInput,
  beginMessageMutation,
  beginMessageSubmission,
  commitRepairGeneration,
  createMessageAuthorityState,
  failRepairGeneration,
  retryMessageSubmission,
  type MessageActorOption,
  type MessageAuthorityInput,
  type MessageAuthorityState,
  type MessageDraft,
  type TimelineMessage,
} from "./view-model.js";
import {
  renderMessageAuthoritySurface,
  type MessageAuthoritySurfaceActions,
} from "./message-authority-surface.js";
import {
  mountAttachmentComposerBridge,
  type AttachmentComposerBridgeController,
} from "../attachment-authority/composer-bridge.js";

export interface MessageAuthorityBridgeSurfaceOptions {
  readonly createMessageId: () => string;
  readonly createTargetId: () => string;
  readonly reducedMotion?: boolean;
  readonly attachmentBridge?: AttachmentAuthorityBridge;
  readonly memoryBridge?: MemoryAuthorityBridge;
}

type RevisionTarget = Readonly<{ messageId: string; expectedRevision: number }>;
type AwaitingReceipt = {
  readonly payload: MessageDraft;
  readonly queued: MessageAuthorityBridgeInput[];
};
type AwaitingMutationReceipt = {
  readonly kind: "revise" | "recall";
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly body?: string;
  readonly queued: MessageAuthorityBridgeInput[];
};

function emptyDraft(roomId: string, messageId: string): MessageDraft {
  return {
    messageId,
    roomId,
    body: "",
    mentionedTargets: [],
    attachments: [],
  };
}

function mapTimelineMessage(message: CoreTimelineMessage): TimelineMessage {
  if (message.lifecycle === "recalled") {
    return {
      kind: "tombstone",
      messageId: message.id,
      roomId: message.roomId,
      authorId: message.authorId,
      createdAt: message.createdAt,
      recalledAt: message.recalledAt,
      revisionCount: message.revisionCount,
    };
  }
  if (message.authorKind === "agent") {
    return {
      kind: "agent-final",
      messageId: message.id,
      roomId: message.roomId,
      authorId: message.authorId,
      createdAt: message.createdAt,
      finalBody: message.finalBody,
      sourceInvocationIntentId: message.sourceInvocationIntentId,
      sourceExecutionId: message.sourceExecutionId,
      citations: message.citations,
      ...(message.correctsMessageId === undefined
        ? {}
        : { correctsMessageId: message.correctsMessageId }),
    };
  }
  return {
    kind: "human",
    messageId: message.id,
    roomId: message.roomId,
    authorId: message.authorId,
    createdAt: message.createdAt,
    body: message.currentRevision.body,
    revision: message.currentRevision.revision,
    revisionCount: message.revisionCount,
    mentionedTargets: message.mentionedTargets,
    ...(message.replyToMessageId === undefined
      ? {}
      : { replyToMessageId: message.replyToMessageId }),
    attachments: message.attachments,
    targetOutcomes: message.targetOutcomes,
  };
}

function replaceState(
  state: MessageAuthorityState,
  patch: Partial<MessageAuthorityState>,
): MessageAuthorityState {
  return createMessageAuthorityState({ ...state, ...patch });
}

function eventInput(event: MessageAuthorityEvent): MessageAuthorityInput {
  if (event.type === "room.message.accepted") {
    return {
      type: "room.message.accepted",
      eventId: event.eventId,
      message: mapTimelineMessage(event.payload),
    };
  }
  if (event.type === "room.message.revised") {
    return {
      type: "room.message.revised",
      eventId: event.eventId,
      messageId: event.payload.id,
      revision: event.payload.currentRevision.revision,
      body: event.payload.currentRevision.body,
      revisedAt: event.payload.currentRevision.revisedAt,
    };
  }
  return {
    type: "room.message.recalled",
    eventId: event.eventId,
    tombstone: mapTimelineMessage(event.payload) as Extract<
      TimelineMessage,
      { readonly kind: "tombstone" }
    >,
  };
}

function renderLoading(root: HTMLElement): void {
  const status = document.createElement("section");
  status.dataset.messageAuthorityLoading = "true";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "正在载入 Room 权威消息…";
  root.replaceChildren(status);
}

export function mountMessageAuthorityBridgeSurface(
  root: HTMLElement,
  bridge: MessageAuthorityBridge,
  roomId: string,
  options: MessageAuthorityBridgeSurfaceOptions,
): () => void {
  const attachmentBridge = options.attachmentBridge;
  const memoryBridge = options.memoryBridge;
  let disposed = false;
  let state: MessageAuthorityState | undefined;
  let replica: MessageAuthorityReplica | undefined;
  let revisionTarget: RevisionTarget | undefined;
  let awaitingReceipt: AwaitingReceipt | undefined;
  let awaitingMutationReceipt: AwaitingMutationReceipt | undefined;
  let attachmentComposer: AttachmentComposerBridgeController | undefined;
  let attachmentSubmissionBlocked = false;
  const attachmentStatuses = new Map<string, AttachmentStatusResult>();
  const attachmentFailures = new Map<string, "forbidden" | "gone" | "unavailable">();
  const attachmentHydratedEpoch = new Map<string, number>();
  const attachmentPending = new Map<string, number>();
  let attachmentHydrationEpoch = 0;
  const beforeHistory: MessageAuthorityBridgeInput[] = [];

  const attachmentTargets = (): ReadonlyMap<string, string> => {
    const result = new Map<string, string>();
    if (state === undefined) return result;
    for (const message of state.timeline) {
      if (message.kind !== "human") continue;
      for (const attachment of message.attachments) {
        result.set(attachment.attachmentId, message.messageId);
      }
    }
    return result;
  };

  const hydrationFor = (attachmentId: string, sourceMessageId: string) => {
    if (state?.connection.status === "offline") {
      const previous = attachmentStatuses.get(attachmentId);
      return previous === undefined || previous.attachment.sourceMessageId !== sourceMessageId
        ? { status: "unavailable" as const, reason: "offline" as const }
        : { status: "available" as const, value: previous };
    }
    if (state?.connection.status === "repairing" || state?.connection.status === "repair-failed") {
      const previous = attachmentStatuses.get(attachmentId);
      return previous === undefined || previous.attachment.sourceMessageId !== sourceMessageId
        ? { status: "unavailable" as const, reason: "repairing" as const }
        : { status: "available" as const, value: previous };
    }
    if (attachmentPending.get(attachmentId) === attachmentHydrationEpoch ||
        attachmentHydratedEpoch.get(attachmentId) !== attachmentHydrationEpoch) {
      const previous = attachmentStatuses.get(attachmentId);
      return previous === undefined
        ? { status: "loading" as const }
        : { status: "loading" as const, previous };
    }
    const current = attachmentStatuses.get(attachmentId);
    if (current !== undefined) {
      return current.attachment.sourceMessageId === sourceMessageId
        ? { status: "available" as const, value: current }
        : { status: "unavailable" as const, reason: "unavailable" as const };
    }
    return {
      status: "unavailable" as const,
      reason: attachmentFailures.get(attachmentId) ?? "unavailable" as const,
    };
  };

  function closedHydrationReason(error: unknown): "forbidden" | "gone" | "unavailable" {
    if (typeof error !== "object" || error === null) return "unavailable";
    const candidate = "attachmentError" in error ? error.attachmentError : error;
    if (typeof candidate !== "object" || candidate === null || !("status" in candidate)) {
      return "unavailable";
    }
    return candidate.status === 403 ? "forbidden" : candidate.status === 410 ? "gone" : "unavailable";
  }

  function hydrateVisibleAttachments(): void {
    if (disposed || attachmentBridge === undefined || state === undefined ||
        state.connection.status !== "online") return;
    for (const [attachmentId, sourceMessageId] of attachmentTargets()) {
      if (attachmentHydratedEpoch.get(attachmentId) === attachmentHydrationEpoch ||
          attachmentPending.get(attachmentId) === attachmentHydrationEpoch) continue;
      const epoch = attachmentHydrationEpoch;
      attachmentPending.set(attachmentId, epoch);
      attachmentFailures.delete(attachmentId);
      void attachmentBridge.status({ type: "attachment.status.query", attachmentId })
        .then((status) => {
          if (disposed || epoch !== attachmentHydrationEpoch ||
              attachmentPending.get(attachmentId) !== epoch) return;
          attachmentPending.delete(attachmentId);
          attachmentHydratedEpoch.set(attachmentId, epoch);
          const attachment = status.attachment;
          if (attachment.attachmentId !== attachmentId || attachment.roomId !== roomId ||
              attachment.sourceMessageId !== sourceMessageId ||
              status.sourceEligibility !== "bound-active" ||
              attachment.processingStatus !== "ready") {
            attachmentStatuses.delete(attachmentId);
            attachmentFailures.set(attachmentId, "unavailable");
          } else {
            attachmentStatuses.set(attachmentId, status);
          }
          render();
        })
        .catch((error: unknown) => {
          if (disposed || epoch !== attachmentHydrationEpoch ||
              attachmentPending.get(attachmentId) !== epoch) return;
          attachmentPending.delete(attachmentId);
          attachmentHydratedEpoch.set(attachmentId, epoch);
          attachmentStatuses.delete(attachmentId);
          attachmentFailures.set(attachmentId, closedHydrationReason(error));
          render();
        });
    }
  }

  const render = (): void => {
    if (disposed || state === undefined) return;
    const currentAttachmentIds = new Set(attachmentTargets().keys());
    for (const attachmentId of attachmentStatuses.keys()) {
      if (!currentAttachmentIds.has(attachmentId)) attachmentStatuses.delete(attachmentId);
    }
    for (const attachmentId of attachmentFailures.keys()) {
      if (!currentAttachmentIds.has(attachmentId)) attachmentFailures.delete(attachmentId);
    }
    for (const attachmentId of attachmentHydratedEpoch.keys()) {
      if (!currentAttachmentIds.has(attachmentId)) attachmentHydratedEpoch.delete(attachmentId);
    }
    for (const attachmentId of attachmentPending.keys()) {
      if (!currentAttachmentIds.has(attachmentId)) attachmentPending.delete(attachmentId);
    }
    renderMessageAuthoritySurface(root, state, actions);
    const attachmentRoot = root.querySelector<HTMLElement>("[data-attachment-composer]");
    if (attachmentRoot !== null && attachmentBridge !== undefined) {
      if (attachmentComposer === undefined) {
        attachmentComposer = mountAttachmentComposerBridge(
          attachmentRoot,
          attachmentBridge,
          roomId,
          {
            accessProjection: () => {
              if (state?.connection.status === "revoked" || state?.connection.status === "fatal") {
                return "permission-revoked";
              }
              if (state?.lifecycle === "archived") return "archived-read-only";
              if (state?.connection.status === "offline") return "offline";
              if (state?.connection.status === "repairing" ||
                  state?.connection.status === "repair-failed") return "repairing";
              return "authorized";
            },
            onReadyAttachmentIdsChange(attachmentIds) {
              if (state === undefined) return;
              state = replaceState(state, {
                draft: {
                  ...state.draft,
                  attachments: attachmentIds.map((attachmentId) => ({ attachmentId })),
                },
              });
            },
            onSubmissionBlockedChange(blocked) {
              if (attachmentSubmissionBlocked === blocked) return;
              attachmentSubmissionBlocked = blocked;
              render();
            },
            onBindRequested() {
              root.querySelector<HTMLButtonElement>("[data-action='send-message']")?.focus();
            },
            onAnnouncement(message) {
              if (state === undefined) return;
              state = replaceState(state, { announcement: message });
              render();
            },
            ...(options.reducedMotion === undefined ? {} : {
              reducedMotion: options.reducedMotion,
            }),
          },
        );
      } else {
        attachmentComposer.remount(attachmentRoot);
      }
    }
    if (revisionTarget !== undefined) {
      const send = root.querySelector<HTMLButtonElement>("[data-action='send-message']");
      if (send !== null) send.textContent = "保存修订";
    }
    hydrateVisibleAttachments();
  };

  const applyStableEvent = (input: Extract<MessageAuthorityBridgeInput, { type: "room.event" }>): void => {
    if (state === undefined || replica === undefined || input.event.roomId !== roomId) return;
    if (input.generation !== replica.generation || input.cursorBefore !== replica.afterSeq) {
      state = state.connection.status === "repairing"
        ? failRepairGeneration(state, "event_cursor_mismatch")
        : replaceState(state, {
          connection: { status: "repair-failed", errorCode: "event_cursor_mismatch" },
          announcement: "事件游标不连续；旧完整 projection 已锁定并等待 repair",
        });
      render();
      return;
    }
    try {
      replica = applyMessageAuthorityEvent(replica, input.event);
      state = applyMessageAuthorityInput(state, eventInput(input.event));
      state = replaceState(state, {
        timeline: replica.timeline.map(mapTimelineMessage),
        projectionGeneration: replica.generation,
      });
      if (input.event.type === "room.message.accepted" &&
          input.event.payload.authorKind === "human") {
        attachmentComposer?.clearBound(
          input.event.payload.attachments.map((attachment) => attachment.attachmentId),
        );
      }
    } catch {
      state = replaceState(state, {
        connection: { status: "repair-failed", errorCode: "event_projection_invalid" },
        announcement: "事件无法安全投影；旧完整 projection 已锁定并等待 repair",
      });
    }
    render();
  };

  const applyCursorAdvance = (
    input: Extract<MessageAuthorityBridgeInput, { type: "room.cursor.advanced" }>,
  ): void => {
    if (state === undefined || replica === undefined || input.roomId !== roomId) return;
    if (input.generation !== replica.generation || input.cursorBefore !== replica.afterSeq) {
      state = state.connection.status === "repairing"
        ? failRepairGeneration(state, "event_cursor_mismatch")
        : replaceState(state, {
          connection: { status: "repair-failed", errorCode: "event_cursor_mismatch" },
          announcement: "事件游标不连续；旧完整 projection 已锁定并等待 repair",
        });
      render();
      return;
    }
    try {
      replica = advanceMessageAuthorityCursor(replica, {
        eventId: input.eventId,
        streamSeq: input.streamSeq,
      });
    } catch {
      state = replaceState(state, {
        connection: { status: "repair-failed", errorCode: "event_projection_invalid" },
        announcement: "事件无法安全投影；旧完整 projection 已锁定并等待 repair",
      });
      render();
    }
  };

  const applyConnection = (
    input: Extract<MessageAuthorityBridgeInput, { type: "message.connection" }>,
  ): void => {
    if (state === undefined || replica === undefined || input.roomId !== roomId) return;
    const connection = input.connection;
    if (connection.status === "revoked") {
      attachmentStatuses.clear();
      attachmentFailures.clear();
      attachmentHydratedEpoch.clear();
      attachmentPending.clear();
      replica = revokeMessageAuthorityRoom(replica);
      state = replaceState(state, {
        connection,
        timeline: [],
        actors: [],
        previews: [],
        executions: [],
        appliedEventIds: [],
        draft: emptyDraft(roomId, options.createMessageId()),
        announcement: "访问已撤销；Room 消息缓存已清除",
      });
    } else if (connection.status === "fatal") {
      replica = revokeMessageAuthorityRoom(replica);
      state = replaceState(state, {
        connection,
        timeline: [],
        previews: [],
        announcement: "无法验证权威消息状态；内容已锁定",
      });
    } else if (connection.status === "offline") {
      if (replica.mode === "online") replica = markMessageAuthorityOfflineReadOnly(replica);
      state = replaceState(state, {
        connection,
        announcement: "当前离线；显示旧完整缓存，消息写入已禁用",
      });
    } else if (connection.status === "repairing") {
      state = applyMessageAuthorityInput(state, {
        type: "repair.started",
        watermark: connection.watermark,
      });
    } else if (connection.status === "repair-failed") {
      state = state.connection.status === "repairing"
        ? failRepairGeneration(state, connection.errorCode)
        : replaceState(state, { connection });
    } else {
      replica = createMessageAuthorityReplica(roomId, {
        generation: replica.generation,
        checkpoint: replica.afterSeq,
        timeline: replica.timeline,
      });
      state = replaceState(state, { connection });
    }
    render();
  };

  const applyRepair = (
    input: Extract<MessageAuthorityBridgeInput, { type: "message.repair.completed" }>,
  ): void => {
    if (state === undefined || replica === undefined || input.roomId !== roomId ||
        input.generation <= replica.generation) return;
    const snapshotId = `message-repair-${input.generation}-${input.watermark}`;
    try {
      let stagingBase = createMessageAuthorityReplica(roomId, {
        generation: replica.generation,
        checkpoint: replica.afterSeq,
        timeline: replica.timeline,
      });
      stagingBase = beginMessageAuthorityRepair(stagingBase, {
        snapshotId,
        generation: input.generation,
        watermark: input.watermark,
      });
      for (const message of input.messages) {
        stagingBase = stageMessageAuthorityRepairRecord(stagingBase, snapshotId, {
          kind: "timeline-message",
          value: message,
        });
      }
      replica = commitMessageAuthorityRepair(stagingBase, {
        snapshotId,
        generation: input.generation,
        watermark: input.watermark,
      });
      if (state.connection.status !== "repairing" ||
          state.connection.watermark !== input.watermark) {
        state = replaceState(state, {
          connection: { status: "repairing", watermark: input.watermark },
        });
      }
      state = commitRepairGeneration(state, {
        generation: input.generation,
        watermark: input.watermark,
        timeline: replica.timeline.map(mapTimelineMessage),
        executions: [],
        appliedEventIds: input.eventIds,
      });
    } catch {
      state = state.connection.status === "repairing"
        ? failRepairGeneration(state, "repair_projection_invalid")
        : replaceState(state, {
          connection: { status: "repair-failed", errorCode: "repair_projection_invalid" },
        });
    }
    render();
  };

  const applyInput = (input: MessageAuthorityBridgeInput): void => {
    if (state === undefined) {
      beforeHistory.push(input);
      return;
    }
    if (input.type === "room.event") {
      if (awaitingReceipt !== undefined &&
          input.event.payload.id === awaitingReceipt.payload.messageId) {
        awaitingReceipt.queued.push(input);
        return;
      }
      if (awaitingMutationReceipt !== undefined &&
          input.event.payload.id === awaitingMutationReceipt.messageId) {
        awaitingMutationReceipt.queued.push(input);
        return;
      }
      applyStableEvent(input);
      return;
    }
    if (input.type === "room.cursor.advanced") {
      applyCursorAdvance(input);
      return;
    }
    if (input.type === "message.connection") {
      applyConnection(input);
      return;
    }
    if (input.type === "message.repair.completed") {
      applyRepair(input);
      return;
    }
    if (awaitingReceipt !== undefined) {
      awaitingReceipt.queued.push(input);
      return;
    }
    if (awaitingMutationReceipt !== undefined &&
        (input.type === "message.error" || input.type === "message.revision.accepted" ||
          input.type === "message.recall.accepted")) {
      awaitingMutationReceipt.queued.push(input);
      return;
    }
    if (input.type === "message.accepted" || input.type === "message.error" ||
        input.type === "message.revision.accepted" || input.type === "message.recall.accepted") {
      const boundAttachmentIds = input.type === "message.accepted" && state.submission.status === "submitting"
        ? state.submission.payload.attachments.map((attachment) => attachment.attachmentId)
        : [];
      state = applyMessageAuthorityInput(state, input);
      if (input.type === "message.accepted") attachmentComposer?.clearBound(boundAttachmentIds);
      render();
      return;
    }
  };

  const newDraft = (): MessageDraft => emptyDraft(roomId, options.createMessageId());

  const sendDraft = async (payload: MessageDraft, retry: boolean): Promise<void> => {
    if (state === undefined || !state.composerEnabled || awaitingReceipt !== undefined ||
        attachmentSubmissionBlocked ||
        awaitingMutationReceipt !== undefined || state.mutation.status === "pending" ||
        state.mutation.status === "event-observed" ||
        state.mutation.status === "acknowledged") return;
    if (revisionTarget !== undefined) {
      const target = revisionTarget;
      state = replaceState(state, { draft: payload, announcement: "正在提交消息修订" });
      render();
      const pending: AwaitingMutationReceipt = {
        kind: "revise", messageId: target.messageId,
        expectedRevision: target.expectedRevision, body: payload.body, queued: [],
      };
      awaitingMutationReceipt = pending;
      try {
        const receipt = await bridge.revise({
          type: "message.revise",
          roomId,
          messageId: target.messageId,
          expectedRevision: target.expectedRevision,
          body: payload.body,
        });
        state = beginMessageMutation(state, {
          kind: pending.kind,
          messageId: pending.messageId,
          expectedRevision: pending.expectedRevision,
          body: pending.body!,
          requestId: receipt.requestId,
        });
        revisionTarget = undefined;
        awaitingMutationReceipt = undefined;
        render();
        for (const queued of pending.queued) applyInput(queued);
      } catch {
        awaitingMutationReceipt = undefined;
        state = replaceState(state, { announcement: "修订命令未进入闭合 bridge；正文已保留" });
      }
      render();
      return;
    }
    const pending: AwaitingReceipt = { payload, queued: [] };
    awaitingReceipt = pending;
    state = replaceState(state, { draft: payload });
    try {
      const receipt = await bridge.sendV2({
        type: "message.send.v2",
        message: payload as HumanMessageSubmit,
      });
      state = retry
        ? retryMessageSubmission(state, receipt.requestId)
        : beginMessageSubmission(state, receipt.requestId);
      state = replaceState(state, { draft: newDraft() });
      awaitingReceipt = undefined;
      render();
      for (const queued of pending.queued) applyInput(queued);
    } catch {
      awaitingReceipt = undefined;
      state = replaceState(state, {
        announcement: "消息命令未进入闭合 bridge；输入已保留",
      });
      render();
    }
  };

  const actions: MessageAuthoritySurfaceActions = {
    onDraftBodyChange(body) {
      if (state === undefined) return;
      state = replaceState(state, { draft: { ...state.draft, body } });
    },
    onSend: (draft) => { void sendDraft(draft, false); },
    onRetry: (draft) => { void sendDraft(draft, true); },
    onSelectMention(actor: MessageActorOption) {
      if (state === undefined || !state.composerEnabled) return;
      const prefix = state.draft.body.length === 0 || state.draft.body.endsWith(" ") ? "" : " ";
      const mention = `@${actor.displayName}`;
      const startUtf16 = state.draft.body.length + prefix.length;
      state = replaceState(state, {
        draft: {
          ...state.draft,
          body: `${state.draft.body}${prefix}${mention}`,
          mentionedTargets: [...state.draft.mentionedTargets, {
            id: options.createTargetId(),
            kind: actor.kind === "human" ? "human-request" : "agent-invocation",
            targetActorId: actor.actorId,
            range: { startUtf16, endUtf16: startUtf16 + mention.length },
          }],
        },
      });
      render();
    },
    onRevise(messageId) {
      if (state === undefined || !state.composerEnabled || awaitingMutationReceipt !== undefined ||
          state.mutation.status === "pending" || state.mutation.status === "event-observed" ||
          state.mutation.status === "acknowledged") return;
      if (state.draft.attachments.length > 0) {
        state = replaceState(state, {
          announcement: "请先移除当前附件，再编辑历史消息正文",
        });
        render();
        return;
      }
      const message = state.timeline.find((candidate) =>
        candidate.messageId === messageId && candidate.kind === "human");
      if (message?.kind !== "human") return;
      void bridge.revisionsQuery({
        type: "message.revisions.query",
        roomId,
        messageId,
      }).then((result) => {
        if (disposed || state === undefined) return;
        if (result.type === "message.error") {
          state = replaceState(state, {
            announcement: `无法载入修订历史；${result.status} ${result.code}`,
          });
          render();
          return;
        }
        const latest = result.revisions.at(-1);
        if (latest === undefined) return;
        revisionTarget = { messageId, expectedRevision: latest.revision };
        state = replaceState(state, {
          draft: { ...newDraft(), body: latest.body },
          announcement: `已载入 v${latest.revision}；保存将提交 revision intent`,
        });
        render();
      }).catch(() => {
        if (state === undefined) return;
        state = replaceState(state, { announcement: "无法载入修订历史" });
        render();
      });
    },
    onRecall(messageId) {
      if (state === undefined || !state.composerEnabled || awaitingMutationReceipt !== undefined ||
          state.mutation.status === "pending" || state.mutation.status === "event-observed" ||
          state.mutation.status === "acknowledged") return;
      const message = state.timeline.find((candidate) => candidate.messageId === messageId);
      if (message?.kind !== "human") return;
      const pending: AwaitingMutationReceipt = {
        kind: "recall", messageId, expectedRevision: message.revision, queued: [],
      };
      awaitingMutationReceipt = pending;
      void bridge.recall({ type: "message.recall", roomId, messageId,
        expectedRevision: message.revision }).then((receipt) => {
        if (disposed || state === undefined || awaitingMutationReceipt !== pending) return;
        state = beginMessageMutation(state, {
          kind: pending.kind,
          messageId: pending.messageId,
          expectedRevision: pending.expectedRevision,
          requestId: receipt.requestId,
        });
        awaitingMutationReceipt = undefined;
        render();
        for (const queued of pending.queued) applyInput(queued);
      }).catch(() => {
        if (state === undefined || awaitingMutationReceipt !== pending) return;
        awaitingMutationReceipt = undefined;
        state = replaceState(state, { announcement: "撤回命令未进入闭合 bridge；旧正文已保留" });
        render();
      });
    },
    onRetryRepair: () => { void loadHistory(); },
    onReconnect: () => { void loadHistory(); },
    onReauthenticate: () => { void loadHistory(); },
    onRefreshProjection: () => { void loadHistory(); },
    onDismissReply() {
      if (state === undefined) return;
      const draft: MessageDraft = {
        messageId: state.draft.messageId,
        roomId: state.draft.roomId,
        body: state.draft.body,
        mentionedTargets: state.draft.mentionedTargets,
        attachments: state.draft.attachments,
      };
      state = replaceState(state, { draft });
      render();
    },
    ...(memoryBridge === undefined ? {} : {
      onOpenCitation(citation) {
        if (state === undefined || state.connection.status !== "online") return;
        const openedFrom = state;
        void memoryBridge.context({ roomId }).then(async (context) => {
          if (disposed || state === undefined || state !== openedFrom ||
              context.roomId !== roomId || context.lifecycle !== "active") throw new Error("citation context stale");
          if (citation.sourceKind === "memory") {
            const target = [...document.querySelectorAll<HTMLElement>("[data-memory-record-id]")]
              .find((candidate) => candidate.dataset.memoryRecordId === citation.sourceId);
            if (target === undefined) throw new Error("citation source unavailable");
            target.tabIndex = -1;
            target.scrollIntoView?.({ block: "center", behavior: "auto" });
            target.focus({ preventScroll: true });
            return;
          }
          const response = await memoryBridge.request({
            accessEpoch: context.accessEpoch,
            frame: {
              type: "room.memory.source.query.v1",
              requestId: `citation-${globalThis.crypto.randomUUID()}`,
              roomId,
              sourceKind: citation.sourceKind,
              sourceId: citation.sourceId,
              sourceRevision: citation.sourceRevision,
            },
          });
          if (!isMemoryAuthorityEpochResponse(response) || response.accessEpoch !== context.accessEpoch ||
              response.frame.type !== "room.memory.source.v1") {
            throw new Error("citation source unavailable");
          }
          const navigation = response.frame.source.navigation;
          const targetId = navigation.kind === "attachment"
            ? navigation.attachmentId
            : navigation.kind === "project_fact" ? undefined : navigation.messageId;
          const attribute = navigation.kind === "attachment" ? "data-attachment-id" : "data-message-id";
          const target = targetId === undefined ? undefined
            : [...document.querySelectorAll<HTMLElement>(`[${attribute}]`)]
              .find((candidate) => candidate.getAttribute(attribute) === targetId);
          if (target === undefined) throw new Error("citation source unavailable");
          target.tabIndex = -1;
          target.scrollIntoView?.({ block: "center", behavior: "auto" });
          target.focus({ preventScroll: true });
        }).catch(() => {
          if (disposed || state === undefined) return;
          state = replaceState(state, { announcement: "来源不可访问；未显示来源正文" });
          render();
        });
      },
    }),
    ...(attachmentBridge === undefined ? {} : {
      attachmentSubmissionBlocked: () => attachmentSubmissionBlocked,
      onSelectAttachment() {
        if (state === undefined || !state.composerEnabled || revisionTarget !== undefined) return;
        void attachmentComposer?.select();
      },
      onPreviewAttachment(attachmentId: string) {
        void attachmentBridge.preview({
          type: "attachment.preview",
          attachmentId,
          representation: "safe-rendered",
        }).catch(() => undefined);
      },
      onDownloadAttachment(attachmentId: string) {
        void attachmentBridge.download({
          type: "attachment.download",
          attachmentId,
        }).catch(() => undefined);
      },
      attachmentHydration: hydrationFor,
    }),
  };

  const acceptHistory = (history: MessageAuthorityReadyHistory): void => {
    const previous = state;
    replica = createMessageAuthorityReplica(roomId, {
      generation: history.generation,
      checkpoint: history.watermark,
      timeline: history.messages,
    });
    state = createMessageAuthorityState({
      roomId,
      viewerActorId: history.viewerActorId,
      lifecycle: history.lifecycle,
      connection: history.connection,
      actors: history.actors,
      draft: previous?.draft ?? newDraft(),
      ...(previous === undefined ? {} : {
        submission: previous.submission,
        mutation: previous.mutation,
      }),
      timeline: history.messages.map(mapTimelineMessage),
      executions: [],
      previews: [],
      appliedEventIds: [],
      projectionGeneration: history.generation,
      reducedMotion: options.reducedMotion ?? false,
      announcement: "Room 权威消息已载入",
    });
  };

  const loadHistory = async (): Promise<void> => {
    if (disposed) return;
    attachmentHydrationEpoch += 1;
    attachmentPending.clear();
    const priorState = state;
    if (state === undefined) {
      renderLoading(root);
    } else {
      const watermark = replica?.afterSeq ?? 0;
      state = replaceState(state, {
        connection: { status: "repairing", watermark },
        announcement: `正在重新连接并恢复；旧完整 projection 保持可见，staging 不可见`,
      });
      render();
    }
    try {
      const history = await bridge.historyV2({ type: "room.history.v2", roomId });
      if (disposed) return;
      if (history.status === "ready") {
        acceptHistory(history);
      } else if (priorState !== undefined && history.connection.status !== "revoked") {
        state = state === undefined ? priorState : state;
        state = state.connection.status === "repairing"
          ? failRepairGeneration(state, history.connection.errorCode)
          : replaceState(state, {
            connection: { status: "repair-failed", errorCode: history.connection.errorCode },
            announcement: "恢复失败；继续使用旧完整 projection",
          });
      } else {
        replica = createMessageAuthorityReplica(roomId);
        if (history.connection.status === "revoked") replica = revokeMessageAuthorityRoom(replica);
        state = createMessageAuthorityState({
          roomId,
          viewerActorId: "unavailable",
          lifecycle: "active",
          connection: history.connection,
          actors: [],
          draft: newDraft(),
          timeline: [],
          executions: [],
          previews: [],
          appliedEventIds: [],
          projectionGeneration: 0,
          reducedMotion: options.reducedMotion ?? false,
          announcement: "Room 权威消息不可用；已 fail closed",
        });
      }
      render();
      const queued = beforeHistory.splice(0);
      for (const input of queued) applyInput(input);
    } catch {
      if (disposed) return;
      if (priorState !== undefined && state !== undefined) {
        state = state.connection.status === "repairing"
          ? failRepairGeneration(state, "history_unavailable")
          : replaceState(state, {
            connection: { status: "repair-failed", errorCode: "history_unavailable" },
            announcement: "恢复失败；继续使用旧完整 projection",
          });
        render();
        return;
      }
      replica = revokeMessageAuthorityRoom(createMessageAuthorityReplica(roomId));
      state = createMessageAuthorityState({
        roomId,
        viewerActorId: "unavailable",
        lifecycle: "active",
        connection: { status: "fatal", errorCode: "history_unavailable" },
        actors: [],
        draft: newDraft(),
        timeline: [],
        executions: [],
        previews: [],
        appliedEventIds: [],
        projectionGeneration: 0,
        reducedMotion: options.reducedMotion ?? false,
        announcement: "Room 权威消息不可用；已 fail closed",
      });
      render();
    }
  };

  renderLoading(root);
  const unsubscribe = bridge.onAuthorityInput(applyInput);
  void loadHistory();

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    attachmentComposer?.dispose();
    attachmentStatuses.clear();
    attachmentFailures.clear();
    attachmentHydratedEpoch.clear();
    attachmentPending.clear();
    root.replaceChildren();
  };
}
