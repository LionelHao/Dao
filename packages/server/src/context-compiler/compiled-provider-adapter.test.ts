import type { ContextCompilerInputV1 } from "@native-im/core";
import { describe, expect, it } from "vitest";
import { isCompiledProviderEnvelopeV1 } from "../agent-runtime/compiled-provider-envelope.js";
import { buildCompiledProviderEnvelopeV1 } from "./compiled-provider-adapter.js";
import { CONTEXT_COMPILER_CONFIG_V1, compileContextV1 } from "./context-compiler.js";

const occurredAt = "2026-08-21T01:02:03.004Z";

function compilerInput(): ContextCompilerInputV1 {
  return {
    version: "context_compiler_input_v1",
    invocation: {
      invocationId: "intent-1",
      executionId: "execution-1",
      roomId: "room-1",
      intent: {
        kind: "direct_mention",
        sourceMessageId: "message-1",
        targetAgentId: "agent-1",
        reasonCode: "direct_mention",
        reasonText: "Structured Agent mention",
      },
    },
    agent: {
      agentId: "agent-1",
      profileId: "profile-1",
      assignmentId: "assignment-1",
      displayName: "Build Agent",
      globalResponsibility: "Build engineering",
      roomResponsibility: "Own releases",
      participation: "on-mention",
      availability: "ready",
      effectiveCapabilities: ["room.conversation.read", "room.memory.read", "room.respond"],
      effectiveTools: [],
      revisions: { profile: 2, assignment: 3, access: 4 },
    },
    room: {
      roomId: "room-1",
      name: "Release Room",
      goal: { availability: "unavailable", reason: "ft09_not_delivered" },
    },
    trigger: {
      triggerType: "message",
      reason: "mention",
      source: { roomId: "room-1", sourceKind: "message", sourceId: "message-1", revision: 2, corpusSeq: 9 },
      body: "@Build Agent summarize release",
      author: { actorId: "human-1", kind: "human", displayName: "Leo" },
      occurredAt,
      replyTo: { sourceId: "message-0", revision: 1 },
      mentions: [{
        targetId: "target-1",
        targetKind: "agent-invocation",
        targetActorId: "agent-1",
        range: { startUtf16: 0, endUtf16: 12 },
      }],
      readRef: "read:message-1",
    },
    memoryWatermark: 9,
    corpusHead: 9,
    memories: [{
      kind: "decision",
      memoryRecordId: "memory-record-1",
      memoryVersionId: "memory-version-2",
      version: 2,
      body: "Two reviewers are required.",
      sourceRefs: [{
        roomId: "room-1", sourceKind: "message", sourceId: "message-0", revision: 1, corpusSeq: 8,
      }],
      availability: "readable",
    }],
    delta: [],
    retrieval: [],
    attachments: [],
    project: { availability: "disabled", reason: "ft09_not_delivered" },
    tools: [{
      id: "room-memory.read",
      description: "Read a manifest-authorized source.",
      effect: "read-only",
      inputSchemaCanonical: "{}",
    }],
    trusted: {
      system: "Follow server authority.",
      developerPolicy: "Cite only manifest labels.",
    },
  };
}

describe("compiled context to Provider adapter", () => {
  it("preserves closed identity/source semantics and emits no legacy conversation window", () => {
    const compilerConfig = {
      ...CONTEXT_COMPILER_CONFIG_V1,
      modelId: "configured-model",
    };
    const result = compileContextV1(compilerInput(), compilerConfig);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const provider = buildCompiledProviderEnvelopeV1({
      result,
      compilerConfig,
      snapshotId: "snapshot-1",
      snapshotGeneration: 1,
      invocation: {
        kind: "direct_mention", roomId: "room-1", sourceMessageId: "message-1", targetAgentId: "agent-1",
      },
      availableTools: [{
        id: "room-memory.read", displayName: "Read Room memory source",
        effect: "read-only", reversibility: "compensatable",
      }],
      openItemTargets: [{ actorId: "human-1", kind: "human" }],
      committedSteps: [],
      timeoutMs: 5_000,
    });

    expect(isCompiledProviderEnvelopeV1(provider)).toBe(true);
    expect(provider.snapshot.manifestHash).toBe(result.manifest.manifestHash);
    expect(provider.groupContent[0]).toMatchObject({
      kind: "trigger",
      speaker: { actorId: "human-1", kind: "human" },
      serverTime: occurredAt,
      replyTo: { messageId: "message-0", revision: 1 },
      mentions: [{
        startUtf16: 0, endUtf16: 12,
        targetKind: "agent-invocation", targetActorId: "agent-1",
      }],
    });
    expect(provider.groupContent.find((group) => group.kind === "memory")).toMatchObject({
      memoryKind: "decision",
      source: { kind: "memory", revision: 2 },
    });
    expect(provider.projectContext).toEqual({ status: "disabled", reason: "ft09_not_delivered" });
    expect(JSON.stringify(provider)).not.toContain("visibleConversation");
  });

  it("rejects a compile result whose canonical evidence no longer verifies", () => {
    const result = compileContextV1(compilerInput(), CONTEXT_COMPILER_CONFIG_V1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => buildCompiledProviderEnvelopeV1({
      result: { ...result, envelopeSha256: "0".repeat(64) },
      compilerConfig: CONTEXT_COMPILER_CONFIG_V1,
      snapshotId: "snapshot-1",
      snapshotGeneration: 1,
      invocation: {
        kind: "direct_mention", roomId: "room-1", sourceMessageId: "message-1", targetAgentId: "agent-1",
      },
      availableTools: [{
        id: "room-memory.read", displayName: "Read Room memory source",
        effect: "read-only", reversibility: "compensatable",
      }],
      openItemTargets: [],
      committedSteps: [],
      timeoutMs: 5_000,
    })).toThrow(/verified/u);
  });
});
