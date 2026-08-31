export type HumanRoomRole = "owner" | "admin" | "member";
export type RoomLifecycle = "active" | "archived";

export interface GovernanceHumanMember {
  readonly kind: "human";
  readonly actorId: string;
  readonly displayName: string;
  readonly role: "admin" | "member";
}

export interface GovernanceAgentMember {
  readonly kind: "agent";
  readonly actorId: string;
  readonly displayName: string;
  readonly ordinary: boolean;
}

export type GovernanceMember = GovernanceHumanMember | GovernanceAgentMember;

export interface GovernanceProjection {
  readonly roomId: string;
  readonly projectId: string;
  readonly roomName: string;
  readonly lifecycle: RoomLifecycle;
  readonly governanceRevision: number;
  readonly archiveGeneration: number;
  readonly ownerActorId: string;
  readonly archivedAt?: string;
  readonly members: readonly GovernanceMember[];
}

export type DepartureConflictKind =
  | "request"
  | "next_action"
  | "blocker_or_open_question"
  | "pending_acceptance"
  | "pending_verification"
  | "pending_confirmation";

export type DepartureResolution =
  | "complete"
  | "transfer"
  | "escalate"
  | "reject_or_revoke";

export interface DepartureConflict {
  readonly conflictId: string;
  readonly roomId: string;
  readonly subjectId: string;
  readonly kind: DepartureConflictKind;
  readonly summary: string;
  readonly state: string;
  readonly sourceRef: string;
  readonly revision: number;
  readonly allowedResolutions: readonly DepartureResolution[];
}

export interface DepartureConflictList {
  readonly roomId: string;
  readonly targetActorId: string;
  readonly governanceRevision: number;
  readonly conflicts: readonly DepartureConflict[];
}

export type GovernanceCommand =
  | "room.ownership.transfer"
  | "room.member.leave"
  | "room.member.remove"
  | "room.archive"
  | "room.reopen";

export type GovernanceClosedError =
  | { readonly status: 401; readonly code: "authentication_required" | "session_revoked" }
  | { readonly status: 403; readonly code: "role_forbidden" | "access_revoked" }
  | { readonly status: 404; readonly code: "member_not_found" | "room_not_found" }
  | {
      readonly status: 409;
      readonly code: "departure_blocked";
      readonly details: DepartureConflictList;
    }
  | {
      readonly status: 409;
      readonly code:
        | "room_revision_conflict"
        | "ownership_transfer_required"
        | "room_archived"
        | "room_read_only";
    }
  | { readonly status: 410; readonly code: "snapshot_expired" }
  | { readonly status: 429; readonly code: "rate_limited"; readonly retryAfterSeconds?: number }
  | {
      readonly status: 503;
      readonly code: "dependency_unavailable" | "service_unavailable" | "repair_unavailable";
    };

export type GovernanceOperationState =
  | { readonly status: "idle" }
  | {
      readonly status: "submitting";
      readonly requestId: string;
      readonly command: GovernanceCommand;
    }
  | {
      readonly status: "acknowledged";
      readonly requestId: string;
      readonly command: GovernanceCommand;
    }
  | {
      readonly status: "succeeded";
      readonly requestId: string;
      readonly command: GovernanceCommand;
    }
  | {
      readonly status: "failed";
      readonly requestId: string;
      readonly command: GovernanceCommand;
      readonly error: GovernanceClosedError;
    };

export type GovernanceConnectionState =
  | { readonly status: "online" }
  | {
      readonly status: "offline";
      readonly asOf: string;
      readonly leaseExpiresAt: string;
    }
  | { readonly status: "repairing"; readonly watermark: number }
  | { readonly status: "repair_failed"; readonly errorCode: string }
  | { readonly status: "revoked"; readonly scope: "room" | "session"; readonly purgeCompleted: boolean }
  | { readonly status: "fatal"; readonly errorCode: string };

export type GovernanceDialog = "departure_conflicts" | "archive_confirmation";

