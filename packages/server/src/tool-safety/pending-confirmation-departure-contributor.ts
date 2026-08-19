import { createHash } from "node:crypto";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  AUTHORITY_PARTICIPANT_VERSION,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFailureReason,
  type AuthorityTransactionView,
  type DepartureContributionResult,
  type ParticipantRegistration,
  type PendingConfirmationDepartureContributor,
} from "../room-governance/private-participant-contracts.js";

const FEATURE = "pending-confirmation-departure" as const;
const REGISTRATION_ID = "dao.tool-safety.pending-confirmation-departure.v1";
const PARAMETER_HASH = /^[0-9a-f]{64}$/u;
const TERMINAL_EXECUTION_STATES = new Set(["completed", "failed", "cancelled"]);
const TERMINAL_ATTEMPT_STATES = new Set(["completed", "failed", "cancelled"]);

interface PendingConfirmationRow {
  readonly confirmationId: unknown;
  readonly executionId: unknown;
  readonly attemptSeq: unknown;
  readonly toolId: unknown;
  readonly parameterSha256: unknown;
  readonly roomId: unknown;
  readonly principalId: unknown;
  readonly sessionFamilyId: unknown;
  readonly expiresAt: unknown;
  readonly consumedAt: unknown;
  readonly confirmationState: unknown;
  readonly confirmationRevision: unknown;
  readonly executionRoomId: unknown;
  readonly executionStatus: unknown;
  readonly currentAttemptSeq: unknown;
  readonly executionActionCategory: unknown;
  readonly attemptStatus: unknown;
  readonly attemptActionCategory: unknown;
  readonly grantId: unknown;
  readonly grantExecutionId: unknown;
  readonly grantAttemptSeq: unknown;
  readonly grantRoomId: unknown;
  readonly grantToolId: unknown;
  readonly grantParameterSha256: unknown;
  readonly grantConsumedAt: unknown;
  readonly grantState: unknown;
  readonly familyActorId: unknown;
  readonly familyRefreshExpiresAt: unknown;
  readonly familyRevokedAt: unknown;
  readonly currentHumanMembership: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fail(
  reason: AuthorityParticipantFailureReason,
): AuthorityParticipantEnvelope<DepartureContributionResult> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      httpStatus: 503 as const,
      code: "dependency_unavailable" as const,
      dependency: FEATURE,
      reason,
      retryable: true as const,
    }),
  });
}

function conflictId(roomId: string, confirmationId: string): string {
  const digest = createHash("sha256")
    .update("ft10-pending-confirmation\0")
    .update(roomId)
    .update("\0")
    .update(confirmationId)
    .digest("hex")
    .slice(0, 32);
  return `ft10-confirmation-${digest}`;
}

function assertCommonBinding(
  row: PendingConfirmationRow,
  roomId: string,
  targetHumanActorId: string,
): Readonly<{
  confirmationId: string;
  revision: number;
  expiresAtMs: number;
}> {
  if (!isNonEmptyString(row.confirmationId) ||
      !isNonEmptyString(row.executionId) ||
      !isPositiveInteger(row.attemptSeq) ||
      !isNonEmptyString(row.toolId) ||
      typeof row.parameterSha256 !== "string" || !PARAMETER_HASH.test(row.parameterSha256) ||
      row.roomId !== roomId || row.principalId !== targetHumanActorId ||
      !isNonEmptyString(row.sessionFamilyId) ||
      !isNonEmptyString(row.expiresAt) ||
      row.confirmationState !== "pending" || row.consumedAt !== null ||
      !isNonNegativeInteger(row.confirmationRevision) ||
      row.executionRoomId !== roomId ||
      !isPositiveInteger(row.currentAttemptSeq) || row.currentAttemptSeq !== row.attemptSeq ||
      !isNonEmptyString(row.executionActionCategory) ||
      !isNonEmptyString(row.attemptStatus) ||
      !isNonEmptyString(row.attemptActionCategory) ||
      !isNonEmptyString(row.grantId) || row.grantExecutionId !== row.executionId ||
      row.grantAttemptSeq !== row.attemptSeq || row.grantRoomId !== roomId ||
      row.grantToolId !== row.toolId || row.grantParameterSha256 !== row.parameterSha256 ||
      row.familyActorId !== targetHumanActorId ||
      !isNonNegativeInteger(row.familyRefreshExpiresAt) ||
      !(row.familyRevokedAt === null || isNonNegativeInteger(row.familyRevokedAt)) ||
      row.currentHumanMembership !== 1) {
    throw new Error("Pending confirmation binding is corrupt");
  }
  const expiresAtMs = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("Pending confirmation expiry is corrupt");
  }
  return {
    confirmationId: row.confirmationId,
    revision: row.confirmationRevision,
    expiresAtMs,
  };
}

function contributesConflict(row: PendingConfirmationRow, nowMs: number): boolean {
  if (typeof row.executionStatus !== "string") {
    throw new Error("Pending confirmation execution state is corrupt");
  }
  if (TERMINAL_EXECUTION_STATES.has(row.executionStatus)) {
    if (!TERMINAL_ATTEMPT_STATES.has(row.attemptStatus as string)) {
      throw new Error("Pending confirmation terminal attempt is corrupt");
    }
    return false;
  }
  if (row.executionStatus !== "running" || row.attemptStatus !== "running" ||
      row.executionActionCategory !== "waiting_upstream" ||
      row.attemptActionCategory !== "waiting_upstream") {
    throw new Error("Pending confirmation parent is not waiting");
  }
  if (row.familyRevokedAt !== null || (row.familyRefreshExpiresAt as number) <= nowMs) {
    return false;
  }
  if (row.grantState === "claimed") {
    if (!isNonEmptyString(row.grantConsumedAt)) {
      throw new Error("Claimed grant consumption is corrupt");
    }
    return false;
  }
  if (row.grantState === "revoked" || row.grantState === "expired") {
    return false;
  }
  if (row.grantState !== "active" || row.grantConsumedAt !== null) {
    throw new Error("Pending confirmation grant is corrupt");
  }
  return true;
}

function listPendingConfirmationsInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; targetHumanActorId: string }>,
): AuthorityParticipantEnvelope<DepartureContributionResult> {
  if (!isNonEmptyString(input.roomId) || !isNonEmptyString(input.targetHumanActorId) ||
      transaction.roomId !== input.roomId) {
    return fail("transaction_mismatch");
  }

  try {
    return useAuthorityTransactionDatabase(transaction, (database) => {
      const nowMs = Date.now();
      const rows = database.prepare(
        `SELECT
           confirmation.confirmation_id AS confirmationId,
           confirmation.execution_id AS executionId,
           confirmation.attempt_seq AS attemptSeq,
           confirmation.tool_id AS toolId,
           confirmation.parameter_sha256 AS parameterSha256,
           confirmation.room_id AS roomId,
           confirmation.human_principal_id AS principalId,
           confirmation.session_family_id AS sessionFamilyId,
           confirmation.expires_at AS expiresAt,
           confirmation.consumed_at AS consumedAt,
           confirmation.confirmation_state AS confirmationState,
           confirmation.confirmation_revision AS confirmationRevision,
           execution.room_id AS executionRoomId,
           execution.status AS executionStatus,
           execution.current_attempt_seq AS currentAttemptSeq,
           execution.action_category AS executionActionCategory,
           attempt.status AS attemptStatus,
           attempt.action_category AS attemptActionCategory,
           grant.grant_id AS grantId,
           grant.execution_id AS grantExecutionId,
           grant.attempt_seq AS grantAttemptSeq,
           grant.room_id AS grantRoomId,
           grant.tool_id AS grantToolId,
           grant.parameter_sha256 AS grantParameterSha256,
           grant.consumed_at AS grantConsumedAt,
           grant.grant_state AS grantState,
           family.actor_id AS familyActorId,
           family.refresh_expires_at AS familyRefreshExpiresAt,
           family.revoked_at AS familyRevokedAt,
           membership.present AS currentHumanMembership
         FROM tool_confirmations AS confirmation
         LEFT JOIN agent_executions AS execution
           ON execution.id = confirmation.execution_id
         LEFT JOIN agent_execution_attempts AS attempt
           ON attempt.execution_id = confirmation.execution_id
          AND attempt.attempt_seq = confirmation.attempt_seq
         LEFT JOIN agent_execution_grants AS grant
           ON grant.execution_id = confirmation.execution_id
          AND grant.attempt_seq = confirmation.attempt_seq
          AND grant.room_id = confirmation.room_id
          AND grant.tool_id = confirmation.tool_id
          AND grant.parameter_sha256 = confirmation.parameter_sha256
         LEFT JOIN session_families AS family
           ON family.family_id = confirmation.session_family_id
         LEFT JOIN (
           SELECT room_id, actor_id, 1 AS present
           FROM room_memberships
           WHERE kind = 'human'
         ) AS membership
           ON membership.room_id = confirmation.room_id
          AND membership.actor_id = confirmation.human_principal_id
         WHERE confirmation.room_id = ?
           AND confirmation.human_principal_id = ?
           AND confirmation.confirmation_state = 'pending'
         ORDER BY confirmation.confirmation_id, grant.grant_id`,
      ).all(input.roomId, input.targetHumanActorId) as unknown as readonly PendingConfirmationRow[];

      const seen = new Set<string>();
      const conflicts = [];
      for (const row of rows) {
        const binding = assertCommonBinding(row, input.roomId, input.targetHumanActorId);
        if (seen.has(binding.confirmationId)) {
          throw new Error("Pending confirmation has duplicate grants");
        }
        seen.add(binding.confirmationId);
        if (binding.expiresAtMs <= nowMs || !contributesConflict(row, nowMs)) continue;
        conflicts.push(Object.freeze({
          conflictId: conflictId(input.roomId, binding.confirmationId),
          roomId: input.roomId,
          subjectId: binding.confirmationId,
          kind: "confirmation" as const,
          title: "Pending tool confirmation",
          state: "pending",
          allowedResolutions: Object.freeze([
            "transfer" as const,
            "escalate" as const,
            "reject_or_revoke" as const,
          ]),
          sourceId: binding.confirmationId,
          revision: binding.revision,
        }));
      }

      return Object.freeze({
        ok: true as const,
        result: Object.freeze({
          roomId: input.roomId,
          targetHumanActorId: input.targetHumanActorId,
          conflicts: Object.freeze(conflicts),
        }),
      });
    });
  } catch {
    return fail("participant_threw");
  }
}

export function createPendingConfirmationDepartureContributor(): PendingConfirmationDepartureContributor {
  return Object.freeze({ listPendingConfirmationsInTransaction });
}

const productionParticipant = createPendingConfirmationDepartureContributor();

export const pendingConfirmationDepartureContributorRegistration = Object.freeze({
  registrationId: REGISTRATION_ID,
  feature: FEATURE,
  version: AUTHORITY_PARTICIPANT_VERSION,
  enabled: true,
  participant: productionParticipant,
}) satisfies ParticipantRegistration<PendingConfirmationDepartureContributor>;
