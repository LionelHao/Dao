import { describe, expect, it, vi } from "vitest";
import {
  createRetentionJanitor,
  decideRetention,
  RETENTION_JANITOR_BATCH_SIZE,
  RETENTION_JANITOR_MAX_ATTEMPTS,
  type RetentionCandidate,
  type RetentionJanitorAuthority,
} from "./retention.js";

const now = 2 * 24 * 60 * 60 * 1_000;
function candidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return { candidateId: "candidate-1", category: "diagnostics_artifact", roomLifecycle: "active", createdAtMs: 0, attempt: 0, ...overrides };
}

describe("FT-14 retention classification and bounded janitor", () => {
  it("never persists Provider raw and retains Room lifecycle/notification authority across archive", () => {
    expect(decideRetention(candidate({ category: "provider_raw" }), now)).toEqual({ action: "reject_persistence", reason: "provider_raw_never_persist" });
    expect(decideRetention(candidate({ category: "room_lifecycle_fact", roomLifecycle: "archived" }), now).action).toBe("retain");
    expect(decideRetention(candidate({ category: "notification_fact", roomLifecycle: "archived" }), now).action).toBe("retain");
  });

  it.each(["outcome_unknown", "needs_review", "cannot_undo", "dispatch_claimed"])(
    "does not purge tool recovery data in %s",
    (state) => expect(decideRetention(candidate({ category: "tool_sealed_side_effect_payload", state, retainUntilMs: 1 }), now).action).toBe("retain"),
  );

  it("purges terminal tool/context and short-lived artifact payloads only at their boundary", () => {
    expect(decideRetention(candidate({ category: "tool_sealed_side_effect_payload", state: "reviewed", retainUntilMs: now }), now).action).toBe("purge");
    expect(decideRetention(candidate({ category: "context_snapshot_payload", state: "terminal", retainUntilMs: now }), now).action).toBe("purge");
    expect(decideRetention(candidate({ category: "diagnostics_artifact" }), now).action).toBe("purge");
    expect(decideRetention(candidate({ category: "room_export_temporary_artifact" }), now).action).toBe("purge");
  });

  it("drains every batch tail, yields between pages and runs cleanup for archived Rooms", async () => {
    const total = RETENTION_JANITOR_BATCH_SIZE + 1;
    const purged: string[] = [];
    const yieldControl = vi.fn(async () => {});
    const authority: RetentionJanitorAuthority = {
      async scan(input) {
        if (input.after === undefined) return { candidates: Array.from({ length: RETENTION_JANITOR_BATCH_SIZE }, (_, index) => candidate({ candidateId: `c-${index}`, roomLifecycle: "archived" })), next: "tail" };
        return { candidates: [candidate({ candidateId: `c-${total - 1}`, roomLifecycle: "archived" })] };
      },
      async purge(input) { purged.push(input.candidateId); return "purged"; },
      async retry() {}, async deadLetter() {},
    };
    const result = await createRetentionJanitor({ authority, yieldControl }).run(now);
    expect(result).toMatchObject({ scanned: total, purged: total, batches: 2 });
    expect(new Set(purged).size).toBe(total);
    expect(yieldControl).toHaveBeenCalledTimes(1);
  });

  it("uses bounded retry then terminal dead-letter without hot looping", async () => {
    const retry = vi.fn(async () => {}); const deadLetter = vi.fn(async () => {});
    const base = { async purge() { throw new Error("failed"); }, retry, deadLetter };
    const first = createRetentionJanitor({ authority: {
      ...base, async scan() { return { candidates: [candidate({ attempt: 0 })] }; },
    } });
    expect(await first.run(now)).toMatchObject({ retried: 1, deadLettered: 0 });
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ nextAttempt: 1, code: "purge_failed" }));
    const last = createRetentionJanitor({ authority: {
      ...base, async scan() { return { candidates: [candidate({ attempt: RETENTION_JANITOR_MAX_ATTEMPTS - 1 })] }; },
    } });
    expect(await last.run(now)).toMatchObject({ retried: 0, deadLettered: 1 });
    expect(deadLetter).toHaveBeenCalledWith(expect.objectContaining({ attempt: RETENTION_JANITOR_MAX_ATTEMPTS }));
  });
});
