import { describe, expect, it } from "vitest";
import { parseGovernanceServerFrame } from "./websocket-authority.js";

describe("Invocation wire ACK decoder", () => {
  it("accepts a closed cancellation receipt only as commit evidence", () => {
    const frame = { type: "invocation.cancel.ack", requestId: "cancel-1", receipt: {
      kind: "scoped-cancellation-committed", fenceId: "fence-1", roomId: "room-1",
      producerId: "human-1", reason: "human_cancelled", replayed: true, effects: [{
        sourceMessageId: "message-1", sourceRevision: 1, invocationIntentId: "intent-1",
        executionId: "execution-1", attemptSeq: 1, disposition: "execution_cancelled",
        confirmationDisposition: "pending_rejected", grantDisposition: "claimed_retained",
        sideEffectState: "outcome-unknown-retained",
      }],
    } };
    expect(parseGovernanceServerFrame(JSON.stringify(frame))).toEqual({
      type: "invocation.cancel.ack", requestId: "cancel-1", replayed: true,
    });
    expect(parseGovernanceServerFrame(JSON.stringify({ ...frame, receipt: {
      ...frame.receipt, effects: [{ ...frame.receipt.effects[0], extra: "open" }],
    } }))).toBeUndefined();
  });
});
