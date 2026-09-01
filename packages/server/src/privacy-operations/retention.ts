export const RETENTION_POLICY_VERSION = "dao.retention.v1" as const;
export const RETENTION_JANITOR_BATCH_SIZE = 100;
export const RETENTION_JANITOR_MAX_ATTEMPTS = 8;
export const DIAGNOSTICS_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SERVER_EXPORT_ARTIFACT_RETENTION_MS = 60 * 60 * 1_000;

export type RetentionCategory =
  | "context_snapshot_payload"
  | "diagnostics_artifact"
  | "provider_raw"
  | "room_export_temporary_artifact"
  | "room_lifecycle_fact"
  | "notification_fact"
  | "tool_sealed_side_effect_payload";

export type RetentionCandidate = Readonly<{
  candidateId: string;
  category: RetentionCategory;
  roomLifecycle: "active" | "archived";
  createdAtMs: number;
  retainUntilMs?: number;
  state?: string;
  attempt: number;
}>;

export type RetentionDecision = Readonly<{
  action: "retain" | "purge" | "reject_persistence";
  reason:
    | "authoritative_room_lifecycle"
    | "notification_authority"
    | "provider_raw_never_persist"
    | "retention_boundary_reached"
    | "recovery_or_review_required"
    | "retention_boundary_pending";
}>;

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function decideRetention(candidate: RetentionCandidate, nowMs: number): RetentionDecision {
  if (!validTime(nowMs) || !validTime(candidate.createdAtMs) || !Number.isSafeInteger(candidate.attempt) || candidate.attempt < 0) {
    throw new TypeError("retention candidate is invalid");
  }
  if (candidate.category === "provider_raw") {
    return { action: "reject_persistence", reason: "provider_raw_never_persist" };
  }
  if (candidate.category === "room_lifecycle_fact") {
    return { action: "retain", reason: "authoritative_room_lifecycle" };
  }
  if (candidate.category === "notification_fact") {
    return { action: "retain", reason: "notification_authority" };
  }
  if (candidate.category === "tool_sealed_side_effect_payload" &&
      ["outcome_unknown", "needs_review", "cannot_undo", "dispatch_claimed"].includes(candidate.state ?? "")) {
    return { action: "retain", reason: "recovery_or_review_required" };
  }
  if (candidate.category === "context_snapshot_payload" &&
      ["active", "in_use", "recovery_required"].includes(candidate.state ?? "")) {
    return { action: "retain", reason: "recovery_or_review_required" };
  }
  const defaultBoundary = candidate.category === "diagnostics_artifact"
    ? candidate.createdAtMs + DIAGNOSTICS_ARTIFACT_RETENTION_MS
    : candidate.category === "room_export_temporary_artifact"
      ? candidate.createdAtMs + SERVER_EXPORT_ARTIFACT_RETENTION_MS
      : undefined;
  const boundary = candidate.retainUntilMs ?? defaultBoundary;
  if (boundary === undefined || !validTime(boundary) || nowMs < boundary) {
    return { action: "retain", reason: "retention_boundary_pending" };
  }
  return { action: "purge", reason: "retention_boundary_reached" };
}

export interface RetentionJanitorAuthority {
  scan(input: Readonly<{ after?: string; limit: number; nowMs: number }>): Promise<Readonly<{
    candidates: readonly RetentionCandidate[];
    next?: string;
  }>>;
  purge(input: Readonly<{ candidateId: string; expectedAttempt: number; nowMs: number }>): Promise<"purged" | "stale">;
  retry(input: Readonly<{ candidateId: string; expectedAttempt: number; nextAttempt: number; nowMs: number; code: "purge_failed" }>): Promise<void>;
  deadLetter(input: Readonly<{ candidateId: string; attempt: number; nowMs: number; code: "purge_failed" }>): Promise<void>;
}

export type RetentionJanitorResult = Readonly<{
  scanned: number;
  purged: number;
  retained: number;
  retried: number;
  deadLettered: number;
  batches: number;
}>;

export function createRetentionJanitor(options: Readonly<{
  authority: RetentionJanitorAuthority;
  yieldControl?: () => Promise<void>;
}>): Readonly<{ run(nowMs: number): Promise<RetentionJanitorResult> }> {
  const yieldControl = options.yieldControl ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  return Object.freeze({
    async run(nowMs) {
      if (!validTime(nowMs)) throw new TypeError("retention janitor time is invalid");
      let after: string | undefined;
      let scanned = 0; let purged = 0; let retained = 0; let retried = 0; let deadLettered = 0; let batches = 0;
      while (true) {
        const page = await options.authority.scan({ ...(after === undefined ? {} : { after }), limit: RETENTION_JANITOR_BATCH_SIZE, nowMs });
        batches += 1;
        if (page.candidates.length > RETENTION_JANITOR_BATCH_SIZE ||
            (page.next !== undefined && (page.next.length === 0 || page.next === after)) ||
            (page.candidates.length === 0 && page.next !== undefined)) {
          throw new TypeError("retention scan page is invalid");
        }
        for (const candidate of page.candidates) {
          scanned += 1;
          const decision = decideRetention(candidate, nowMs);
          if (decision.action !== "purge") { retained += 1; continue; }
          try {
            const outcome = await options.authority.purge({ candidateId: candidate.candidateId, expectedAttempt: candidate.attempt, nowMs });
            if (outcome === "purged") purged += 1; else retained += 1;
          } catch {
            const nextAttempt = candidate.attempt + 1;
            if (nextAttempt >= RETENTION_JANITOR_MAX_ATTEMPTS) {
              await options.authority.deadLetter({ candidateId: candidate.candidateId, attempt: nextAttempt, nowMs, code: "purge_failed" });
              deadLettered += 1;
            } else {
              await options.authority.retry({ candidateId: candidate.candidateId, expectedAttempt: candidate.attempt, nextAttempt, nowMs, code: "purge_failed" });
              retried += 1;
            }
          }
        }
        if (page.next === undefined) break;
        after = page.next;
        await yieldControl();
      }
      return Object.freeze({ scanned, purged, retained, retried, deadLettered, batches });
    },
  });
}
