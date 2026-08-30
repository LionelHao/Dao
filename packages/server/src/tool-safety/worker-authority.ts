import type { ToolId } from "@native-im/core";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type {
  ToolDispatchClaimInput,
  ToolDispatchClaimResult,
  ToolDispatchSettlement,
  ToolSafetyAuthority,
} from "../agent-runtime/tool-gateway.js";
import {
  createDispatchPermitAuthority,
  type DispatchPermit,
  type DispatchPermitBinding,
} from "../agent-runtime/dispatch-permit.js";
import type {
  ToolSafetyAuthorityOperation,
  ToolSafetyAuthorityResult,
} from "./authority-protocol.js";

export interface WorkerToolSafetyAuthority extends ToolSafetyAuthority {
  execute(operation: ToolSafetyAuthorityOperation): Promise<ToolSafetyAuthorityResult>;
}

function isToolId(value: unknown): value is ToolId {
  return value === "http-json.read" || value === "repository.git-status" ||
    value === "sandbox-file.write";
}

function parseResult(value: unknown): ToolSafetyAuthorityResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      typeof (value as { kind?: unknown }).kind !== "string") {
    throw new Error("Tool safety Authority result was malformed");
  }
  return value as ToolSafetyAuthorityResult;
}

export function createWorkerToolSafetyAuthority(input: Readonly<{
  worker: WorkerDatabaseClient;
  now: () => number;
}>): WorkerToolSafetyAuthority {
  const permits = createDispatchPermitAuthority();
  const execute = async (operation: ToolSafetyAuthorityOperation): Promise<ToolSafetyAuthorityResult> =>
    parseResult(await input.worker.executeRuntime(operation));
  return Object.freeze({
    execute,
    async claimDispatch(claim: ToolDispatchClaimInput): Promise<ToolDispatchClaimResult> {
      if (claim.parameters === undefined) {
        return { kind: "rejected", reason: "parameter_hash_mismatch" };
      }
      const result = await execute({ type: "tool-safety.claim", ...claim,
        parameters: claim.parameters, now: input.now() });
      if (result.kind === "rejected" || result.kind === "not_replayable") return result;
      if (result.kind !== "claimed" || !isToolId(result.toolId)) {
        throw new Error("Tool safety claim result was malformed");
      }
      const permitBinding = Object.freeze({
        dispatchId: result.dispatchId,
        grantId: claim.grantId,
        toolCallId: claim.toolCallId,
        invocationId: claim.invocationId,
        executionId: claim.executionId,
        attemptSeq: claim.attemptSeq,
        executionVersion: claim.expectedExecutionVersion,
        roomId: claim.roomId,
        agentId: claim.agentId,
        toolId: claim.toolId,
        canonicalParameterSha256: claim.canonicalParameterSha256,
        canonicalizerVersion: claim.canonicalizerVersion,
        sourceSnapshotId: claim.sourceSnapshotId,
        accessRevision: claim.expectedAccessRevision,
        roomLifecycleGeneration: claim.expectedRoomLifecycleGeneration,
        profileId: claim.profileId,
        profileRevision: claim.expectedProfileRevision,
        assignmentId: claim.assignmentId,
        assignmentRevision: claim.expectedAssignmentRevision,
        ...(claim.principalActorId === undefined ? {} : { principalActorId: claim.principalActorId }),
        ...(claim.sessionFamilyId === undefined ? {} : { sessionFamilyId: claim.sessionFamilyId }),
        ...(claim.bindingGeneration === undefined ? {} : { bindingGeneration: claim.bindingGeneration }),
        ...(claim.compensationOfDispatchId === undefined ? {} : {
          compensationOfDispatchId: claim.compensationOfDispatchId,
        }),
      });
      return Object.freeze({ ...result, ...permits.grantAfterCommittedClaim(permitBinding) });
    },
    consumeDispatchPermit: (permit: DispatchPermit, expected: DispatchPermitBinding) =>
      permits.consumeCommittedClaim(permit, expected),
    async settleDispatch(settlement: ToolDispatchSettlement): Promise<void> {
      const result = await execute({ type: "tool-safety.settle", ...settlement, now: input.now() });
      if (result.kind !== "settled" || result.dispatchId !== settlement.dispatchId ||
          result.state !== settlement.state) {
        throw new Error("Tool safety settlement result was malformed");
      }
    },
  });
}
