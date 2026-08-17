import { describe, expect, it, vi } from "vitest";
import type { RuntimeAuthority, ToolAdapter } from "./contracts.js";
import { AgentRuntimeError } from "./contracts.js";
import { createToolGateway } from "./tool-gateway.js";

function authority(claimTool: RuntimeAuthority["claimTool"]): RuntimeAuthority {
  return {
    readContext: vi.fn(),
    claimTool,
    settleTool: vi.fn(async () => undefined),
  } as unknown as RuntimeAuthority;
}

describe("tool gateway authority fence", () => {
  it.each([
    "capability_actor",
    "inactive_membership",
    "membership_permission",
    "execution_attempt",
    "tool_id",
    "parameter_hash",
    "grant_expired",
    "confirmation_principal",
    "confirmation_family",
    "confirmation_room",
    "confirmation_replay",
  ])("does not call an adapter when %s is rejected", async (reason) => {
    const execute = vi.fn();
    const adapter: ToolAdapter = {
      descriptor: { id: "sandbox-file.write", displayName: "write", effect: "side-effecting", reversibility: "compensatable" },
      execute,
    };
    const gateway = createToolGateway({
      authority: authority(async () => {
        throw new AgentRuntimeError("permission_denied", `closed:${reason}`);
      }),
      adapters: [adapter],
    });

    await expect(gateway.execute({
      executionId: "execution-1",
      attemptSeq: 1,
      roomId: "room-1",
      agentId: "agent-1",
      grantId: "grant-1",
      toolId: "sandbox-file.write",
      parameters: { path: "x", content: "y" },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("records outcome_unknown without replay when a dispatched side effect is ambiguous", async () => {
    const execute = vi.fn(async () => {
      throw new Error("ambiguous adapter error");
    });
    const runtimeAuthority = authority(async () => ({
      dispatchId: "dispatch-1",
      toolId: "sandbox-file.write",
      parameters: { path: "x", content: "y" },
    }));
    const gateway = createToolGateway({
      authority: runtimeAuthority,
      adapters: [{
        descriptor: { id: "sandbox-file.write", displayName: "write", effect: "side-effecting", reversibility: "compensatable" },
        execute,
      }],
    });

    await expect(gateway.execute({
      executionId: "execution-1",
      attemptSeq: 1,
      roomId: "room-1",
      agentId: "agent-1",
      grantId: "grant-1",
      toolId: "sandbox-file.write",
      parameters: { path: "x", content: "y" },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "side_effect_outcome_unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(runtimeAuthority.settleTool).toHaveBeenCalledWith(
      "dispatch-1", "outcome_unknown", { outcome: "unknown" },
    );
  });
});
