const internalAgentMessageAuthority: unique symbol = Symbol(
  "internal-agent-message-authority",
);
const internalAgentMessageContexts = new WeakSet<object>();

export interface InternalAgentMessageCommitContextInput {
  readonly agentActorId: string;
  readonly invocationIntentId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly executionGeneration: number;
}

export interface AgentMessagePrincipal {
  readonly actorId: string;
  readonly kind: "agent";
}

export interface InternalAgentMessageCommitContext {
  readonly kind: "agent-message";
  readonly [internalAgentMessageAuthority]: true;
  readonly agent: AgentMessagePrincipal;
  readonly invocationIntentId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly executionGeneration: number;
}

export interface AgentMessageWorkerContext {
  readonly kind: "agent-message";
  readonly agent: AgentMessagePrincipal;
  readonly invocationIntentId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly executionGeneration: number;
}

export class AgentMessageCapabilityForbiddenError extends Error {
  readonly status = 403 as const;
  readonly code = "agent_message_capability_forbidden" as const;

  constructor() {
    super("agent_message_capability_forbidden");
    this.name = "AgentMessageCapabilityForbiddenError";
  }
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function hasExactInputKeys(value: object): boolean {
  return Reflect.ownKeys(value).length === 5 &&
    Reflect.ownKeys(value).every((key) =>
      key === "agentActorId" || key === "invocationIntentId" ||
      key === "executionId" || key === "attemptSeq" ||
      key === "executionGeneration");
}

export function mintInternalAgentMessageCommitContext(
  input: InternalAgentMessageCommitContextInput,
): InternalAgentMessageCommitContext {
  if (typeof input !== "object" || input === null || !hasExactInputKeys(input) ||
      !nonEmptyText(input.agentActorId) || !nonEmptyText(input.invocationIntentId) ||
      !nonEmptyText(input.executionId) || !positiveSafeInteger(input.attemptSeq) ||
      !positiveSafeInteger(input.executionGeneration)) {
    throw new TypeError("Internal Agent message authority binding is invalid");
  }

  const context: InternalAgentMessageCommitContext = Object.freeze({
    kind: "agent-message",
    [internalAgentMessageAuthority]: true as const,
    agent: Object.freeze({ actorId: input.agentActorId, kind: "agent" as const }),
    invocationIntentId: input.invocationIntentId,
    executionId: input.executionId,
    attemptSeq: input.attemptSeq,
    executionGeneration: input.executionGeneration,
  });
  internalAgentMessageContexts.add(context);
  return context;
}

export function isInternalAgentMessageCommitContext(
  value: unknown,
): value is InternalAgentMessageCommitContext {
  return typeof value === "object" && value !== null &&
    internalAgentMessageContexts.has(value);
}

export function toAgentMessageWorkerContext(
  context: InternalAgentMessageCommitContext,
): AgentMessageWorkerContext {
  if (!isInternalAgentMessageCommitContext(context)) {
    throw new AgentMessageCapabilityForbiddenError();
  }
  return Object.freeze({
    kind: "agent-message",
    agent: Object.freeze({ ...context.agent }),
    invocationIntentId: context.invocationIntentId,
    executionId: context.executionId,
    attemptSeq: context.attemptSeq,
    executionGeneration: context.executionGeneration,
  });
}
