import type { ToolId } from "@native-im/core";
import type { WorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type {
  ToolDispatchClaimInput,
  ToolDispatchClaimResult,
  ToolDispatchSettlement,
  ToolSafetyAuthority,
} from "../agent-runtime/tool-gateway.js";
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
      return result;
    },
    async settleDispatch(settlement: ToolDispatchSettlement): Promise<void> {
      const result = await execute({ type: "tool-safety.settle", ...settlement, now: input.now() });
      if (result.kind !== "settled" || result.dispatchId !== settlement.dispatchId ||
          result.state !== settlement.state) {
        throw new Error("Tool safety settlement result was malformed");
      }
    },
  });
}
