import type {
  DepartureConflict,
  DepartureConflictList,
  HumanRoomRole,
  RoomLifecycleState,
} from "@native-im/core";
import { useAuthorityTransactionDatabase } from "../persistence/authority-transaction-database.js";
import {
  isAuthorityTransactionView,
  type AuthorityTransactionView,
  type FeatureEnablementManifest,
} from "./private-participant-contracts.js";
import {
  AuthorityParticipantUnavailableError,
  invokeAuthorityParticipant,
} from "./private-participant-registry.js";

const FEATURE = "departure-responsibility" as const;

export interface DepartureGovernanceComposition {
  readonly manifest: FeatureEnablementManifest;
  readonly registrations: readonly unknown[];
}

export interface DeparturePreflightInput {
  readonly roomId: string;
  /** Derived by the AuthorityWorker from a current Human session. */
  readonly authenticatedHumanActorId: string;
  readonly targetHumanActorId: string;
}

export type DepartureMutationOperation = "leave" | "remove";

export interface DepartureMutationInput extends DeparturePreflightInput {
  readonly operation: DepartureMutationOperation;
  readonly expectedGovernanceRevision: number;
}

export interface DepartureMutationAuthorization {
  readonly operation: DepartureMutationOperation;
  readonly roomId: string;
  readonly actorId: string;
  readonly actorRole: HumanRoomRole;
  readonly targetHumanActorId: string;
  readonly targetRole: HumanRoomRole;
  readonly lifecycle: RoomLifecycleState;
  readonly previousGovernanceRevision: number;
  readonly nextGovernanceRevision: number;
}

export type DepartureGovernanceErrorCode =
  | "room_not_found"
  | "member_not_found"
  | "room_forbidden"
  | "role_forbidden"
  | "room_revision_conflict"
  | "ownership_transfer_required"
  | "departure_blocked";

export class DepartureGovernanceCommandError extends Error {
  readonly details?: DepartureConflictList;

  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: DepartureGovernanceErrorCode,
    message: string,
    details?: DepartureConflictList,
  ) {
    super(message);
    this.name = "DepartureGovernanceCommandError";
    if (details !== undefined) this.details = details;
  }
}

declare const departureMutationAttemptBrand: unique symbol;

/**
 * A server-private, transaction-bound proof. It intentionally serializes as
 * `{}` and cannot be reconstructed from protocol JSON.
 */
export interface DepartureMutationAttempt {
  readonly [departureMutationAttemptBrand]: true;
}

interface HumanMembershipState {
  readonly actorId: string;
  readonly kind: "human";
  readonly role: HumanRoomRole;
}

interface RoomDepartureState {
  readonly roomId: string;
  readonly lifecycle: RoomLifecycleState;
  readonly governanceRevision: number;
  readonly ownerActorId: string;
  readonly actor: HumanMembershipState;
  readonly target:
    | HumanMembershipState
    | Readonly<{ readonly actorId: string; readonly kind: "agent"; readonly role: null }>;
}

interface AttemptBinding {
  readonly transaction: AuthorityTransactionView;
  readonly input: DepartureMutationInput;
  readonly authorization: DepartureMutationAuthorization;
  consumed: boolean;
}

const attemptBindings = new WeakMap<object, AttemptBinding>();

function commandError(
  status: DepartureGovernanceCommandError["status"],
  code: DepartureGovernanceErrorCode,
  message: string,
  details?: DepartureConflictList,
): never {
  throw new DepartureGovernanceCommandError(status, code, message, details);
}

