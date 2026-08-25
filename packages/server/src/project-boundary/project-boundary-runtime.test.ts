import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeProviderInput, ProviderEvent } from "@native-im/core";
import { createProjectBoundaryRuntime } from "./project-boundary-runtime.js";

const checkpointProjectionJson = '{"goal":"ship"}';
const execution = Object.freeze({
  intentId: "intent-1", executionId: "execution-1", roomId: "room-1", projectId: "room-1",
  agentId: "agent-1", boundaryId: "boundary-1", boundaryKind: "due" as const,
  sourceKind: "next_action", sourceId: "action-1", sourceRevision: 2,
  lifecycleGeneration: 1, profileId: "profile-1", profileRevision: 3,
  assignmentId: "assignment-1", assignmentRevision: 4, accessRevision: 5,
  checkpointId: "checkpoint-1", checkpointRevision: 6,
  checkpointSha256: createHash("sha256").update(checkpointProjectionJson).digest("hex"),
  checkpointProjectionJson,
  providerId: "provider-1", modelId: "model-1", status: "accepted" as const, version: 1,
});

describe("Project boundary runtime", () => {
  it("runs one independent tool-free execution and discards the Agent final body", async () => {
    const operations: unknown[] = [];
    const authority = { executeRuntime: vi.fn(async (operation: Record<string, unknown>) => {
      operations.push(operation);
      if (operation.type === "runtime.scan-project-boundary-executions") {
        return { kind: "project-boundary-executions", records: [execution] };
      }
      if (operation.type === "runtime.begin-project-boundary-execution") {
        return { kind: "project-boundary-execution", execution: { ...execution,
          status: "running", version: 2 } };
      }
      return { kind: "project-boundary-execution", execution: { ...execution,
        status: "completed", version: 3 } };
    }) };
    let providerInput: AgentRuntimeProviderInput | undefined;
    const provider = { id: "provider-1", async *stream(input: AgentRuntimeProviderInput):
      AsyncIterable<ProviderEvent> {
      providerInput = input;
      yield { type: "agent_final", sequence: 1, body: "must not become a Project fact", citations: [] };
    } };
    const runtime = createProjectBoundaryRuntime({ authority, provider, now: () => 1_750_000_000_000 });
    await runtime.scan();
    expect(providerInput?.invocation).toEqual(expect.objectContaining({
      kind: "project_boundary", boundaryId: "boundary-1",
    }));
    expect(providerInput?.availableTools).toEqual([]);
    expect(operations.at(-1)).toEqual(expect.objectContaining({
      type: "runtime.finish-project-boundary-execution", outcome: "completed",
    }));
    expect(JSON.stringify(operations)).not.toContain("must not become a Project fact");
  });

  it("fails closed on a tool call and never creates another invocation", async () => {
    const operations: Record<string, unknown>[] = [];
    const authority = { executeRuntime: vi.fn(async (operation: Record<string, unknown>) => {
      operations.push(operation);
      if (operation.type === "runtime.scan-project-boundary-executions") {
        return { kind: "project-boundary-executions", records: [execution] };
      }
      if (operation.type === "runtime.begin-project-boundary-execution") {
        return { kind: "project-boundary-execution", execution: { ...execution,
          status: "running", version: 2 } };
      }
      return { kind: "project-boundary-execution", execution: { ...execution,
        status: "failed", version: 3 } };
    }) };
    const provider = { id: "provider-1", async *stream(): AsyncIterable<ProviderEvent> {
      yield { type: "tool_call_started", sequence: 1, callId: "call-1",
        toolName: "sandbox_file_write" };
    } };
    await createProjectBoundaryRuntime({ authority, provider }).scan();
    expect(operations.at(-1)).toEqual(expect.objectContaining({
      type: "runtime.finish-project-boundary-execution", outcome: "failed",
      errorCode: "provider_failure",
    }));
    expect(operations.filter((operation) => operation.type === "runtime.claim-project-boundary"))
      .toHaveLength(0);
  });

  it("settles a recovered running execution without invoking Provider", async () => {
    const stream = vi.fn(async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "completed", sequence: 1 };
    });
    const authority = { executeRuntime: vi.fn(async (operation: Record<string, unknown>) =>
      operation.type === "runtime.scan-project-boundary-executions"
        ? { kind: "project-boundary-executions", records: [{ ...execution,
            status: "running", version: 7 }] }
        : { kind: "project-boundary-execution", execution: { ...execution,
            status: "failed", version: 8 } }) };
    await createProjectBoundaryRuntime({ authority, provider: { id: "provider-1", stream } }).scan();
    expect(stream).not.toHaveBeenCalled();
    expect(authority.executeRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "runtime.finish-project-boundary-execution", errorCode: "runtime_restarted",
    }));
  });
});
