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
  type RoomMemoryReadToolAdapter,
} from "./room-memory-read-tool.js";

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
        if (error instanceof AgentRuntimeError || isRoomMemoryReadError(error)) throw error;
        throw new AgentRuntimeError("tool_failure", "Tool execution failed");
      }
    },
  });
}
