import { createHash } from "node:crypto";
import {
  isProjectBoundaryInvocationRequest,
  isProjectBoundaryInvocationResult,
  type ProjectBoundaryInvocationRequest,
  type ProjectBoundaryInvocationResult,
} from "@native-im/core";
import { canonicalJsonV1 } from "../context-compiler/canonical-json.js";
import type { RuntimeAuthorityOperation } from
  "../agent-runtime/runtime-authority-protocol.js";

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

export interface AuthoritativeProjectBoundaryInvocationPort {
  /**
   * The v23 adapter must atomically verify that the boundary is confirmed,
   * active, current, unconsumed, Agent-held, lifecycle-active and assignment-
   * eligible; claim it; and create the FT-08 invocation intent. Ineligible
   * inputs return a durable suppression and must create zero execution/provider
   * work.
   */
  claimConfirmedAgentBoundary(input: Readonly<{
    request: ProjectBoundaryInvocationRequest;
    requestSha256: string;
    attemptedAt: string;
  }>): Promise<ProjectBoundaryInvocationResult>;
}

export interface ProjectBoundaryInvocationProducer {
  consume(request: ProjectBoundaryInvocationRequest): Promise<ProjectBoundaryInvocationResult>;
}

export interface ProjectBoundaryRuntimeOperationExecutor {
  executeRuntime(operation: RuntimeAuthorityOperation): Promise<unknown>;
}

export function createWorkerProjectBoundaryInvocationAuthority(
  worker: ProjectBoundaryRuntimeOperationExecutor,
): ProjectBoundaryInvocationAuthorityPort {
  return Object.freeze({
    async recordSuppressed(
      input: Parameters<ProjectBoundaryInvocationAuthorityPort["recordSuppressed"]>[0],
    ) {
      const result = await worker.executeRuntime({
        type: "runtime.suppress-project-boundary",
        request: input.request,
        requestSha256: input.requestSha256,
        reason: input.reason,
        decidedAt: input.decidedAt,
        now: Date.parse(input.decidedAt),
      });
      if (typeof result !== "object" || result === null || !("kind" in result) ||
          result.kind !== "project-boundary" || !("result" in result) ||
          !isProjectBoundaryInvocationResult(result.result)) {
        throw new TypeError("Project boundary worker result was malformed");
      }
      return result.result;
    },
  });
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

export function createAuthoritativeProjectBoundaryInvocationProducer(options: Readonly<{
  authority: AuthoritativeProjectBoundaryInvocationPort;
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
      const attemptedAt = new Date(now()).toISOString();
      const result = await options.authority.claimConfirmedAgentBoundary({
        request,
        requestSha256,
        attemptedAt,
      });
      if (!isProjectBoundaryInvocationResult(result) ||
          result.boundaryId !== request.boundaryId || result.roomId !== request.roomId) {
        throw new TypeError("Project boundary authority result was malformed");
      }
      return result;
    },
  });
}
