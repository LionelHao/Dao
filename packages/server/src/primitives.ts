import {
  isAgentExecution,
  isAgentJudgement,
  isCalibrationSignal,
  isHumanReadReceipt,
  isOpenItem,
} from "@native-im/core";
import type {
  Actor,
  AgentActor,
  AgentExecution,
  AgentJudgement,
  AgentJudgementOutcome,
  AgentReadiness,
  CalibrationSignal,
  HumanActor,
  HumanReadReceipt,
  Message,
  OpenItem,
  OpenItemTransfer,
  Room,
  SocialReaction,
} from "@native-im/core";
import type {
  AgentCollaborationCommand,
  AuthenticatedCommandContext,
  CommandAcknowledgement,
  CommandStore,
  HumanCollaborationCommand,
  InternalAgentCommandContext,
} from "./persistence/contracts.js";

export type {
  AgentExecution,
  AgentExecutionStatus,
  AgentJudgement,
  AgentJudgementOutcome,
  CalibrationSignal,
  HumanReadReceipt,
  OpenItem,
  OpenItemStatus,
  OpenItemTransfer,
  SocialReaction,
} from "@native-im/core";

export interface AgentToolInvocation {
  readonly agentId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly input: string;
  readonly signal: AbortSignal;
}

export type AgentToolInvoker = (invocation: AgentToolInvocation) => Promise<string>;

export interface AgentCorrection {
  readonly id: string;
  readonly originalMessageId: string;
  readonly agentId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface MessageState {
  readonly id: string;
  readonly body: string;
  readonly edited: boolean;
  readonly recalled: boolean;
}

export type AcceptedCollaborationFact =
  | { readonly kind: "human-read"; readonly value: HumanReadReceipt }
  | { readonly kind: "agent-judgment"; readonly value: AgentJudgement }
  | { readonly kind: "open-item"; readonly value: OpenItem }
  | { readonly kind: "agent-execution"; readonly value: AgentExecution }
  | { readonly kind: "calibration"; readonly value: CalibrationSignal };

export type PrimitiveErrorCode =
  | "unknown_actor"
  | "unknown_message"
  | "unknown_room"
  | "actor_not_in_room"
  | "human_target_required"
  | "agent_target_required"
  | "agent_missing_permission"
  | "agent_message_immutable"
  | "message_author_mismatch"
  | "unknown_open_item"
  | "unknown_execution"
  | "agent_cannot_reject_invocation"
  | "here_requires_room_owner"
  | "here_rate_limited"
  | "unsupported_agent_reaction";

export class CollaborationPrimitiveError extends Error {
  readonly code: PrimitiveErrorCode;

  constructor(code: PrimitiveErrorCode) {
    super(code);
    this.name = "CollaborationPrimitiveError";
    this.code = code;
  }
}

export interface CollaborationPrimitivesOptions {
  readonly actors: readonly Actor[];
  readonly rooms: readonly Room[];
  readonly messages: readonly Message[];
  readonly roomOwners?: ReadonlyMap<string, string>;
  readonly toolInvokers?: Readonly<Record<string, AgentToolInvoker>>;
  readonly now?: () => string;
  readonly hereRateLimitMs?: number;
}

type HumanReadCommand = Extract<HumanCollaborationCommand, { readonly type: "human.read.record" }>;
type AgentJudgementCommand = Extract<AgentCollaborationCommand, { readonly type: "agent.judgment.record" }>;
type OpenItemCreateCommand = Extract<HumanCollaborationCommand, { readonly type: "open-item.create" }>;
type OpenItemTransitionCommand = Extract<HumanCollaborationCommand, { readonly type: "open-item.transition" }>;
type AgentExecutionCommand = Extract<AgentCollaborationCommand, { readonly type: "agent.execution.transition" }>;
type CalibrationCommand = Extract<HumanCollaborationCommand, { readonly type: "calibration.record" }>;

export interface AuthoritativeCollaborationPrimitivesOptions {
  readonly commandStore: CommandStore;
  readonly publishAccepted?: (fact: AcceptedCollaborationFact) => void;
}

export interface AuthoritativeCollaborationPrimitives {
  recordHumanRead(
    context: AuthenticatedCommandContext,
    roomId: string,
    payload: HumanReadCommand["payload"],
  ): Promise<HumanReadReceipt>;
  recordAgentJudgement(
    context: InternalAgentCommandContext,
    roomId: string,
    payload: AgentJudgementCommand["payload"],
  ): Promise<AgentJudgement>;
  createOpenItem(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    roomId: string,
    payload: OpenItemCreateCommand["payload"],
  ): Promise<OpenItem>;
  transitionOpenItem(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    roomId: string,
    payload: OpenItemTransitionCommand["payload"],
  ): Promise<OpenItem>;
  transitionAgentExecution(
    context: InternalAgentCommandContext,
    roomId: string,
    payload: AgentExecutionCommand["payload"],
  ): Promise<AgentExecution>;
  recordCalibration(
    context: AuthenticatedCommandContext,
    roomId: string,
    payload: CalibrationCommand["payload"],
  ): Promise<CalibrationSignal>;
}

function authoritativeResult<T>(
  acknowledgement: CommandAcknowledgement,
  key: string,
  guard: (value: unknown) => value is T,
): T {
  const result = acknowledgement.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new TypeError("Authoritative primitive acknowledgement is invalid");
  }
  const value = Reflect.get(result, key);
  if (!guard(value)) {
    throw new TypeError("Authoritative primitive acknowledgement is invalid");
  }
  return value;
}

