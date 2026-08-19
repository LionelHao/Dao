import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AttachmentObjectStore,
  AttachmentObjectStoreError,
  type AttachmentStoreLimits,
} from "./object-store.js";

const roots: string[] = [];

const limits: AttachmentStoreLimits = Object.freeze({
  maxChunkBytes: 32 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxExtractionBytes: 8 * 1024 * 1024,
  reconcileMaxEntries: 128,
  reconcileMaxBytes: 256 * 1024 * 1024,
});

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "dao-attachment-store-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("AttachmentObjectStore", () => {
  it("writes exact chunk replay once and rejects changed bytes for the same ordinal", async () => {
    const store = new AttachmentObjectStore({ root: await root(), limits });
    await store.initialize();
    const uploadId = randomUUID();
    const chunk = Buffer.from("bounded attachment chunk");

    const first = await store.writeChunk({
      uploadId, ordinal: 0, bytes: chunk, sha256: digest(chunk),
    });
    const replay = await store.writeChunk({
      uploadId, ordinal: 0, bytes: chunk, sha256: digest(chunk),
    });

    expect(first).toEqual({ byteLength: chunk.byteLength, replayed: false });
    expect(replay).toEqual({ byteLength: chunk.byteLength, replayed: true });
    await expect(store.writeChunk({
      uploadId, ordinal: 0, bytes: Buffer.from("changed"), sha256: digest(Buffer.from("changed")),
    })).rejects.toMatchObject({ reason: "chunk_conflict" });
  });

  it("rejects oversized, digest-mismatched and path-shaped server identities before writing", async () => {
    const storeRoot = await root();
    const store = new AttachmentObjectStore({ root: storeRoot, limits });
    await store.initialize();

    await expect(store.writeChunk({
      uploadId: "../escape", ordinal: 0, bytes: Buffer.from("x"), sha256: digest(Buffer.from("x")),
    })).rejects.toMatchObject({ reason: "invalid_identity" });
    await expect(store.writeChunk({
      uploadId: randomUUID(), ordinal: 0,
      bytes: Buffer.alloc(limits.maxChunkBytes + 1),
      sha256: digest(Buffer.alloc(limits.maxChunkBytes + 1)),
    })).rejects.toMatchObject({ reason: "chunk_too_large" });
    await expect(store.writeChunk({
      uploadId: randomUUID(), ordinal: 0, bytes: Buffer.from("x"), sha256: "0".repeat(64),
    })).rejects.toMatchObject({ reason: "digest_mismatch" });

    await expect(lstat(join(storeRoot, "parts", "..", "escape"))).rejects.toBeDefined();
  });

  it("assembles ordered chunks with bounded streaming and publishes only an exact whole file", async () => {
    const storeRoot = await root();
    const store = new AttachmentObjectStore({ root: storeRoot, limits });
    await store.initialize();
    const uploadId = randomUUID();
    const attachmentId = randomUUID();
    const chunks = [Buffer.from("alpha"), Buffer.from("beta"), Buffer.from("gamma")];
    for (const [ordinal, bytes] of chunks.entries()) {
      await store.writeChunk({ uploadId, ordinal, bytes, sha256: digest(bytes) });
    }
    const whole = Buffer.concat(chunks);

    const quarantined = await store.assembleQuarantine({
      uploadId,
      attachmentId,
      chunkCount: chunks.length,
      expectedBytes: whole.byteLength,
      expectedSha256: digest(whole),
    });
    expect(quarantined).toEqual({
      attachmentId,
      byteLength: whole.byteLength,
      sha256: digest(whole),
    });

    const published = await store.publishCleanObject({ attachmentId });
    expect(published.objectKey).toMatch(/^object_[a-f0-9]{64}$/u);
    expect(await store.readForAuthorizedOperation(published.objectKey)).toEqual(whole);
    expect(await store.readAuthorizedRange(published.objectKey, 0, 4)).toEqual({
      bytes: Buffer.from("alph"),
      byteSize: whole.byteLength,
      eof: false,
    });
    expect(await store.readAuthorizedRange(
      published.objectKey,
      whole.byteLength - 3,
      limits.maxChunkBytes,
    )).toEqual({ bytes: Buffer.from("mma"), byteSize: whole.byteLength, eof: true });
    await expect(store.readAuthorizedRange(
      published.objectKey,
      0,
      limits.maxChunkBytes + 1,
    )).rejects.toMatchObject({ reason: "invalid_chunk" });
    await expect(readFile(join(storeRoot, "quarantine", `${attachmentId}.blob`))).rejects.toBeDefined();
  });

  it("installs bounded extraction artifacts immutably and serves only bounded ranges", async () => {
    const store = new AttachmentObjectStore({ root: await root(), limits });
    await store.initialize();
    const extraction = Buffer.from("safe extracted text");
    const first = await store.storeExtractionArtifact({
      bytes: extraction,
      sha256: digest(extraction),
    });
    const replay = await store.storeExtractionArtifact({
      bytes: extraction,
      sha256: digest(extraction),
    });
    expect(first).toEqual({
      objectKey: `extraction_${digest(extraction)}`,
      byteLength: extraction.byteLength,
      sha256: digest(extraction),
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await store.readAuthorizedRange(first.objectKey, 5, 9)).toEqual({
      bytes: Buffer.from("extracted"),
      byteSize: extraction.byteLength,
      eof: false,
    });
    await expect(store.storeExtractionArtifact({
      bytes: extraction,
      sha256: "0".repeat(64),
    })).rejects.toMatchObject({ reason: "digest_mismatch" });
    await expect(store.storeExtractionArtifact({
      bytes: Buffer.alloc(limits.maxExtractionBytes + 1),
      sha256: digest(Buffer.alloc(limits.maxExtractionBytes + 1)),
    })).rejects.toMatchObject({ reason: "file_too_large" });
  });

  it("keeps a failed assembly invisible and does not consume quarantine on a changed expectation", async () => {
    const storeRoot = await root();
    const store = new AttachmentObjectStore({ root: storeRoot, limits });
    await store.initialize();
    const uploadId = randomUUID();
    const attachmentId = randomUUID();
    const bytes = Buffer.from("not the declared file");
    await store.writeChunk({ uploadId, ordinal: 0, bytes, sha256: digest(bytes) });

    await expect(store.assembleQuarantine({
      uploadId, attachmentId, chunkCount: 1,
      expectedBytes: bytes.byteLength, expectedSha256: "f".repeat(64),
    })).rejects.toMatchObject({ reason: "whole_digest_mismatch" });
    await expect(store.publishCleanObject({ attachmentId })).rejects.toMatchObject({
      reason: "quarantine_missing",
    });
  });

  it("rejects a symlink root and creates private directories and files", async () => {
    const parent = await root();
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    const store = new AttachmentObjectStore({ root: linked, limits });
    await expect(store.initialize()).rejects.toBeInstanceOf(AttachmentObjectStoreError);

    const safeRoot = join(parent, "safe");
    const safe = new AttachmentObjectStore({ root: safeRoot, limits });
    await safe.initialize();
    const directory = await lstat(safeRoot);
    expect(directory.mode & 0o077).toBe(0);
    const bytes = Buffer.from("private");
    const uploadId = randomUUID();
    await safe.writeChunk({ uploadId, ordinal: 0, bytes, sha256: digest(bytes) });
    const part = await lstat(join(safeRoot, "parts", uploadId, "0.part"));
    expect(part.mode & 0o077).toBe(0);
  });

  it("performs bounded orphan reconciliation without deleting referenced objects", async () => {
    const storeRoot = await root();
    const store = new AttachmentObjectStore({ root: storeRoot, limits: {
      ...limits, reconcileMaxEntries: 1,
    }});
    await store.initialize();
    const first = randomUUID();
    const second = randomUUID();
    const bytes = Buffer.from("orphan");
    await store.writeChunk({ uploadId: first, ordinal: 0, bytes, sha256: digest(bytes) });
    await store.writeChunk({ uploadId: second, ordinal: 0, bytes, sha256: digest(bytes) });

    const result = await store.reconcileOrphans({
      referencedUploadIds: new Set([second]),
      referencedQuarantineAttachmentIds: new Set(),
      referencedObjectKeys: new Set(),
    });
    expect(result.deletedEntries).toBe(1);
    expect(result.limitReached).toBe(true);
    expect(await lstat(join(storeRoot, "parts", second))).toBeDefined();
  });
});
