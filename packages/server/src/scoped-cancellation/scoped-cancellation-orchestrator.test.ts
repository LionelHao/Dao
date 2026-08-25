import { describe, expect, it, vi } from "vitest";
import {
  SCOPED_CANCELLATION_REASONS,
  createScopedCancellationOrchestrator,
  type ScopedCancellationAuthorityPort,
  type ScopedCancellationCommitReceipt,
  type ScopedCancellationInput,
} from "./scoped-cancellation-orchestrator.js";

const relatedCancellation: ScopedCancellationInput = {
  kind: "related-cancellation",
  roomId: "room-1",
  producerId: "cancel-command-1",
  target: {
    kind: "execution",
    executionId: "execution-1",
    expectedVersion: 4,
  },
  trigger: {
    kind: "explicit-cancel",
    controllerPrincipalId: "human-1",
  },
};

function committedReceipt(
  overrides: Partial<ScopedCancellationCommitReceipt> = {},
): ScopedCancellationCommitReceipt {
  const fenceId = overrides.fenceId ?? "fence-1";
  const roomId = overrides.roomId ?? "room-1";
  const producerId = overrides.producerId ?? "cancel-command-1";
  const reason = overrides.reason ?? "human_cancelled";
  return {
    kind: "scoped-cancellation-committed",
    fenceId: "fence-1",
    roomId: "room-1",
    producerId: "cancel-command-1",
    reason: "human_cancelled",
    replayed: false,
    receipt: {
      requestId: producerId, fenceId, roomId, lineageId: "lineage-1",
      scope: { kind: "execution", executionId: "execution-1", expectedVersion: 4 },
      reason,
      intentOutcomes: [{ intentId: "intent-1", outcome: "already_claimed" }],
      executionOutcomes: [{ executionId: "execution-1", outcome: "cancelled", version: 5 }],
      rejectedConfirmationIds: ["confirmation-1"], revokedGrantIds: ["grant-1"],
      preservedDispatchIds: [], committedAt: "2026-08-25T00:00:00.000Z",
    },
    effects: [{
      sourceMessageId: "source-1",
      sourceRevision: 1,
      invocationIntentId: "intent-1",
      executionId: "execution-1",
      attemptSeq: 2,
      disposition: "execution_cancelled",
      confirmationDisposition: "pending_rejected",
      grantDisposition: "unclaimed_revoked",
      sideEffectState: "none",
    }],
    ...overrides,
  };
}

function authority(
  commitScopedCancellation = vi.fn(async () => committedReceipt()),
): ScopedCancellationAuthorityPort {
  return { commitScopedCancellation };
}

function ports(order: string[] = []) {
  return {
    queue: {
      removeAfterCommittedCancellation: vi.fn(async ({ executionId }: { executionId: string }) => {
        order.push(`queue:${executionId}`);
      }),
    },
    controllers: {
      abortAfterCommittedCancellation: vi.fn(async ({ executionId }: { executionId: string }) => {
        order.push(`abort:${executionId}`);
      }),
    },
    preview: {
      resetAfterCommittedCancellation: vi.fn(async ({
        executionId,
        event,
      }: {
        executionId: string;
        event: { kind: string; durable: boolean };
      }) => {
        order.push(`preview:${executionId}:${event.kind}:${String(event.durable)}`);
      }),
    },
  };
}

