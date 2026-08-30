import { describe, expect, it, vi } from "vitest";
import type { RuntimeAuthority, ToolAdapter } from "./contracts.js";
import { AgentRuntimeError } from "./contracts.js";
import { RoomMemoryReadError, type RoomMemoryReadToolAdapter } from "./room-memory-read-tool.js";
import { createToolGateway } from "./tool-gateway.js";
import {
  TOOL_DISPATCH_REJECTION_REASONS,
  createToolSafetyGateway,
  type ToolSafetyAdapter,
  type ToolSafetyAuthority,
  type ToolSafetyGatewayExecutionInput,
} from "./tool-gateway.js";

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
      callId: "call-1",
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
      callId: "call-1",
      grantId: "grant-1",
      toolId: "sandbox-file.write",
      parameters: { path: "x", content: "y" },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "side_effect_outcome_unknown" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      callId: "call-1",
      grantId: "grant-1",
      dispatchId: "dispatch-1",
      toolId: "sandbox-file.write",
    }));
    expect(runtimeAuthority.settleTool).toHaveBeenCalledWith(
      "dispatch-1", "outcome_unknown", { outcome: "unknown" },
    );
  });

  it("keeps a room-memory claim rejection before the source adapter", async () => {
    const execute = vi.fn();
    const adapter: RoomMemoryReadToolAdapter = {
      descriptor: {
        id: "room-memory.read", displayName: "read source", effect: "read-only", reversibility: "compensatable",
      },
      execute,
    };
    const gateway = createToolGateway({
      authority: authority(async () => {
        throw new AgentRuntimeError("permission_denied", "closed source permission");
      }),
      adapters: [adapter],
    });
    await expect(gateway.execute({
      executionId: "execution-1", attemptSeq: 1, roomId: "room-1", agentId: "agent-1",
      callId: "call-room-memory",
      grantId: "grant-1", toolId: "room-memory.read",
      parameters: { snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source" },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("settles a dispatched read failure while preserving its closed status", async () => {
    const execute = vi.fn(async () => {
      throw new RoomMemoryReadError(410, "source_gone");
    });
    const runtimeAuthority = authority((async () => ({
      dispatchId: "dispatch-room-memory",
      toolId: "room-memory.read",
      parameters: { snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source" },
    })) as unknown as RuntimeAuthority["claimTool"]);
    const gateway = createToolGateway({
      authority: runtimeAuthority,
      adapters: [{
        descriptor: {
          id: "room-memory.read", displayName: "read source", effect: "read-only", reversibility: "compensatable",
        },
        execute,
      }],
    });
    await expect(gateway.execute({
      executionId: "execution-1", attemptSeq: 1, roomId: "room-1", agentId: "agent-1",
      callId: "call-room-memory",
      grantId: "grant-1", toolId: "room-memory.read",
      parameters: { snapshotId: "snapshot-1", sourceLabel: "source-1", mode: "source" },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 410, code: "context_source_gone" });
    expect(runtimeAuthority.settleTool).toHaveBeenCalledWith(
      "dispatch-room-memory", "failed", { outcome: "failed" },
    );
  });
});

const safetyInput: ToolSafetyGatewayExecutionInput = Object.freeze({
  toolCallId: "tool-call-1",
  invocationId: "invocation-1",
  executionId: "execution-1",
  attemptSeq: 2,
  expectedExecutionVersion: 7,
  roomId: "room-1",
  agentId: "agent-1",
  grantId: "grant-1",
  toolId: "sandbox-file.write",
  canonicalParameterSha256: "a".repeat(64),
  canonicalizerVersion: "rfc8785-ft10-v1",
  sourceSnapshotId: "snapshot-1",
  expectedAccessRevision: 9,
  expectedRoomLifecycleGeneration: 2,
  profileId: "profile-1",
  expectedProfileRevision: 4,
  assignmentId: "assignment-1",
  expectedAssignmentRevision: 6,
  principalActorId: "human-1",
  sessionFamilyId: "family-1",
  bindingGeneration: 1,
  signal: new AbortController().signal,
});

function safetyAdapters(sideEffectExecute = vi.fn<ToolSafetyAdapter["execute"]>()): readonly ToolSafetyAdapter[] {
  return [
    {
      descriptor: { id: "http-json.read", effect: "read-only" },
      execute: vi.fn(async () => ({
        state: "known_succeeded", summary: { status: "ok" }, modelInput: "{}",
      })),
    },
    {
      descriptor: { id: "repository.git-status", effect: "read-only" },
      execute: vi.fn(async () => ({
        state: "known_succeeded", summary: { status: "ok" }, modelInput: "",
      })),
    },
    {
      descriptor: { id: "sandbox-file.write", effect: "side-effect" },
      execute: sideEffectExecute,
    },
  ];
}

describe("FT-10 tool safety gateway", () => {
  it("fails startup closed for an incomplete physical adapter catalog", () => {
    const execute = vi.fn<ToolSafetyAdapter["execute"]>();
    expect(() => createToolSafetyGateway({
      authority: { claimDispatch: vi.fn(), settleDispatch: vi.fn() },
      adapters: safetyAdapters(execute).slice(0, 2),
    })).toThrow(TypeError);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(TOOL_DISPATCH_REJECTION_REASONS)(
    "keeps the adapter at zero when claim authority rejects %s",
    async (reason) => {
      const execute = vi.fn<ToolSafetyAdapter["execute"]>();
      const authority: ToolSafetyAuthority = {
        claimDispatch: vi.fn(async () => ({ kind: "rejected", reason })),
        settleDispatch: vi.fn(async () => undefined),
      };
      const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

      await expect(gateway.execute(safetyInput)).rejects.toBeInstanceOf(AgentRuntimeError);
      expect(execute).not.toHaveBeenCalled();
      expect(authority.settleDispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["claimed", "dispatched", "outcome_unknown"] as const)(
    "does not issue a permit or replay an adapter for durable %s",
    async (state) => {
      const execute = vi.fn<ToolSafetyAdapter["execute"]>();
      const authority: ToolSafetyAuthority = {
        claimDispatch: vi.fn(async () => ({ kind: "not_replayable", state, dispatchId: "dispatch-1" })),
        settleDispatch: vi.fn(async () => undefined),
      };
      const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

      await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
        code: "side_effect_outcome_unknown",
      });
      expect(execute).not.toHaveBeenCalled();
      expect(authority.settleDispatch).not.toHaveBeenCalled();
    },
  );

  it("claims before the adapter, consumes a process-local permit once, and settles a typed success", async () => {
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("adapter");
      return {
        state: "known_succeeded" as const,
        summary: { byteCount: 7 },
        modelInput: "written",
      };
    });
    const authority: ToolSafetyAuthority = {
      claimDispatch: vi.fn(async () => {
        order.push("claim-committed");
        return {
          kind: "claimed" as const,
          dispatchId: "dispatch-1",
          toolId: "sandbox-file.write" as const,
          parameters: { path: "notes/a.txt", content: "bounded" },
        };
      }),
      settleDispatch: vi.fn(async (input) => {
        order.push(`settle:${input.state}`);
      }),
    };
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

    await expect(gateway.execute(safetyInput)).resolves.toMatchObject({ modelInput: "written" });
    expect(order).toEqual(["claim-committed", "adapter", "settle:known_succeeded"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authority.settleDispatch).toHaveBeenCalledWith({
      dispatchId: "dispatch-1",
      state: "known_succeeded",
      summary: { byteCount: 7 },
    });
    expect(authority.claimDispatch).toHaveBeenCalledWith(expect.not.objectContaining({ signal: expect.anything() }));
  });

  it("settles typed known_failed without guessing from a throw", async () => {
    const execute = vi.fn(async () => ({
      state: "known_failed" as const,
      errorCode: "execution_conflict" as const,
      summary: { outcome: "precondition_failed" },
    }));
    const authority: ToolSafetyAuthority = {
      claimDispatch: vi.fn(async () => ({
        kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "bounded" },
      })),
      settleDispatch: vi.fn(async () => undefined),
    };
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({ code: "execution_conflict" });
    expect(authority.settleDispatch).toHaveBeenCalledWith({
      dispatchId: "dispatch-1", state: "known_failed",
      summary: { outcome: "precondition_failed" },
    });
  });

  it.each([
    ["typed ambiguous", async () => ({ state: "ambiguous" as const, summary: { outcome: "unknown" } })],
    ["unexpected adapter throw", async () => { throw new Error("lost physical truth"); }],
  ] as const)("settles outcome_unknown for %s and never retries the same dispatch", async (_label, run) => {
    const execute = vi.fn(run);
    const authority: ToolSafetyAuthority = {
      claimDispatch: vi.fn(async () => ({
        kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "bounded" },
      })),
      settleDispatch: vi.fn(async () => undefined),
    };
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
      code: "side_effect_outcome_unknown",
    });
    await expect(gateway.execute(safetyInput)).rejects.toBeInstanceOf(AgentRuntimeError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authority.settleDispatch).toHaveBeenCalledWith({
      dispatchId: "dispatch-1", state: "outcome_unknown", summary: { outcome: "unknown" },
    });
  });

  it("treats a malformed adapter result as ambiguous and never exposes its shape", async () => {
    const execute = vi.fn(async () => null as never);
    const authority: ToolSafetyAuthority = {
      claimDispatch: vi.fn(async () => ({
        kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "bounded" },
      })),
      settleDispatch: vi.fn(async () => undefined),
    };
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
      code: "side_effect_outcome_unknown",
    });
    expect(authority.settleDispatch).toHaveBeenCalledWith({
      dispatchId: "dispatch-1", state: "outcome_unknown", summary: { outcome: "unknown" },
    });
  });

  it("does not retry after a side-effect settle acknowledgement is lost", async () => {
    const execute = vi.fn(async () => ({
      state: "known_succeeded" as const, summary: { byteCount: 7 }, modelInput: "written",
    }));
    const authority: ToolSafetyAuthority = {
      claimDispatch: vi.fn(async () => ({
        kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "bounded" },
      })),
      settleDispatch: vi.fn(async () => { throw new Error("ack lost"); }),
    };
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
      code: "side_effect_outcome_unknown",
    });
    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({ code: "execution_conflict" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fails closed before claim when shutdown has started", async () => {
    const execute = vi.fn<ToolSafetyAdapter["execute"]>();
    const authority: ToolSafetyAuthority = {
      claimDispatch: vi.fn(), settleDispatch: vi.fn(),
    };
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });
    await gateway.close();

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({ code: "agent_runtime_closed" });
    expect(authority.claimDispatch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
