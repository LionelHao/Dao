import { describe, expect, it, vi } from "vitest";
import {
  mintInternalAgentMessageCommitContext,
} from "../internal-message-capability.js";
import {
  createSourceScopedRuntimeBoundary,
  createSourceScopedRuntimeCoordinator,
  type AgentMessageCommitCommand,
  type AgentMessageCommitReceipt,
  type InvocationClaimCommitReceipt,
  type SourceRecallCommitReceipt,
  type SourceScopedRuntimePersistencePort,
} from "./source-scoped-runtime-coordinator.js";

const source = {
  roomId: "room-1",
  sourceMessageId: "message-source-1",
  expectedRevision: 1,
} as const;

const capability = mintInternalAgentMessageCommitContext({
  agentActorId: "agent-1",
  invocationIntentId: "intent-1",
  executionId: "execution-1",
  attemptSeq: 2,
  executionGeneration: 3,
});

function cancelledExecution(
  executionId: string,
  sideEffectState: "none" | "dispatched-retained" | "outcome-unknown-retained" = "none",
) {
  return {
    sourceMessageId: source.sourceMessageId,
    sourceRevision: source.expectedRevision,
    invocationIntentId: `intent-for-${executionId}`,
    executionId,
    attemptSeq: 2,
    cancellationReason: "message_recalled" as const,
    sideEffectState,
  };
}

function recallReceipt(
  executionCancellations = [cancelledExecution("execution-1")],
): SourceRecallCommitReceipt {
  return {
    kind: "source-recall-committed",
    roomId: source.roomId,
    sourceMessageId: source.sourceMessageId,
    recalledRevision: source.expectedRevision,
    cancelledIntentIds: ["intent-1"],
    executionCancellations,
    retainedFinalMessageIds: [],
    retainedFactIds: [],
  };
}

function persistencePort(
  overrides: Partial<SourceScopedRuntimePersistencePort> = {},
): SourceScopedRuntimePersistencePort {
  return {
    commitSourceRecall: vi.fn(async () => recallReceipt()),
    claimAndCreateExecution: vi.fn(async (): Promise<InvocationClaimCommitReceipt> => ({
      kind: "execution-created",
      sourceMessageId: source.sourceMessageId,
      invocationIntentId: "intent-1",
      executionId: "execution-1",
      attemptSeq: 1,
    })),
    commitAgentMessage: vi.fn(async (): Promise<AgentMessageCommitReceipt> => ({
      kind: "agent-message-committed",
      messageKind: "final",
      roomId: source.roomId,
      sourceMessageId: source.sourceMessageId,
      messageId: "agent-final-1",
    })),
    ...overrides,
  };
}