export function createAuthoritativeCollaborationPrimitives(
  options: AuthoritativeCollaborationPrimitivesOptions,
): AuthoritativeCollaborationPrimitives {
  async function publish<T>(
    promise: Promise<CommandAcknowledgement>,
    key: string,
    guard: (value: unknown) => value is T,
    toFact: (value: T) => AcceptedCollaborationFact,
  ): Promise<T> {
    const acknowledgement = await promise;
    const value = authoritativeResult(acknowledgement, key, guard);
    try {
      options.publishAccepted?.(toFact(value));
    } catch {
      // Post-commit observation must not change the durable command acknowledgement.
    }
    return value;
  }

  function executeOpenItem(
    context: AuthenticatedCommandContext | InternalAgentCommandContext,
    command: OpenItemCreateCommand | OpenItemTransitionCommand,
  ): Promise<CommandAcknowledgement> {
    return context.kind === "human"
      ? options.commandStore.executeHuman(context, command)
      : options.commandStore.executeAgent(context, command);
  }

  return {
    recordHumanRead(context, roomId, payload) {
      return publish(
        options.commandStore.executeHuman(context, { type: "human.read.record", roomId, payload }),
        "receipt",
        isHumanReadReceipt,
        (value) => ({ kind: "human-read", value }),
      );
    },
    recordAgentJudgement(context, roomId, payload) {
      return publish(
        options.commandStore.executeAgent(context, { type: "agent.judgment.record", roomId, payload }),
        "judgment",
        isAgentJudgement,
        (value) => ({ kind: "agent-judgment", value }),
      );
    },
    createOpenItem(context, roomId, payload) {
      return publish(
        executeOpenItem(context, { type: "open-item.create", roomId, payload }),
        "item",
        isOpenItem,
        (value) => ({ kind: "open-item", value }),
      );
    },
    transitionOpenItem(context, roomId, payload) {
      return publish(
        executeOpenItem(context, { type: "open-item.transition", roomId, payload }),
        "item",
        isOpenItem,
        (value) => ({ kind: "open-item", value }),
      );
    },
    transitionAgentExecution(context, roomId, payload) {
      return publish(
        options.commandStore.executeAgent(context, { type: "agent.execution.transition", roomId, payload }),
        "execution",
        isAgentExecution,
        (value) => ({ kind: "agent-execution", value }),
      );
    },
    recordCalibration(context, roomId, payload) {
      return publish(
        options.commandStore.executeHuman(context, { type: "calibration.record", roomId, payload }),
        "signal",
        isCalibrationSignal,
        (value) => ({ kind: "calibration", value }),
      );
    },
  };
}

