import type { ToolConfirmationInput, ToolDescriptor } from "@native-im/core";
import type { AuthenticatedCommandContext } from "../persistence/contracts.js";
import {
  AgentRuntimeError,
  type RuntimeAuthority,
  type ToolAdapter,
  type ToolOutcome,
} from "./contracts.js";
import {
  isRoomMemoryReadError,
  type RoomMemoryReadError,
  type RoomMemoryReadToolAdapter,
} from "./room-memory-read-tool.js";
import { createDispatchOnceLatch } from "./dispatch-once-latch.js";
import type {
  DispatchPermit,
  DispatchPermitBinding,
} from "./dispatch-permit.js";
import {
  runtimeErrorCodeForToolDispatchRejection,
  type ToolDispatchRejectionReason,
} from "./tool-permission-matrix.js";

export { TOOL_DISPATCH_REJECTION_REASONS } from "./tool-permission-matrix.js";

type RuntimeToolId = ToolDescriptor["id"] | "room-memory.read";
type RuntimeToolAdapter = ToolAdapter | RoomMemoryReadToolAdapter;

interface ToolGatewayOptions {
  readonly authority: RuntimeAuthority;
  readonly adapters: readonly RuntimeToolAdapter[];
}

interface GatewayExecutionInput {
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly callId: string;
  readonly grantId: string;
  readonly toolId: RuntimeToolId;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly confirmation?: {
    readonly context: AuthenticatedCommandContext;
    readonly input: ToolConfirmationInput;
  };
  readonly signal: AbortSignal;
}

export interface ToolGateway {
  execute(input: GatewayExecutionInput): Promise<ToolOutcome>;
}

function runtimeSourceReadError(error: RoomMemoryReadError): AgentRuntimeError {
  if (error.status === 403) {
    return new AgentRuntimeError("context_forbidden", "Context source read was forbidden");
  }
  if (error.status === 409) {
    return new AgentRuntimeError("context_generation_conflict", "Context source read was stale");
  }
  if (error.status === 410) {
    return new AgentRuntimeError("context_source_gone", "Context source was invalidated");
  }
  if (error.status === 429) {
    return new AgentRuntimeError("context_capacity_limited", "Context source read capacity was exceeded");
  }
  return new AgentRuntimeError("context_storage_unavailable", "Context source authority was unavailable");
}

export function createToolGateway(options: ToolGatewayOptions): ToolGateway {
  const adapters = new Map<RuntimeToolId, RuntimeToolAdapter>();
  for (const adapter of options.adapters) {
    if (adapters.has(adapter.descriptor.id)) throw new TypeError(`Duplicate tool adapter: ${adapter.descriptor.id}`);
    adapters.set(adapter.descriptor.id, adapter);
  }
  return Object.freeze({
    async execute(input: GatewayExecutionInput): Promise<ToolOutcome> {
      const adapter = adapters.get(input.toolId);
      if (adapter === undefined) throw new AgentRuntimeError("permission_denied", "Tool was not registered");
      const dispatch = await options.authority.claimTool(
        input.executionId,
        input.attemptSeq,
        input.grantId,
        input.parameters,
        input.confirmation,
        { callId: input.callId },
      );
      if ((dispatch.toolId as RuntimeToolId) !== input.toolId) {
        throw new AgentRuntimeError("execution_conflict", "Claimed tool identity changed");
      }
      try {
        const outcome = await adapter.execute({
          executionId: input.executionId,
          attemptSeq: input.attemptSeq,
          roomId: input.roomId,
          agentId: input.agentId,
          callId: input.callId,
          grantId: input.grantId,
          dispatchId: dispatch.dispatchId,
          toolId: input.toolId,
          parameters: dispatch.parameters,
          signal: input.signal,
        });
        await options.authority.settleTool(
          dispatch.dispatchId,
          "succeeded",
          outcome.summary,
          outcome.compensationToken,
        );
        return outcome;
      } catch (error: unknown) {
        if (adapter.descriptor.effect === "side-effecting") {
          await options.authority.settleTool(
            dispatch.dispatchId,
            "outcome_unknown",
            { outcome: "unknown" },
          );
          void error;
          throw new AgentRuntimeError(
            "side_effect_outcome_unknown",
            "Side-effect outcome requires human review",
          );
        }
        await options.authority.settleTool(dispatch.dispatchId, "failed", { outcome: "failed" });
        if (error instanceof AgentRuntimeError) throw error;
        if (isRoomMemoryReadError(error)) throw runtimeSourceReadError(error);
        throw new AgentRuntimeError("tool_failure", "Tool execution failed");
      }
    },
  });
}

