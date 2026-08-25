/**
 * Server-private FT-08 cancellation coordination.
 *
 * The AuthorityWorker port owns the transaction and is the only source of a
 * committed cancellation receipt. Queue, AbortController, and preview effects
 * are deliberately separate, non-authoritative ports that run only after that
 * receipt resolves and validates.
 */

const MAX_CANCELLATION_EFFECTS = 256;
const MAX_IDENTIFIER_LENGTH = 256;

export const SCOPED_CANCELLATION_REASONS = [
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
] as const;

export type ScopedCancellationReason = (typeof SCOPED_CANCELLATION_REASONS)[number];

export type ScopedCancellationTarget =
  | Readonly<{
      kind: "execution";
      executionId: string;
      expectedVersion: number;
    }>
  | Readonly<{
      kind: "intent";
      invocationIntentId: string;
      expectedVersion: number;
    }>
  | Readonly<{
      kind: "source";
      sourceMessageId: string;
      expectedRevision: number;
    }>;

export type ScopedCancellationTrigger =
  | Readonly<{
      kind: "explicit-cancel";
      controllerPrincipalId: string;
    }>
  | Readonly<{
      kind: "reply-supersede";
      sourceMessageId: string;
    }>
  | Readonly<{
      kind: "correction-supersede";
      sourceMessageId: string;
    }>
  | Readonly<{
      kind: "source-recall";
      sourceMessageId: string;
      sourceRevision: number;
    }>
  | Readonly<{
      kind: "intent-supersede";
      supersedingIntentId: string;
    }>
  | Readonly<{
      kind: "governance";
      authorityEventId: string;
      reason: Extract<
        ScopedCancellationReason,
        | "room_archived"
        | "membership_revoked"
        | "assignment_revoked"
        | "profile_disabled"
        | "capability_revoked"
        | "source_ineligible"
        | "runtime_shutdown"
      >;
    }>;

export type ScopedCancellationInput =
  | Readonly<{
      kind: "related-cancellation";
      roomId: string;
      producerId: string;
      target: ScopedCancellationTarget;
      trigger: ScopedCancellationTrigger;
    }>
  | Readonly<{
      kind: "unrelated-human-message";
      roomId: string;
      messageId: string;
    }>;

export interface ScopedCancellationAuthorityRequest {
  readonly roomId: string;
  readonly producerId: string;
  readonly target: ScopedCancellationTarget;
  readonly trigger: ScopedCancellationTrigger;
  readonly reason: ScopedCancellationReason;
}

export type ScopedCancellationDisposition =
  | "intent_cancelled"
  | "execution_cancelled"
  | "already_terminal";

export type ScopedConfirmationDisposition =
  | "none"
  | "pending_rejected"
  | "confirmed_retained";

export type ScopedGrantDisposition =
  | "none"
  | "unclaimed_revoked"
  | "claimed_retained";

export type ScopedRetainedSideEffectState =
  | "none"
  | "dispatched-retained"
  | "outcome-unknown-retained";

export interface ScopedCancellationCommitEffect {
  readonly sourceMessageId: string;
  readonly sourceRevision: number;
  readonly invocationIntentId: string;
  readonly executionId?: string;
  readonly attemptSeq?: number;
  readonly disposition: ScopedCancellationDisposition;
  readonly confirmationDisposition: ScopedConfirmationDisposition;
  readonly grantDisposition: ScopedGrantDisposition;
  readonly sideEffectState: ScopedRetainedSideEffectState;
}

export interface ScopedCancellationCommitReceipt {
  readonly kind: "scoped-cancellation-committed";
  readonly fenceId: string;
  readonly roomId: string;
  readonly producerId: string;
  readonly reason: ScopedCancellationReason;
  readonly replayed: boolean;
  readonly effects: readonly ScopedCancellationCommitEffect[];
}

export interface ScopedCancellationAuthorityPort {
  /**
   * Resolves only after intent/execution/attempt, confirmation, grant,
   * dispatch evidence, events, outbox, and the idempotent receipt commit in one
   * AuthorityWorker transaction. A rejection represents no committed receipt.
   */
  commitScopedCancellation(
    request: ScopedCancellationAuthorityRequest,
  ): Promise<ScopedCancellationCommitReceipt>;
}

