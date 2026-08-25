import type {
  AuthenticatedCommandContext,
  AuthenticatedSessionContext,
} from "./persistence/contracts.js";
import {
  isProjectLoopServerFrame,
  type ProjectLoopClientFrame,
  type ProjectLoopServerFrame,
} from "./project-loop-protocol.js";

type ProjectLoopMutationFrame = Exclude<
  ProjectLoopClientFrame,
  { readonly type: "project.snapshot.read" }
>;

export interface ProjectLoopAuthorityTransport {
  executeQuery(
    context: AuthenticatedSessionContext,
    frame: Extract<ProjectLoopClientFrame, { readonly type: "project.snapshot.read" }>,
  ): Promise<unknown>;
  executeMutation(
    context: AuthenticatedCommandContext,
    frame: ProjectLoopMutationFrame,
  ): Promise<unknown>;
}

export class ProjectLoopTransportError extends Error {
  readonly status = 503;
  readonly code = "project_dependency_unavailable";

  constructor() {
    super("project_dependency_unavailable");
    this.name = "ProjectLoopTransportError";
  }
}

export async function executeProjectLoopFrame(
  session: AuthenticatedSessionContext,
  frame: ProjectLoopClientFrame,
  authority: ProjectLoopAuthorityTransport | undefined,
): Promise<ProjectLoopServerFrame> {
  if (authority === undefined) throw new ProjectLoopTransportError();
  const response = frame.type === "project.snapshot.read"
    ? await authority.executeQuery(session, frame)
    : await authority.executeMutation({
        ...session,
        kind: "human",
        requestId: frame.requestId,
        idempotencyKey: frame.idempotencyKey,
      }, frame);
  if (!isProjectLoopServerFrame(response) || response.requestId !== frame.requestId ||
      (response.type === "project.snapshot"
        ? (response.snapshot as { roomId?: unknown }).roomId !== frame.roomId
        : response.roomId !== frame.roomId)) throw new ProjectLoopTransportError();
  return response;
}
