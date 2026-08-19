import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  AttachmentReadGrantError,
  createAttachmentReadGrantRegistry,
  type AttachmentReadAuthorization,
} from "./read-grant-registry.js";

const authorization: AttachmentReadAuthorization = Object.freeze({
  attachmentId: "attachment-1",
  generation: 3,
  lifecycleGeneration: 2,
  accessRevision: 7,
  operation: "download",
  representation: "original",
  objectKey: `object_${"a".repeat(64)}`,
  sha256: "a".repeat(64),
  byteSize: 5,
  originalFilename: "safe.txt",
});
const context = Object.freeze({
  sessionId: "session-1",
  sessionFamilyId: "family-1",
  principal: Object.freeze({ accountId: "account-1", actorId: "actor-1" }),
});

describe("attachment read grant registry", () => {
  it("binds an opaque grant to principal/family and reauthorizes every bounded sequential read", async () => {
    let now = 1_000;
    const reauthorize = vi.fn(async () => authorization);
    const crossRealmBytes = runInNewContext(
      "new Uint8Array([104, 101, 108, 108, 111])",
    ) as Uint8Array;
    expect(crossRealmBytes).not.toBeInstanceOf(Uint8Array);
    const readRange = vi.fn(async (_key: string, offset: number, maximum: number) => {
      const bytes = crossRealmBytes.subarray(
        offset,
        Math.min(crossRealmBytes.byteLength, offset + maximum),
      );
      return {
        bytes,
        byteSize: crossRealmBytes.byteLength,
        eof: offset + bytes.byteLength === crossRealmBytes.byteLength,
      };
    });
    const registry = createAttachmentReadGrantRegistry({
      nowMs: () => now,
      nextGrantId: () => "00000000-0000-4000-8000-000000000001",
      reauthorize,
      readRange,
    });
    const grant = registry.open(context, authorization);
    expect(grant).toEqual({
      streamId: "00000000-0000-4000-8000-000000000001",
      byteSize: 5,
      originalFilename: "safe.txt",
    });
    await expect(registry.read(context, grant.streamId, 0, 2)).resolves.toEqual({
      streamId: grant.streamId,
      offset: 0,
      bytes: Uint8Array.from(Buffer.from("he")),
      byteSize: 2,
      eof: false,
    });
    now += 1;
    await expect(registry.read(context, grant.streamId, 2, 32_768)).resolves.toEqual({
      streamId: grant.streamId,
      offset: 2,
      bytes: Uint8Array.from(Buffer.from("llo")),
      byteSize: 3,
      eof: true,
    });
    expect(reauthorize).toHaveBeenCalledTimes(2);
    expect(readRange).toHaveBeenCalledTimes(2);
    await expect(registry.read(context, grant.streamId, 5, 1)).rejects.toMatchObject({
      status: 410,
      code: "attachment_gone",
    });
  });

  it("fails closed on family reuse, offset replay, expiry, authorization drift and storage drift", async () => {
    let now = 1_000;
    let current = authorization;
    let storedSize = authorization.byteSize;
    let sequence = 0;
    const registry = createAttachmentReadGrantRegistry({
      nowMs: () => now,
      nextGrantId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      reauthorize: async () => current,
      readRange: async () => ({ bytes: Buffer.from("h"), byteSize: storedSize, eof: false }),
      ttlMs: 100,
    });
    const first = registry.open(context, authorization);
    await expect(registry.read({ ...context, sessionFamilyId: "other" }, first.streamId, 0, 1))
      .rejects.toMatchObject({ status: 403, code: "attachment_forbidden" });
    await expect(registry.read(context, first.streamId, 1, 1))
      .rejects.toMatchObject({ status: 409, code: "upload_offset_conflict" });

    const expired = registry.open(context, authorization);
    now += 101;
    await expect(registry.read(context, expired.streamId, 0, 1))
      .rejects.toMatchObject({ status: 410, code: "attachment_gone" });

    now = 1_000;
    const changed = registry.open(context, authorization);
    current = { ...authorization, accessRevision: authorization.accessRevision + 1 };
    await expect(registry.read(context, changed.streamId, 0, 1))
      .rejects.toMatchObject({ status: 403, code: "attachment_forbidden" });

    current = authorization;
    const corrupt = registry.open(context, authorization);
    storedSize += 1;
    await expect(registry.read(context, corrupt.streamId, 0, 1))
      .rejects.toMatchObject({ status: 503, code: "storage_unavailable" });
  });

  it("enforces exact safe authorization, grant capacity and maximum chunk size", async () => {
    let sequence = 0;
    const registry = createAttachmentReadGrantRegistry({
      nowMs: () => 1_000,
      nextGrantId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
      reauthorize: async () => authorization,
      readRange: async () => ({ bytes: Buffer.from("h"), byteSize: 5, eof: false }),
      maximumGrantsPerFamily: 2,
    });
    expect(() => registry.open(context, { ...authorization, path: "/leak" } as never))
      .toThrow(TypeError);
    const first = registry.open(context, authorization);
    registry.open(context, authorization);
    expect(() => registry.open(context, authorization)).toThrow(AttachmentReadGrantError);
    await expect(registry.read(context, first.streamId, 0, 32_769))
      .rejects.toMatchObject({ status: 400, code: "invalid_chunk" });
  });
});