export interface CommittedScopedCancellationRuntimeEffect
  extends ScopedCancellationCommitEffect {
  readonly fenceId: string;
  readonly roomId: string;
  readonly reason: ScopedCancellationReason;
}

export interface ScopedCancellationQueuePort {
  removeAfterCommittedCancellation(
    effect: CommittedScopedCancellationRuntimeEffect,
  ): void | Promise<void>;
}

export interface ScopedCancellationControllerPort {
  abortAfterCommittedCancellation(
    effect: CommittedScopedCancellationRuntimeEffect,
  ): void | Promise<void>;
}

export interface TransientPreviewResetEvent {
  readonly kind: "preview.reset";
  readonly durable: false;
  readonly roomId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly reason: ScopedCancellationReason;
}

export interface ScopedCancellationPreviewPort {
  /** Clears the local buffer and publishes the supplied non-durable reset. */
  resetAfterCommittedCancellation(input: Readonly<{
    fenceId: string;
    roomId: string;
    sourceMessageId: string;
    sourceRevision: number;
    invocationIntentId: string;
    executionId: string;
    attemptSeq: number;
    reason: ScopedCancellationReason;
    confirmationDisposition: ScopedConfirmationDisposition;
    grantDisposition: ScopedGrantDisposition;
    sideEffectState: ScopedRetainedSideEffectState;
    event: TransientPreviewResetEvent;
  }>): void | Promise<void>;
}

export interface ScopedCancellationPostCommitErrorContext {
  readonly phase: "queue-remove" | "controller-abort" | "preview-reset";
  readonly fenceId: string;
  readonly roomId: string;
  readonly executionId: string;
}

export interface CreateScopedCancellationOrchestratorOptions {
  readonly authority: ScopedCancellationAuthorityPort;
  readonly queue: ScopedCancellationQueuePort;
  readonly controllers: ScopedCancellationControllerPort;
  readonly preview: ScopedCancellationPreviewPort;
  readonly onPostCommitError?: (
    error: unknown,
    context: ScopedCancellationPostCommitErrorContext,
  ) => void;
}

export type ScopedCancellationResult =
  | Readonly<{
      kind: "unrelated-human-message-ignored";
      roomId: string;
      messageId: string;
    }>
  | Readonly<{
      kind: "scoped-cancellation-applied";
      receipt: ScopedCancellationCommitReceipt;
      postCommitEffects: readonly Readonly<{
        executionId: string;
        status: "applied" | "recovery-required";
      }>[];
    }>;

