import {
  isNotificationProjection,
  type NotificationKind,
  type NotificationProjection,
} from "@native-im/core";

export type NotificationDomainFailureReason =
  | "unauthenticated" | "forbidden" | "revision_conflict" | "source_inaccessible"
  | "rate_limited" | "storage_unavailable" | "invalid_request";

const statusForReason: Readonly<Record<NotificationDomainFailureReason, 400 | 401 | 403 | 409 | 410 | 429 | 503>> =
  Object.freeze({
    unauthenticated: 401,
    forbidden: 403,
    revision_conflict: 409,
    source_inaccessible: 410,
    rate_limited: 429,
    storage_unavailable: 503,
    invalid_request: 400,
  });

export class NotificationDomainError extends Error {
  readonly reason: NotificationDomainFailureReason;
  readonly status: 400 | 401 | 403 | 409 | 410 | 429 | 503;

  constructor(reason: NotificationDomainFailureReason, message: string) {
    super(message);
    this.name = "NotificationDomainError";
    this.reason = reason;
    this.status = statusForReason[reason];
  }
}

export type NotificationReadAuthority = Readonly<{
  principal: Readonly<{ kind: "human"; actorId: string }> | null;
  session: "active" | "revoked";
  membership: "active" | "revoked";
  sourceAccessible: boolean;
  availability: "ready" | "rate_limited" | "unavailable";
  expectedReadRevision: number;
  readAt: string;
}>;

export type NotificationReadResult = Readonly<{
  outcome: "read" | "already_read";
  projection: NotificationProjection;
}>;

function timestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function readInput(value: NotificationReadAuthority): void {
  if (!Number.isSafeInteger(value.expectedReadRevision) || value.expectedReadRevision < 0 ||
      !timestamp(value.readAt)) {
    throw new NotificationDomainError("invalid_request", "Notification read input was invalid");
  }
}

/** Opening the center never calls this function; only an explicit recipient read command does. */
export function markNotificationRead(
  fact: NotificationProjection,
  authority: NotificationReadAuthority,
): NotificationReadResult {
  if (!isNotificationProjection(fact)) {
    throw new NotificationDomainError("invalid_request", "Notification projection was invalid");
  }
  readInput(authority);
  if (authority.principal === null || authority.session !== "active") {
    throw new NotificationDomainError("unauthenticated", "A current Human session is required");
  }
  if (authority.principal.actorId !== fact.recipientActorId || authority.membership !== "active") {
    throw new NotificationDomainError("forbidden", "Only the current notification recipient may mark it read");
  }
  if (!authority.sourceAccessible) {
    throw new NotificationDomainError("source_inaccessible", "Notification source is unavailable");
  }
  if (authority.availability === "rate_limited") {
    throw new NotificationDomainError("rate_limited", "Notification read is rate limited");
  }
  if (authority.availability === "unavailable") {
    throw new NotificationDomainError("storage_unavailable", "Notification authority is unavailable");
  }
  if (authority.expectedReadRevision !== fact.readRevision) {
    throw new NotificationDomainError("revision_conflict", "Notification read revision changed");
  }
  if (fact.readAt !== null) {
    return Object.freeze({ outcome: "already_read", projection: fact });
  }
  const projection: NotificationProjection = Object.freeze({ ...fact,
    readAt: authority.readAt, readRevision: fact.readRevision + 1 });
  return Object.freeze({ outcome: "read", projection });
}

export type NotificationSourceTerminal =
  | "request_terminal"
  | "confirmation_terminal"
  | "project_boundary_released"
  | "tool_result_acknowledged_or_reviewed"
  | "execution_result_acknowledged_or_recovered"
  | "escalation_resolved";

const terminalForKind: Readonly<Record<NotificationKind, NotificationSourceTerminal | null>> =
  Object.freeze({
    human_mention: "request_terminal",
    human_request: "request_terminal",
    tool_confirmation: "confirmation_terminal",
    project_due: "project_boundary_released",
    tool_result: "tool_result_acknowledged_or_reviewed",
    agent_execution_completed: "execution_result_acknowledged_or_recovered",
    agent_execution_failed: "execution_result_acknowledged_or_recovered",
    cannot_answer_escalation: "escalation_resolved",
  });

/** handled is source authority projection; this function has no Human/client principal input. */
export function applyNotificationHandledProjection(
  fact: NotificationProjection,
  input: Readonly<{
    sourceBoundaryId: string;
    sourceTerminal: NotificationSourceTerminal;
    occurredAt: string;
  }>,
): NotificationProjection {
  if (!isNotificationProjection(fact) || !timestamp(input.occurredAt)) {
    throw new NotificationDomainError("invalid_request", "Notification handled input was invalid");
  }
  if (input.sourceBoundaryId !== fact.source.sourceBoundaryId) {
    throw new NotificationDomainError("revision_conflict", "Notification source boundary changed");
  }
  if (terminalForKind[fact.notificationKind] !== input.sourceTerminal) {
    throw new NotificationDomainError("invalid_request", "Notification source terminal was invalid");
  }
  if (fact.handled) return fact;
  return Object.freeze({ ...fact, handled: true, handledAt: input.occurredAt });
}

/** Inaccessible facts are omitted completely; callers must never create redacted metadata cards. */
export function projectNotificationForRecipient(
  fact: NotificationProjection,
  access: Readonly<{
    recipientActorId: string;
    membership: "active" | "revoked";
    sourceAccessible: boolean;
  }>,
): NotificationProjection | null {
  if (!isNotificationProjection(fact)) return null;
  return access.recipientActorId === fact.recipientActorId && access.membership === "active" &&
    access.sourceAccessible ? fact : null;
}
