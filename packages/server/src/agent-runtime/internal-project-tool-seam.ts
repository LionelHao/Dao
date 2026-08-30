import type { ProjectSnapshot } from "@native-im/core";
import type { AgentWorkerCommandContext } from "../persistence/contracts.js";
import type { ProjectLoopAuthorityOperation } from "../project-loop/authority-protocol.js";

/**
 * FT-09 remains the only Project authority. This facade owns no state and
 * deliberately has no public/parser/adapter registration surface.
 */
export interface InternalProjectToolQuery {
  readonly kind: "project.query";
  readonly executionId: string;
  readonly expectedExecutionVersion: number;
  readonly roomId: string;
  readonly sourceSnapshotId: string;
  readonly afterEventSeq: number;
  readonly limit: number;
}

export interface InternalProjectToolCommand {
  readonly kind: "project.command";
  readonly executionId: string;
  readonly expectedExecutionVersion: number;
  readonly roomId: string;
  readonly sourceSnapshotId: string;
  /** Existing FT-09 Agent-only closed Authority operation; never provider free text. */
  readonly operation: InternalProjectAgentCommandOperation;
}

type ProjectProposalCreateOperation = Extract<
  ProjectLoopAuthorityOperation,
  { readonly type: "project-loop.proposal.create" }
>;
type ProjectFactTransitionOperation = Extract<
  ProjectLoopAuthorityOperation,
  { readonly type: "project-loop.fact.transition" }
>;

export type InternalProjectAgentCommandOperation =
  | (Omit<ProjectProposalCreateOperation, "context"> & Readonly<{ context: AgentWorkerCommandContext }>)
  | (Omit<ProjectFactTransitionOperation, "context"> & Readonly<{ context: AgentWorkerCommandContext }>);

export type InternalProjectToolQueryResult =
  | Readonly<{ status: "dependency_unavailable" }>
  | Readonly<{ status: "ready"; snapshot: ProjectSnapshot }>;

export type InternalProjectToolCommandResult =
  | Readonly<{ status: "dependency_unavailable" }>
  | Readonly<{ status: "accepted"; acceptedRevision: number }>;

export interface InternalProjectToolAuthority {
  query(input: InternalProjectToolQuery): Promise<InternalProjectToolQueryResult>;
  command(input: InternalProjectToolCommand): Promise<InternalProjectToolCommandResult>;
}

export function createInternalProjectToolSeam(
  authority?: InternalProjectToolAuthority,
): InternalProjectToolAuthority {
  if (authority !== undefined) return Object.freeze({
    query: (input: InternalProjectToolQuery) => authority.query(input),
    command: (input: InternalProjectToolCommand) => authority.command(input),
  });
  const unavailable = Object.freeze({ status: "dependency_unavailable" as const });
  return Object.freeze({
    async query() { return unavailable; },
    async command() { return unavailable; },
  });
}
