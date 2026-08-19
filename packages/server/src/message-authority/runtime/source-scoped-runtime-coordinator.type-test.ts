import type {
  AgentMessageCommitCommand,
  CommittedSourceExecutionCancellation,
  SourceScopedAgentRuntimePort,
  SourceScopedRuntimePersistencePort,
} from "./source-scoped-runtime-coordinator.js";

declare const persistence: SourceScopedRuntimePersistencePort;
declare const runtime: SourceScopedAgentRuntimePort;
declare const committedCancellation: CommittedSourceExecutionCancellation;

// @ts-expect-error Provider preview has no authority persistence operation.
persistence.publishPreview({ executionId: "execution-1", delta: "partial" });

// @ts-expect-error Source recall cannot invoke legacy Room-wide Human preemption.
runtime.applyRoomWideHumanPreemption("room-1");

// @ts-expect-error Retained dispatch facts have no generic undo operation.
runtime.undoDispatchedSideEffect("execution-1");

runtime.abortAfterCommittedCancellation(committedCancellation);

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
