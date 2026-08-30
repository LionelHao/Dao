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
import { createDispatchPermitIssuer } from "./dispatch-permit.js";
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
  readonly signal: AbortSignal;
}

export type ToolDispatchClaimInput = Omit<ToolSafetyGatewayExecutionInput, "signal">;

export type ToolDispatchClaimResult =
  | Readonly<{
      kind: "claimed";
      dispatchId: string;
      toolId: ExternalPhysicalToolId;
      parameters: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ kind: "rejected"; reason: ToolDispatchRejectionReason }>
  | Readonly<{
      kind: "not_replayable";
      state: "claimed" | "dispatched" | "outcome_unknown";
      dispatchId: string;
    }>;

export type ToolDispatchSettlement = Readonly<{
  dispatchId: string;
  state: "known_succeeded" | "known_failed" | "outcome_unknown";
  summary: Readonly<Record<string, string | number | boolean>>;
  sealedCompensation?: string;
}>;

export interface ToolSafetyAuthority {
  claimDispatch(input: ToolDispatchClaimInput): Promise<ToolDispatchClaimResult>;
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
    toolId: ExternalPhysicalToolId;
    parameters: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
  }>): Promise<ToolAdapterTypedOutcome>;
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

export function createToolSafetyGateway(options: ToolSafetyGatewayOptions): ToolSafetyGateway {
  const dispatchCapacity = options.dispatchCapacity ?? 65_536;
  const shutdownWaitMs = options.shutdownWaitMs ?? 15_000;
  if (!Number.isSafeInteger(shutdownWaitMs) || shutdownWaitMs < 1 || shutdownWaitMs > 30_000) {
    throw new TypeError("FT-10 gateway shutdown timeout was invalid");
  }
  const adapters = validateToolSafetyCatalog(options.adapters);
  const latch = createDispatchOnceLatch({ capacity: dispatchCapacity });
  const permits = createDispatchPermitIssuer();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;

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
      });
    } catch (error: unknown) {
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
        Array.isArray(claim.parameters)) {
      latch.release(reservation);
      throw new AgentRuntimeError("execution_conflict", "Claimed tool dispatch binding changed");
    }
    if (!latch.enter(reservation, claim.dispatchId)) {
      throw new AgentRuntimeError("execution_conflict", "Tool dispatch was already entered in this process");
    }

    const permitBinding = Object.freeze({
      dispatchId: claim.dispatchId,
      toolId: claim.toolId,
      toolCallId: input.toolCallId,
      executionId: input.executionId,
      attemptSeq: input.attemptSeq,
      executionVersion: input.expectedExecutionVersion,
      roomId: input.roomId,
      agentId: input.agentId,
      canonicalParameterSha256: input.canonicalParameterSha256,
      canonicalizerVersion: input.canonicalizerVersion,
      sourceSnapshotId: input.sourceSnapshotId,
      accessRevision: input.expectedAccessRevision,
      roomLifecycleGeneration: input.expectedRoomLifecycleGeneration,
      profileId: input.profileId,
      profileRevision: input.expectedProfileRevision,
      assignmentId: input.assignmentId,
      assignmentRevision: input.expectedAssignmentRevision,
      ...(input.principalActorId === undefined ? {} : {
        principalActorId: input.principalActorId,
      }),
      ...(input.sessionFamilyId === undefined ? {} : {
        sessionFamilyId: input.sessionFamilyId,
      }),
      ...(input.bindingGeneration === undefined ? {} : {
        bindingGeneration: input.bindingGeneration,
      }),
    });
    const permit = permits.issue(permitBinding);
    if (permits.consume(permit, permitBinding) === undefined) {
      throw new AgentRuntimeError("side_effect_outcome_unknown", "Dispatch permit could not be consumed");
    }

    let outcome: ToolAdapterTypedOutcome;
    try {
      outcome = normalizeTypedAdapterOutcome(await adapter.execute({
        dispatchId: claim.dispatchId,
        toolCallId: input.toolCallId,
        executionId: input.executionId,
        attemptSeq: input.attemptSeq,
        roomId: input.roomId,
        agentId: input.agentId,
        toolId: input.toolId,
        parameters: claim.parameters,
        signal: input.signal,
      }));
    } catch {
      outcome = Object.freeze({ state: "ambiguous", summary: Object.freeze({ outcome: "unknown" }) });
    }

    const settle = async (settlement: ToolDispatchSettlement): Promise<void> => {
      try {
        await options.authority.settleDispatch(settlement);
      } catch {
        throw new AgentRuntimeError(
          adapter.descriptor.effect === "side-effect" ? "side_effect_outcome_unknown" : "tool_failure",
          "Tool dispatch settlement was not acknowledged",
        );
      }
    };

    if (outcome.state === "known_succeeded") {
      await settle({
        dispatchId: claim.dispatchId,
        state: "known_succeeded",
        summary: outcome.summary,
        ...(outcome.compensationToken === undefined ? {} : {
          sealedCompensation: outcome.compensationToken,
        }),
      });
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
        state: "known_failed",
        summary: outcome.summary,
      });
      throw new AgentRuntimeError(outcome.errorCode, "Tool adapter returned a known failure");
    }

    await settle({
      dispatchId: claim.dispatchId,
      state: "outcome_unknown",
      summary: outcome.summary,
    });
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
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      latch.close();
      if (inFlight.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, shutdownWaitMs); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}