function dependencyUnavailable(reason: ConstructorParameters<
  typeof AuthorityParticipantUnavailableError
>[1]): never {
  throw new AuthorityParticipantUnavailableError(FEATURE, reason);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHumanRoomRole(value: unknown): value is HumanRoomRole {
  return value === "owner" || value === "admin" || value === "member";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null &&
    "then" in value && typeof (value as { readonly then?: unknown }).then === "function";
}

function requireTransaction(
  transaction: AuthorityTransactionView,
  roomId: string,
): void {
  if (!isAuthorityTransactionView(transaction) || transaction.roomId !== roomId) {
    dependencyUnavailable("transaction_mismatch");
  }
}

function useTransactionDatabase<TResult>(
  transaction: AuthorityTransactionView,
  operation: Parameters<typeof useAuthorityTransactionDatabase<TResult>>[1],
): TResult {
  try {
    return useAuthorityTransactionDatabase(transaction, operation);
  } catch (error: unknown) {
    if (error instanceof DepartureGovernanceCommandError ||
      error instanceof AuthorityParticipantUnavailableError) {
      throw error;
    }
    dependencyUnavailable(error instanceof TypeError
      ? "transaction_mismatch"
      : "participant_threw");
  }
}

function readRoomDepartureState(
  transaction: AuthorityTransactionView,
  input: DeparturePreflightInput,
): RoomDepartureState {
  requireTransaction(transaction, input.roomId);
  if (!isNonEmptyString(input.roomId) ||
    !isNonEmptyString(input.authenticatedHumanActorId) ||
    !isNonEmptyString(input.targetHumanActorId)) {
    dependencyUnavailable("malformed_result");
  }

  return useTransactionDatabase(transaction, (database) => {
    const room = database.prepare(
      `SELECT id AS roomId, status AS lifecycle,
              governance_revision AS governanceRevision,
              owner_actor_id AS ownerActorId
       FROM rooms WHERE id = ?`,
    ).get(input.roomId);
    if (room === undefined) {
      return commandError(404, "room_not_found", "Authority Room was not found");
    }
    if (room.roomId !== input.roomId ||
      (room.lifecycle !== "active" && room.lifecycle !== "archived") ||
      !isSafeRevision(room.governanceRevision) ||
      !isNonEmptyString(room.ownerActorId)) {
      return dependencyUnavailable("malformed_result");
    }

    const actor = database.prepare(
      `SELECT membership.actor_id AS actorId, membership.kind, membership.role,
              actor.kind AS actorKind
       FROM room_memberships AS membership
       JOIN actors AS actor ON actor.id = membership.actor_id
       WHERE membership.room_id = ? AND membership.actor_id = ?`,
    ).get(input.roomId, input.authenticatedHumanActorId);
    if (actor === undefined) {
      return commandError(403, "room_forbidden", "Current Human Room membership is required");
    }
    if (actor.kind !== "human" || actor.actorKind !== "human" ||
      !isHumanRoomRole(actor.role) || actor.actorId !== input.authenticatedHumanActorId) {
      return commandError(403, "role_forbidden", "Only a current Human member may govern departure");
    }

    const target = database.prepare(
      `SELECT membership.actor_id AS actorId, membership.kind, membership.role,
              actor.kind AS actorKind
       FROM room_memberships AS membership
       JOIN actors AS actor ON actor.id = membership.actor_id
       WHERE membership.room_id = ? AND membership.actor_id = ?`,
    ).get(input.roomId, input.targetHumanActorId);
    if (target === undefined) {
      return commandError(404, "member_not_found", "Departure target was not found");
    }
    if (target.actorId !== input.targetHumanActorId ||
      target.kind !== target.actorKind ||
      (target.kind !== "human" && target.kind !== "agent")) {
      return dependencyUnavailable("malformed_result");
    }
    if (target.kind === "human" && !isHumanRoomRole(target.role)) {
      return dependencyUnavailable("malformed_result");
    }
    if (target.kind === "agent" && target.role !== null) {
      return dependencyUnavailable("malformed_result");
    }
    const ownership = database.prepare(
      `SELECT COUNT(*) AS ownerCount,
              SUM(CASE WHEN actor_id = ? THEN 1 ELSE 0 END) AS canonicalOwnerCount
       FROM room_memberships
       WHERE room_id = ? AND kind = 'human' AND role = 'owner'`,
    ).get(room.ownerActorId, input.roomId);
    if (ownership?.ownerCount !== 1 || ownership.canonicalOwnerCount !== 1 ||
      (actor.role === "owner") !== (actor.actorId === room.ownerActorId) ||
      (target.kind === "human" &&
        ((target.role === "owner") !== (target.actorId === room.ownerActorId)))) {
      return dependencyUnavailable("malformed_result");
    }

    return Object.freeze({
      roomId: input.roomId,
      lifecycle: room.lifecycle,
      governanceRevision: room.governanceRevision,
      ownerActorId: room.ownerActorId,
      actor: Object.freeze({
        actorId: actor.actorId,
        kind: "human" as const,
        role: actor.role,
      }),
      target: target.kind === "human"
        ? Object.freeze({
          actorId: target.actorId as string,
          kind: "human" as const,
          role: target.role as HumanRoomRole,
        })
        : Object.freeze({
          actorId: target.actorId as string,
          kind: "agent" as const,
          role: null,
        }),
    });
  });
}

function authorizePreflight(state: RoomDepartureState): void {
  if (state.target.kind !== "human") {
    return commandError(403, "role_forbidden", "FT-02B preflight accepts only Human targets");
  }
  if (state.actor.actorId === state.target.actorId || state.actor.role === "owner") return;
  if (state.actor.role === "admin" && state.target.role === "member") return;
  return commandError(403, "role_forbidden", "Caller cannot inspect this departure target");
}

function authorizeMutation(
  state: RoomDepartureState,
  input: DepartureMutationInput,
): DepartureMutationAuthorization {
  if (!isSafeRevision(input.expectedGovernanceRevision)) {
    dependencyUnavailable("malformed_result");
  }
  if (state.governanceRevision !== input.expectedGovernanceRevision) {
    return commandError(409, "room_revision_conflict", "Room governance revision is stale");
  }
  if (state.target.kind !== "human") {
    return commandError(403, "role_forbidden", "FT-02B mutation accepts only Human targets");
  }

  if (input.operation === "leave") {
    if (state.actor.actorId !== state.target.actorId) {
      return commandError(403, "role_forbidden", "A Human may only leave for itself");
    }
    if (state.target.actorId === state.ownerActorId || state.target.role === "owner") {
      return commandError(
        409,
        "ownership_transfer_required",
        "Room owner must transfer ownership before leaving",
      );
    }
  } else if (input.operation === "remove") {
    if (state.target.actorId === state.ownerActorId || state.target.role === "owner") {
      return commandError(
        409,
        "ownership_transfer_required",
        "Room owner must transfer ownership before removal",
      );
    }
    if (state.actor.actorId === state.target.actorId) {
      return commandError(403, "role_forbidden", "Self departure must use leave");
    }
    if (state.actor.role === "owner") {
      // Owner may remove current Human admins and members.
    } else if (state.actor.role === "admin" && state.target.role === "member") {
      // Admin may remove only ordinary Human members.
    } else {
      return commandError(403, "role_forbidden", "Caller cannot remove this Human member");
    }
  } else {
    return dependencyUnavailable("malformed_result");
  }
  if (!Number.isSafeInteger(state.governanceRevision + 1)) {
    return dependencyUnavailable("malformed_result");
  }

  return Object.freeze({
    operation: input.operation,
    roomId: state.roomId,
    actorId: state.actor.actorId,
    actorRole: state.actor.role,
    targetHumanActorId: state.target.actorId,
    targetRole: state.target.role,
    lifecycle: state.lifecycle,
    previousGovernanceRevision: state.governanceRevision,
    nextGovernanceRevision: state.governanceRevision + 1,
  });
}

function cloneConflict(value: DepartureConflict): DepartureConflict {
  return Object.freeze({
    conflictId: value.conflictId,
    roomId: value.roomId,
    subjectId: value.subjectId,
    kind: value.kind,
    title: value.title,
    state: value.state,
    allowedResolutions: Object.freeze([...value.allowedResolutions]),
    sourceId: value.sourceId,
    revision: value.revision,
  });
}

function collectConflictList(
  composition: DepartureGovernanceComposition,
  transaction: AuthorityTransactionView,
  state: RoomDepartureState,
): DepartureConflictList {
  const result = invokeAuthorityParticipant({
    feature: FEATURE,
    manifest: composition.manifest,
    registrations: composition.registrations,
    tx: transaction,
    roomId: state.roomId,
    invoke: (participant) => participant.listInTransaction(transaction, {
      roomId: state.roomId,
      targetHumanActorId: state.target.actorId,
    }),
  });
  if (result.targetHumanActorId !== state.target.actorId ||
    result.conflicts.some((conflict) => conflict.revision <= 0)) {
    dependencyUnavailable("malformed_result");
  }
  const conflicts = Object.freeze(result.conflicts.map(cloneConflict));
  return Object.freeze({
    roomId: state.roomId,
    targetActorId: state.target.actorId,
    governanceRevision: state.governanceRevision,
    conflicts,
  });
}

function throwIfBlocked(conflicts: DepartureConflictList): void {
  if (conflicts.conflicts.length > 0) {
    commandError(
      409,
      "departure_blocked",
      "Departure has unresolved responsibilities",
      conflicts,
    );
  }
}

function mintAttempt(binding: AttemptBinding): DepartureMutationAttempt {
  const attempt = Object.freeze(Object.create(null)) as object;
  attemptBindings.set(attempt, binding);
  return attempt as DepartureMutationAttempt;
}

export interface DepartureGovernanceCoordinator {
  preflightInTransaction(
    transaction: AuthorityTransactionView,
    input: DeparturePreflightInput,
  ): DepartureConflictList;
  beginMutationInTransaction(
    transaction: AuthorityTransactionView,
    input: DepartureMutationInput,
  ): DepartureMutationAttempt;
  finalizeMutationInTransaction<TResult>(
    transaction: AuthorityTransactionView,
    attempt: DepartureMutationAttempt,
    commit: (authorization: DepartureMutationAuthorization) => TResult,
  ): TResult;
  coordinateMutationInTransaction<TResult>(
    transaction: AuthorityTransactionView,
    input: DepartureMutationInput,
    commit: (authorization: DepartureMutationAuthorization) => TResult,
  ): TResult;
}

export function createDepartureGovernanceCoordinator(
  inputComposition: DepartureGovernanceComposition,
): DepartureGovernanceCoordinator {
  const composition = Object.freeze({
    manifest: inputComposition.manifest,
    registrations: Object.freeze([...inputComposition.registrations]),
  });

  const preflightInTransaction = (
    transaction: AuthorityTransactionView,
    input: DeparturePreflightInput,
  ): DepartureConflictList => {
    const state = readRoomDepartureState(transaction, input);
    authorizePreflight(state);
    return collectConflictList(composition, transaction, state);
  };

  const beginMutationInTransaction = (
    transaction: AuthorityTransactionView,
    input: DepartureMutationInput,
  ): DepartureMutationAttempt => {
    const state = readRoomDepartureState(transaction, input);
    const authorization = authorizeMutation(state, input);
    throwIfBlocked(collectConflictList(composition, transaction, state));
    return mintAttempt({
      transaction,
      input: Object.freeze({ ...input }),
      authorization,
      consumed: false,
    });
  };

  const finalizeMutationInTransaction = <TResult>(
    transaction: AuthorityTransactionView,
    attempt: DepartureMutationAttempt,
    commit: (authorization: DepartureMutationAuthorization) => TResult,
  ): TResult => {
    const binding = attemptBindings.get(attempt as object);
    if (binding === undefined || binding.consumed || binding.transaction !== transaction) {
      dependencyUnavailable("transaction_mismatch");
    }
    binding.consumed = true;

    const finalState = readRoomDepartureState(transaction, binding.input);
    const finalAuthorization = authorizeMutation(finalState, binding.input);
    if (finalAuthorization.actorRole !== binding.authorization.actorRole ||
      finalAuthorization.targetRole !== binding.authorization.targetRole ||
      finalAuthorization.lifecycle !== binding.authorization.lifecycle) {
      dependencyUnavailable("malformed_result");
    }
    throwIfBlocked(collectConflictList(composition, transaction, finalState));

    const result = commit(finalAuthorization);
    if (isThenable(result)) {
      throw new TypeError("Departure commit callback must finish inside the authority transaction");
    }
    return result;
  };

  const coordinateMutationInTransaction = <TResult>(
    transaction: AuthorityTransactionView,
    input: DepartureMutationInput,
    commit: (authorization: DepartureMutationAuthorization) => TResult,
  ): TResult => finalizeMutationInTransaction(
    transaction,
    beginMutationInTransaction(transaction, input),
    commit,
  );

  return Object.freeze({
    preflightInTransaction,
    beginMutationInTransaction,
    finalizeMutationInTransaction,
    coordinateMutationInTransaction,
  });
}