export interface GovernanceSurfaceState {
  readonly projection: GovernanceProjection;
  readonly viewerActorId: string;
  readonly connection: GovernanceConnectionState;
  readonly operation: GovernanceOperationState;
  readonly departureConflicts?: DepartureConflictList;
  readonly dialog: GovernanceDialog | null;
  readonly reducedMotion: boolean;
}

export type GovernanceAuthorityResponse =
  | {
      readonly type: "ack";
      readonly requestId: string;
      readonly command: GovernanceCommand;
    }
  | {
      readonly type: "projection";
      readonly requestId: string;
      readonly projection: GovernanceProjection;
    }
  | ({ readonly type: "error"; readonly requestId: string } & GovernanceClosedError);

export interface GovernanceIntent {
  readonly command: GovernanceCommand;
  readonly expectedGovernanceRevision: number;
  readonly targetActorId?: string;
}

export interface GovernanceMemberView {
  readonly kind: GovernanceMember["kind"];
  readonly actorId: string;
  readonly displayName: string;
  readonly role: HumanRoomRole | "agent";
  readonly manageable: boolean;
  readonly manageReason: string;
}

export interface GovernanceViewModel {
  readonly roomId: string;
  readonly roomName: string;
  readonly lifecycle: RoomLifecycle;
  readonly archivedAt?: string;
  readonly viewerRole: HumanRoomRole | null;
  readonly members: readonly GovernanceMemberView[];
  readonly transferTargets: readonly GovernanceHumanMember[];
  readonly mutationsAllowed: boolean;
  readonly contentLocked: boolean;
  readonly readableSurfaces: {
    readonly history: boolean;
    readonly attachments: boolean;
    readonly projectFacts: boolean;
    readonly audit: boolean;
  };
  readonly businessControls: {
    readonly composer: boolean;
    readonly projectMutation: boolean;
    readonly agentBusinessControls: boolean;
  };
  readonly controls: {
    readonly canTransferOwnership: boolean;
    readonly canArchive: boolean;
    readonly canReopen: boolean;
    readonly canSelfLeave: boolean;
  };
  member(actorId: string): GovernanceMemberView | undefined;
}

const conflictKinds = new Set<DepartureConflictKind>([
  "request",
  "next_action",
  "blocker_or_open_question",
  "pending_acceptance",
  "pending_verification",
  "pending_confirmation",
]);
const conflictResolutions = new Set<DepartureResolution>([
  "complete",
  "transfer",
  "escalate",
  "reject_or_revoke",
]);
const resolutionsByKind: Record<DepartureConflictKind, ReadonlySet<DepartureResolution>> = {
  request: new Set(["complete", "transfer"]),
  next_action: new Set(["complete", "transfer"]),
  blocker_or_open_question: new Set(["complete", "transfer", "escalate"]),
  pending_acceptance: new Set(["transfer", "reject_or_revoke"]),
  pending_verification: new Set(["complete", "transfer"]),
  pending_confirmation: new Set(["reject_or_revoke"]),
};

function nonEmpty(value: string, description: string): void {
  if (value.length === 0 || value.length > 512) {
    throw new TypeError(`${description} is not a bounded non-empty string`);
  }
}

