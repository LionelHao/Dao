import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  type ArchivedMessageGate,
  type ArchivedMessageGateResult,
  type AuthorityParticipantEnvelope,
  type AuthorityParticipantFailureReason,
  type AuthorityTransactionView,
  type ParticipantRegistration,
} from "../room-governance/private-participant-contracts.js";

const FEATURE = "archived-message-gate" as const;
const BLOCKED_MUTATION_KINDS = ["message", "message_intent"] as const;

interface RoomLifecycleRow {
  readonly status: unknown;
  readonly archiveGeneration: unknown;
  readonly archivedAt: unknown;
}

interface GateRow {
  readonly gateGeneration: unknown;
  readonly blockedAt: unknown;
}

class ArchiveGateInputMismatchError extends Error {
  constructor() {
    super("Archive gate input does not match the authority transaction");
    Object.defineProperty(this, "name", { value: "ArchiveGateInputMismatchError" });
  }
}

export type ArchivedMessageMutationBlockReason =
  | "room_archived"
  | "generation_mismatch"
  | "room_not_found"
  | "transaction_mismatch"
  | "gate_unavailable";

export class ArchivedMessageMutationBlockedError extends Error {
  readonly code = "message_mutation_blocked" as const;
  readonly reason: ArchivedMessageMutationBlockReason;

  constructor(reason: ArchivedMessageMutationBlockReason) {
    super(`Message mutation blocked: ${reason}`);
    Object.defineProperty(this, "name", { value: "ArchivedMessageMutationBlockedError" });
    this.reason = reason;
  }
}