describe("source-scoped message runtime coordination", () => {
  it("bridges the production recall receipt to an exact-source abort only after commit", async () => {
    const order: string[] = [];
    let releaseCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const applyCommittedMessageRecall = vi.fn((input: { sourceMessageId: string }) => {
      order.push(`abort:${input.sourceMessageId}`);
    });
    const boundary = createSourceScopedRuntimeBoundary({
      runtime: { applyCommittedMessageRecall },
    });
    const pending = boundary.coordinateRecallCommit(
      async () => {
        order.push("authority:start");
        await commitBarrier;
        order.push("authority:committed");
        return { messageId: source.sourceMessageId, revision: 1, abortTargets: [
          cancelledExecution("execution-1"),
        ] };
      },
      (receipt) => ({
        sourceMessageId: receipt.messageId,
        cancellations: receipt.abortTargets,
      }),
    );
    await Promise.resolve();
    expect(applyCommittedMessageRecall).not.toHaveBeenCalled();
    releaseCommit();
    await expect(pending).resolves.toMatchObject({ messageId: source.sourceMessageId });
    expect(order).toEqual([
      "authority:start",
      "authority:committed",
      `abort:${source.sourceMessageId}`,
    ]);
  });

  it("never publishes preview through a durable port and keeps its source identity", () => {
    const publish = vi.fn();
    const boundary = createSourceScopedRuntimeBoundary({ preview: { publish } });
    boundary.publishPreview({
      roomId: source.roomId,
      sourceMessageId: source.sourceMessageId,
      executionId: "execution-preview",
      attemptSeq: 1,
      streamSeq: 2,
      delta: "temporary-only",
    });
    expect(publish).toHaveBeenCalledWith({
      roomId: source.roomId,
      sourceMessageId: source.sourceMessageId,
      executionId: "execution-preview",
      attemptSeq: 1,
      streamSeq: 2,
      delta: "temporary-only",
    });
    expect(boundary).not.toHaveProperty("persistence");
  });

  it("propagates exact-source AbortSignal effects only after durable recall commit", async () => {
    const order: string[] = [];
    let releaseCommit!: () => void;
    const committing = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const persistence = persistencePort({
      commitSourceRecall: vi.fn(async () => {
        order.push("authority:start");
        await committing;
        order.push("authority:committed");
        return recallReceipt([
          cancelledExecution("execution-1"),
          cancelledExecution("execution-2", "dispatched-retained"),
          cancelledExecution("execution-3", "outcome-unknown-retained"),
        ]);
      }),
    });
    const abortAfterCommittedCancellation = vi.fn(async (effect: { executionId: string }) => {
      order.push(`abort:${effect.executionId}`);
    });
    const discardExecution = vi.fn((input: { executionId: string }) => {
      order.push(`preview-reset:${input.executionId}`);
    });
    const broadPreemption = vi.fn();
    const coordinator = createSourceScopedRuntimeCoordinator({
      persistence,
      runtime: {
        enqueueCommittedExecution: vi.fn(),
        abortAfterCommittedCancellation,
        applyRoomWideHumanPreemption: broadPreemption,
      },
      preview: { publish: vi.fn(), discardExecution, discardAll: vi.fn() },
    });

    const pending = coordinator.recallSource(source);
    await Promise.resolve();
    expect(abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(discardExecution).not.toHaveBeenCalled();

    releaseCommit();
    const result = await pending;

    expect(result.postCommitEffects).toEqual([
      { executionId: "execution-1", status: "applied" },
      { executionId: "execution-2", status: "applied" },
      { executionId: "execution-3", status: "applied" },
    ]);
    expect(order).toEqual([
      "authority:start",
      "authority:committed",
      "preview-reset:execution-1",
      "abort:execution-1",
      "preview-reset:execution-2",
      "abort:execution-2",
      "preview-reset:execution-3",
      "abort:execution-3",
    ]);
    expect(broadPreemption).not.toHaveBeenCalled();
    expect(abortAfterCommittedCancellation.mock.calls.map(([effect]) => effect)).toEqual([
      expect.objectContaining({ executionId: "execution-1", sideEffectState: "none" }),
      expect.objectContaining({
        invocationIntentId: "intent-for-execution-2",
        executionId: "execution-2",
        sideEffectState: "dispatched-retained",
      }),
      expect.objectContaining({
        executionId: "execution-3",
        sideEffectState: "outcome-unknown-retained",
      }),
    ]);
  });

  it("never aborts or clears preview when the durable recall transaction fails", async () => {
    const persistence = persistencePort({
      commitSourceRecall: vi.fn(async () => {
        throw new Error("injected authority rollback");
      }),
    });
    const runtime = {
      enqueueCommittedExecution: vi.fn(),
      abortAfterCommittedCancellation: vi.fn(),
    };
    const preview = { publish: vi.fn(), discardExecution: vi.fn(), discardAll: vi.fn() };
    const coordinator = createSourceScopedRuntimeCoordinator({ persistence, runtime, preview });

    await expect(coordinator.recallSource(source)).rejects.toThrow("injected authority rollback");
    expect(runtime.abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(preview.discardExecution).not.toHaveBeenCalled();
  });

  it("keeps a committed recall authoritative when one post-commit abort path faults", async () => {
    const persistence = persistencePort({
      commitSourceRecall: vi.fn(async () => recallReceipt([
        cancelledExecution("execution-fault"),
        cancelledExecution("execution-survivor"),
      ])),
    });
    const onPostCommitError = vi.fn();
    const runtime = {
      enqueueCommittedExecution: vi.fn(),
      abortAfterCommittedCancellation: vi.fn(async (effect: { executionId: string }) => {
        if (effect.executionId === "execution-fault") throw new Error("abort port fault");
      }),
    };
    const coordinator = createSourceScopedRuntimeCoordinator({
      persistence,
      runtime,
      preview: { publish: vi.fn(), discardExecution: vi.fn(), discardAll: vi.fn() },
      onPostCommitError,
    });

    const result = await coordinator.recallSource(source);

    expect(result.receipt.kind).toBe("source-recall-committed");
    expect(result.postCommitEffects).toEqual([
      { executionId: "execution-fault", status: "recovery-required" },
      { executionId: "execution-survivor", status: "applied" },
    ]);
    expect(persistence.commitSourceRecall).toHaveBeenCalledTimes(1);
    expect(runtime.abortAfterCommittedCancellation).toHaveBeenCalledTimes(2);
    expect(onPostCommitError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "abort", executionId: "execution-fault" }),
    );
  });

  it("fails pending claim and execution creation closed when recall wins the source race", async () => {
    let fenced = false;
    let releaseClaim!: () => void;
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const persistence = persistencePort({
      claimAndCreateExecution: vi.fn(async (): Promise<InvocationClaimCommitReceipt> => {
        await claimBarrier;
        return fenced
          ? {
              kind: "source-fenced",
              sourceMessageId: source.sourceMessageId,
              invocationIntentId: "intent-1",
              reason: "message_recalled",
            }
          : {
              kind: "execution-created",
              sourceMessageId: source.sourceMessageId,
              invocationIntentId: "intent-1",
              executionId: "execution-late",
              attemptSeq: 1,
            };
      }),
      commitSourceRecall: vi.fn(async () => {
        fenced = true;
        return recallReceipt([]);
      }),
    });
    const runtime = {
      enqueueCommittedExecution: vi.fn(),
      abortAfterCommittedCancellation: vi.fn(),
    };
    const coordinator = createSourceScopedRuntimeCoordinator({ persistence, runtime });

    const pendingClaim = coordinator.claimAndCreateExecution({
      sourceMessageId: source.sourceMessageId,
      invocationIntentId: "intent-1",
    });
    await coordinator.recallSource(source);
    releaseClaim();

    await expect(pendingClaim).resolves.toEqual({
      receipt: {
        kind: "source-fenced",
        sourceMessageId: source.sourceMessageId,
        invocationIntentId: "intent-1",
        reason: "message_recalled",
      },
      runtimeHandoff: "not-applicable",
    });
    expect(runtime.enqueueCommittedExecution).not.toHaveBeenCalled();
  });

  it("refuses a malformed late execution receipt that resolves after the source fence", async () => {
    let releaseClaim!: () => void;
    const claimBarrier = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const persistence = persistencePort({
      claimAndCreateExecution: vi.fn(async (): Promise<InvocationClaimCommitReceipt> => {
        await claimBarrier;
        return {
          kind: "execution-created",
          sourceMessageId: source.sourceMessageId,
          invocationIntentId: "intent-1",
          executionId: "execution-created-after-fence",
          attemptSeq: 1,
        };
      }),
      commitSourceRecall: vi.fn(async () => recallReceipt([])),
    });
    const runtime = {
      enqueueCommittedExecution: vi.fn(),
      abortAfterCommittedCancellation: vi.fn(),
    };
    const onPostCommitError = vi.fn();
    const coordinator = createSourceScopedRuntimeCoordinator({
      persistence,
      runtime,
      onPostCommitError,
    });
    const pendingClaim = coordinator.claimAndCreateExecution({
      sourceMessageId: source.sourceMessageId,
      invocationIntentId: "intent-1",
    });

    await coordinator.recallSource(source);
    releaseClaim();
    await expect(pendingClaim).resolves.toMatchObject({ runtimeHandoff: "recovery-required" });

    expect(runtime.enqueueCommittedExecution).not.toHaveBeenCalled();
    expect(onPostCommitError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "enqueue", executionId: "execution-created-after-fence" }),
    );
  });

  it("enqueues a committed claim and later cancels only its exact source execution", async () => {
    const persistence = persistencePort();
    const broadPreemption = vi.fn();
    const runtime = {
      enqueueCommittedExecution: vi.fn(),
      abortAfterCommittedCancellation: vi.fn(),
      applyRoomWideHumanPreemption: broadPreemption,
    };
    const coordinator = createSourceScopedRuntimeCoordinator({ persistence, runtime });

    await expect(coordinator.claimAndCreateExecution({
      sourceMessageId: source.sourceMessageId,
      invocationIntentId: "intent-1",
    })).resolves.toMatchObject({ runtimeHandoff: "scheduled" });
    await coordinator.recallSource(source);

    expect(runtime.enqueueCommittedExecution).toHaveBeenCalledWith({
      sourceMessageId: source.sourceMessageId,
      invocationIntentId: "intent-1",
      executionId: "execution-1",
      attemptSeq: 1,
    });
    expect(runtime.abortAfterCommittedCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceMessageId: source.sourceMessageId,
        executionId: "execution-1",
      }),
    );
    expect(broadPreemption).not.toHaveBeenCalled();
  });

  it("retains completed final/facts and never models dispatched or unknown effects as undone", async () => {
    const persistence = persistencePort({
      commitSourceRecall: vi.fn(async (): Promise<SourceRecallCommitReceipt> => ({
        ...recallReceipt([
          cancelledExecution("execution-dispatched", "dispatched-retained"),
          cancelledExecution("execution-unknown", "outcome-unknown-retained"),
        ]),
        retainedFinalMessageIds: ["agent-final-before-recall"],
        retainedFactIds: ["project-fact-before-recall"],
      })),
    });
    const runtime = {
      enqueueCommittedExecution: vi.fn(),
      abortAfterCommittedCancellation: vi.fn(),
      undoDispatchedSideEffect: vi.fn(),
      deleteCompletedFinal: vi.fn(),
      deleteConfirmedFact: vi.fn(),
    };
    const coordinator = createSourceScopedRuntimeCoordinator({ persistence, runtime });

    const result = await coordinator.recallSource(source);

    expect(result.receipt.retainedFinalMessageIds).toEqual(["agent-final-before-recall"]);
    expect(result.receipt.retainedFactIds).toEqual(["project-fact-before-recall"]);
    expect(runtime.undoDispatchedSideEffect).not.toHaveBeenCalled();
    expect(runtime.deleteCompletedFinal).not.toHaveBeenCalled();
    expect(runtime.deleteConfirmedFact).not.toHaveBeenCalled();
  });

  it.each(["final", "correction"] as const)(
    "uses opaque capability plus persistence CAS for %s and gives fenced late results zero writes",
    async (messageKind) => {
      let fenced = false;
      const committedMessages: string[] = [];
      const command: AgentMessageCommitCommand = messageKind === "final"
        ? {
            kind: "final",
            roomId: source.roomId,
            sourceMessageId: source.sourceMessageId,
            sourceRevision: 1,
            messageId: "agent-final-1",
            body: "authoritative final",
          }
        : {
            kind: "correction",
            roomId: source.roomId,
            sourceMessageId: source.sourceMessageId,
            sourceRevision: 1,
            messageId: "agent-correction-1",
            correctsMessageId: "agent-final-1",
            body: "authoritative correction",
          };
      const persistence = persistencePort({
        commitSourceRecall: vi.fn(async () => {
          fenced = true;
          return recallReceipt([]);
        }),
        commitAgentMessage: vi.fn(async ({ command: candidate }): Promise<AgentMessageCommitReceipt> => {
          if (fenced) {
            return {
              kind: "agent-message-rejected",
              messageKind: candidate.kind,
              sourceMessageId: candidate.sourceMessageId,
              reason: "source_fenced",
              writeDisposition: "zero-write",
            };
          }
          committedMessages.push(candidate.messageId);
          return {
            kind: "agent-message-committed",
            messageKind: candidate.kind,
            roomId: candidate.roomId,
            sourceMessageId: candidate.sourceMessageId,
            messageId: candidate.messageId,
          };
        }),
      });
      const coordinator = createSourceScopedRuntimeCoordinator({ persistence });

      await coordinator.recallSource(source);
      await expect(coordinator.commitAgentMessage(capability, command)).resolves.toEqual({
        kind: "agent-message-rejected",
        messageKind,
        sourceMessageId: source.sourceMessageId,
        reason: "source_fenced",
        writeDisposition: "zero-write",
      });
      expect(committedMessages).toEqual([]);

      const forged = JSON.parse(JSON.stringify(capability)) as typeof capability;
      await expect(coordinator.commitAgentMessage(forged, command)).rejects.toMatchObject({
        code: "agent_message_capability_forbidden",
      });
      expect(persistence.commitAgentMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a final that won the CAS before recall and reports it as retained", async () => {
    const committedMessages: string[] = [];
    const persistence = persistencePort({
      commitAgentMessage: vi.fn(async ({ command }): Promise<AgentMessageCommitReceipt> => {
        committedMessages.push(command.messageId);
        return {
          kind: "agent-message-committed",
          messageKind: command.kind,
          roomId: command.roomId,
          sourceMessageId: command.sourceMessageId,
          messageId: command.messageId,
        };
      }),
      commitSourceRecall: vi.fn(async (): Promise<SourceRecallCommitReceipt> => ({
        ...recallReceipt([]),
        retainedFinalMessageIds: ["agent-final-winner"],
        retainedFactIds: ["fact-winner"],
      })),
    });
    const coordinator = createSourceScopedRuntimeCoordinator({ persistence });
    const command: AgentMessageCommitCommand = {
      kind: "final",
      roomId: source.roomId,
      sourceMessageId: source.sourceMessageId,
      sourceRevision: 1,
      messageId: "agent-final-winner",
      body: "winner",
    };

    await expect(coordinator.commitAgentMessage(capability, command)).resolves.toMatchObject({
      kind: "agent-message-committed",
    });
    const recalled = await coordinator.recallSource(source);

    expect(committedMessages).toEqual(["agent-final-winner"]);
    expect(recalled.receipt.retainedFinalMessageIds).toEqual(["agent-final-winner"]);
    expect(recalled.receipt.retainedFactIds).toEqual(["fact-winner"]);
  });

  it("keeps provider preview transient across publish, cancel, crash and reconnect", async () => {
    const persistence = persistencePort({
      commitSourceRecall: vi.fn(async () => recallReceipt([
        cancelledExecution("execution-preview"),
      ])),
    });
    const preview = { publish: vi.fn(), discardExecution: vi.fn(), discardAll: vi.fn() };
    const coordinator = createSourceScopedRuntimeCoordinator({ persistence, preview });
    const sentinel = "PREVIEW-MUST-NEVER-BECOME-AUTHORITY-93d607";

    coordinator.publishPreview({
      sourceMessageId: source.sourceMessageId,
      executionId: "execution-preview",
      attemptSeq: 1,
      streamSeq: 1,
      delta: sentinel,
    });
    coordinator.discardTransientPreviews("runtime-crash");
    coordinator.discardTransientPreviews("client-reconnect");
    await coordinator.recallSource(source);

    expect(preview.publish).toHaveBeenCalledWith(expect.objectContaining({ delta: sentinel }));
    expect(preview.discardAll.mock.calls.map(([input]) => input.reason)).toEqual([
      "runtime-crash",
      "client-reconnect",
    ]);
    expect(preview.discardExecution).toHaveBeenCalledWith({
      executionId: "execution-preview",
      reason: "message-recalled",
    });
    expect(JSON.stringify(persistence.commitSourceRecall.mock.calls)).not.toContain(sentinel);
    expect(persistence.claimAndCreateExecution).not.toHaveBeenCalled();
    expect(persistence.commitAgentMessage).not.toHaveBeenCalled();
  });

  it("rejects malformed authority receipts before any post-commit runtime effect", async () => {
    const persistence = persistencePort({
      commitSourceRecall: vi.fn(async () => ({
        ...recallReceipt(),
        roomId: "room-other",
      } as SourceRecallCommitReceipt)),
    });
    const runtime = {
      enqueueCommittedExecution: vi.fn(),
      abortAfterCommittedCancellation: vi.fn(),
    };
    const preview = { publish: vi.fn(), discardExecution: vi.fn(), discardAll: vi.fn() };
    const coordinator = createSourceScopedRuntimeCoordinator({ persistence, runtime, preview });

    await expect(coordinator.recallSource(source)).rejects.toThrow(
      "Source recall authority receipt was malformed",
    );
    expect(runtime.abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(preview.discardExecution).not.toHaveBeenCalled();
  });
});
