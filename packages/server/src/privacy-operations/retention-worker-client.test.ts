import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkerDatabaseClient,
  createWorkerDatabaseClientForTest,
  type AuthorityWorkerTransport,
} from "../persistence/worker-database-client.js";
import type {
  AuthorityWorkerRequest,
  AuthorityWorkerResponse,
} from "../persistence/worker-protocol.js";
import type { HostedRetentionBatchPort } from "./operations-runtime.js";

const temporaryDirectories = new Set<string>();

class RetentionTransport extends EventEmitter implements AuthorityWorkerTransport {
  readonly requests: AuthorityWorkerRequest[] = [];

  postMessage(message: AuthorityWorkerRequest): void {
    this.requests.push(message);
    let response: AuthorityWorkerResponse;
    if (message.type === "authority.initialize") {
      response = { type: "authority.ready", requestId: message.requestId, schemaVersion: 29 };
    } else if (message.type === "authority.privacy-retention") {
      response = {
        type: "authority.privacy-retention-result",
        requestId: message.requestId,
        result: {
          kind: "privacy-retention-batch",
          processed: 2,
          purged: 1,
          retained: 1,
          retried: 0,
          deadLettered: 0,
          hasMore: true,
          queueDepth: 3,
          oldestAgeMs: 10_000,
        },
      };
    } else if (message.type === "authority.close") {
      response = { type: "authority.closed", requestId: message.requestId };
    } else {
      throw new TypeError(`Unexpected request ${message.type}`);
    }
    queueMicrotask(() => this.emit("message", response));
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "dao-retention-worker-"));
  temporaryDirectories.add(directory);
  return join(directory, "authority.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("FT-14 hosted retention AuthorityWorker client port", () => {
  it("executes an empty batch through the real single-writer AuthorityWorker", async () => {
    const client = await createWorkerDatabaseClient({ databasePath: databasePath() });
    try {
      await expect(client.runBatch({
        workerId: "retention_janitor",
        limit: 100,
        nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
        trigger: "startup_recovery",
        signal: new AbortController().signal,
      })).resolves.toEqual({
        processed: 0,
        purged: 0,
        retained: 0,
        retried: 0,
        deadLettered: 0,
        hasMore: false,
        queueDepth: 0,
        oldestAgeMs: 0,
      });
    } finally {
      await client.close();
    }
  });

  it("sends one closed operation and returns only hosted aggregate fields", async () => {
    const transport = new RetentionTransport();
    const client = await createWorkerDatabaseClientForTest(
      { databasePath: databasePath() },
      () => transport,
    );
    const port: HostedRetentionBatchPort = client;
    try {
      await expect(port.runBatch({
        workerId: "retention_janitor",
        limit: 100,
        nowMs: Date.parse("2026-08-31T00:00:00.000Z"),
        trigger: "startup_recovery",
        signal: new AbortController().signal,
      })).resolves.toEqual({
        processed: 2,
        purged: 1,
        retained: 1,
        retried: 0,
        deadLettered: 0,
        hasMore: true,
        queueDepth: 3,
        oldestAgeMs: 10_000,
      });
      expect(transport.requests[1]).toEqual({
        type: "authority.privacy-retention",
        requestId: "2",
        operation: {
          version: 1,
          type: "privacy.retention.run-batch",
          trigger: "startup_recovery",
          now: Date.parse("2026-08-31T00:00:00.000Z"),
          limit: 100,
        },
      });
    } finally {
      await client.close();
    }
  });

  it("rejects aborted and oversized inputs before posting to the worker", async () => {
    const transport = new RetentionTransport();
    const client = await createWorkerDatabaseClientForTest(
      { databasePath: databasePath() },
      () => transport,
    );
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(client.runBatch({
        workerId: "retention_janitor",
        limit: 100,
        nowMs: 0,
        trigger: "periodic",
        signal: controller.signal,
      })).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(client.runBatch({
        workerId: "retention_janitor",
        limit: 101,
        nowMs: 0,
        trigger: "periodic",
        signal: new AbortController().signal,
      })).rejects.toThrow("Privacy retention batch input is invalid");
      expect(transport.requests).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
