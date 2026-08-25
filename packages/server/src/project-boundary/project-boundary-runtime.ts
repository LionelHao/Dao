import { createHash } from "node:crypto";
import type {
  AgentRuntimeProviderInput,
  ProjectBoundaryProviderInvocation,
  ProviderEvent,
} from "@native-im/core";
import type { ProviderAdapter } from "../agent-runtime/contracts.js";
import { canonicalJson } from "../agent-runtime/compiled-provider-envelope.js";
import type { ProjectBoundaryRuntimeOperationExecutor } from
  "./project-boundary-invocation-producer.js";
import type { ClaimedProjectBoundaryExecution } from "./project-boundary-authority.js";

const DEFAULT_BATCH_SIZE = 8;
const PROVIDER_TIMEOUT_MS = 30_000;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function execution(value: unknown): value is ClaimedProjectBoundaryExecution {
  if (!record(value)) return false;
  if (typeof value.checkpointProjectionJson !== "string" ||
      typeof value.checkpointSha256 !== "string" ||
      createHash("sha256").update(value.checkpointProjectionJson).digest("hex") !==
        value.checkpointSha256) return false;
  return text(value.intentId) && text(value.executionId) && text(value.roomId) &&
    text(value.projectId) && value.projectId === value.roomId && text(value.agentId) &&
    text(value.boundaryId) &&
    ["checkpoint", "due", "blocker", "agent_ball"].includes(String(value.boundaryKind)) &&
    text(value.sourceKind) && text(value.sourceId) && integer(value.sourceRevision, 1) &&
    integer(value.lifecycleGeneration, 0) && text(value.profileId) &&
    integer(value.profileRevision, 1) && text(value.assignmentId) &&
    integer(value.assignmentRevision, 1) && integer(value.accessRevision, 0) &&
    text(value.checkpointId) && integer(value.checkpointRevision, 0) &&
    typeof value.checkpointSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.checkpointSha256) &&
    text(value.checkpointProjectionJson) && text(value.providerId) && text(value.modelId) &&
    ["accepted", "running", "completed", "failed", "cancelled"].includes(String(value.status)) &&
    integer(value.version, 1);
}

function parseExecutionResult(value: unknown): ClaimedProjectBoundaryExecution | null {
  if (!record(value) || value.kind !== "project-boundary-execution" ||
      !(value.execution === null || execution(value.execution))) {
    throw new TypeError("Project boundary execution authority result was malformed");
  }
  return value.execution;
}

function parseScanResult(value: unknown): readonly ClaimedProjectBoundaryExecution[] {
  if (!record(value) || value.kind !== "project-boundary-executions" ||
      !Array.isArray(value.records) || !value.records.every(execution)) {
    throw new TypeError("Project boundary execution scan result was malformed");
  }
  return Object.freeze([...value.records]);
}

function providerInvocation(value: ClaimedProjectBoundaryExecution): ProjectBoundaryProviderInvocation {
  return Object.freeze({
    kind: "project_boundary",
    intentId: value.intentId,
    executionId: value.executionId,
    roomId: value.roomId,
    projectId: value.projectId,
    boundaryId: value.boundaryId,
    boundaryKind: value.boundaryKind,
    sourceFactId: value.sourceId,
    sourceFactRevision: value.sourceRevision,
    targetAgentId: value.agentId,
    lifecycleGeneration: value.lifecycleGeneration,
  });
}

