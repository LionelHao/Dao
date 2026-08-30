import { AgentRuntimeError, type AgentRuntimeErrorCode } from "../contracts.js";

export type AdapterOutcomeKind = "known_succeeded" | "known_failed" | "ambiguous";

/** Physical adapter failures are explicit; authority must not infer them from arbitrary throws. */
export class ToolAdapterExecutionError extends AgentRuntimeError {
  constructor(
    readonly outcome: Exclude<AdapterOutcomeKind, "known_succeeded">,
    code: AgentRuntimeErrorCode,
    message: string,
  ) {
    super(code, message);
    this.name = "ToolAdapterExecutionError";
  }
}

export function knownFailure(code: AgentRuntimeErrorCode, message: string): ToolAdapterExecutionError {
  return new ToolAdapterExecutionError("known_failed", code, message);
}

export function ambiguousFailure(message: string): ToolAdapterExecutionError {
  return new ToolAdapterExecutionError("ambiguous", "side_effect_outcome_unknown", message);
}
