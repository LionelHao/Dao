import type { ToolAdapter } from "./contracts.js";
import type { ToolSafetyAdapter, ToolAdapterTypedOutcome } from "./tool-gateway.js";
import { ToolAdapterExecutionError } from "./tools/adapter-outcome.js";

/** Bridges only the three closed physical adapters; internal source seams cannot enter this catalog. */
export function bridgePhysicalToolAdapter(adapter: ToolAdapter): ToolSafetyAdapter {
  if (adapter.descriptor.id !== "http-json.read" &&
      adapter.descriptor.id !== "repository.git-status" &&
      adapter.descriptor.id !== "sandbox-file.write") {
    throw new TypeError("Internal source seam cannot enter the physical adapter catalog");
  }
  const id = adapter.descriptor.id;
  const normalizeOutcome = (outcome: Awaited<ReturnType<ToolAdapter["execute"]>>): ToolAdapterTypedOutcome => {
    if (outcome.outcome !== "known_succeeded") {
      return Object.freeze({ state: "ambiguous", summary: Object.freeze({ outcome: "unknown" }) });
    }
    return Object.freeze({
      state: "known_succeeded",
      summary: outcome.summary,
      modelInput: outcome.modelInput,
      ...(outcome.compensationToken === undefined ? {} : {
        compensationToken: outcome.compensationToken,
      }),
    });
  };
  return Object.freeze({
    descriptor: Object.freeze({ id,
      effect: adapter.descriptor.effect === "side-effecting" ? "side-effect" as const : "read-only" as const }),
    async execute(
      input: Parameters<ToolSafetyAdapter["execute"]>[0],
    ): Promise<ToolAdapterTypedOutcome> {
      try {
        const outcome = await adapter.execute({
          executionId: input.executionId,
          attemptSeq: input.attemptSeq,
          roomId: input.roomId,
          agentId: input.agentId,
          callId: input.toolCallId,
          grantId: input.grantId,
          dispatchId: input.dispatchId,
          toolId: id,
          parameters: input.parameters,
          signal: input.signal,
        });
        return normalizeOutcome(outcome);
      } catch (error) {
        if (error instanceof ToolAdapterExecutionError && error.outcome === "known_failed") {
          const errorCode = error.code === "execution_conflict" || error.code === "invalid_parameters"
            ? error.code : "tool_failure";
          return Object.freeze({ state: "known_failed",
            summary: Object.freeze({ outcome: "failed", code: errorCode }), errorCode });
        }
        return Object.freeze({ state: "ambiguous", summary: Object.freeze({ outcome: "unknown" }) });
      }
    },
    ...(adapter.compensate === undefined ? {} : {
      async compensate(token: string, signal: AbortSignal): Promise<ToolAdapterTypedOutcome> {
        try {
          return normalizeOutcome(await adapter.compensate!(token, signal));
        } catch (error) {
          if (error instanceof ToolAdapterExecutionError && error.outcome === "known_failed") {
            const errorCode = error.code === "execution_conflict" || error.code === "invalid_parameters"
              ? error.code : "tool_failure";
            return Object.freeze({ state: "known_failed" as const,
              summary: Object.freeze({ outcome: "failed", code: errorCode }), errorCode });
          }
          return Object.freeze({ state: "ambiguous" as const,
            summary: Object.freeze({ outcome: "unknown" }) });
        }
      },
    }),
  });
}