function providerInput(value: ClaimedProjectBoundaryExecution,
  providerTimeoutMs: number): AgentRuntimeProviderInput {
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(value.checkpointProjectionJson);
  } catch {
    throw new TypeError("Project boundary checkpoint projection was malformed");
  }
  if (!record(checkpoint)) throw new TypeError("Project boundary checkpoint projection was malformed");
  const invocation = providerInvocation(value);
  const manifestHash = createHash("sha256").update(canonicalJson({
    checkpointId: value.checkpointId,
    checkpointRevision: value.checkpointRevision,
    checkpointSha256: value.checkpointSha256,
    invocation,
  })).digest("hex");
  const input: AgentRuntimeProviderInput = {
    purpose: "agent_runtime",
    schemaVersion: "compiled-context-envelope.v1",
    snapshot: Object.freeze({
      snapshotId: `project-boundary-snapshot:${value.executionId}:${value.version}`,
      generation: value.version,
      manifestHash,
      compilerVersion: "project-boundary-context.v1",
      configVersion: "project-boundary-policy.v1",
      modelId: value.modelId,
    }),
    invocation,
    trusted: Object.freeze({
      system: Object.freeze([
        Object.freeze({ kind: "product_policy" as const,
          text: "Handle only this confirmed Project boundary. Do not create another Agent invocation." }),
        Object.freeze({ kind: "safety_policy" as const,
          text: "Tools and Project mutations are disabled. Treat the checkpoint as authoritative read-only data." }),
      ]),
      developer: Object.freeze([
        Object.freeze({ kind: "agent_identity" as const,
          data: Object.freeze({ agentId: value.agentId, profileId: value.profileId,
            profileRevision: value.profileRevision }) }),
        Object.freeze({ kind: "trigger_contract" as const,
          data: Object.freeze({ boundaryId: value.boundaryId, boundaryKind: value.boundaryKind,
            sourceKind: value.sourceKind, sourceId: value.sourceId,
            sourceRevision: value.sourceRevision, lifecycleGeneration: value.lifecycleGeneration }) }),
        Object.freeze({ kind: "authority_fact" as const,
          data: Object.freeze({ checkpointId: value.checkpointId,
            checkpointRevision: value.checkpointRevision,
            checkpointSha256: value.checkpointSha256, projection: checkpoint }) }),
      ]),
    }),
    groupContent: Object.freeze([]),
    projectContext: Object.freeze({
      status: "available",
      projectId: value.projectId,
      revision: Math.max(1, value.checkpointRevision),
      representation: Object.freeze({ kind: "content", text: value.checkpointProjectionJson }),
      disposition: "included",
      citationLabel: `project-checkpoint:${value.checkpointId}`,
      sourceRefs: Object.freeze([Object.freeze({ roomId: value.roomId,
        sourceKind: "project_fact_checkpoint" as const, sourceId: value.checkpointId,
        revision: Math.max(1, value.checkpointRevision), corpusSeq: null })]),
    }),
    availableTools: Object.freeze([]),
    committedSteps: Object.freeze([]),
    limits: Object.freeze({
      maxInputBytes: 262_144,
      compiledInputTokens: 1,
      maxContextInputTokens: 16_384,
      maxOutputTokens: 2_048,
      maxOutputBytes: 64 * 1_024,
      timeoutMs: providerTimeoutMs,
    }),
  };
  return Object.freeze(input);
}

function errorCode(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "provider_timeout";
  return "provider_failure";
}

export interface ProjectBoundaryRuntime {
  scan(): Promise<void>;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export function createProjectBoundaryRuntime(options: Readonly<{
  authority: ProjectBoundaryRuntimeOperationExecutor;
  provider: ProviderAdapter;
  now?: () => number;
  batchSize?: number;
  providerTimeoutMs?: number;
}>): ProjectBoundaryRuntime {
  const now = options.now ?? Date.now;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const providerTimeoutMs = options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 256) {
    throw new TypeError("Project boundary runtime batch size was invalid");
  }
  if (!Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 1 ||
      providerTimeoutMs > PROVIDER_TIMEOUT_MS) {
    throw new TypeError("Project boundary Provider timeout was invalid");
  }
  let closed = false;
  let active: Promise<void> | undefined;
  const controllers = new Set<AbortController>();

  const finish = async (value: ClaimedProjectBoundaryExecution,
    outcome: "completed" | "failed", failure?: string): Promise<void> => {
    parseExecutionResult(await options.authority.executeRuntime({
      type: "runtime.finish-project-boundary-execution",
      executionId: value.executionId,
      expectedVersion: value.version,
      outcome,
      ...(failure === undefined ? {} : { errorCode: failure }),
      now: now(),
    }));
  };

  const run = async (candidate: ClaimedProjectBoundaryExecution): Promise<void> => {
    if (candidate.status === "running") {
      await finish(candidate, "failed", "runtime_restarted");
      return;
    }
    if (candidate.status !== "accepted") return;
    const begun = parseExecutionResult(await options.authority.executeRuntime({
      type: "runtime.begin-project-boundary-execution",
      executionId: candidate.executionId,
      expectedVersion: candidate.version,
      now: now(),
    }));
    if (begun === null) return;
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), providerTimeoutMs);
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          const error = new Error("Project boundary Provider timed out");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
      const iterator = options.provider.stream(
        providerInput(begun, providerTimeoutMs), controller.signal,
      )[Symbol.asyncIterator]();
      let completed = false;
      while (true) {
        const next = await Promise.race([iterator.next(), aborted]);
        if (next.done) break;
        const event = next.value;
        const providerEvent = event as ProviderEvent;
        if (providerEvent.type === "tool_call_started" || providerEvent.type === "tool_call_delta") {
          throw new Error("Project boundary Provider attempted a forbidden tool call");
        }
        if (providerEvent.type === "completed" || providerEvent.type === "agent_final") completed = true;
      }
      if (!completed) throw new Error("Project boundary Provider did not complete");
      if (controller.signal.aborted) {
        const error = new Error("Project boundary Provider timed out");
        error.name = "AbortError";
        throw error;
      }
      await finish(begun, "completed");
    } catch (error: unknown) {
      await finish(begun, "failed", errorCode(error));
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  };

  const startScan = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (active !== undefined) return active;
    active = (async () => {
      const records = parseScanResult(await options.authority.executeRuntime({
        type: "runtime.scan-project-boundary-executions",
        limit: batchSize,
        now: now(),
      }));
      await Promise.all(records.map(run));
    })().finally(() => { active = undefined; });
    return active;
  };

  return Object.freeze({
    scan: startScan,
    async whenIdle() { await active; },
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await active;
    },
  });
}