describe("scoped cancellation orchestration", () => {
  it("removes only committed targets from queue/controller/preview after the atomic receipt", async () => {
    const order: string[] = [];
    let releaseCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const commitScopedCancellation = vi.fn(async () => {
      order.push("authority:start");
      await commitBarrier;
      order.push("authority:committed");
      return committedReceipt();
    });
    const effects = ports(order);
    const orchestrator = createScopedCancellationOrchestrator({
      authority: authority(commitScopedCancellation),
      ...effects,
    });

    const pending = orchestrator.handle(relatedCancellation);
    await Promise.resolve();
    expect(effects.queue.removeAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.controllers.abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.preview.resetAfterCommittedCancellation).not.toHaveBeenCalled();

    releaseCommit();
    const result = await pending;

    expect(result).toMatchObject({
      kind: "scoped-cancellation-applied",
      receipt: { fenceId: "fence-1", reason: "human_cancelled" },
      postCommitEffects: [{ executionId: "execution-1", status: "applied" }],
    });
    expect(order).toEqual([
      "authority:start",
      "authority:committed",
      "queue:execution-1",
      "abort:execution-1",
      "preview:execution-1:preview.reset:false",
    ]);
  });

  it("does not touch queue, controller, or preview when the AuthorityWorker transaction rolls back", async () => {
    const effects = ports();
    const orchestrator = createScopedCancellationOrchestrator({
      authority: authority(vi.fn(async () => {
        throw new Error("injected transaction rollback");
      })),
      ...effects,
    });

    await expect(orchestrator.handle(relatedCancellation))
      .rejects.toThrow("injected transaction rollback");
    expect(effects.queue.removeAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.controllers.abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.preview.resetAfterCommittedCancellation).not.toHaveBeenCalled();
  });

  it("gives an unrelated Human message zero authority and runtime effects", async () => {
    const commitScopedCancellation = vi.fn(async () => committedReceipt());
    const effects = ports();
    const orchestrator = createScopedCancellationOrchestrator({
      authority: authority(commitScopedCancellation),
      ...effects,
    });

    await expect(orchestrator.handle({
      kind: "unrelated-human-message",
      roomId: "room-1",
      messageId: "human-message-unrelated",
    })).resolves.toEqual({
      kind: "unrelated-human-message-ignored",
      roomId: "room-1",
      messageId: "human-message-unrelated",
    });

    expect(commitScopedCancellation).not.toHaveBeenCalled();
    expect(effects.queue.removeAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.controllers.abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.preview.resetAfterCommittedCancellation).not.toHaveBeenCalled();
  });

  it("derives a closed stable reason from every authorized trigger", async () => {
    const cases: readonly [
      ScopedCancellationInput & { kind: "related-cancellation" },
      (typeof SCOPED_CANCELLATION_REASONS)[number],
    ][] = [
      [relatedCancellation, "human_cancelled"],
      [{
        ...relatedCancellation,
        producerId: "reply-1",
        trigger: { kind: "reply-supersede", sourceMessageId: "reply-1" },
      }, "reply_superseded"],
      [{
        ...relatedCancellation,
        producerId: "correction-1",
        trigger: { kind: "correction-supersede", sourceMessageId: "correction-1" },
      }, "correction_superseded"],
      [{
        ...relatedCancellation,
        producerId: "recall-1",
        target: { kind: "source", sourceMessageId: "source-1", expectedRevision: 3 },
        trigger: { kind: "source-recall", sourceMessageId: "source-1", sourceRevision: 3 },
      }, "message_recalled"],
      [{
        ...relatedCancellation,
        producerId: "intent-new",
        trigger: { kind: "intent-supersede", supersedingIntentId: "intent-new" },
      }, "intent_superseded"],
      ...([
        "room_archived",
        "membership_revoked",
        "assignment_revoked",
        "profile_disabled",
        "capability_revoked",
        "source_ineligible",
        "runtime_shutdown",
      ] as const)
        .map((reason) => [{
          ...relatedCancellation,
          producerId: `governance-${reason}`,
          trigger: { kind: "governance" as const, authorityEventId: `event-${reason}`, reason },
        }, reason] as const),
    ];

    expect(SCOPED_CANCELLATION_REASONS).toEqual([
      "human_cancelled",
      "reply_superseded",
      "correction_superseded",
      "message_recalled",
      "intent_superseded",
      "room_archived",
      "membership_revoked",
      "assignment_revoked",
      "profile_disabled",
      "capability_revoked",
      "source_ineligible",
      "runtime_shutdown",
    ]);
    for (const [input, reason] of cases) {
      const commitScopedCancellation = vi.fn(async () => committedReceipt({
        producerId: input.producerId,
        reason,
        ...(input.target.kind === "source" ? {
          effects: committedReceipt().effects.map((effect) => ({
            ...effect,
            sourceMessageId: input.target.kind === "source"
              ? input.target.sourceMessageId
              : effect.sourceMessageId,
            sourceRevision: input.target.kind === "source"
              ? input.target.expectedRevision
              : effect.sourceRevision,
          })),
        } : {}),
      }));
      const orchestrator = createScopedCancellationOrchestrator({
        authority: authority(commitScopedCancellation),
        ...ports(),
      });
      await orchestrator.handle(input);
      expect(commitScopedCancellation).toHaveBeenCalledWith({
        roomId: input.roomId,
        producerId: input.producerId,
        target: input.target,
        trigger: input.trigger,
        reason,
      });
    }
  });

  it("never applies runtime effects for already-terminal executions or intent-only cancellation", async () => {
    const effects = ports();
    const sourceScopedCancellation: ScopedCancellationInput = {
      ...relatedCancellation,
      target: { kind: "source", sourceMessageId: "source-scope", expectedRevision: 1 },
      trigger: { kind: "source-recall", sourceMessageId: "source-scope", sourceRevision: 1 },
    };
    const receipt = committedReceipt({
      reason: "message_recalled",
      effects: [{
        sourceMessageId: "source-scope",
        sourceRevision: 1,
        invocationIntentId: "intent-pending",
        disposition: "intent_cancelled",
        confirmationDisposition: "none",
        grantDisposition: "none",
        sideEffectState: "none",
      }, {
        sourceMessageId: "source-scope",
        sourceRevision: 1,
        invocationIntentId: "intent-terminal",
        executionId: "execution-terminal",
        attemptSeq: 3,
        disposition: "already_terminal",
        confirmationDisposition: "confirmed_retained",
        grantDisposition: "claimed_retained",
        sideEffectState: "dispatched-retained",
      }],
    });
    const orchestrator = createScopedCancellationOrchestrator({
      authority: authority(vi.fn(async () => receipt)),
      ...effects,
    });

    const result = await orchestrator.handle(sourceScopedCancellation);

    expect(result).toMatchObject({ postCommitEffects: [] });
    expect(effects.queue.removeAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.controllers.abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.preview.resetAfterCommittedCancellation).not.toHaveBeenCalled();
  });

  it("preserves confirmation, grant, and dispatched evidence in the exact post-commit tuple", async () => {
    const effects = ports();
    const receipt = committedReceipt({
      effects: [{
        sourceMessageId: "source-1",
        sourceRevision: 1,
        invocationIntentId: "intent-1",
        executionId: "execution-1",
        attemptSeq: 2,
        disposition: "execution_cancelled",
        confirmationDisposition: "confirmed_retained",
        grantDisposition: "claimed_retained",
        sideEffectState: "outcome-unknown-retained",
      }],
    });
    const orchestrator = createScopedCancellationOrchestrator({
      authority: authority(vi.fn(async () => receipt)),
      ...effects,
    });

    await orchestrator.handle(relatedCancellation);

    const exactTuple = expect.objectContaining({
      invocationIntentId: "intent-1",
      executionId: "execution-1",
      attemptSeq: 2,
      reason: "human_cancelled",
      confirmationDisposition: "confirmed_retained",
      grantDisposition: "claimed_retained",
      sideEffectState: "outcome-unknown-retained",
    });
    expect(effects.queue.removeAfterCommittedCancellation).toHaveBeenCalledWith(exactTuple);
    expect(effects.controllers.abortAfterCommittedCancellation).toHaveBeenCalledWith(exactTuple);
    expect(effects.preview.resetAfterCommittedCancellation).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-1",
        executionId: "execution-1",
        attemptSeq: 2,
        reason: "human_cancelled",
        event: {
          kind: "preview.reset",
          durable: false,
          roomId: "room-1",
          executionId: "execution-1",
          attemptSeq: 2,
          reason: "human_cancelled",
        },
      }),
    );
  });

  it("rejects a malformed authority receipt before any post-commit effect", async () => {
    const effects = ports();
    const orchestrator = createScopedCancellationOrchestrator({
      authority: authority(vi.fn(async () => ({
        ...committedReceipt(),
        effects: [{
          ...committedReceipt().effects[0],
          executionId: "different-room-sweep",
          attemptSeq: 2,
        }],
      } as ScopedCancellationCommitReceipt))),
      ...effects,
    });

    await expect(orchestrator.handle(relatedCancellation))
      .rejects.toThrow("receipt was malformed");
    expect(effects.queue.removeAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.controllers.abortAfterCommittedCancellation).not.toHaveBeenCalled();
    expect(effects.preview.resetAfterCommittedCancellation).not.toHaveBeenCalled();
  });

  it("keeps the durable receipt authoritative and reports each failed post-commit effect", async () => {
    const report = vi.fn();
    const effects = ports();
    effects.queue.removeAfterCommittedCancellation.mockRejectedValueOnce(new Error("queue fault"));
    effects.controllers.abortAfterCommittedCancellation.mockRejectedValueOnce(new Error("abort fault"));
    effects.preview.resetAfterCommittedCancellation.mockRejectedValueOnce(new Error("preview fault"));
    const orchestrator = createScopedCancellationOrchestrator({
      authority: authority(),
      ...effects,
      onPostCommitError: report,
    });

    const result = await orchestrator.handle(relatedCancellation);

    expect(result).toMatchObject({
      kind: "scoped-cancellation-applied",
      receipt: { fenceId: "fence-1" },
      postCommitEffects: [{ executionId: "execution-1", status: "recovery-required" }],
    });
    expect(effects.queue.removeAfterCommittedCancellation).toHaveBeenCalledTimes(1);
    expect(effects.controllers.abortAfterCommittedCancellation).toHaveBeenCalledTimes(1);
    expect(effects.preview.resetAfterCommittedCancellation).toHaveBeenCalledTimes(1);
    expect(report.mock.calls.map(([, context]) => context.phase)).toEqual([
      "queue-remove", "controller-abort", "preview-reset",
    ]);
  });
});