export interface CollaborationPrimitives {
  recordHumanRead(input: { readonly messageId: string; readonly readerId: string }): HumanReadReceipt;
  humanReadReceiptsFor(messageId: string): readonly HumanReadReceipt[];
  evaluateAgentJudgement(input: {
    readonly messageId: string;
    readonly agentId: string;
    readonly matchesDomain: boolean;
    readonly cooldownRemainingMinutes?: number;
    readonly willRespond?: boolean;
  }): AgentJudgement;
  agentJudgementsFor(messageId: string): readonly AgentJudgement[];
  addressHuman(input: {
    readonly messageId: string;
    readonly requesterId: string;
    readonly targetId: string;
    readonly content: string;
  }): OpenItem;
  openItemsFor(roomId: string): readonly OpenItem[];
  respondToOpenItem(itemId: string, status: "responded" | "deferred"): OpenItem;
  transferOpenItem(itemId: string, targetId: string, reason: string): OpenItem;
  addressAgent(input: {
    readonly messageId: string;
    readonly requesterId: string;
    readonly targetId: string;
    readonly toolName: string;
    readonly input: string;
  }): AgentExecution;
  agentReadiness(agentId: string): AgentReadiness;
  interruptAgentExecution(executionId: string): AgentExecution;
  waitForAgentExecution(executionId: string): Promise<AgentExecution>;
  rejectAgentExecution(executionId: string): never;
  addressAll(input: {
    readonly roomId: string;
    readonly requesterId: string;
    readonly messageId: string;
    readonly toolNameByAgentId: ReadonlyMap<string, string>;
    readonly input: string;
  }): readonly AgentExecution[];
  addressHere(input: { readonly roomId: string; readonly requesterId: string }):
    | { readonly ok: true; readonly recipientIds: readonly string[] }
    | { readonly ok: false; readonly code: "here_requires_room_owner" | "here_rate_limited" };
  editMessage(input: { readonly messageId: string; readonly actorId: string; readonly body: string }): MessageState;
  recallMessage(input: { readonly messageId: string; readonly actorId: string }): MessageState;
  messageState(messageId: string): MessageState;
  correctAgentMessage(input: { readonly originalMessageId: string; readonly agentId: string; readonly body: string }): AgentCorrection;
  correctionsFor(originalMessageId: string): readonly AgentCorrection[];
  react(input: { readonly messageId: string; readonly actorId: string; readonly emoji: string }): SocialReaction | CalibrationSignal;
  socialReactionsFor(messageId: string): readonly SocialReaction[];
  calibrationSignalsFor(agentId: string): readonly CalibrationSignal[];
}

function cloneOpenItem(item: OpenItem): OpenItem {
  return { ...item, transferChain: item.transferChain.map((entry) => ({ ...entry })) };
}

function cloneExecution(execution: AgentExecution): AgentExecution {
  return { ...execution };
}

function requireNonEmpty(text: string): void {
  if (text.trim().length === 0) {
    throw new TypeError("Primitive text must not be empty");
  }
}

