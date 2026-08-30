import type { ProjectLoopAuthorityOperation } from "../project-loop/authority-protocol.js";
import type {
  InternalProjectAgentCommandOperation,
  InternalProjectToolCommand,
  InternalProjectToolQuery,
} from "./internal-project-tool-seam.js";

type Assert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

type HumanProposalResolution = Extract<
  ProjectLoopAuthorityOperation,
  { readonly type: "project-loop.proposal.resolve" }
>;

export type HumanResolutionCannotBecomeAgentProjectCommand = Assert<Not<
  IsAssignable<HumanProposalResolution, InternalProjectAgentCommandOperation>
>>;
export type ProjectQueryCannotBecomeCommand = Assert<Not<
  IsAssignable<InternalProjectToolQuery, InternalProjectToolCommand>
>>;
