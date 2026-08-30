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
  type ToolDispatchClaimInput,
  type ToolDispatchClaimResult,
  type ToolSafetyGatewayExecutionInput,
} from "./tool-gateway.js";
import { createDispatchPermitAuthority } from "./dispatch-permit.js";

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

type UnpermittedClaim = Exclude<ToolDispatchClaimResult, { kind: "claimed" }> |
  Omit<Extract<ToolDispatchClaimResult, { kind: "claimed" }>, "permit" | "permitBinding">;

function safetyAuthority(
  claim: (input: ToolDispatchClaimInput) => Promise<UnpermittedClaim>,
  settleDispatch = vi.fn<ToolSafetyAuthority["settleDispatch"]>(async () => undefined),
): ToolSafetyAuthority {
  const permits = createDispatchPermitAuthority();
  const grantedDispatches = new Set<string>();
  return {
    claimDispatch: vi.fn(async (input) => {
      const result = await claim(input);
      if (result.kind !== "claimed") return result;
      if (grantedDispatches.has(result.dispatchId)) {
        return { kind: "not_replayable" as const, state: "claimed" as const, dispatchId: result.dispatchId };
      }
      grantedDispatches.add(result.dispatchId);
      const binding = Object.freeze({
        dispatchId: result.dispatchId,
        grantId: input.grantId,
        toolCallId: input.toolCallId,
        invocationId: input.invocationId,
        executionId: input.executionId,
        attemptSeq: input.attemptSeq,
        executionVersion: input.expectedExecutionVersion,
        roomId: input.roomId,
        agentId: input.agentId,
        toolId: input.toolId,
        canonicalParameterSha256: input.canonicalParameterSha256,
        canonicalizerVersion: input.canonicalizerVersion,
        sourceSnapshotId: input.sourceSnapshotId,
        accessRevision: input.expectedAccessRevision,
        roomLifecycleGeneration: input.expectedRoomLifecycleGeneration,
        profileId: input.profileId,
        profileRevision: input.expectedProfileRevision,
        assignmentId: input.assignmentId,
        assignmentRevision: input.expectedAssignmentRevision,
        ...(input.principalActorId === undefined ? {} : { principalActorId: input.principalActorId }),
        ...(input.sessionFamilyId === undefined ? {} : { sessionFamilyId: input.sessionFamilyId }),
        ...(input.bindingGeneration === undefined ? {} : { bindingGeneration: input.bindingGeneration }),
      });
      return Object.freeze({ ...result, ...permits.grantAfterCommittedClaim(binding) });
    }),
    consumeDispatchPermit: (permit, expected) => permits.consumeCommittedClaim(permit, expected),
    settleDispatch,
  };
}

