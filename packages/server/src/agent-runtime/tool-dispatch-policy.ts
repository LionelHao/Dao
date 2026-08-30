export type DurableToolDispatchState =
  | "prepared"
  | "claimed"
  | "dispatched"
  | "known_succeeded"
  | "known_failed"
  | "outcome_unknown"
  | "reviewed";

export type ToolDispatchRestartAction =
  | "revalidate_before_claim"
  | "settle_outcome_unknown_without_adapter"
  | "restore_human_review_only"
  | "resume_continuation_if_current"
  | "terminal";

export function restartActionForToolDispatch(state: DurableToolDispatchState): ToolDispatchRestartAction {
  switch (state) {
    case "prepared": return "revalidate_before_claim";
    case "claimed":
    case "dispatched": return "settle_outcome_unknown_without_adapter";
    case "outcome_unknown": return "restore_human_review_only";
    case "known_succeeded": return "resume_continuation_if_current";
    case "known_failed":
    case "reviewed": return "terminal";
  }
}

export function genericRetryEligibilityForToolDispatch(
  state: DurableToolDispatchState,
): "eligible_new_attempt" | "needs_review" | "not_eligible" {
  if (state === "outcome_unknown" || state === "claimed" || state === "dispatched") {
    return "needs_review";
  }
  return state === "known_failed" ? "eligible_new_attempt" : "not_eligible";
}
