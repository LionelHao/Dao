import { randomUUID } from "node:crypto";
import {
  isContextCompilerInputV1,
  type AgentExecution,
  type AgentInvocationIntent,
  type AgentRuntimeProviderInput,
  type ContextCompileResultV1,
  type ContextManifestEntryV1,
  type ToolDescriptor,
} from "@native-im/core";
import type { ContextAuthorityWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import type {
  ContextManifestItemInput,
  ContextSnapshotCommitOperation,
  ContextSnapshotPreparation,
  ContextSnapshotRecord,
  ContextSnapshotSourceInput,
} from "../persistence/context-snapshot-database-authority.js";
import { AgentRuntimeError } from "../agent-runtime/contracts.js";
import { buildCompiledProviderEnvelopeV1 } from "./compiled-provider-adapter.js";
import { canonicalJsonV1, sha256HexV1 } from "./canonical-json.js";
import {
  compileContextV1,
  CONTEXT_COMPILER_CONFIG_V1,
  verifyContextCompileResultV1,
} from "./context-compiler.js";

type SuccessfulCompile = Extract<ContextCompileResultV1, { readonly ok: true }>;
type ContextWorker = ContextAuthorityWorkerDatabaseClient;

type SnapshotPreparationResult = Readonly<{
  kind: "context-preparation";
  disposition: "candidate" | "existing";
  preparation: ContextSnapshotPreparation;
  snapshot?: ContextSnapshotRecord;
}>;

export interface WorkerCompiledContextBuilder {
  build(
    execution: AgentExecution,
    invocation: AgentInvocationIntent,
  ): Promise<AgentRuntimeProviderInput>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function snapshotRecord(value: unknown): value is ContextSnapshotRecord {
  return record(value) && typeof value.snapshotId === "string" && value.snapshotId.length > 0 &&
    typeof value.executionId === "string" && positive(value.attemptSeq) &&
    positive(value.snapshotGeneration) && positive(value.executionGeneration) &&
    ["active", "invalidated", "superseded", "retired"].includes(String(value.state)) &&
    sha256(value.manifestSha256) && sha256(value.envelopeSha256) &&
    ["required", "purge_pending", "purged"].includes(String(value.payloadRetentionState));
}

function preparationResult(value: unknown): SnapshotPreparationResult {
  if (!record(value) || value.kind !== "context-preparation" ||
      (value.disposition !== "candidate" && value.disposition !== "existing") ||
      !record(value.preparation)) {
    throw new AgentRuntimeError("provider_failure", "Context preparation result was malformed");
  }
  const preparation = value.preparation;
  if (typeof preparation.executionId !== "string" || !positive(preparation.attemptSeq) ||
      !positive(preparation.executionGeneration) ||
      typeof preparation.invocationIntentId !== "string" ||
      typeof preparation.roomId !== "string" || typeof preparation.agentId !== "string" ||
      typeof preparation.providerId !== "string" || typeof preparation.modelId !== "string" ||
      typeof preparation.triggerMessageId !== "string" || !positive(preparation.triggerRevision) ||
      !Array.isArray(preparation.expectedLineage) ||
      !isContextCompilerInputV1(preparation.compilerInputFacts) ||
      !sha256(preparation.preparationSha256)) {
    throw new AgentRuntimeError("provider_failure", "Context preparation facts were malformed");
  }
  if (value.disposition === "existing" && !snapshotRecord(value.snapshot)) {
    throw new AgentRuntimeError("provider_failure", "Existing context snapshot was malformed");
  }
  return value as unknown as SnapshotPreparationResult;
}

function snapshotResult(value: unknown): ContextSnapshotRecord {
  if (!record(value) || value.kind !== "context-snapshot" || !snapshotRecord(value.snapshot)) {
    throw new AgentRuntimeError("provider_failure", "Context snapshot result was malformed");
  }
  return value.snapshot;
}

function manifestProjection(entry: ContextManifestEntryV1): ContextManifestItemInput {
  if (entry.source === null) {
    return {
      section: entry.section,
      disposition: entry.disposition,
      canonicalSortKey: entry.canonicalOrder,
      sourceLabel: entry.citationLabel,
      sourceKind: null,
      sourceId: null,
      sourceRevision: null,
      contentSha256: null,
      originalBytes: entry.originalBytes,
      includedBytes: entry.includedBytes,
      originalTokens: entry.originalTokens,
      includedTokens: entry.includedTokens,
      reasonCode: entry.reason,
      segmentJson: canonicalJsonV1({
        fromCorpusSeq: entry.fromCorpusSeq,
        toCorpusSeq: entry.toCorpusSeq,
        count: entry.count,
        sourceIndexHash: entry.sourceIndexHash,
        readRef: entry.readRef,
      }),
      availability: "metadata_only",
    };
  }
  return {
    section: entry.section,
    disposition: entry.disposition,
    canonicalSortKey: entry.canonicalOrder,
    sourceLabel: entry.citationLabel,
    sourceKind: entry.source.sourceKind,
    sourceId: entry.source.sourceId,
    sourceRevision: entry.source.revision,
    contentSha256: entry.contentHash,
    originalBytes: entry.originalBytes,
    includedBytes: entry.includedBytes,
    originalTokens: entry.originalTokens,
    includedTokens: entry.includedTokens,
    reasonCode: entry.reason,
    ...(entry.segment === null && entry.range === null ? {} : {
      segmentJson: canonicalJsonV1({ range: entry.range, segment: entry.segment }),
    }),
    availability: entry.availability === "temporarily_unavailable" ? "unavailable"
      : entry.availability === "tombstone" ? "metadata_only" : entry.availability,
  };
}

function normalizedSourceKind(
  value: string,
): ContextSnapshotSourceInput["sourceKind"] {
  if (value === "memory") return "memory";
  if (value === "message_tombstone") return "message_tombstone";
  if (value === "attachment" || value === "attachment_extraction") {
    return "attachment_extraction";
  }
  if (value === "project" || value === "project_fact_checkpoint") {
    return "project_fact_checkpoint";
  }
  return "message_revision";
}

async function sourceSet(
  preparation: ContextSnapshotPreparation,
  result: SuccessfulCompile,
  attachmentAuthorizationRevision: (
    sourceId: string,
    sourceRevision: number,
  ) => Promise<number>,
): Promise<readonly ContextSnapshotSourceInput[]> {
  const values = new Map<string, ContextSnapshotSourceInput>();
  const key = (source: Pick<ContextSnapshotSourceInput, "sourceKind" | "sourceId" | "sourceRevision">) =>
    `${source.sourceKind}\u0000${source.sourceId}\u0000${source.sourceRevision}`;
  const authorizationRevision = async (
    kind: ContextSnapshotSourceInput["sourceKind"],
    sourceId: string,
    sourceRevision: number,
  ): Promise<number> => kind === "attachment_extraction"
    ? attachmentAuthorizationRevision(sourceId, sourceRevision)
    : preparation.membershipAccessRevision;
  const add = async (
    kind: ContextSnapshotSourceInput["sourceKind"],
    sourceId: string,
    sourceRevision: number,
    sourceLabel: string | null,
  ): Promise<void> => {
    const source: ContextSnapshotSourceInput = {
      sourceKind: kind,
      sourceId,
      sourceRevision,
      sourceLabel,
      currentlyRequired: kind !== "message_tombstone",
      authorizationRevision: await authorizationRevision(kind, sourceId, sourceRevision),
    };
    const identity = key(source);
    const existing = values.get(identity);
    if (existing === undefined || (existing.sourceLabel === null && sourceLabel !== null)) {
      values.set(identity, source);
    }
  };
  for (const item of result.manifest.items) {
    if (item.source === null) continue;
    await add(
      normalizedSourceKind(item.source.sourceKind),
      item.source.sourceId,
      item.source.revision,
      item.citationLabel,
    );
  }
  await add("message_revision", preparation.triggerMessageId, preparation.triggerRevision, null);
  for (const candidate of [
    ...preparation.compilerInputFacts.delta,
    ...preparation.compilerInputFacts.attachments,
  ]) {
    await add(
      normalizedSourceKind(candidate.source.sourceKind),
      candidate.source.sourceId,
      candidate.source.revision,
      null,
    );
  }
  for (const memory of preparation.compilerInputFacts.memories) {
    await add("memory", memory.memoryVersionId, memory.version, null);
  }
  return Object.freeze([...values.values()]);
}

async function commitOperation(
  preparation: ContextSnapshotPreparation,
  result: SuccessfulCompile,
  now: number,
  nextId: (kind: "snapshot" | "manifest") => string,
  attachmentAuthorizationRevision: (
    sourceId: string,
    sourceRevision: number,
  ) => Promise<number>,
): Promise<ContextSnapshotCommitOperation> {
  const items = result.manifest.items.map(manifestProjection);
  const totals = items.reduce((sum, item) => ({
    originalBytes: sum.originalBytes + item.originalBytes,
    includedBytes: sum.includedBytes + item.includedBytes,
    originalTokens: sum.originalTokens + item.originalTokens,
    includedTokens: sum.includedTokens + item.includedTokens,
  }), { originalBytes: 0, includedBytes: 0, originalTokens: 0, includedTokens: 0 });
  const compilerConfig = {
    ...CONTEXT_COMPILER_CONFIG_V1,
    modelId: preparation.modelId,
  };
  return {
    type: "context.commit",
    snapshotId: nextId("snapshot"),
    executionId: preparation.executionId,
    attemptSeq: 1,
    expectedExecutionGeneration: preparation.executionGeneration,
    preparationSha256: preparation.preparationSha256,
    compilerVersion: result.manifest.compilerVersion,
    compilerConfigVersion: result.manifest.configVersion,
    estimatorVersion: result.manifest.estimatorVersion,
    budgetJson: canonicalJsonV1(compilerConfig),
    compilerResult: result,
    manifest: {
      manifestId: nextId("manifest"),
      manifestVersion: result.manifest.version,
      manifestSha256: result.manifestSha256,
      canonicalManifestJson: result.canonicalManifest,
      totalOriginalBytes: totals.originalBytes,
      totalIncludedBytes: totals.includedBytes,
      totalOriginalTokens: totals.originalTokens,
      totalIncludedTokens: totals.includedTokens,
      accountingJson: canonicalJsonV1(result.manifest.accounting),
      items,
    },
    body: {
      envelopeSchemaVersion: result.envelope.version,
      canonicalEnvelopeJson: result.canonicalEnvelope,
      envelopeSha256: result.envelopeSha256,
      tokenCount: result.manifest.accounting.inputTokens,
    },
    sources: await sourceSet(preparation, result, attachmentAuthorizationRevision),
    ...(preparation.expectedLineage.length === 0
      ? {}
      : { lineage: preparation.expectedLineage }),
    now,
  };
}

function compiledBody(
  value: unknown,
  preparation: ContextSnapshotPreparation,
): Readonly<{ result: SuccessfulCompile; snapshot: ContextSnapshotRecord }> {
  if (!record(value) || value.kind !== "context-body" || !snapshotRecord(value.snapshot) ||
      typeof value.canonicalEnvelopeJson !== "string" ||
      value.envelopeSchemaVersion !== "compiled_context_envelope_v1" ||
      !positive(value.byteCount) || !positive(value.tokenCount) ||
      Buffer.byteLength(value.canonicalEnvelopeJson, "utf8") !== value.byteCount) {
    throw new AgentRuntimeError("provider_failure", "Restricted context body was malformed");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(value.canonicalEnvelopeJson);
  } catch {
    throw new AgentRuntimeError("provider_failure", "Restricted context body was not JSON");
  }
  if (!record(envelope) || !record(envelope.manifest)) {
    throw new AgentRuntimeError("provider_failure", "Restricted context envelope was malformed");
  }
  const canonicalManifest = canonicalJsonV1(envelope.manifest);
  const result = {
    ok: true,
    envelope,
    manifest: envelope.manifest,
    canonicalEnvelope: value.canonicalEnvelopeJson,
    canonicalManifest,
    envelopeSha256: sha256HexV1(value.canonicalEnvelopeJson),
    manifestSha256: sha256HexV1(canonicalManifest),
  } as unknown as SuccessfulCompile;
  const config = { ...CONTEXT_COMPILER_CONFIG_V1, modelId: preparation.modelId };
  if (!verifyContextCompileResultV1(result, config) ||
      result.envelopeSha256 !== value.snapshot.envelopeSha256 ||
      result.manifestSha256 !== value.snapshot.manifestSha256 ||
      result.manifest.accounting.inputTokens !== value.tokenCount) {
    throw new AgentRuntimeError("provider_failure", "Restricted context body failed verification");
  }
  return { result, snapshot: value.snapshot };
}

function compileFailure(result: Extract<ContextCompileResultV1, { readonly ok: false }>): never {
  if (result.error.code === "content_too_large") {
    throw new AgentRuntimeError("content_too_large", "Required context exceeded the model budget");
  }
  throw new AgentRuntimeError("provider_failure", "Authority context could not be compiled");
}

export function createWorkerCompiledContextBuilder(options: Readonly<{
  worker: ContextWorker;
  availableTools: readonly ToolDescriptor[];
  timeoutMs: number;
  loadOpenItemTargets: (
    executionId: string,
  ) => Promise<readonly Readonly<{ actorId: string; kind: "human" | "agent" }>[]>;
  attachmentAuthorizationRevision?: (
    sourceId: string,
    sourceRevision: number,
    preparation: ContextSnapshotPreparation,
  ) => Promise<number>;
  nowMs?: () => number;
  nextId?: (kind: "snapshot" | "manifest") => string;
}>): WorkerCompiledContextBuilder {
  if (!positive(options.timeoutMs) || options.timeoutMs > 30_000) {
    throw new TypeError("Compiled context Provider timeout was invalid");
  }
  const nowMs = options.nowMs ?? Date.now;
  const nextId = options.nextId ?? ((kind) => `context-${kind}-${randomUUID()}`);
  const attachmentAuthorizationRevision = options.attachmentAuthorizationRevision ??
    (async () => {
      throw new AgentRuntimeError(
        "provider_failure",
        "Attachment context authorization adapter was unavailable",
      );
    });

  return Object.freeze({
    async build(
      execution: AgentExecution,
      invocation: AgentInvocationIntent,
    ): Promise<AgentRuntimeProviderInput> {
      const prepared = preparationResult(await options.worker.executeContext({
        type: "context.prepare",
        executionId: execution.id,
        attemptSeq: execution.currentAttemptSeq,
        now: nowMs(),
      }));
      if (prepared.preparation.executionId !== execution.id ||
          prepared.preparation.attemptSeq !== execution.currentAttemptSeq ||
          prepared.preparation.roomId !== execution.roomId ||
          prepared.preparation.agentId !== execution.agentId ||
          prepared.preparation.modelId !== execution.modelId ||
          prepared.preparation.compilerInputFacts.invocation.intent.kind !== invocation.kind ||
          prepared.preparation.compilerInputFacts.invocation.intent.sourceMessageId !==
            invocation.sourceMessageId ||
          prepared.preparation.compilerInputFacts.invocation.intent.targetAgentId !==
            invocation.targetAgentId) {
        throw new AgentRuntimeError("execution_conflict", "Context preparation changed execution identity");
      }
      let snapshot: ContextSnapshotRecord;
      if (prepared.disposition === "candidate") {
        if (execution.currentAttemptSeq !== 1) {
          throw new AgentRuntimeError("execution_conflict", "Retry execution lost its context snapshot");
        }
        const config = { ...CONTEXT_COMPILER_CONFIG_V1, modelId: prepared.preparation.modelId };
        const compiled = compileContextV1(prepared.preparation.compilerInputFacts, config);
        if (!compiled.ok) compileFailure(compiled);
        snapshot = snapshotResult(await options.worker.executeContext(await commitOperation(
          prepared.preparation,
          compiled,
          nowMs(),
          nextId,
          (sourceId, sourceRevision) => attachmentAuthorizationRevision(
            sourceId,
            sourceRevision,
            prepared.preparation,
          ),
        )));
      } else {
        snapshot = prepared.snapshot!;
        if (execution.currentAttemptSeq > 1) {
          snapshot = snapshotResult(await options.worker.executeContext({
            type: "context.bind-attempt",
            executionId: execution.id,
            attemptSeq: execution.currentAttemptSeq,
            expectedExecutionGeneration: prepared.preparation.executionGeneration,
            reuseKind: "automatic_retry",
            now: nowMs(),
          }));
        }
      }
      const [body, openItemTargets] = await Promise.all([
        options.worker.executeContext({
          type: "context.read",
          executionId: execution.id,
          attemptSeq: execution.currentAttemptSeq,
          expectedExecutionGeneration: prepared.preparation.executionGeneration,
          now: nowMs(),
        }),
        options.loadOpenItemTargets(execution.id),
      ]);
      const verified = compiledBody(body, prepared.preparation);
      if (verified.snapshot.snapshotId !== snapshot.snapshotId ||
          verified.snapshot.snapshotGeneration !== snapshot.snapshotGeneration) {
        throw new AgentRuntimeError("execution_conflict", "Context snapshot changed during Provider build");
      }
      const compiledToolIds = new Set(verified.result.envelope.availableTools.map((entry) => entry.id));
      const availableTools = options.availableTools.filter((entry) => compiledToolIds.has(entry.id));
      try {
        return buildCompiledProviderEnvelopeV1({
          result: verified.result,
          compilerConfig: {
            ...CONTEXT_COMPILER_CONFIG_V1,
            modelId: prepared.preparation.modelId,
          },
          snapshotId: snapshot.snapshotId,
          snapshotGeneration: snapshot.snapshotGeneration,
          invocation,
          availableTools,
          openItemTargets,
          committedSteps: [],
          timeoutMs: options.timeoutMs,
        });
      } catch {
        throw new AgentRuntimeError("provider_failure", "Compiled Provider envelope was rejected");
      }
    },
  });
}
