// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentExecution, ToolDescriptor } from "@native-im/core";
import type {
  ContextAuthorityWorkerDatabaseClient,
  WorkerDatabaseClient,
} from "../persistence/worker-database-client.js";
import { canonicalJsonV1 } from "../context-compiler/canonical-json.js";
import { createWorkerRuntimeAuthority } from "./worker-runtime-authority.js";

const execution: AgentExecution = Object.freeze({
  id: "execution-context", roomId: "room-context", sourceMessageId: "message-trigger",
  requesterId: "human-1", agentId: "agent-context", toolName: "model.generate",
  status: "running", actionCategory: "model_generation", currentAttemptSeq: 1,
  retryCycle: 1, retryOrdinal: 1, providerId: "openai-responses", modelId: "model-1",
  recoveryCursor: 0, queuedAt: "2026-08-21T00:00:00.000Z",
  startedAt: "2026-08-21T00:00:01.000Z", updatedAt: "2026-08-21T00:00:01.000Z",
});

const sourceTool: ToolDescriptor = Object.freeze({
  id: "room-memory.read", displayName: "Read source", effect: "read-only",
  reversibility: "compensatable",
});

function contextPreparation() {
  return {
    kind: "context-preparation",
    disposition: "existing",
    preparation: {
      executionGeneration: 1,
      invocationIntentId: "intent-context",
      agentId: execution.agentId,
      roomId: execution.roomId,
    },
    snapshot: { snapshotId: "snapshot-context", snapshotGeneration: 1 },
  } as const;
}

describe("worker runtime context authority composition", () => {
  it("mints and dispatches a source grant bound to the canonical provider call", async () => {
    const runtimeOperations: unknown[] = [];
    const contextOperations: Record<string, unknown>[] = [];
    const worker = {
      executeRuntime: vi.fn(async (operation: Record<string, unknown>) => {
        runtimeOperations.push(operation);
        if (operation.type === "runtime.claim") return { kind: "execution", execution };
        throw new Error(`unexpected runtime operation ${String(operation.type)}`);
      }),
    } as unknown as WorkerDatabaseClient;
    const contextWorker = {
      executeContext: vi.fn(async (operation: Record<string, unknown>) => {
        contextOperations.push(operation);
        if (operation.type === "context.prepare") return contextPreparation();
        if (operation.type === "context.source-read-grant") {
          return { kind: "context-source-read-grant", grantId: operation.grantId };
        }
        if (operation.type === "context.source-read-dispatch") {
          return { kind: "context-source-read-dispatch", dispatchId: operation.dispatchId };
        }
        throw new Error(`unexpected context operation ${String(operation.type)}`);
      }),
    } as unknown as ContextAuthorityWorkerDatabaseClient;
    const authority = createWorkerRuntimeAuthority(worker, { contextWorker });
    await authority.claim(execution.id, 1);
    const parameters = {
      snapshotId: "snapshot-context", sourceLabel: "source:one", mode: "source",
    } as const;

    const prepared = await authority.prepareTool(
      execution.id, 1, sourceTool, parameters, undefined,
      { callId: "call-source", argumentsJson: JSON.stringify(parameters) },
    );
    const dispatched = await authority.claimTool(
      execution.id, 1, prepared.grantId, parameters, undefined, { callId: "call-source" },
    );
    await authority.settleTool(dispatched.dispatchId, "succeeded", { outcome: "succeeded" });

    const parameterSha256 = createHash("sha256")
      .update(canonicalJsonV1(parameters), "utf8").digest("hex");
    expect(contextOperations.map((operation) => operation.type)).toEqual([
      "context.prepare", "context.source-read-grant", "context.source-read-dispatch",
    ]);
    expect(contextOperations[1]).toMatchObject({ parameterSha256 });
    expect(contextOperations[2]).toMatchObject({ callId: "call-source", parameterSha256 });
    expect(dispatched).toMatchObject({ toolId: "room-memory.read", parameters });
    expect(runtimeOperations).toHaveLength(1);
  });

  it("forgets an in-process source grant after a failed dispatch", async () => {
    const worker = {
      executeRuntime: vi.fn(async (operation: Record<string, unknown>) => {
        if (operation.type === "runtime.claim") return { kind: "execution", execution };
        if (operation.type === "runtime.claim-tool") {
          return {
            kind: "claimed-tool", dispatchId: "fallback-dispatch",
            toolId: "room-memory.read", parameters: operation.parameters,
          };
        }
        throw new Error(`unexpected runtime operation ${String(operation.type)}`);
      }),
    } as unknown as WorkerDatabaseClient;
    const contextWorker = {
      executeContext: vi.fn(async (operation: Record<string, unknown>) => {
        if (operation.type === "context.prepare") return contextPreparation();
        if (operation.type === "context.source-read-grant") {
          return { kind: "context-source-read-grant", grantId: operation.grantId };
        }
        if (operation.type === "context.source-read-dispatch") {
          throw new Error("temporary context authority failure");
        }
        throw new Error(`unexpected context operation ${String(operation.type)}`);
      }),
    } as unknown as ContextAuthorityWorkerDatabaseClient;
    const authority = createWorkerRuntimeAuthority(worker, { contextWorker });
    await authority.claim(execution.id, 1);
    const parameters = {
      snapshotId: "snapshot-context", sourceLabel: "source:one", mode: "source",
    } as const;
    const prepared = await authority.prepareTool(
      execution.id, 1, sourceTool, parameters, undefined,
      { callId: "call-source", argumentsJson: JSON.stringify(parameters) },
    );

    await expect(authority.claimTool(
      execution.id, 1, prepared.grantId, parameters, undefined, { callId: "call-source" },
    )).rejects.toMatchObject({ code: "provider_failure" });
    await expect(authority.claimTool(
      execution.id, 1, prepared.grantId, parameters, undefined, { callId: "call-source" },
    )).resolves.toMatchObject({ dispatchId: "fallback-dispatch" });
    expect(contextWorker.executeContext).toHaveBeenCalledTimes(3);
    expect(worker.executeRuntime).toHaveBeenCalledTimes(2);
  });

  it("atomically finalizes the Agent message with the active snapshot and citations", async () => {
    const operations: Record<string, unknown>[] = [];
    const worker = {
      executeRuntime: vi.fn(async () => ({ kind: "execution", execution })),
    } as unknown as WorkerDatabaseClient;
    const contextWorker = {
      executeContext: vi.fn(async (operation: Record<string, unknown>) => {
        operations.push(operation);
        if (operation.type === "context.prepare") return contextPreparation();
        if (operation.type === "context.finalize-agent-message") {
          return {
            kind: "context-finalized",
            execution: {
              ...execution, status: "completed", completedAt: "2026-08-21T00:00:02.000Z",
              resultMessageId: "message-agent-final",
            },
          };
        }
        throw new Error("unexpected operation");
      }),
    } as unknown as ContextAuthorityWorkerDatabaseClient;
    const authority = createWorkerRuntimeAuthority(worker, { contextWorker });
    await authority.claim(execution.id, 1);

    const result = await authority.complete(
      execution.id, 1, "answer", [`read:${Buffer.alloc(32, 7).toString("base64url")}`],
    );

    expect(result.status).toBe("completed");
    expect(operations[1]).toMatchObject({
      type: "context.finalize-agent-message",
      context: {
        invocationIntentId: "intent-context", executionId: execution.id,
        executionGeneration: 1,
      },
      command: { roomId: execution.roomId, body: "answer" },
      snapshotId: "snapshot-context", snapshotGeneration: 1,
    });
    expect(worker.executeRuntime).toHaveBeenCalledTimes(1);
  });
});
