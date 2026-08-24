const trustedOrigins = new WeakSet<object>();

declare const trustedInvocationOriginBrand: unique symbol;

interface TargetBoundTrustedOriginBase {
  readonly [trustedInvocationOriginBrand]: true;
  readonly roomId: string;
  readonly targetActorId: string;
  readonly profileRevision: number;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
}

export interface DirectInvocationOrigin extends TargetBoundTrustedOriginBase {
  readonly kind: "message_target";
  readonly messageId: string;
  readonly messageRevision: number;
  readonly targetOutcomeId: string;
}

export interface RouteDecisionTargetBinding {
  readonly actorId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly assignmentId: string;
  readonly assignmentRevision: number;
  readonly accessRevision: number;
}

export interface RouteDecisionOrigin {
  readonly [trustedInvocationOriginBrand]: true;
  readonly kind: "route_decision";
  readonly roomId: string;
  readonly routeJobId: string;
  readonly routeJobRevision: number;
  readonly snapshotId: string;
  readonly decisionId: string;
  readonly targets: readonly RouteDecisionTargetBinding[];
}

export interface ProjectBoundaryOrigin extends TargetBoundTrustedOriginBase {
  readonly kind: "project_boundary";
  readonly projectFactKind: "checkpoint" | "due" | "blocker";
  readonly projectFactId: string;
  readonly projectFactRevision: number;
}

export type TrustedInvocationOrigin =
  | DirectInvocationOrigin
  | RouteDecisionOrigin
  | ProjectBoundaryOrigin;

type DirectInput = Omit<DirectInvocationOrigin, typeof trustedInvocationOriginBrand>;
type RouteInput = Omit<RouteDecisionOrigin, typeof trustedInvocationOriginBrand>;
type ProjectInput = Omit<ProjectBoundaryOrigin, typeof trustedInvocationOriginBrand>;

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function common(input: Omit<TargetBoundTrustedOriginBase, typeof trustedInvocationOriginBrand>): void {
  if (!text(input.roomId) || !text(input.targetActorId) || !revision(input.profileRevision) ||
      !revision(input.assignmentRevision) || !revision(input.accessRevision)) {
    throw new TypeError("Trusted invocation origin binding is invalid");
  }
}

function mint<T extends object>(value: T): T {
  const frozen = Object.freeze(value);
  trustedOrigins.add(frozen);
  return frozen;
}

export function mintDirectInvocationOrigin(input: DirectInput): DirectInvocationOrigin {
  common(input);
  if (input.kind !== "message_target" || !text(input.messageId) ||
      !revision(input.messageRevision) || !text(input.targetOutcomeId)) {
    throw new TypeError("Direct invocation evidence is invalid");
  }
  return mint(input) as DirectInvocationOrigin;
}

export function mintRouteDecisionOrigin(input: RouteInput): RouteDecisionOrigin {
  if (input.kind !== "route_decision" || !text(input.roomId) || !text(input.routeJobId) ||
      !revision(input.routeJobRevision) || !text(input.snapshotId) || !text(input.decisionId) ||
      !Array.isArray(input.targets) || input.targets.length > 256 ||
      !input.targets.every((target) => text(target.actorId) && text(target.profileId) &&
        revision(target.profileRevision) && text(target.assignmentId) &&
        revision(target.assignmentRevision) && revision(target.accessRevision)) ||
      new Set(input.targets.map((target) => target.actorId)).size !== input.targets.length ||
      !input.targets.every((target, index) =>
        index === 0 || input.targets[index - 1]!.actorId.localeCompare(target.actorId) < 0)) {
    throw new TypeError("Route decision evidence is invalid");
  }
  return mint({
    ...input,
    targets: Object.freeze(input.targets.map((target) => Object.freeze({ ...target }))),
  }) as RouteDecisionOrigin;
}

export function mintProjectBoundaryOrigin(input: ProjectInput): ProjectBoundaryOrigin {
  common(input);
  if (input.kind !== "project_boundary" ||
      (input.projectFactKind !== "checkpoint" && input.projectFactKind !== "due" &&
        input.projectFactKind !== "blocker") || !text(input.projectFactId) ||
      !revision(input.projectFactRevision)) {
    throw new TypeError("Project boundary evidence is invalid");
  }
  return mint(input) as ProjectBoundaryOrigin;
}

export function isTrustedInvocationOrigin(value: unknown): value is TrustedInvocationOrigin {
  return typeof value === "object" && value !== null && trustedOrigins.has(value);
}