function safeRevision(value: number, description: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${description} is not a safe revision`);
  }
}

function validateProjection(projection: GovernanceProjection): void {
  nonEmpty(projection.roomId, "roomId");
  nonEmpty(projection.roomName, "roomName");
  if (projection.projectId !== projection.roomId) {
    throw new TypeError("Room and Project projection diverged");
  }
  safeRevision(projection.governanceRevision, "governanceRevision", true);
  safeRevision(projection.archiveGeneration, "archiveGeneration", true);
  if (projection.lifecycle === "archived" && projection.archivedAt === undefined) {
    throw new TypeError("archived projection omitted archivedAt");
  }
  const actorIds = new Set<string>();
  for (const member of projection.members) {
    nonEmpty(member.actorId, "member actorId");
    nonEmpty(member.displayName, "member displayName");
    if (actorIds.has(member.actorId)) throw new TypeError("membership projection is duplicated");
    actorIds.add(member.actorId);
  }
  const owner = projection.members.filter(
    (member) => member.kind === "human" && member.actorId === projection.ownerActorId,
  );
  if (owner.length !== 1) throw new TypeError("owner projection is inconsistent");
}

function validateConflicts(
  roomId: string,
  list: DepartureConflictList | undefined,
): void {
  if (list === undefined) return;
  if (list.roomId !== roomId) throw new TypeError("departure conflict list crossed Room authority");
  safeRevision(list.governanceRevision, "departure governance revision", true);
  const ids = new Set<string>();
  for (const conflict of list.conflicts) {
    if (conflict.roomId !== roomId) {
      throw new TypeError("departure conflict crossed Room authority");
    }
    nonEmpty(conflict.conflictId, "conflictId");
    nonEmpty(conflict.subjectId, "conflict subjectId");
    nonEmpty(conflict.summary, "conflict summary");
    nonEmpty(conflict.state, "conflict state");
    nonEmpty(conflict.sourceRef, "conflict sourceRef");
    safeRevision(conflict.revision, "conflict revision");
    if (!conflictKinds.has(conflict.kind) || conflict.allowedResolutions.length === 0 ||
        conflict.allowedResolutions.some((resolution) => !conflictResolutions.has(resolution)) ||
        conflict.allowedResolutions.some((resolution) => !resolutionsByKind[conflict.kind].has(resolution)) ||
        new Set(conflict.allowedResolutions).size !== conflict.allowedResolutions.length) {
      throw new TypeError("departure conflict is not closed");
    }
    if (ids.has(conflict.conflictId)) throw new TypeError("departure conflict ID is duplicated");
    ids.add(conflict.conflictId);
  }
}

function roleForMember(
  projection: GovernanceProjection,
  member: GovernanceMember,
): HumanRoomRole | "agent" {
  if (member.kind === "agent") return "agent";
  return member.actorId === projection.ownerActorId ? "owner" : member.role;
}

function managementDecision(
  viewerRole: HumanRoomRole | null,
  memberRole: HumanRoomRole | "agent",
  member: GovernanceMember,
): { readonly manageable: boolean; readonly reason: string } {
  if (viewerRole === "owner" && memberRole !== "owner") {
    return memberRole !== "agent" || (member.kind === "agent" && member.ordinary)
      ? { manageable: true, reason: "owner 可管理此成员" }
      : { manageable: false, reason: "该 Agent 不属于普通治理路径" };
  }
  if (viewerRole === "admin") {
    if (memberRole === "owner") {
      return { manageable: false, reason: "admin 不能管理 owner" };
    }
    if (memberRole === "admin") {
      return { manageable: false, reason: "admin 不能管理同级 admin" };
    }
    if (memberRole === "member" ||
        (memberRole === "agent" && member.kind === "agent" && member.ordinary)) {
      return { manageable: true, reason: "admin 可管理 member 与普通 Agent" };
    }
    return { manageable: false, reason: "admin 不能管理此 Agent" };
  }
  if (viewerRole === "member") {
    return { manageable: false, reason: "member 治理区只读" };
  }
  return { manageable: false, reason: "当前主体没有 Room 治理权限" };
}

export function createGovernanceViewModel(state: GovernanceSurfaceState): GovernanceViewModel {
  validateProjection(state.projection);
  validateConflicts(state.projection.roomId, state.departureConflicts);
  const locked = state.connection.status === "revoked" || state.connection.status === "fatal";
  const viewer = state.projection.members.find(
    (member): member is GovernanceHumanMember =>
      member.kind === "human" && member.actorId === state.viewerActorId,
  );
  if (!locked && viewer === undefined) throw new TypeError("viewer is not a current Human member");
  const viewerRole = viewer === undefined
    ? null
    : viewer.actorId === state.projection.ownerActorId ? "owner" : viewer.role;
  const mutationsAllowed = state.connection.status === "online" && !locked;
  const businessEnabled = mutationsAllowed && state.projection.lifecycle === "active";
  const members = state.projection.members.map((member): GovernanceMemberView => {
    const role = roleForMember(state.projection, member);
    const decision = managementDecision(viewerRole, role, member);
    return {
      kind: member.kind,
      actorId: member.actorId,
      displayName: member.displayName,
      role,
      manageable: mutationsAllowed && decision.manageable,
      manageReason: mutationsAllowed
        ? decision.reason
        : "当前 offline / repair / locked 状态禁止治理 mutation",
    };
  });
  const readable = !locked;
  const privileged = viewerRole === "owner" || viewerRole === "admin";
  return {
    roomId: state.projection.roomId,
    roomName: state.projection.roomName,
    lifecycle: state.projection.lifecycle,
    ...(state.projection.archivedAt === undefined ? {} : { archivedAt: state.projection.archivedAt }),
    viewerRole,
    members,
    transferTargets: state.projection.members.filter(
      (member): member is GovernanceHumanMember =>
        member.kind === "human" && member.actorId !== state.projection.ownerActorId,
    ),
    mutationsAllowed,
    contentLocked: locked,
    readableSurfaces: {
      history: readable,
      attachments: readable,
      projectFacts: readable,
      audit: readable,
    },
    businessControls: {
      composer: businessEnabled,
      projectMutation: businessEnabled,
      agentBusinessControls: businessEnabled,
    },
    controls: {
      canTransferOwnership: mutationsAllowed && viewerRole === "owner",
      canArchive: mutationsAllowed && privileged && state.projection.lifecycle === "active",
      canReopen: mutationsAllowed && privileged && state.projection.lifecycle === "archived",
      canSelfLeave: mutationsAllowed && viewerRole !== null && viewerRole !== "owner",
    },
    member: (actorId: string) => members.find((member) => member.actorId === actorId),
  };
}

function currentRequestMatches(
  operation: GovernanceOperationState,
  requestId: string,
): operation is Exclude<GovernanceOperationState, { readonly status: "idle" }> {
  return operation.status !== "idle" && operation.requestId === requestId;
}

export function applyGovernanceAuthorityResponse(
  state: GovernanceSurfaceState,
  response: GovernanceAuthorityResponse,
): GovernanceSurfaceState {
  if (!currentRequestMatches(state.operation, response.requestId)) return state;
  if (response.type === "ack") {
    if (state.operation.status !== "submitting" || response.command !== state.operation.command) {
      return state;
    }
    return {
      ...state,
      operation: {
        status: "acknowledged",
        requestId: response.requestId,
        command: response.command,
      },
    };
  }
  if (response.type === "projection") {
    if (state.operation.status !== "acknowledged") return state;
    validateProjection(response.projection);
    if (response.projection.roomId !== state.projection.roomId) return state;
    return {
      ...state,
      projection: response.projection,
      operation: {
        status: "succeeded",
        requestId: response.requestId,
        command: state.operation.command,
      },
    };
  }
  if (state.operation.status === "succeeded") return state;
  const error: GovernanceClosedError = response.code === "departure_blocked"
    ? { status: response.status, code: response.code, details: response.details }
    : response.status === 429 && response.retryAfterSeconds !== undefined
      ? { status: response.status, code: response.code, retryAfterSeconds: response.retryAfterSeconds }
      : { status: response.status, code: response.code } as GovernanceClosedError;
  const next = {
    ...state,
    operation: {
      status: "failed" as const,
      requestId: response.requestId,
      command: state.operation.command,
      error,
    },
  };
  return response.code === "departure_blocked"
    ? { ...next, departureConflicts: response.details, dialog: "departure_conflicts" }
    : next;
}