export interface MessageMutationGatePermit {
  readonly roomId: string;
  readonly mutationKind: "message" | "message_intent";
  readonly archiveGeneration: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function fail(
  reason: AuthorityParticipantFailureReason,
): AuthorityParticipantEnvelope<ArchivedMessageGateResult> {
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

function blockForArchive(
  transaction: AuthorityTransactionView,
  input: Readonly<{ roomId: string; archiveGeneration: number }>,
): AuthorityParticipantEnvelope<ArchivedMessageGateResult> {
  if (!isNonEmptyString(input.roomId) || !isPositiveInteger(input.archiveGeneration) ||
    transaction.roomId !== input.roomId) {
    return fail("transaction_mismatch");
  }

  try {
    return useAuthorityTransactionDatabase(transaction, (database) => {
      const room = database.prepare(
        `SELECT status, archive_generation AS archiveGeneration, archived_at AS archivedAt
         FROM rooms WHERE id = ?`,
      ).get(input.roomId) as RoomLifecycleRow | undefined;
      if (room === undefined || room.status !== "archived" ||
        room.archiveGeneration !== input.archiveGeneration ||
        !isNonEmptyString(room.archivedAt)) {
        throw new ArchiveGateInputMismatchError();
      }

      const priorGate = database.prepare(
        `SELECT gate_generation AS gateGeneration, blocked_at AS blockedAt
         FROM room_message_archive_gates WHERE room_id = ?`,
      ).get(input.roomId) as GateRow | undefined;
      if (priorGate !== undefined && (!isPositiveInteger(priorGate.gateGeneration) ||
        !isNonEmptyString(priorGate.blockedAt) ||
        priorGate.gateGeneration > input.archiveGeneration)) {
        throw new ArchiveGateInputMismatchError();
      }

      database.prepare(
        `INSERT INTO room_message_archive_gates (
           room_id, gate_generation, blocked_at
         ) VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           gate_generation = excluded.gate_generation,
           blocked_at = excluded.blocked_at
         WHERE room_message_archive_gates.gate_generation < excluded.gate_generation`,
      ).run(input.roomId, input.archiveGeneration, room.archivedAt);

      const gate = database.prepare(
        `SELECT gate_generation AS gateGeneration, blocked_at AS blockedAt
         FROM room_message_archive_gates WHERE room_id = ?`,
      ).get(input.roomId) as GateRow | undefined;
      if (gate?.gateGeneration !== input.archiveGeneration ||
        !isNonEmptyString(gate.blockedAt)) {
        throw new ArchiveGateInputMismatchError();
      }

      return Object.freeze({
        ok: true as const,
        result: Object.freeze({
          roomId: input.roomId,
          archiveGeneration: input.archiveGeneration,
          gateGeneration: input.archiveGeneration,
          blockedMutationKinds: BLOCKED_MUTATION_KINDS,
        }),
      });
    });
  } catch (error: unknown) {
    return fail(error instanceof ArchiveGateInputMismatchError
      ? "transaction_mismatch"
      : "participant_threw");
  }
}

export function createArchivedMessageGate(): ArchivedMessageGate {
  return Object.freeze({ blockForArchive });
}

const productionArchivedMessageGate = createArchivedMessageGate();

export const archivedMessageGateRegistration: ParticipantRegistration<ArchivedMessageGate> =
  Object.freeze({
    registrationId: "dao.message-authority.archived-message-gate.v1",
    feature: FEATURE,
    version: 1,
    enabled: true,
    participant: productionArchivedMessageGate,
  });

export function requireMessageMutationAllowedInTransaction(
  transaction: AuthorityTransactionView,
  input: Readonly<{
    roomId: string;
    mutationKind: "message" | "message_intent";
    expectedArchiveGeneration: number;
  }>,
): MessageMutationGatePermit {
  if (!isNonEmptyString(input.roomId) ||
    (input.mutationKind !== "message" && input.mutationKind !== "message_intent") ||
    !isNonNegativeInteger(input.expectedArchiveGeneration) ||
    transaction.roomId !== input.roomId) {
    throw new ArchivedMessageMutationBlockedError("transaction_mismatch");
  }

  try {
    return useAuthorityTransactionDatabase(transaction, (database) => {
      const room = database.prepare(
        `SELECT status, archive_generation AS archiveGeneration, archived_at AS archivedAt
         FROM rooms WHERE id = ?`,
      ).get(input.roomId) as RoomLifecycleRow | undefined;
      if (room === undefined) {
        throw new ArchivedMessageMutationBlockedError("room_not_found");
      }
      if ((room.status !== "active" && room.status !== "archived") ||
        !isNonNegativeInteger(room.archiveGeneration)) {
        throw new ArchivedMessageMutationBlockedError("gate_unavailable");
      }
      if (room.archiveGeneration !== input.expectedArchiveGeneration) {
        throw new ArchivedMessageMutationBlockedError("generation_mismatch");
      }

      const gate = database.prepare(
        `SELECT gate_generation AS gateGeneration, blocked_at AS blockedAt
         FROM room_message_archive_gates WHERE room_id = ?`,
      ).get(input.roomId) as GateRow | undefined;
      if (gate !== undefined && (!isPositiveInteger(gate.gateGeneration) ||
        !isNonEmptyString(gate.blockedAt) ||
        gate.gateGeneration > room.archiveGeneration)) {
        throw new ArchivedMessageMutationBlockedError("gate_unavailable");
      }

      if (room.status === "archived") {
        if (gate?.gateGeneration !== room.archiveGeneration ||
          !isNonEmptyString(room.archivedAt)) {
          throw new ArchivedMessageMutationBlockedError("gate_unavailable");
        }
        throw new ArchivedMessageMutationBlockedError("room_archived");
      }

      if (room.archiveGeneration > 0 && gate?.gateGeneration !== room.archiveGeneration) {
        throw new ArchivedMessageMutationBlockedError("gate_unavailable");
      }

      return Object.freeze({
        roomId: input.roomId,
        mutationKind: input.mutationKind,
        archiveGeneration: room.archiveGeneration,
      });
    });
  } catch (error: unknown) {
    if (error instanceof ArchivedMessageMutationBlockedError) throw error;
    throw new ArchivedMessageMutationBlockedError("gate_unavailable");
  }
}