export type ExternalPhysicalToolId =
  | "http-json.read"
  | "repository.git-status"
  | "sandbox-file.write";

export interface ToolSafetyGatewayExecutionInput {
  readonly toolCallId: string;
  readonly invocationId: string;
  readonly executionId: string;
  readonly attemptSeq: number;
  readonly expectedExecutionVersion: number;
  readonly roomId: string;
  readonly agentId: string;
  readonly grantId: string;
  readonly toolId: ExternalPhysicalToolId;
  readonly canonicalParameterSha256: string;
  readonly canonicalizerVersion: string;
  readonly sourceSnapshotId: string;
  readonly expectedAccessRevision: number;
  readonly expectedRoomLifecycleGeneration: number;
  readonly profileId: string;
  readonly expectedProfileRevision: number;
  readonly assignmentId: string;
  readonly expectedAssignmentRevision: number;
  readonly principalActorId?: string;
  readonly sessionFamilyId?: string;
  readonly bindingGeneration?: number;
  /** Server-private parsed parameters; never exposed through public protocol or repair. */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Server-private compensation lineage. Public commands can never provide this field. */
  readonly compensationOfDispatchId?: string;
  readonly signal: AbortSignal;
}

export type ToolDispatchClaimInput = Omit<ToolSafetyGatewayExecutionInput, "signal">;

export type ToolDispatchClaimResult =
  | Readonly<{
      kind: "claimed";
      dispatchId: string;
      toolId: ExternalPhysicalToolId;
      parameters: Readonly<Record<string, unknown>>;
      compensationToken?: string;
      compensationOfDispatchId?: string;
      permit: DispatchPermit;
      permitBinding: DispatchPermitBinding;
    }>
  | Readonly<{ kind: "rejected"; reason: ToolDispatchRejectionReason }>
  | Readonly<{
      kind: "not_replayable";
      state: "claimed" | "dispatched" | "known_succeeded" | "known_failed" |
        "outcome_unknown" | "reviewed";
      dispatchId: string;
    }>;

export type ToolDispatchSettlement = Readonly<{
  dispatchId: string;
  expectedVersion: number;
  state: "known_succeeded" | "known_failed" | "outcome_unknown";
  summary: Readonly<Record<string, string | number | boolean>>;
  sealedCompensation?: string;
}>;

export interface ToolSafetyAuthority {
  claimDispatch(input: ToolDispatchClaimInput): Promise<ToolDispatchClaimResult>;
  consumeDispatchPermit(
    permit: DispatchPermit,
    expected: DispatchPermitBinding,
  ): DispatchPermitBinding | undefined;
  settleDispatch(input: ToolDispatchSettlement): Promise<void>;
}

export type ToolKnownFailureCode = "execution_conflict" | "invalid_parameters" | "tool_failure";

export type ToolAdapterTypedOutcome =
  | Readonly<{
      state: "known_succeeded";
      summary: Readonly<Record<string, string | number | boolean>>;
      modelInput: string;
      compensationToken?: string;
    }>
  | Readonly<{
      state: "known_failed";
      summary: Readonly<Record<string, string | number | boolean>>;
      errorCode: ToolKnownFailureCode;
    }>
  | Readonly<{
      state: "ambiguous";
      summary: Readonly<Record<string, string | number | boolean>>;
    }>;

export interface ToolSafetyAdapter {
  readonly descriptor: Readonly<{
    id: ExternalPhysicalToolId;
    effect: "read-only" | "side-effect";
  }>;
  execute(input: Readonly<{
    dispatchId: string;
    toolCallId: string;
    executionId: string;
    attemptSeq: number;
    roomId: string;
    agentId: string;
    grantId: string;
    toolId: ExternalPhysicalToolId;
    parameters: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }>): Promise<ToolAdapterTypedOutcome>;
  compensate?(token: string, signal: AbortSignal): Promise<ToolAdapterTypedOutcome>;
}

export interface ToolSafetyGateway {
  execute(input: ToolSafetyGatewayExecutionInput): Promise<ToolOutcome>;
  close(): Promise<void>;
}