export function createCollaborationPrimitives(
  options: CollaborationPrimitivesOptions,
): CollaborationPrimitives {
  const actorsById = new Map(options.actors.map((actor) => [actor.id, actor]));
  const roomsById = new Map(options.rooms.map((room) => [room.id, room]));
  const messagesById = new Map(options.messages.map((message) => [message.id, message]));
  const messageStatesById = new Map<string, MessageState>(
    options.messages.map((message) => [
      message.id,
      { id: message.id, body: message.body, edited: false, recalled: false },
    ]),
  );
  const humanReadReceipts: HumanReadReceipt[] = [];
  const agentJudgements: AgentJudgement[] = [];
  const openItemsById = new Map<string, OpenItem>();
  const executionsById = new Map<string, AgentExecution>();
  const executionControllersById = new Map<string, AbortController>();
  const executionPromisesById = new Map<string, Promise<AgentExecution>>();
  const corrections: AgentCorrection[] = [];
  const socialReactions: SocialReaction[] = [];
  const calibrationSignals: CalibrationSignal[] = [];
  const agentReadinessOverridesById = new Map<string, AgentReadiness>();
  const lastHereAtByRoom = new Map<string, number>();
  const now = options.now ?? (() => new Date().toISOString());
  const roomOwners = options.roomOwners ?? new Map<string, string>();
  const toolInvokers = options.toolInvokers ?? {};
  const hereRateLimitMs = options.hereRateLimitMs ?? 60_000;
  let sequence = 0;

  function nextId(prefix: string): string {
    sequence += 1;
    return `${prefix}-${sequence}`;
  }

  function actor(actorId: string): Actor {
    const value = actorsById.get(actorId);
    if (value === undefined) {
      throw new CollaborationPrimitiveError("unknown_actor");
    }
    return value;
  }

  function human(actorId: string): HumanActor {
    const value = actor(actorId);
    if (value.kind !== "human") {
      throw new CollaborationPrimitiveError("human_target_required");
    }
    return value;
  }

  function agent(actorId: string): AgentActor {
    const value = actor(actorId);
    if (value.kind !== "agent") {
      throw new CollaborationPrimitiveError("agent_target_required");
    }
    return value;
  }

  function room(roomId: string): Room {
    const value = roomsById.get(roomId);
    if (value === undefined) {
      throw new CollaborationPrimitiveError("unknown_room");
    }
    return value;
  }

  function message(messageId: string): Message {
    const value = messagesById.get(messageId);
    if (value === undefined) {
      throw new CollaborationPrimitiveError("unknown_message");
    }
    return value;
  }

  function assertRoomMembership(actorId: string, roomId: string): void {
    if (!room(roomId).memberIds.includes(actorId)) {
      throw new CollaborationPrimitiveError("actor_not_in_room");
    }
  }

  function execution(executionId: string): AgentExecution {
    const value = executionsById.get(executionId);
    if (value === undefined) {
      throw new CollaborationPrimitiveError("unknown_execution");
    }
    return value;
  }

  function updateExecution(
    value: AgentExecution,
    update: Partial<Pick<AgentExecution,
      "status" | "toolDispatchPhase" | "updatedAt" | "finishedAt" |
      "cancellationReason" | "terminalErrorCode"
    >>,
  ): AgentExecution {
    const next: AgentExecution = { ...value, ...update };
    executionsById.set(next.id, next);
    return next;
  }

  function startAgentExecution(input: {
    readonly message: Message;
    readonly requesterId: string;
    readonly target: AgentActor;
    readonly toolName: string;
    readonly input: string;
  }): AgentExecution {
    if (!input.target.toolPermissions.includes(input.toolName)) {
      throw new CollaborationPrimitiveError("agent_missing_permission");
    }
    const toolInvoker = toolInvokers[input.toolName];
    if (toolInvoker === undefined) {
      throw new CollaborationPrimitiveError("agent_missing_permission");
    }

    const controller = new AbortController();
    const startedAt = now();
    const initial: AgentExecution = {
      id: nextId("execution"),
      roomId: input.message.roomId,
      sourceMessageId: input.message.id,
      requesterId: input.requesterId,
      agentId: input.target.id,
      status: "running",
      actionCategory: "tool_call",
      toolDispatchPhase: "dispatched",
      currentToolId: input.toolName,
      currentAttemptSeq: 1,
      retryCycle: 1,
      retryOrdinal: 1,
      providerId: "legacy-direct-tool",
      modelId: "no-model",
      recoveryCursor: 0,
      queuedAt: startedAt,
      startedAt,
      updatedAt: startedAt,
    };
    executionsById.set(initial.id, initial);
    executionControllersById.set(initial.id, controller);
    agentReadinessOverridesById.set(input.target.id, "busy");

    const running = (async (): Promise<AgentExecution> => {
      try {
        await toolInvoker({
          agentId: input.target.id,
          roomId: input.message.roomId,
          messageId: input.message.id,
          input: input.input,
          signal: controller.signal,
        });
        const current = execution(initial.id);
        if (current.status !== "running") {
          return cloneExecution(current);
        }
        const finishedAt = now();
        const completed = updateExecution(current, {
          status: "completed", toolDispatchPhase: "finished", finishedAt, updatedAt: finishedAt,
        });
        agentReadinessOverridesById.set(input.target.id, "ready");
        return cloneExecution(completed);
      } catch {
        const current = execution(initial.id);
        if (current.status === "running") {
          const finishedAt = now();
          const finished = controller.signal.aborted
            ? updateExecution(current, {
              status: "cancelled", toolDispatchPhase: "finished", finishedAt, updatedAt: finishedAt,
              cancellationReason: "human_interrupt",
            })
            : updateExecution(current, {
              status: "failed", toolDispatchPhase: "finished", finishedAt, updatedAt: finishedAt,
              terminalErrorCode: "tool_failure",
            });
          agentReadinessOverridesById.set(input.target.id, "ready");
          return cloneExecution(finished);
        }
        return cloneExecution(current);
      } finally {
        executionControllersById.delete(initial.id);
      }
    })();
    executionPromisesById.set(initial.id, running);
    return cloneExecution(initial);
  }

  return {
    recordHumanRead(input): HumanReadReceipt {
      human(input.readerId);
      message(input.messageId);
      const receipt: HumanReadReceipt = {
        id: nextId("human-read"),
        messageId: input.messageId,
        readerId: input.readerId,
        readAt: now(),
      };
      humanReadReceipts.push(receipt);
      return { ...receipt };
    },

    humanReadReceiptsFor(messageId: string): readonly HumanReadReceipt[] {
      message(messageId);
      return humanReadReceipts.filter((receipt) => receipt.messageId === messageId).map((receipt) => ({ ...receipt }));
    },

    evaluateAgentJudgement(input): AgentJudgement {
      agent(input.agentId);
      message(input.messageId);
      const outcome: AgentJudgementOutcome = input.cooldownRemainingMinutes !== undefined && input.cooldownRemainingMinutes > 0
        ? "suppressed"
        : input.willRespond === true || input.matchesDomain
          ? "will_respond"
          : "no_response_needed";
      const reason = outcome === "suppressed"
        ? `同话题冷却期内，还剩 ${input.cooldownRemainingMinutes} 分钟`
        : outcome === "will_respond"
          ? "命中我的领域，准备回应"
          : "未命中我的领域";
      const judgement: AgentJudgement = {
        id: nextId("agent-judgement"),
        messageId: input.messageId,
        agentId: input.agentId,
        outcome,
        reason,
        decidedAt: now(),
      };
      agentJudgements.push(judgement);
      return { ...judgement };
    },

    agentJudgementsFor(messageId: string): readonly AgentJudgement[] {
      message(messageId);
      return agentJudgements.filter((judgement) => judgement.messageId === messageId).map((judgement) => ({ ...judgement }));
    },

    addressHuman(input): OpenItem {
      const sourceMessage = message(input.messageId);
      human(input.requesterId);
      human(input.targetId);
      assertRoomMembership(input.requesterId, sourceMessage.roomId);
      assertRoomMembership(input.targetId, sourceMessage.roomId);
      requireNonEmpty(input.content);
      const openItem: OpenItem = {
        id: nextId("open-item"),
        roomId: sourceMessage.roomId,
        sourceMessageId: sourceMessage.id,
        requesterId: input.requesterId,
        ownerId: input.targetId,
        content: input.content,
        status: "pending_response",
        createdAt: now(),
        transferChain: [],
      };
      openItemsById.set(openItem.id, openItem);
      return cloneOpenItem(openItem);
    },

    openItemsFor(roomId: string): readonly OpenItem[] {
      room(roomId);
      return [...openItemsById.values()].filter((item) => item.roomId === roomId).map(cloneOpenItem);
    },

    respondToOpenItem(itemId: string, status: "responded" | "deferred"): OpenItem {
      const item = openItemsById.get(itemId);
      if (item === undefined) {
        throw new CollaborationPrimitiveError("unknown_open_item");
      }
      const next: OpenItem = {
        ...item,
        status,
        ...(status === "responded" ? { respondedAt: now() } : {}),
      };
      openItemsById.set(itemId, next);
      return cloneOpenItem(next);
    },

    transferOpenItem(itemId: string, targetId: string, reason: string): OpenItem {
      const item = openItemsById.get(itemId);
      if (item === undefined) {
        throw new CollaborationPrimitiveError("unknown_open_item");
      }
      human(targetId);
      assertRoomMembership(targetId, item.roomId);
      requireNonEmpty(reason);
      const transfer: OpenItemTransfer = {
        fromId: item.ownerId,
        toId: targetId,
        reason,
        transferredAt: now(),
      };
      const next: OpenItem = {
        ...item,
        ownerId: targetId,
        status: "transferred",
        transferChain: [...item.transferChain, transfer],
      };
      openItemsById.set(itemId, next);
      return cloneOpenItem(next);
    },

    addressAgent(input): AgentExecution {
      const sourceMessage = message(input.messageId);
      human(input.requesterId);
      const target = agent(input.targetId);
      assertRoomMembership(input.requesterId, sourceMessage.roomId);
      assertRoomMembership(target.id, sourceMessage.roomId);
      requireNonEmpty(input.input);
      return startAgentExecution({
        message: sourceMessage,
        requesterId: input.requesterId,
        target,
        toolName: input.toolName,
        input: input.input,
      });
    },

    agentReadiness(agentId: string): AgentReadiness {
      const target = agent(agentId);
      return agentReadinessOverridesById.get(agentId) ?? target.readiness;
    },

    interruptAgentExecution(executionId: string): AgentExecution {
      const current = execution(executionId);
      if (current.status !== "running") {
        return cloneExecution(current);
      }
      const finishedAt = now();
      const cancelled = updateExecution(current, {
        status: "cancelled", toolDispatchPhase: "finished", finishedAt, updatedAt: finishedAt,
        cancellationReason: "human_interrupt",
      });
      agentReadinessOverridesById.set(current.agentId, "ready");
      executionControllersById.get(executionId)?.abort();
      return cloneExecution(cancelled);
    },

    waitForAgentExecution(executionId: string): Promise<AgentExecution> {
      const current = executionsById.get(executionId);
      if (current !== undefined && current.status !== "running") {
        return Promise.resolve(cloneExecution(current));
      }
      const running = executionPromisesById.get(executionId);
      if (running === undefined) {
        if (current === undefined) {
          return Promise.reject(new CollaborationPrimitiveError("unknown_execution"));
        }
        return Promise.resolve(cloneExecution(current));
      }
      return running.then(cloneExecution);
    },

    rejectAgentExecution(executionId: string): never {
      execution(executionId);
      throw new CollaborationPrimitiveError("agent_cannot_reject_invocation");
    },

    addressAll(input): readonly AgentExecution[] {
      const targetRoom = room(input.roomId);
      human(input.requesterId);
      assertRoomMembership(input.requesterId, input.roomId);
      const sourceMessage = message(input.messageId);
      if (sourceMessage.roomId !== targetRoom.id) {
        throw new CollaborationPrimitiveError("unknown_message");
      }
      const executions: AgentExecution[] = [];
      for (const target of options.actors) {
        if (target.kind !== "agent" || !targetRoom.memberIds.includes(target.id)) {
          continue;
        }
        const toolName = input.toolNameByAgentId.get(target.id);
        if (toolName === undefined) {
          continue;
        }
        executions.push(startAgentExecution({
          message: sourceMessage,
          requesterId: input.requesterId,
          target,
          toolName,
          input: input.input,
        }));
      }
      return executions;
    },

    addressHere(input) {
      const targetRoom = room(input.roomId);
      human(input.requesterId);
      if (roomOwners.get(input.roomId) !== input.requesterId) {
        return { ok: false, code: "here_requires_room_owner" } as const;
      }
      const requestedAt = Date.parse(now());
      const lastRequestedAt = lastHereAtByRoom.get(input.roomId);
      if (lastRequestedAt !== undefined && requestedAt - lastRequestedAt < hereRateLimitMs) {
        return { ok: false, code: "here_rate_limited" } as const;
      }
      lastHereAtByRoom.set(input.roomId, requestedAt);
      return {
        ok: true,
        recipientIds: options.actors
          .filter((entry): entry is HumanActor => entry.kind === "human")
          .filter((entry) => targetRoom.memberIds.includes(entry.id) && entry.reachability === "online")
          .map((entry) => entry.id),
      } as const;
    },

    editMessage(input): MessageState {
      const sourceMessage = message(input.messageId);
      if (sourceMessage.authorKind === "agent") {
        throw new CollaborationPrimitiveError("agent_message_immutable");
      }
      if (sourceMessage.authorId !== input.actorId) {
        throw new CollaborationPrimitiveError("message_author_mismatch");
      }
      human(input.actorId);
      requireNonEmpty(input.body);
      const state = messageStatesById.get(input.messageId);
      if (state === undefined) {
        throw new CollaborationPrimitiveError("unknown_message");
      }
      const next: MessageState = { ...state, body: input.body, edited: true };
      messageStatesById.set(input.messageId, next);
      return { ...next };
    },

    recallMessage(input): MessageState {
      const sourceMessage = message(input.messageId);
      if (sourceMessage.authorKind === "agent") {
        throw new CollaborationPrimitiveError("agent_message_immutable");
      }
      if (sourceMessage.authorId !== input.actorId) {
        throw new CollaborationPrimitiveError("message_author_mismatch");
      }
      human(input.actorId);
      const state = messageStatesById.get(input.messageId);
      if (state === undefined) {
        throw new CollaborationPrimitiveError("unknown_message");
      }
      const next: MessageState = { ...state, recalled: true };
      messageStatesById.set(input.messageId, next);
      return { ...next };
    },

    messageState(messageId: string): MessageState {
      message(messageId);
      const state = messageStatesById.get(messageId);
      if (state === undefined) {
        throw new CollaborationPrimitiveError("unknown_message");
      }
      return { ...state };
    },

    correctAgentMessage(input): AgentCorrection {
      const sourceMessage = message(input.originalMessageId);
      if (sourceMessage.authorKind !== "agent") {
        throw new CollaborationPrimitiveError("agent_target_required");
      }
      if (sourceMessage.authorId !== input.agentId) {
        throw new CollaborationPrimitiveError("message_author_mismatch");
      }
      agent(input.agentId);
      requireNonEmpty(input.body);
      const correction: AgentCorrection = {
        id: nextId("agent-correction"),
        originalMessageId: input.originalMessageId,
        agentId: input.agentId,
        body: input.body,
        createdAt: now(),
      };
      corrections.push(correction);
      return { ...correction };
    },

    correctionsFor(originalMessageId: string): readonly AgentCorrection[] {
      message(originalMessageId);
      return corrections
        .filter((correction) => correction.originalMessageId === originalMessageId)
        .map((correction) => ({ ...correction }));
    },

    react(input): SocialReaction | CalibrationSignal {
      const sourceMessage = message(input.messageId);
      human(input.actorId);
      requireNonEmpty(input.emoji);
      if (sourceMessage.authorKind === "agent") {
        if (input.emoji !== "👍" && input.emoji !== "👎") {
          throw new CollaborationPrimitiveError("unsupported_agent_reaction");
        }
        const signal: CalibrationSignal = {
          id: nextId("calibration"),
          sourceMessageId: sourceMessage.id,
          actorId: input.actorId,
          agentId: sourceMessage.authorId,
          emoji: input.emoji,
          createdAt: now(),
        };
        calibrationSignals.push(signal);
        return { ...signal };
      }
      const reaction: SocialReaction = {
        id: nextId("social-reaction"),
        sourceMessageId: sourceMessage.id,
        actorId: input.actorId,
        emoji: input.emoji,
        createdAt: now(),
      };
      socialReactions.push(reaction);
      return { ...reaction };
    },

    socialReactionsFor(messageId: string): readonly SocialReaction[] {
      message(messageId);
      return socialReactions
        .filter((reaction) => reaction.sourceMessageId === messageId)
        .map((reaction) => ({ ...reaction }));
    },

    calibrationSignalsFor(agentId: string): readonly CalibrationSignal[] {
      agent(agentId);
      return calibrationSignals.filter((signal) => signal.agentId === agentId).map((signal) => ({ ...signal }));
    },
  };
}