export interface ScopedCancellationOrchestrator {
  handle(input: ScopedCancellationInput): Promise<ScopedCancellationResult>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    value.length <= MAX_IDENTIFIER_LENGTH;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validTarget(value: unknown): value is ScopedCancellationTarget {
  if (!record(value)) return false;
  if (value.kind === "execution") {
    return exact(value, ["kind", "executionId", "expectedVersion"]) &&
      identifier(value.executionId) && positiveInteger(value.expectedVersion);
  }
  if (value.kind === "intent") {
    return exact(value, ["kind", "invocationIntentId", "expectedVersion"]) &&
      identifier(value.invocationIntentId) && positiveInteger(value.expectedVersion);
  }
  return value.kind === "source" &&
    exact(value, ["kind", "sourceMessageId", "expectedRevision"]) &&
    identifier(value.sourceMessageId) && positiveInteger(value.expectedRevision);
}

function validTrigger(value: unknown): value is ScopedCancellationTrigger {
  if (!record(value)) return false;
  switch (value.kind) {
    case "explicit-cancel":
      return exact(value, ["kind", "controllerPrincipalId"]) &&
        identifier(value.controllerPrincipalId);
    case "reply-supersede":
    case "correction-supersede":
      return exact(value, ["kind", "sourceMessageId"]) && identifier(value.sourceMessageId);
    case "source-recall":
      return exact(value, ["kind", "sourceMessageId", "sourceRevision"]) &&
        identifier(value.sourceMessageId) && positiveInteger(value.sourceRevision);
    case "intent-supersede":
      return exact(value, ["kind", "supersedingIntentId"]) &&
        identifier(value.supersedingIntentId);
    case "governance":
      return exact(value, ["kind", "authorityEventId", "reason"]) &&
        identifier(value.authorityEventId) &&
        (value.reason === "room_archived" || value.reason === "membership_revoked" ||
          value.reason === "assignment_revoked" || value.reason === "profile_disabled" ||
          value.reason === "capability_revoked" || value.reason === "source_ineligible" ||
          value.reason === "runtime_shutdown");
    default:
      return false;
  }
}

function reasonFor(trigger: ScopedCancellationTrigger): ScopedCancellationReason {
  switch (trigger.kind) {
    case "explicit-cancel": return "human_cancelled";
    case "reply-supersede": return "reply_superseded";
    case "correction-supersede": return "correction_superseded";
    case "source-recall": return "message_recalled";
    case "intent-supersede": return "intent_superseded";
    case "governance": return trigger.reason;
  }
}

function validInput(value: unknown): value is ScopedCancellationInput {
  if (!record(value)) return false;
  if (value.kind === "unrelated-human-message") {
    return exact(value, ["kind", "roomId", "messageId"]) &&
      identifier(value.roomId) && identifier(value.messageId);
  }
  if (value.kind !== "related-cancellation" ||
      !exact(value, ["kind", "roomId", "producerId", "target", "trigger"]) ||
      !identifier(value.roomId) || !identifier(value.producerId) ||
      !validTarget(value.target) || !validTrigger(value.trigger)) {
    return false;
  }
  return value.trigger.kind !== "source-recall" ||
    (value.target.kind === "source" &&
      value.target.sourceMessageId === value.trigger.sourceMessageId &&
      value.target.expectedRevision === value.trigger.sourceRevision);
}

const dispositions = new Set<ScopedCancellationDisposition>([
  "intent_cancelled", "execution_cancelled", "already_terminal",
]);
const confirmationDispositions = new Set<ScopedConfirmationDisposition>([
  "none", "pending_rejected", "confirmed_retained",
]);
const grantDispositions = new Set<ScopedGrantDisposition>([
  "none", "unclaimed_revoked", "claimed_retained",
]);
const retainedSideEffectStates = new Set<ScopedRetainedSideEffectState>([
  "none", "dispatched-retained", "outcome-unknown-retained",
]);

function validEffect(value: unknown): value is ScopedCancellationCommitEffect {
  if (!record(value) || !exact(value, [
    "sourceMessageId",
    "sourceRevision",
    "invocationIntentId",
    "disposition",
    "confirmationDisposition",
    "grantDisposition",
    "sideEffectState",
  ], ["executionId", "attemptSeq"]) || !identifier(value.sourceMessageId) ||
      !positiveInteger(value.sourceRevision) || !identifier(value.invocationIntentId) ||
      !dispositions.has(value.disposition as ScopedCancellationDisposition) ||
      !confirmationDispositions.has(value.confirmationDisposition as ScopedConfirmationDisposition) ||
      !grantDispositions.has(value.grantDisposition as ScopedGrantDisposition) ||
      !retainedSideEffectStates.has(value.sideEffectState as ScopedRetainedSideEffectState)) {
    return false;
  }
  if (value.disposition === "intent_cancelled") {
    return value.executionId === undefined && value.attemptSeq === undefined &&
      value.confirmationDisposition === "none" && value.grantDisposition === "none" &&
      value.sideEffectState === "none";
  }
  return identifier(value.executionId) && positiveInteger(value.attemptSeq);
}

function validReceipt(
  value: unknown,
  request: ScopedCancellationAuthorityRequest,
): value is ScopedCancellationCommitReceipt {
  if (!record(value) || !exact(value, [
    "kind", "fenceId", "roomId", "producerId", "reason", "replayed", "effects",
  ]) || value.kind !== "scoped-cancellation-committed" || !identifier(value.fenceId) ||
      value.roomId !== request.roomId || value.producerId !== request.producerId ||
      value.reason !== request.reason || typeof value.replayed !== "boolean" ||
      !Array.isArray(value.effects) || value.effects.length > MAX_CANCELLATION_EFFECTS ||
      !value.effects.every(validEffect)) {
    return false;
  }
  const executionIds = value.effects.flatMap((effect) =>
    effect.executionId === undefined ? [] : [effect.executionId]);
  if (new Set(executionIds).size !== executionIds.length) return false;
  if (request.target.kind === "execution") {
    const { executionId } = request.target;
    return value.effects.every((effect) => effect.executionId === executionId);
  }
  if (request.target.kind === "intent") {
    const { invocationIntentId } = request.target;
    return value.effects.every((effect) =>
      effect.invocationIntentId === invocationIntentId);
  }
  const { sourceMessageId, expectedRevision } = request.target;
  return value.effects.every((effect) =>
    effect.sourceMessageId === sourceMessageId &&
    effect.sourceRevision === expectedRevision);
}

function contractError(message: string): TypeError {
  return new TypeError(message);
}

export function createScopedCancellationOrchestrator(
  options: CreateScopedCancellationOrchestratorOptions,
): ScopedCancellationOrchestrator {
  const report = (
    error: unknown,
    context: ScopedCancellationPostCommitErrorContext,
  ): void => {
    try {
      options.onPostCommitError?.(error, context);
    } catch {
      // Diagnostics cannot alter a committed cancellation or transient cleanup.
    }
  };

  return Object.freeze({
    async handle(input: ScopedCancellationInput): Promise<ScopedCancellationResult> {
      if (!validInput(input)) throw contractError("Scoped cancellation input was malformed");
      if (input.kind === "unrelated-human-message") {
        return {
          kind: "unrelated-human-message-ignored",
          roomId: input.roomId,
          messageId: input.messageId,
        };
      }

      const request: ScopedCancellationAuthorityRequest = {
        roomId: input.roomId,
        producerId: input.producerId,
        target: input.target,
        trigger: input.trigger,
        reason: reasonFor(input.trigger),
      };
      const receipt = await options.authority.commitScopedCancellation(request);
      if (!validReceipt(receipt, request)) {
        throw contractError("Scoped cancellation authority receipt was malformed");
      }

      const postCommitEffects: {
        executionId: string;
        status: "applied" | "recovery-required";
      }[] = [];
      for (const effect of receipt.effects) {
        if (effect.disposition !== "execution_cancelled" ||
            effect.executionId === undefined || effect.attemptSeq === undefined) {
          continue;
        }
        const committedEffect: CommittedScopedCancellationRuntimeEffect = {
          ...effect,
          fenceId: receipt.fenceId,
          roomId: receipt.roomId,
          reason: receipt.reason,
        };
        let recoveryRequired = false;
        const phases = [
          ["queue-remove", () => options.queue.removeAfterCommittedCancellation(committedEffect)],
          ["controller-abort", () =>
            options.controllers.abortAfterCommittedCancellation(committedEffect)],
          ["preview-reset", () => options.preview.resetAfterCommittedCancellation({
            fenceId: receipt.fenceId,
            roomId: receipt.roomId,
            sourceMessageId: effect.sourceMessageId,
            sourceRevision: effect.sourceRevision,
            invocationIntentId: effect.invocationIntentId,
            executionId: effect.executionId!,
            attemptSeq: effect.attemptSeq!,
            reason: receipt.reason,
            confirmationDisposition: effect.confirmationDisposition,
            grantDisposition: effect.grantDisposition,
            sideEffectState: effect.sideEffectState,
            event: {
              kind: "preview.reset",
              durable: false,
              roomId: receipt.roomId,
              executionId: effect.executionId!,
              attemptSeq: effect.attemptSeq!,
              reason: receipt.reason,
            },
          })],
        ] as const;
        for (const [phase, apply] of phases) {
          try {
            await apply();
          } catch (error: unknown) {
            recoveryRequired = true;
            report(error, {
              phase,
              fenceId: receipt.fenceId,
              roomId: receipt.roomId,
              executionId: effect.executionId,
            });
          }
        }
        postCommitEffects.push({
          executionId: effect.executionId,
          status: recoveryRequired ? "recovery-required" : "applied",
        });
      }

      return {
        kind: "scoped-cancellation-applied",
        receipt,
        postCommitEffects,
      };
    },
  });
}
