import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeProviderInput } from "./contracts.js";
import {
  createEnvironmentSecretProvider,
  createOpenAiResponsesProvider,
} from "./provider-openai.js";

const enabled =
  process.env.NATIVE_IM_OPENAI_LIVE_SMOKE === "1" &&
  typeof process.env.OPENAI_API_KEY === "string" &&
  process.env.OPENAI_API_KEY.length > 0;

function scanRollingNeedle(
  tail: string,
  chunk: string,
  needle: string,
): { readonly found: boolean; readonly tail: string } {
  if (needle.length === 0) {
    return { found: false, tail: "" };
  }
  const combined = `${tail}${chunk}`;
  return {
    found: combined.includes(needle),
    tail: combined.slice(-needle.length),
  };
}

describe("live smoke rolling scanner", () => {
  it("detects a needle at the beginning of a large single chunk", () => {
    const needle = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    expect(
      scanRollingNeedle("", `${needle}${"x".repeat(needle.length * 3)}`, needle)
        .found,
    ).toBe(true);
  });

  it("detects a needle split across adjacent chunks", () => {
    const needle = "nonce-0123456789";
    const first = scanRollingNeedle("", "prefix-nonce-012", needle);
    const second = scanRollingNeedle(first.tail, "3456789-suffix", needle);
    expect(second.found).toBe(true);
  });
});

describe.skipIf(!enabled)(
  "OpenAI Responses live smoke (requires NATIVE_IM_OPENAI_LIVE_SMOKE=1 and OPENAI_API_KEY)",
  () => {
    it("streams a non-fixture response without retaining text or exposing the secret", async () => {
      const nonce = randomUUID();
      const input: AgentRuntimeProviderInput = {
        purpose: "agent_runtime",
        invocation: {
          sourceMessageId: `live-${nonce}`,
          requesterActorId: "live-human",
          targetAgentId: "live-agent",
          intentKind: "direct_mention",
        },
        visibleConversation: [
          {
            messageId: `live-${nonce}`,
            actorId: "live-human",
            body: `Reply with one short plain-text sentence about reliable collaboration and include this exact nonce: ${nonce}`,
          },
        ],
        availableTools: [],
        committedSteps: [],
        limits: {
          maxInputBytes: 8_192,
          maxOutputBytes: 8_192,
          maxToolCalls: 1,
        },
      };
      const provider = createOpenAiResponsesProvider({
        endpoint:
          process.env.NATIVE_IM_OPENAI_ENDPOINT ??
          "https://api.openai.com/v1/responses",
        model: process.env.NATIVE_IM_OPENAI_MODEL ?? "gpt-5-mini",
        secretEnvironmentKey: "OPENAI_API_KEY",
        secretProvider: createEnvironmentSecretProvider(),
      });
      const hash = createHash("sha256");
      let outputBytes = 0;
      let started = 0;
      let completed = 0;
      let deltas = 0;
      let nonceSeen = false;
      let rollingTail = "";
      let secretTail = "";
      let secretLeakDetected = false;
      const safeEventShapes: string[] = [];
      const secret = process.env.OPENAI_API_KEY ?? "";

      try {
        for await (const event of provider.stream(input, new AbortController().signal)) {
          const safeShape = JSON.stringify(
            event.type === "usage"
              ? {
                  type: event.type,
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                }
              : { type: event.type },
          );
          secretLeakDetected ||= safeShape.includes(secret);
          safeEventShapes.push(safeShape);
          if (event.type === "response_started") {
            started += 1;
          } else if (event.type === "text_delta") {
            const bytes = Buffer.from(event.delta, "utf8");
            hash.update(bytes);
            outputBytes += bytes.byteLength;
            deltas += 1;
            const nonceScan = scanRollingNeedle(rollingTail, event.delta, nonce);
            rollingTail = nonceScan.tail;
            nonceSeen ||= nonceScan.found;
            const secretScan = scanRollingNeedle(secretTail, event.delta, secret);
            secretTail = secretScan.tail;
            secretLeakDetected ||= secretScan.found;
          } else if (event.type === "completed") {
            completed += 1;
            expect(event.finishReason).toBe("stop");
          }
        }
      } catch (error) {
        secretLeakDetected ||=
          String(error).includes(secret) || JSON.stringify(error).includes(secret);
        expect(secretLeakDetected).toBe(false);
        throw error;
      }

      const outputHash = hash.digest("hex");
      expect(started).toBe(1);
      expect(completed).toBe(1);
      expect(deltas).toBeGreaterThan(0);
      expect(outputBytes).toBeGreaterThan(0);
      expect(nonceSeen).toBe(true);
      expect(outputHash).toMatch(/^[a-f0-9]{64}$/);
      expect(outputHash).not.toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      secretLeakDetected ||= safeEventShapes.join("\n").includes(secret);
      expect(secretLeakDetected).toBe(false);
    }, 30_000);
  },
);
