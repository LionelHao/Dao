import type {
  AgentInvocationIntent,
  AgentRuntimeProviderInput,
  ContextCompileResultV1,
  ContextCompilerConfigV1,
  ProviderNeutralCheckpoint,
  ToolDescriptor,
} from "@native-im/core";
import {
  isCompiledProviderEnvelopeV1,
  type CompiledGroupContentBlockV1,
  type CompiledProviderEnvelopeV1,
} from "../agent-runtime/compiled-provider-envelope.js";
import { verifyContextCompileResultV1 } from "./context-compiler.js";

type SuccessfulCompileResult = Extract<ContextCompileResultV1, { readonly ok: true }>;

export interface CompiledProviderAdapterInputV1 {
  readonly result: SuccessfulCompileResult;
  readonly compilerConfig: ContextCompilerConfigV1;
  readonly snapshotId: string;
  readonly snapshotGeneration: number;
  readonly invocation: AgentInvocationIntent;
  readonly availableTools: readonly ToolDescriptor[];
  readonly openItemTargets: readonly Readonly<{ actorId: string; kind: "human" | "agent" }>[];
  readonly committedSteps: readonly ProviderNeutralCheckpoint[];
  readonly toolContinuations?: AgentRuntimeProviderInput["toolContinuations"];
  readonly timeoutMs: number;
}

function groupKind(
  group: SuccessfulCompileResult["envelope"]["groupContent"][number],
): CompiledGroupContentBlockV1["kind"] {
  if (group.section === "trigger") return "trigger";
  if (group.section === "memory") return "memory";
  if (group.section === "attachment") return "attachment_extraction";
  if (group.section === "retrieval") return "retrieval";
  if (group.author?.kind === "human") return "human_message";
  if (group.author?.kind === "agent") return "agent_message";
  return "raw_delta";
}

function providerGroup(
  group: SuccessfulCompileResult["envelope"]["groupContent"][number],
): CompiledGroupContentBlockV1 {
  const kind = groupKind(group);
  return {
    kind,
    trust: "untrusted_group_content",
    source: {
      label: group.citationLabel,
      kind: group.source.sourceKind,
      revision: group.source.revision,
    },
    content: group.representation.text,
    ...(group.memoryKind === null ? {} : { memoryKind: group.memoryKind }),
    ...(group.author === null || group.author.kind === "system" ? {} : {
      speaker: { actorId: group.author.actorId, kind: group.author.kind },
    }),
    ...(group.occurredAt === null ? {} : { serverTime: group.occurredAt }),
    ...(group.replyTo === null ? {} : {
      replyTo: { messageId: group.replyTo.sourceId, revision: group.replyTo.revision },
    }),
    ...(group.mentions.length === 0 ? {} : {
      mentions: group.mentions.map((mention) => ({
        startUtf16: mention.range.startUtf16,
        endUtf16: mention.range.endUtf16,
        targetKind: mention.targetKind,
        targetActorId: mention.targetActorId,
      })),
    }),
  };
}

function providerProject(
  project: SuccessfulCompileResult["envelope"]["projectContext"],
): AgentRuntimeProviderInput["projectContext"] {
  switch (project.availability) {
    case "disabled":
    case "unavailable":
      return { status: project.availability, reason: project.reason };
    case "available":
      return {
        status: "available",
        projectId: project.projectId,
        revision: project.revision,
        representation: project.representation,
        disposition: project.disposition,
        citationLabel: project.citationLabel,
        sourceRefs: project.sourceRefs,
      };
  }
}

function selectedTools(
  result: SuccessfulCompileResult,
  availableTools: readonly ToolDescriptor[],
): readonly ToolDescriptor[] {
  const actual = new Map(availableTools.map((tool) => [tool.id, tool]));
  if (actual.size !== availableTools.length) throw new TypeError("Provider tool identities were duplicated");
  const selected = result.envelope.availableTools.map((compiled) => {
    const tool = actual.get(compiled.id as ToolDescriptor["id"]);
    if (tool === undefined ||
        (compiled.effect === "read-only") !== (tool.effect === "read-only")) {
      throw new TypeError("Compiled Provider tools did not match authority tools");
    }
    return tool;
  });
  if (selected.length !== actual.size) {
    throw new TypeError("Authority tools were not closed by the compiled context");
  }
  return selected;
}