interface ToolSafetyGatewayOptions {
  readonly authority: ToolSafetyAuthority;
  readonly adapters: readonly ToolSafetyAdapter[];
  readonly dispatchCapacity?: number;
  readonly shutdownWaitMs?: number;
}

const externalToolEffects: Readonly<Record<ExternalPhysicalToolId, "read-only" | "side-effect">> =
  Object.freeze({
    "http-json.read": "read-only",
    "repository.git-status": "read-only",
    "sandbox-file.write": "side-effect",
  });

function rejectionError(reason: ToolDispatchRejectionReason): AgentRuntimeError {
  return new AgentRuntimeError(
    runtimeErrorCodeForToolDispatchRejection(reason),
    "Tool dispatch authority was rejected",
  );
}

function validateToolSafetyCatalog(adapters: readonly ToolSafetyAdapter[]): Map<ExternalPhysicalToolId, ToolSafetyAdapter> {
  const result = new Map<ExternalPhysicalToolId, ToolSafetyAdapter>();
  for (const adapter of adapters) {
    const expectedEffect = externalToolEffects[adapter.descriptor.id];
    if (expectedEffect === undefined || adapter.descriptor.effect !== expectedEffect ||
        result.has(adapter.descriptor.id)) {
      throw new TypeError("FT-10 external tool catalog was invalid");
    }
    result.set(adapter.descriptor.id, adapter);
  }
  if (result.size !== 3 || !Object.keys(externalToolEffects).every((toolId) =>
    result.has(toolId as ExternalPhysicalToolId))) {
    throw new TypeError("FT-10 external tool catalog was incomplete");
  }
  return result;
}

function isSafeAdapterSummary(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !Object.values(value).every((entry) => typeof entry === "string" ||
        (typeof entry === "number" && Number.isFinite(entry)) || typeof entry === "boolean")) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= 8_192;
  } catch {
    return false;
  }
}

function normalizeTypedAdapterOutcome(value: unknown): ToolAdapterTypedOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return Object.freeze({ state: "ambiguous", summary: Object.freeze({ outcome: "unknown" }) });
  }
  const candidate = value as Record<string, unknown>;
  if (!isSafeAdapterSummary(candidate.summary)) {
    return Object.freeze({ state: "ambiguous", summary: Object.freeze({ outcome: "unknown" }) });
  }
  if (candidate.state === "known_succeeded" && typeof candidate.modelInput === "string" &&
      Buffer.byteLength(candidate.modelInput, "utf8") <= 1_048_576 &&
      (candidate.compensationToken === undefined || (typeof candidate.compensationToken === "string" &&
        Buffer.byteLength(candidate.compensationToken, "utf8") <= 1_048_576))) {
    return value as ToolAdapterTypedOutcome;
  }
  if (candidate.state === "known_failed" &&
      (candidate.errorCode === "execution_conflict" || candidate.errorCode === "invalid_parameters" ||
        candidate.errorCode === "tool_failure")) {
    return value as ToolAdapterTypedOutcome;
  }
  if (candidate.state === "ambiguous") return value as ToolAdapterTypedOutcome;
  return Object.freeze({ state: "ambiguous", summary: Object.freeze({ outcome: "unknown" }) });
}

function permitBindingMatchesClaim(
  binding: unknown,
  claim: Extract<ToolDispatchClaimResult, { kind: "claimed" }>,
  input: ToolSafetyGatewayExecutionInput,
): binding is DispatchPermitBinding {
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) return false;
  const candidate = binding as Partial<DispatchPermitBinding>;
  return candidate.dispatchId === claim.dispatchId && candidate.grantId === input.grantId &&
    candidate.toolCallId === input.toolCallId && candidate.invocationId === input.invocationId &&
    candidate.executionId === input.executionId && candidate.attemptSeq === input.attemptSeq &&
    candidate.executionVersion === input.expectedExecutionVersion && candidate.roomId === input.roomId &&
    candidate.agentId === input.agentId && candidate.toolId === input.toolId &&
    candidate.canonicalParameterSha256 === input.canonicalParameterSha256 &&
    candidate.canonicalizerVersion === input.canonicalizerVersion &&
    candidate.sourceSnapshotId === input.sourceSnapshotId &&
    candidate.accessRevision === input.expectedAccessRevision &&
    candidate.roomLifecycleGeneration === input.expectedRoomLifecycleGeneration &&
    candidate.profileId === input.profileId &&
    candidate.profileRevision === input.expectedProfileRevision &&
    candidate.assignmentId === input.assignmentId &&
    candidate.assignmentRevision === input.expectedAssignmentRevision &&
    candidate.principalActorId === input.principalActorId &&
    candidate.sessionFamilyId === input.sessionFamilyId &&
    candidate.bindingGeneration === input.bindingGeneration &&
    candidate.compensationOfDispatchId === input.compensationOfDispatchId;
}

