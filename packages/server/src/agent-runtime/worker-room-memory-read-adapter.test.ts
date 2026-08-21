// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ContextAuthorityWorkerDatabaseClient } from "../persistence/worker-database-client.js";
import { createWorkerRoomMemoryReadAdapter } from "./worker-room-memory-read-adapter.js";

const citationLabel = `read:${Buffer.alloc(32, 9).toString("base64url")}`;
const item = {
  ordinal: 1,
  text: "authoritative source text",
  provenance: {
    sourceKind: "message_revision",
    sourceLabel: "source:message-1:1",
    sourceRevision: 1,
  },
} as const;

function invocation(parameters: Readonly<Record<string, unknown>> = {
  snapshotId: "snapshot-1", sourceLabel: "source:message-1:1", mode: "source", pageSize: 1,
}) {
  return {
    executionId: "execution-1", attemptSeq: 1, roomId: "room-1", agentId: "agent-1",
    callId: "call-1", grantId: "grant-1", dispatchId: "dispatch-1",
    toolId: "room-memory.read" as const, parameters, signal: new AbortController().signal,
  };
}

describe("worker room-memory.read production adapter", () => {
  it("revalidates around the page and issues only the worker-bound opaque receipt", async () => {
    const operations: Record<string, unknown>[] = [];
    const canonicalResultJson = JSON.stringify({ items: [item], hasMore: false });
    const contentJson = JSON.stringify([item]);
    const worker = {
      executeContext: vi.fn(async (operation: Record<string, unknown>) => {
        operations.push(operation);
        if (operation.type === "context.prepare") {
          return {
            kind: "context-preparation", disposition: "existing",
            preparation: { executionGeneration: 1 },
            snapshot: { snapshotId: "snapshot-1", snapshotGeneration: 1 },
          };
        }
        if (operation.type === "context.source-read-claim") {
          return {
            kind: "context-source-read", readId: "read-fixed", executionId: "execution-1",
            attemptSeq: 1, snapshotId: "snapshot-1", snapshotGeneration: 1,
            sourceLabel: "source:message-1:1", sourceKind: "message_revision",
            sourceId: "message-1", sourceRevision: 1, authorizationEpoch: 4,
            callCount: 1, cumulativeBytes: 0, readerCapability: "room-memory.read",
          };
        }
        if (operation.type === "context.source-read-page") {
          return {
            kind: "context-source-page", readId: "read-fixed", canonicalResultJson,
            resultSha256: createHash("sha256").update(canonicalResultJson).digest("hex"),
            hasMore: false,
          };
        }
        if (operation.type === "context.source-read-complete") {
          return {
            kind: "context-source-read-receipt", citationLabel, readId: "read-fixed",
            callId: "call-1", dispatchId: "dispatch-1", roomId: "room-1",
            executionId: "execution-1", snapshotId: "snapshot-1", snapshotGeneration: 1,
            sourceLabel: "source:message-1:1", sourceKind: "message_revision",
            sourceId: "message-1", sourceRevision: 1, authorizationEpoch: 4,
            representation: "source", range: "items:1-1;cursor:initial",
            contentSha256: createHash("sha256").update(contentJson).digest("hex"),
            contentBytes: Buffer.byteLength(contentJson),
          };
        }
        throw new Error(`unexpected operation ${String(operation.type)}`);
      }),
    } as unknown as ContextAuthorityWorkerDatabaseClient;
    const adapter = createWorkerRoomMemoryReadAdapter({
      worker, cursorSecret: new Uint8Array(32).fill(3), attachmentReader: () => undefined,
      nextReadId: () => "read-fixed", nextCitationLabel: () => citationLabel,
    });

    const result = await adapter.execute(invocation());

    expect(operations.map((operation) => operation.type)).toEqual([
      "context.prepare", "context.source-read-claim", "context.source-read-page",
      "context.source-read-claim", "context.source-read-complete",
    ]);
    expect(JSON.parse(result.modelInput)).toEqual({
      type: "room-memory.read.result.v1", snapshotId: "snapshot-1",
      sourceLabel: "source:message-1:1", mode: "source", sourceRevision: 1,
      items: [item], nextCursor: null, citationLabel,
    });
  });

  it("durably fails a claimed read when the source page becomes unavailable", async () => {
    const operations: Record<string, unknown>[] = [];
    const worker = {
      executeContext: vi.fn(async (operation: Record<string, unknown>) => {
        operations.push(operation);
        if (operation.type === "context.prepare") {
          return {
            kind: "context-preparation", disposition: "existing",
            preparation: { executionGeneration: 1 },
            snapshot: { snapshotId: "snapshot-1", snapshotGeneration: 1 },
          };
        }
        if (operation.type === "context.source-read-claim") {
          return {
            kind: "context-source-read", readId: "read-fixed", executionId: "execution-1",
            attemptSeq: 1, snapshotId: "snapshot-1", snapshotGeneration: 1,
            sourceLabel: "source:message-1:1", sourceKind: "message_revision",
            sourceId: "message-1", sourceRevision: 1, authorizationEpoch: 4,
            callCount: 1, cumulativeBytes: 0, readerCapability: "room-memory.read",
          };
        }
        if (operation.type === "context.source-read-page") {
          throw Object.assign(new Error("gone"), { code: "context_source_gone" });
        }
        if (operation.type === "context.source-read-fail") {
          return { kind: "context-source-read-settled", readId: "read-fixed" };
        }
        throw new Error("unexpected operation");
      }),
    } as unknown as ContextAuthorityWorkerDatabaseClient;
    const adapter = createWorkerRoomMemoryReadAdapter({
      worker, cursorSecret: new Uint8Array(32).fill(3), attachmentReader: () => undefined,
      nextReadId: () => "read-fixed",
    });

    await expect(adapter.execute(invocation())).rejects.toMatchObject({
      status: 410, code: "source_invalidated",
    });
    expect(operations.at(-1)).toMatchObject({
      type: "context.source-read-fail", outcome: "invalidated",
    });
  });

  it("seals opaque expiring cursors to room, execution, snapshot, and authorization epoch", async () => {
    let now = 1_000;
    let authorizationEpoch = 4;
    const canonicalResultJson = JSON.stringify({ items: [item], hasMore: true });
    const contentJson = JSON.stringify([item]);
    const worker = {
      executeContext: vi.fn(async (operation: Record<string, unknown>) => {
        if (operation.type === "context.prepare") {
          return {
            kind: "context-preparation", disposition: "existing",
            preparation: { executionGeneration: 1 },
            snapshot: { snapshotId: "snapshot-1", snapshotGeneration: 1 },
          };
        }
        if (operation.type === "context.source-read-claim") {
          return {
            kind: "context-source-read", readId: operation.readId,
            executionId: operation.executionId, attemptSeq: 1,
            snapshotId: "snapshot-1", snapshotGeneration: 1,
            sourceLabel: "source:message-1:1", sourceKind: "message_revision",
            sourceId: "message-1", sourceRevision: 1, authorizationEpoch,
            callCount: 1, cumulativeBytes: 0, readerCapability: "room-memory.read",
          };
        }
        if (operation.type === "context.source-read-page") {
          return {
            kind: "context-source-page", readId: operation.readId, canonicalResultJson,
            resultSha256: createHash("sha256").update(canonicalResultJson).digest("hex"),
            hasMore: true,
          };
        }
        if (operation.type === "context.source-read-complete") {
          return {
            kind: "context-source-read-receipt", citationLabel,
            readId: operation.readId, callId: "call-cursor", dispatchId: "dispatch-cursor",
            roomId: "room-1", executionId: "execution-1", snapshotId: "snapshot-1",
            snapshotGeneration: 1, sourceLabel: "source:message-1:1",
            sourceKind: "message_revision", sourceId: "message-1", sourceRevision: 1,
            authorizationEpoch: 4, representation: "source",
            range: "items:1-1;cursor:initial",
            contentSha256: createHash("sha256").update(contentJson).digest("hex"),
            contentBytes: Buffer.byteLength(contentJson),
          };
        }
        if (operation.type === "context.source-read-fail") {
          return { kind: "context-source-read-settled", readId: operation.readId };
        }
        throw new Error(`unexpected operation ${String(operation.type)}`);
      }),
    } as unknown as ContextAuthorityWorkerDatabaseClient;
    const adapter = createWorkerRoomMemoryReadAdapter({
      worker, cursorSecret: new Uint8Array(32).fill(7), attachmentReader: () => undefined,
      nowMs: () => now, nextReadId: () => "read-cursor", nextCitationLabel: () => citationLabel,
    });
    const first = await adapter.execute({
      ...invocation(), callId: "call-cursor", dispatchId: "dispatch-cursor",
    });
    const nextCursor = (JSON.parse(first.modelInput) as { nextCursor: string }).nextCursor;
    expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(Buffer.from(nextCursor, "base64url").toString("utf8"))
      .not.toContain("message-1");

    const continued = {
      snapshotId: "snapshot-1", sourceLabel: "source:message-1:1", mode: "source",
      cursor: nextCursor,
    };
    await expect(adapter.execute({
      ...invocation(continued), roomId: "room-2", callId: "call-room",
      grantId: "grant-room", dispatchId: "dispatch-room",
    })).rejects.toMatchObject({ status: 409, code: "stale_context" });
    await expect(adapter.execute({
      ...invocation(continued), executionId: "execution-2", callId: "call-execution",
      grantId: "grant-execution", dispatchId: "dispatch-execution",
    })).rejects.toMatchObject({ status: 409, code: "stale_context" });

    authorizationEpoch = 5;
    await expect(adapter.execute({
      ...invocation(continued), callId: "call-epoch", grantId: "grant-epoch",
      dispatchId: "dispatch-epoch",
    })).rejects.toMatchObject({ status: 409, code: "stale_context" });
    authorizationEpoch = 4;
    const tampered = `${nextCursor.slice(0, -1)}${nextCursor.endsWith("A") ? "B" : "A"}`;
    await expect(adapter.execute({
      ...invocation({ ...continued, cursor: tampered }), callId: "call-tamper",
      grantId: "grant-tamper", dispatchId: "dispatch-tamper",
    })).rejects.toMatchObject({ status: 409, code: "stale_context" });
    now += 5 * 60_000 + 1;
    await expect(adapter.execute({
      ...invocation(continued), callId: "call-expired", grantId: "grant-expired",
      dispatchId: "dispatch-expired",
    })).rejects.toMatchObject({ status: 409, code: "stale_context" });
  });
});
