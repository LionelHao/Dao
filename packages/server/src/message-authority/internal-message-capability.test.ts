import { describe, expect, it } from "vitest";
import {
  isInternalAgentMessageCommitContext,
  mintInternalAgentMessageCommitContext,
  toAgentMessageWorkerContext,
} from "./internal-message-capability.js";

const input = {
  agentActorId: "agent-1",
  invocationIntentId: "intent-1",
  executionId: "execution-1",
  attemptSeq: 2,
  executionGeneration: 3,
} as const;

describe("internal Agent message commit capability", () => {
  it("mints one opaque immutable authority context and explicitly lowers it for the worker", () => {
    const context = mintInternalAgentMessageCommitContext(input);

    expect(isInternalAgentMessageCommitContext(context)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.agent)).toBe(true);
    expect(toAgentMessageWorkerContext(context)).toEqual({
      kind: "agent-message",
      agent: { actorId: "agent-1", kind: "agent" },
      invocationIntentId: "intent-1",
      executionId: "execution-1",
      attemptSeq: 2,
      executionGeneration: 3,
    });
  });

  it("rejects structurally identical forgeries and serialized clones", () => {
    const context = mintInternalAgentMessageCommitContext(input);
    const forged = {
      kind: "agent-message",
      agent: { actorId: "agent-1", kind: "agent" },
      invocationIntentId: "intent-1",
      executionId: "execution-1",
      attemptSeq: 2,
      executionGeneration: 3,
    };
    const serializedClone = JSON.parse(JSON.stringify(context)) as unknown;

    expect(isInternalAgentMessageCommitContext(forged)).toBe(false);
    expect(isInternalAgentMessageCommitContext(serializedClone)).toBe(false);
    expect(() => toAgentMessageWorkerContext(forged as never)).toThrowError(
      /agent_message_capability_forbidden/,
    );
    expect(() => toAgentMessageWorkerContext(serializedClone as never)).toThrowError(
      /agent_message_capability_forbidden/,
    );
  });

  it.each([
    { ...input, agentActorId: "" },
    { ...input, invocationIntentId: " " },
    { ...input, executionId: "" },
    { ...input, attemptSeq: 0 },
    { ...input, attemptSeq: 1.5 },
    { ...input, executionGeneration: 0 },
    { ...input, executionGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, capability: "forged" },
  ])("rejects invalid binding input %#", (candidate) => {
    expect(() => mintInternalAgentMessageCommitContext(candidate)).toThrow(TypeError);
  });
});
