import { describe, expect, it } from "vitest";
import { AgentRuntimeError } from "./contracts.js";
import { parseAgentFinalDraftV1 } from "./provider-final.js";

describe("AgentFinalDraftV1", () => {
  it("accepts only exact body and citation declarations", () => {
    expect(parseAgentFinalDraftV1(JSON.stringify({ body: "answer", citations: ["source-2", "source-1"] })))
      .toEqual({ body: "answer", citations: ["source-2", "source-1"] });
  });

  it.each([
    "plain text",
    JSON.stringify({ body: "answer" }),
    JSON.stringify({ body: "answer", citations: [], sourceId: "forged" }),
    JSON.stringify({ body: "", citations: [] }),
    JSON.stringify({ body: "answer", citations: [""] }),
    JSON.stringify({ body: "answer", citations: Array.from({ length: 129 }, (_, index) => `s-${index}`) }),
  ])("rejects malformed or expanded output without exposing its contents", (raw) => {
    let thrown: unknown;
    try {
      parseAgentFinalDraftV1(raw);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentRuntimeError);
    expect(thrown).toMatchObject({ code: "provider_malformed" });
    expect(String(thrown)).not.toContain(raw);
  });
});
