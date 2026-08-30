import { describe, expect, it } from "vitest";
import {
  TOOL_DISPATCH_REJECTION_REASONS,
  runtimeErrorCodeForToolDispatchRejection,
} from "./tool-permission-matrix.js";

describe("FT-10 permission rejection matrix", () => {
  it("is closed, duplicate-free, and maps every rejection to a closed runtime error", () => {
    expect(new Set(TOOL_DISPATCH_REJECTION_REASONS).size).toBe(TOOL_DISPATCH_REJECTION_REASONS.length);
    expect(TOOL_DISPATCH_REJECTION_REASONS).toEqual(expect.arrayContaining([
      "catalog_mismatch", "authority_unavailable", "execution_attempt_stale",
      "execution_version_stale", "execution_fenced", "origin_ineligible", "source_ineligible",
      "access_revision_stale",
      "profile_capability_missing", "profile_revision_stale", "assignment_missing",
      "assignment_permission_missing", "assignment_revision_stale", "agent_membership_inactive",
      "principal_membership_inactive", "principal_mismatch", "session_family_stale",
      "tool_call_binding_stale", "confirmation_binding_stale", "parameter_hash_mismatch",
      "canonicalizer_version_mismatch", "confirmation_expired", "grant_expired", "grant_inactive",
      "side_effect_slot_busy", "room_inactive", "shutdown",
    ]));
    for (const reason of TOOL_DISPATCH_REJECTION_REASONS) {
      expect(runtimeErrorCodeForToolDispatchRejection(reason)).toMatch(
        /^(agent_runtime_closed|confirmation_expired|execution_conflict|permission_denied|tool_target_busy)$/u,
      );
    }
  });
});
