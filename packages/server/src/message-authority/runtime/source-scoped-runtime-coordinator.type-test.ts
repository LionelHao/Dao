import type {
  AgentMessageCommitCommand,
  CommittedSourceExecutionCancellation,
  SourceScopedAgentRuntimePort,
  SourceScopedRuntimeBoundary,
  SourceScopedRuntimePersistencePort,
} from "./source-scoped-runtime-coordinator.js";

declare const persistence: SourceScopedRuntimePersistencePort;
declare const runtime: SourceScopedAgentRuntimePort;
declare const committedCancellation: CommittedSourceExecutionCancellation;
declare const boundary: SourceScopedRuntimeBoundary;

// @ts-expect-error Provider preview has no authority persistence operation.
persistence.publishPreview({ executionId: "execution-1", delta: "partial" });

// @ts-expect-error Source recall cannot invoke legacy Room-wide Human preemption.
runtime.applyRoomWideHumanPreemption("room-1");

// @ts-expect-error Retained dispatch facts have no generic undo operation.
runtime.undoDispatchedSideEffect("execution-1");

runtime.abortAfterCommittedCancellation(committedCancellation);

// @ts-expect-error The production preview/recall boundary has no authority write port.
boundary.persistence.submit({ body: "preview" });

// @ts-expect-error Provider partials cannot use the final-message CAS operation.
boundary.commitAgentMessage({ body: "preview" });

const invalidFinal: AgentMessageCommitCommand = {
  kind: "final",
  roomId: "room-1",
  sourceMessageId: "message-1",
  sourceRevision: 1,
  messageId: "agent-message-1",
  body: "final",
  // @ts-expect-error Agent identity comes only from the opaque internal context.
  agentActorId: "agent-forged",
};

void invalidFinal;
