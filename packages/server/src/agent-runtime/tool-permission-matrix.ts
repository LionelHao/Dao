import type { AgentRuntimeErrorCode } from "./contracts.js";

export const TOOL_DISPATCH_REJECTION_REASONS = Object.freeze([
  "catalog_mismatch",
  "authority_unavailable",
  "execution_attempt_stale",
  "execution_version_stale",
  "execution_fenced",
  "origin_ineligible",
  "source_ineligible",
  "access_revision_stale",
  "profile_capability_missing",
  "profile_revision_stale",
  "assignment_missing",
  "assignment_permission_missing",
  "assignment_revision_stale",
  "agent_membership_inactive",
  "principal_membership_inactive",
  "principal_mismatch",
  "session_family_stale",
  "tool_call_binding_stale",
  "confirmation_binding_stale",
  "parameter_hash_mismatch",
  "canonicalizer_version_mismatch",
  "confirmation_expired",
  "grant_expired",
  "grant_inactive",
  "side_effect_slot_busy",
  "room_inactive",
  "availability_ineligible",
  "shutdown",
] as const);

export type ToolDispatchRejectionReason = typeof TOOL_DISPATCH_REJECTION_REASONS[number];

export function runtimeErrorCodeForToolDispatchRejection(
  reason: ToolDispatchRejectionReason,
): AgentRuntimeErrorCode {
  if (reason === "confirmation_expired" || reason === "grant_expired") {
    return "confirmation_expired";
  }
  if (reason === "authority_unavailable" || reason === "shutdown") {
    return "agent_runtime_closed";
  }
  if (reason === "side_effect_slot_busy") return "tool_target_busy";
  if (reason === "execution_attempt_stale" || reason === "execution_version_stale" ||
      reason === "execution_fenced" || reason === "profile_revision_stale" ||
      reason === "assignment_revision_stale" || reason === "access_revision_stale" ||
      reason === "tool_call_binding_stale" || reason === "confirmation_binding_stale" ||
      reason === "parameter_hash_mismatch" || reason === "canonicalizer_version_mismatch") {
    return "execution_conflict";
  }
  return "permission_denied";
}
