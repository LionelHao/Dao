import { describe, expect, it } from "vitest";
import {
  genericRetryEligibilityForToolDispatch,
  restartActionForToolDispatch,
} from "./tool-dispatch-policy.js";

describe("durable tool dispatch recovery policy", () => {
  it.each(["claimed", "dispatched"] as const)(
    "never replays an adapter for restart state %s",
    (state) => {
      expect(restartActionForToolDispatch(state)).toBe("settle_outcome_unknown_without_adapter");
      expect(genericRetryEligibilityForToolDispatch(state)).toBe("needs_review");
    },
  );

  it("restores review only for outcome_unknown and blocks generic retry", () => {
    expect(restartActionForToolDispatch("outcome_unknown")).toBe("restore_human_review_only");
    expect(genericRetryEligibilityForToolDispatch("outcome_unknown")).toBe("needs_review");
  });

  it("allows only a never-claimed prepared dispatch to re-enter the claim transaction", () => {
    expect(restartActionForToolDispatch("prepared")).toBe("revalidate_before_claim");
    expect(restartActionForToolDispatch("known_succeeded")).toBe("resume_continuation_if_current");
    expect(restartActionForToolDispatch("known_failed")).toBe("terminal");
    expect(restartActionForToolDispatch("reviewed")).toBe("terminal");
  });
});