function assertInvocation(
  result: SuccessfulCompileResult,
  invocation: AgentInvocationIntent,
): void {
  const compiled = result.envelope.invocation;
  if (compiled.roomId !== invocation.roomId || compiled.intent.kind !== invocation.kind ||
      compiled.intent.sourceMessageId !== invocation.sourceMessageId ||
      compiled.intent.targetAgentId !== invocation.targetAgentId) {
    throw new TypeError("Compiled Provider invocation did not match the execution");
  }
}

export function buildCompiledProviderEnvelopeV1(
  input: CompiledProviderAdapterInputV1,
): CompiledProviderEnvelopeV1 {
  if (!verifyContextCompileResultV1(input.result, input.compilerConfig) || !input.result.ok) {
    throw new TypeError("Context compile result was not verified");
  }
  assertInvocation(input.result, input.invocation);
  const { envelope, manifest } = input.result;
  const providerEnvelope: CompiledProviderEnvelopeV1 = {
    purpose: "agent_runtime",
    schemaVersion: "compiled-context-envelope.v1",
    snapshot: {
      snapshotId: input.snapshotId,
      generation: input.snapshotGeneration,
      manifestHash: manifest.manifestHash,
      compilerVersion: envelope.compilerVersion,
      configVersion: manifest.configVersion,
      modelId: manifest.modelId,
    },
    invocation: input.invocation,
    trusted: {
      system: [{ kind: "product_policy", text: envelope.trusted.system }],
      developer: [
        { kind: "authority_fact", text: envelope.trusted.developer.policy },
        { kind: "agent_identity", data: {
          agentId: envelope.trusted.developer.agent.agentId,
          profileId: envelope.trusted.developer.agent.profileId,
          assignmentId: envelope.trusted.developer.agent.assignmentId,
          displayName: envelope.trusted.developer.agent.displayName,
          participation: envelope.trusted.developer.agent.participation,
          availability: envelope.trusted.developer.agent.availability,
          effectiveCapabilities: envelope.trusted.developer.agent.effectiveCapabilities,
          effectiveTools: envelope.trusted.developer.agent.effectiveTools,
          revisions: envelope.trusted.developer.agent.revisions,
        } },
        { kind: "responsibility", data: {
          global: envelope.trusted.developer.agent.globalResponsibility,
          room: envelope.trusted.developer.agent.roomResponsibility,
        } },
        { kind: "room_goal", data: {
          room: envelope.trusted.developer.room,
        } },
        { kind: "trigger_contract", data: {
          triggerType: envelope.trusted.developer.triggerType,
          triggerReason: envelope.trusted.developer.triggerReason,
          invocationIntent: envelope.trusted.developer.invocationIntent,
        } },
        { kind: "citation_contract", data: {
          contract: envelope.trusted.developer.citationContract,
          manifestHash: manifest.manifestHash,
          degradationNotes: envelope.degradationNotes,
        } },
      ],
    },
    groupContent: envelope.groupContent.map(providerGroup),
    projectContext: providerProject(envelope.projectContext),
    availableTools: selectedTools(input.result, input.availableTools),
    openItemTargets: input.openItemTargets,
    committedSteps: input.committedSteps,
    ...(input.toolContinuations === undefined ? {} : { toolContinuations: input.toolContinuations }),
    limits: {
      maxInputBytes: 262_144,
      compiledInputTokens: envelope.accounting.inputTokens,
      maxContextInputTokens: input.compilerConfig.hardLimitTokens -
        input.compilerConfig.outputReserveTokens - input.compilerConfig.toolSchemaBudgetTokens,
      maxOutputTokens: envelope.accounting.outputReserveTokens,
      maxOutputBytes: 262_144,
      timeoutMs: input.timeoutMs,
    },
  };
  if (!isCompiledProviderEnvelopeV1(providerEnvelope)) {
    throw new TypeError("Compiled Provider envelope was malformed");
  }
  return Object.freeze(providerEnvelope);
}