export function createToolSafetyGateway(options: ToolSafetyGatewayOptions): ToolSafetyGateway {
  const dispatchCapacity = options.dispatchCapacity ?? 65_536;
  const shutdownWaitMs = options.shutdownWaitMs ?? 15_000;
  if (!Number.isSafeInteger(shutdownWaitMs) || shutdownWaitMs < 1 || shutdownWaitMs > 30_000) {
    throw new TypeError("FT-10 gateway shutdown timeout was invalid");
  }
  const adapters = validateToolSafetyCatalog(options.adapters);
  const latch = createDispatchOnceLatch({ capacity: dispatchCapacity });
  const inFlight = new Set<Promise<unknown>>();
  const claimedInFlight = new Map<string, Readonly<{
    abort(): void;
    settleUnknown(): Promise<void>;
  }>>();
  let closed = false;
  let closeComplete = false;
  let closeAttempt: Promise<void> | undefined;

  const run = async (input: ToolSafetyGatewayExecutionInput): Promise<ToolOutcome> => {
    if (closed) throw new AgentRuntimeError("agent_runtime_closed", "Tool gateway is shutting down");
    const adapter = adapters.get(input.toolId);
    if (adapter === undefined) throw new AgentRuntimeError("permission_denied", "Tool adapter is unavailable");
    const reservation = latch.reserve();
    if (reservation === undefined) throw new AgentRuntimeError("tool_target_busy", "Tool dispatch latch is full");

    let claim: ToolDispatchClaimResult;
    try {
      claim = await options.authority.claimDispatch({
        toolCallId: input.toolCallId,
        invocationId: input.invocationId,
        executionId: input.executionId,
        attemptSeq: input.attemptSeq,
        expectedExecutionVersion: input.expectedExecutionVersion,
        roomId: input.roomId,
        agentId: input.agentId,
        grantId: input.grantId,
        toolId: input.toolId,
        canonicalParameterSha256: input.canonicalParameterSha256,
        canonicalizerVersion: input.canonicalizerVersion,
        sourceSnapshotId: input.sourceSnapshotId,
        expectedAccessRevision: input.expectedAccessRevision,
        expectedRoomLifecycleGeneration: input.expectedRoomLifecycleGeneration,
        profileId: input.profileId,
        expectedProfileRevision: input.expectedProfileRevision,
        assignmentId: input.assignmentId,
        expectedAssignmentRevision: input.expectedAssignmentRevision,
        ...(input.principalActorId === undefined ? {} : {
          principalActorId: input.principalActorId,
        }),
        ...(input.sessionFamilyId === undefined ? {} : {
          sessionFamilyId: input.sessionFamilyId,
        }),
        ...(input.bindingGeneration === undefined ? {} : {
          bindingGeneration: input.bindingGeneration,
        }),
        ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
        ...(input.compensationOfDispatchId === undefined ? {} : {
          compensationOfDispatchId: input.compensationOfDispatchId,
        }),
      });
    } catch (error: unknown) {
      if (adapter.descriptor.effect === "side-effect") {
        // A thrown claim acknowledgement cannot prove that the durable claim
        // did not commit. Retain the slot and require recovery/review instead
        // of allowing this process to retry the physical action.
        latch.retainUnknown(reservation);
        throw new AgentRuntimeError(
          "side_effect_outcome_unknown",
          "Tool dispatch claim outcome requires review",
        );
      }
      latch.release(reservation);
      if (error instanceof AgentRuntimeError) throw error;
      throw rejectionError("authority_unavailable");
    }
    if (claim.kind === "rejected") {
      latch.release(reservation);
      throw rejectionError(claim.reason);
    }
    if (claim.kind === "not_replayable") {
      latch.release(reservation);
      throw new AgentRuntimeError(
        "side_effect_outcome_unknown",
        "Claimed tool dispatch requires review and cannot be replayed",
      );
    }
    if (claim.dispatchId.length === 0 || claim.toolId !== input.toolId ||
        typeof claim.parameters !== "object" || claim.parameters === null ||
        Array.isArray(claim.parameters) || !permitBindingMatchesClaim(claim.permitBinding, claim, input)) {
      if (adapter.descriptor.effect === "side-effect") {
        latch.retainUnknown(reservation);
        throw new AgentRuntimeError(
          "side_effect_outcome_unknown",
          "Claimed tool dispatch binding requires review",
        );
      }
      latch.release(reservation);
      throw new AgentRuntimeError("execution_conflict", "Claimed tool dispatch binding changed");
    }
    if (!latch.enter(reservation, claim.dispatchId)) {
      throw new AgentRuntimeError(
        adapter.descriptor.effect === "side-effect"
          ? "side_effect_outcome_unknown"
          : "execution_conflict",
        "Tool dispatch was already entered in this process",
      );
    }

    const physicalController = new AbortController();
    const relayInputAbort = (): void => physicalController.abort(input.signal.reason);
    if (input.signal.aborted) relayInputAbort();
    else input.signal.addEventListener("abort", relayInputAbort, { once: true });
    let terminalSettlement: Readonly<{
      state: ToolDispatchSettlement["state"];
      result: Promise<void>;
    }> | undefined;
    let physicalComplete = false;
    const markPhysicalComplete = (): void => {
      physicalComplete = true;
      if (terminalSettlement !== undefined) {
        void terminalSettlement.result.then(() => claimedInFlight.delete(claim.dispatchId),
          () => undefined);
      }
    };
    const settle = async (settlement: ToolDispatchSettlement): Promise<void> => {
      terminalSettlement ??= Object.freeze({
        state: settlement.state,
        result: Promise.resolve()
          .then(() => options.authority.settleDispatch(settlement))
          .then(() => {
            latch.settle(claim.dispatchId);
            if (physicalComplete) claimedInFlight.delete(claim.dispatchId);
          }),
      });
      try {
        await terminalSettlement.result;
      } catch {
        throw new AgentRuntimeError(
          adapter.descriptor.effect === "side-effect" ? "side_effect_outcome_unknown" : "tool_failure",
          "Tool dispatch settlement was not acknowledged",
        );
      }
      if (terminalSettlement.state !== settlement.state) {
        throw new AgentRuntimeError(
          adapter.descriptor.effect === "side-effect" ? "side_effect_outcome_unknown" : "tool_failure",
          "A different terminal tool settlement won the shutdown race",
        );
      }
    };
    const claimedOperation = Object.freeze({
      abort: () => physicalController.abort("tool_gateway_shutdown"),
      settleUnknown: () => settle({
        dispatchId: claim.dispatchId,
        expectedVersion: 2,
        state: "outcome_unknown",
        summary: Object.freeze({ outcome: "unknown" }),
      }),
    });
    claimedInFlight.set(claim.dispatchId, claimedOperation);

    let consumedPermit: DispatchPermitBinding | undefined;
    try {
      consumedPermit = options.authority.consumeDispatchPermit(claim.permit, claim.permitBinding);
    } catch {
      throw new AgentRuntimeError(
        adapter.descriptor.effect === "side-effect" ? "side_effect_outcome_unknown" : "tool_failure",
        "Dispatch permit verification failed",
      );
    }
    if (consumedPermit === undefined) {
      markPhysicalComplete();
      await settle({
        dispatchId: claim.dispatchId,
        expectedVersion: 2,
        state: "outcome_unknown",
        summary: Object.freeze({ outcome: "unknown" }),
      });
      input.signal.removeEventListener("abort", relayInputAbort);
      throw new AgentRuntimeError("side_effect_outcome_unknown", "Dispatch permit could not be consumed");
    }

    // close()/abort never crosses the physical boundary after a durable claim.
    // The claim is conservatively terminalized as unknown and cannot be
    // cancelled, retried, or re-dispatched.
    if (closed || input.signal.aborted) {
      markPhysicalComplete();
      await settle({
        dispatchId: claim.dispatchId,
        expectedVersion: 2,
        state: "outcome_unknown",
        summary: Object.freeze({ outcome: "unknown" }),
      });
      claimedOperation.abort();
      input.signal.removeEventListener("abort", relayInputAbort);
      throw new AgentRuntimeError(
        adapter.descriptor.effect === "side-effect" ? "side_effect_outcome_unknown" : "tool_failure",
        "Tool dispatch claim committed during shutdown",
      );
    }

    let outcome: ToolAdapterTypedOutcome;
    try {
      if (claim.compensationToken !== undefined) {
        if (input.compensationOfDispatchId === undefined ||
            claim.compensationOfDispatchId !== input.compensationOfDispatchId ||
            adapter.compensate === undefined) {
          throw new AgentRuntimeError("execution_conflict", "Compensation dispatch binding changed");
        }
        outcome = normalizeTypedAdapterOutcome(
          await adapter.compensate(claim.compensationToken, physicalController.signal),
        );
      } else {
        outcome = normalizeTypedAdapterOutcome(await adapter.execute({
          dispatchId: claim.dispatchId,
          toolCallId: input.toolCallId,
          executionId: input.executionId,
          attemptSeq: input.attemptSeq,
          roomId: input.roomId,
          agentId: input.agentId,
          grantId: input.grantId,
          toolId: input.toolId,
          parameters: claim.parameters,
          signal: physicalController.signal,
        }));
      }
    } catch {
      outcome = Object.freeze({ state: "ambiguous", summary: Object.freeze({ outcome: "unknown" }) });
    }
    markPhysicalComplete();

    if (outcome.state === "known_succeeded") {
      await settle({
        dispatchId: claim.dispatchId,
        expectedVersion: 2,
        state: "known_succeeded",
        summary: outcome.summary,
        ...(outcome.compensationToken === undefined ? {} : {
          sealedCompensation: outcome.compensationToken,
        }),
      });
      input.signal.removeEventListener("abort", relayInputAbort);
      return Object.freeze({
        summary: outcome.summary,
        modelInput: outcome.modelInput,
        ...(outcome.compensationToken === undefined ? {} : {
          compensationToken: outcome.compensationToken,
        }),
      });
    }

    if (outcome.state === "known_failed") {
      await settle({
        dispatchId: claim.dispatchId,
        expectedVersion: 2,
        state: "known_failed",
        summary: outcome.summary,
      });
      input.signal.removeEventListener("abort", relayInputAbort);
      throw new AgentRuntimeError(outcome.errorCode, "Tool adapter returned a known failure");
    }

    await settle({
      dispatchId: claim.dispatchId,
      expectedVersion: 2,
      state: "outcome_unknown",
      summary: outcome.summary,
    });
    input.signal.removeEventListener("abort", relayInputAbort);
    throw new AgentRuntimeError(
      adapter.descriptor.effect === "side-effect" ? "side_effect_outcome_unknown" : "tool_failure",
      "Tool adapter outcome is ambiguous",
    );
  };

  return Object.freeze({
    async execute(input: ToolSafetyGatewayExecutionInput): Promise<ToolOutcome> {
      const operation = run(input);
      inFlight.add(operation);
      try {
        return await operation;
      } finally {
        inFlight.delete(operation);
      }
    },
    close(): Promise<void> {
      if (closeComplete) return Promise.resolve();
      if (closeAttempt !== undefined) return closeAttempt;
      closed = true;
      latch.close();
      closeAttempt = (async () => {
        const deadline = Date.now() + shutdownWaitMs;
        const waitBounded = async (operation: Promise<unknown>): Promise<void> => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new AgentRuntimeError("provider_timeout", "Tool gateway safety settlement timed out");
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              operation,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new AgentRuntimeError(
                  "provider_timeout", "Tool gateway safety settlement timed out",
                )), remaining);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        const claimed = [...claimedInFlight.values()];
        // No physical abort may happen until every claimed permit has a
        // durably acknowledged outcome_unknown settlement. A timeout rejects
        // close and leaves the adapter running so a later close can retry the
        // same settlement promise without inventing physical truth.
        await waitBounded(Promise.all(claimed.map((operation) => operation.settleUnknown())));
        for (const operation of claimed) operation.abort();
        if (inFlight.size > 0) await waitBounded(Promise.allSettled([...inFlight]));
        closeComplete = true;
      })().finally(() => {
        closeAttempt = undefined;
      });
      return closeAttempt;
    },
  });
}