describe("FT-10 tool safety gateway", () => {
  it("fails startup closed for an incomplete physical adapter catalog", () => {
    const execute = vi.fn<ToolSafetyAdapter["execute"]>();
    expect(() => createToolSafetyGateway({
      authority: {
        claimDispatch: vi.fn(), consumeDispatchPermit: vi.fn(), settleDispatch: vi.fn(),
      },
      adapters: safetyAdapters(execute).slice(0, 2),
    })).toThrow(TypeError);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(TOOL_DISPATCH_REJECTION_REASONS)(
    "keeps the adapter at zero when claim authority rejects %s",
    async (reason) => {
      const execute = vi.fn<ToolSafetyAdapter["execute"]>();
      const authority = safetyAuthority(async () => ({ kind: "rejected", reason }));
      const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

      await expect(gateway.execute(safetyInput)).rejects.toBeInstanceOf(AgentRuntimeError);
      expect(execute).not.toHaveBeenCalled();
      expect(authority.settleDispatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "claimed", "dispatched", "known_succeeded", "known_failed", "outcome_unknown", "reviewed",
  ] as const)(
    "does not issue a permit or replay an adapter for durable %s",
    async (state) => {
      const execute = vi.fn<ToolSafetyAdapter["execute"]>();
      const authority = safetyAuthority(async () => ({
        kind: "not_replayable", state, dispatchId: "dispatch-1",
      }));
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
    const authority = safetyAuthority(
      async () => {
        order.push("claim-committed");
        return {
          kind: "claimed" as const,
          dispatchId: "dispatch-1",
          toolId: "sandbox-file.write" as const,
          parameters: { path: "notes/a.txt", content: "bounded" },
        };
      },
      vi.fn(async (input) => {
        order.push(`settle:${input.state}`);
      }),
    );
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

  it("rejects a forged claimed permit before the physical adapter boundary", async () => {
    const execute = vi.fn<ToolSafetyAdapter["execute"]>();
    const permits = createDispatchPermitAuthority();
    const forgedBinding = Object.freeze({
      dispatchId: "dispatch-forged", grantId: safetyInput.grantId,
      toolCallId: safetyInput.toolCallId, invocationId: safetyInput.invocationId,
      executionId: safetyInput.executionId, attemptSeq: safetyInput.attemptSeq,
      executionVersion: safetyInput.expectedExecutionVersion, roomId: safetyInput.roomId,
      agentId: safetyInput.agentId, toolId: safetyInput.toolId,
      canonicalParameterSha256: safetyInput.canonicalParameterSha256,
      canonicalizerVersion: safetyInput.canonicalizerVersion,
      sourceSnapshotId: safetyInput.sourceSnapshotId,
      accessRevision: safetyInput.expectedAccessRevision,
      roomLifecycleGeneration: safetyInput.expectedRoomLifecycleGeneration,
      profileId: safetyInput.profileId, profileRevision: safetyInput.expectedProfileRevision,
      assignmentId: safetyInput.assignmentId,
      assignmentRevision: safetyInput.expectedAssignmentRevision,
      principalActorId: safetyInput.principalActorId,
      sessionFamilyId: safetyInput.sessionFamilyId,
      bindingGeneration: safetyInput.bindingGeneration,
    });
    const authority: ToolSafetyAuthority = {
      claimDispatch: vi.fn(async () => ({
        kind: "claimed", dispatchId: "dispatch-forged", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "must-not-run" },
        permit: Object.freeze({}) as never,
        permitBinding: forgedBinding,
      })),
      consumeDispatchPermit: (permit, expected) =>
        permits.consumeCommittedClaim(permit, expected),
      settleDispatch: vi.fn(async () => undefined),
    };
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
      code: "side_effect_outcome_unknown",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(authority.settleDispatch).toHaveBeenCalledWith({
      dispatchId: "dispatch-forged", state: "outcome_unknown", summary: { outcome: "unknown" },
    });
  });

  it("conservatively retains capacity when a side-effect claim acknowledgement throws", async () => {
    const execute = vi.fn<ToolSafetyAdapter["execute"]>();
    const authority = safetyAuthority(async () => {
      throw new Error("claim acknowledgement lost");
    });
    const gateway = createToolSafetyGateway({
      authority, adapters: safetyAdapters(execute), dispatchCapacity: 1,
    });

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
      code: "side_effect_outcome_unknown",
    });
    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({ code: "tool_target_busy" });
    expect(authority.claimDispatch).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["shutdown", "abort"] as const)(
    "settles a committed claim as unknown without entering the adapter on %s race",
    async (race) => {
      const execute = vi.fn<ToolSafetyAdapter["execute"]>();
      let releaseClaim!: () => void;
      const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
      const authority = safetyAuthority(async () => {
        await claimGate;
        return {
          kind: "claimed", dispatchId: `dispatch-${race}`, toolId: "sandbox-file.write",
          parameters: { path: "notes/a.txt", content: "must-not-run" },
        };
      });
      const controller = new AbortController();
      const gateway = createToolSafetyGateway({
        authority, adapters: safetyAdapters(execute), shutdownWaitMs: 100,
      });
      const operation = gateway.execute({ ...safetyInput, signal: controller.signal });
      await vi.waitFor(() => expect(authority.claimDispatch).toHaveBeenCalledTimes(1));
      const close = race === "shutdown" ? gateway.close() : Promise.resolve();
      if (race === "abort") controller.abort("cancel-after-claim-started");
      releaseClaim();

      await expect(operation).rejects.toMatchObject({ code: "side_effect_outcome_unknown" });
      await close;
      expect(execute).not.toHaveBeenCalled();
      expect(authority.settleDispatch).toHaveBeenCalledWith({
        dispatchId: `dispatch-${race}`, state: "outcome_unknown", summary: { outcome: "unknown" },
      });
    },
  );

  it("commits unknown before aborting an adapter that is already running at shutdown", async () => {
    const order: string[] = [];
    let entered!: () => void;
    const adapterEntered = new Promise<void>((resolve) => { entered = resolve; });
    const execute = vi.fn<ToolSafetyAdapter["execute"]>(async ({ signal }) => {
      entered();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          order.push("adapter-aborted");
          reject(new Error("physical result is ambiguous"));
        }, { once: true });
      });
      throw new Error("unreachable");
    });
    const authority = safetyAuthority(
      async () => ({
        kind: "claimed", dispatchId: "dispatch-running-shutdown",
        toolId: "sandbox-file.write", parameters: { path: "a.txt", content: "bounded" },
      }),
      vi.fn(async (settlement) => {
        order.push(`settled:${settlement.state}`);
      }),
    );
    const gateway = createToolSafetyGateway({
      authority, adapters: safetyAdapters(execute), shutdownWaitMs: 100,
    });
    const operation = gateway.execute(safetyInput);
    await adapterEntered;

    await gateway.close();
    await expect(operation).rejects.toMatchObject({ code: "side_effect_outcome_unknown" });

    expect(order).toEqual(["settled:outcome_unknown", "adapter-aborted"]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authority.settleDispatch).toHaveBeenCalledTimes(1);
  });

  it("settles typed known_failed without guessing from a throw", async () => {
    const execute = vi.fn(async () => ({
      state: "known_failed" as const,
      errorCode: "execution_conflict" as const,
      summary: { outcome: "precondition_failed" },
    }));
    const authority = safetyAuthority(async () => ({
        kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "bounded" },
      }));
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
    const authority = safetyAuthority(async () => ({
        kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "bounded" },
      }));
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
    const authority = safetyAuthority(async () => ({
        kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
        parameters: { path: "notes/a.txt", content: "bounded" },
      }));
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
      code: "side_effect_outcome_unknown",
    });
    expect(authority.settleDispatch).toHaveBeenCalledWith({
      dispatchId: "dispatch-1", state: "outcome_unknown", summary: { outcome: "unknown" },
    });
  });

  it.each(["sync", "async"] as const)(
    "does not retry after a side-effect settle acknowledgement is lost by %s throw",
    async (throwKind) => {
      const execute = vi.fn(async () => ({
        state: "known_succeeded" as const, summary: { byteCount: 7 }, modelInput: "written",
      }));
      const authority = safetyAuthority(
        async () => ({
          kind: "claimed", dispatchId: "dispatch-1", toolId: "sandbox-file.write",
          parameters: { path: "notes/a.txt", content: "bounded" },
        }),
        vi.fn(() => {
          if (throwKind === "sync") throw new Error("ack lost");
          return Promise.reject(new Error("ack lost"));
        }),
      );
      const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });

      await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
        code: "side_effect_outcome_unknown",
      });
      await expect(gateway.execute(safetyInput)).rejects.toMatchObject({
        code: "side_effect_outcome_unknown",
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed before claim when shutdown has started", async () => {
    const execute = vi.fn<ToolSafetyAdapter["execute"]>();
    const authority = safetyAuthority(async () => ({
      kind: "rejected", reason: "shutdown",
    }));
    const gateway = createToolSafetyGateway({ authority, adapters: safetyAdapters(execute) });
    await gateway.close();

    await expect(gateway.execute(safetyInput)).rejects.toMatchObject({ code: "agent_runtime_closed" });
    expect(authority.claimDispatch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
