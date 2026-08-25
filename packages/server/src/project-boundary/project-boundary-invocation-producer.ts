import { createHash } from "node:crypto";
import {
  isProjectBoundaryInvocationRequest,
  isProjectBoundaryInvocationResult,
  type ProjectBoundaryInvocationRequest,
  type ProjectBoundaryInvocationResult,
} from "@native-im/core";
import { canonicalJsonV1 } from "../context-compiler/canonical-json.js";

/**
 * FT-08's server-private handoff. FT-09 will supply the versioned Project fact
 * reader and intent creator; until then production installs only the durable
 * fail-closed authority port below.
 */
export interface ProjectBoundaryInvocationAuthorityPort {
  recordSuppressed(input: Readonly<{
    request: ProjectBoundaryInvocationRequest;
    requestSha256: string;
    reason: "dependency_unavailable";
    decidedAt: string;
  }>): Promise<ProjectBoundaryInvocationResult>;
}

export interface ProjectBoundaryInvocationProducer {
  consume(request: ProjectBoundaryInvocationRequest): Promise<ProjectBoundaryInvocationResult>;
}

export function createFailClosedProjectBoundaryInvocationProducer(options: Readonly<{
  authority: ProjectBoundaryInvocationAuthorityPort;
  now?: () => number;
}>): ProjectBoundaryInvocationProducer {
  const now = options.now ?? Date.now;
  return Object.freeze({
    async consume(request: ProjectBoundaryInvocationRequest) {
      if (!isProjectBoundaryInvocationRequest(request)) {
        throw new TypeError("Project boundary invocation request was malformed");
      }
      const requestSha256 = createHash("sha256")
        .update(canonicalJsonV1(request))
        .digest("hex");
      const result = await options.authority.recordSuppressed({
        request,
        requestSha256,
        reason: "dependency_unavailable",
        decidedAt: new Date(now()).toISOString(),
      });
      if (!isProjectBoundaryInvocationResult(result) ||
          result.boundaryId !== request.boundaryId || result.roomId !== request.roomId ||
          result.status !== "suppressed" || result.reason !== "dependency_unavailable") {
        throw new TypeError("Project boundary authority result was malformed");
      }
      return result;
    },
  });
}
