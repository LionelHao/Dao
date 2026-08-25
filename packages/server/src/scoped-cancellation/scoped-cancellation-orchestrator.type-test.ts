import type {
  ScopedCancellationOrchestrator,
  ScopedCancellationPreviewPort,
  ScopedCancellationQueuePort,
} from "./scoped-cancellation-orchestrator.js";

declare const orchestrator: ScopedCancellationOrchestrator;
declare const queue: ScopedCancellationQueuePort;
declare const preview: ScopedCancellationPreviewPort;

// @ts-expect-error The scoped orchestrator exposes no legacy Room-wide producer.
orchestrator.applyRoomWideHumanPreemption("room-1");

void orchestrator.handle({
  kind: "related-cancellation",
  roomId: "room-1",
  producerId: "command-1",
  target: { kind: "execution", executionId: "execution-1", expectedVersion: 1 },
  trigger: { kind: "explicit-cancel", controllerPrincipalId: "human-1" },
  // @ts-expect-error Public/control input cannot choose an authority cancellation reason.
  reason: "runtime_shutdown",
});

// @ts-expect-error A scheduler port cannot undo retained dispatched side effects.
queue.undoDispatchedSideEffect("dispatch-1");

const durableReset: Parameters<ScopedCancellationPreviewPort["resetAfterCommittedCancellation"]>[0] = {
  fenceId: "fence-1",
  roomId: "room-1",
  sourceMessageId: "source-1",
  sourceRevision: 1,
  invocationIntentId: "intent-1",
  executionId: "execution-1",
  attemptSeq: 1,
  reason: "human_cancelled",
  confirmationDisposition: "none",
  grantDisposition: "none",
  sideEffectState: "none",
  event: {
    kind: "preview.reset",
    // @ts-expect-error Preview reset is expressly non-durable.
    durable: true,
    roomId: "room-1",
    executionId: "execution-1",
    attemptSeq: 1,
    reason: "human_cancelled",
  },
};

void preview;
void durableReset;
