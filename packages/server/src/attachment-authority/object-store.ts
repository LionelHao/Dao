import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type Dirent,
} from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface AttachmentStoreLimits {
  readonly maxChunkBytes: number;
  readonly maxFileBytes: number;
  readonly maxExtractionBytes: number;
  readonly reconcileMaxEntries: number;
  readonly reconcileMaxBytes: number;
}

export type AttachmentObjectStoreFailureReason =
  | "invalid_configuration"
  | "invalid_identity"
  | "invalid_chunk"
  | "chunk_too_large"
  | "digest_mismatch"
  | "chunk_conflict"
  | "chunk_missing"
  | "file_too_large"
  | "whole_size_mismatch"
  | "whole_digest_mismatch"
  | "quarantine_conflict"
  | "quarantine_missing"
  | "object_conflict"
  | "object_missing"
  | "unsafe_store"
  | "storage_unavailable";

export class AttachmentObjectStoreError extends Error {
  readonly reason: AttachmentObjectStoreFailureReason;

  constructor(reason: AttachmentObjectStoreFailureReason) {
    super(`Attachment object store rejected: ${reason}`);
    this.name = "AttachmentObjectStoreError";
    this.reason = reason;
  }
}

export interface AttachmentObjectStoreOptions {
  readonly root: string;
  readonly limits: AttachmentStoreLimits;
}

export interface WriteAttachmentChunkInput {
  readonly uploadId: string;
  readonly ordinal: number;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface AssembleAttachmentQuarantineInput {
  readonly uploadId: string;
  readonly attachmentId: string;
  readonly chunkCount: number;
  readonly expectedBytes: number;
  readonly expectedSha256: string;
}

export interface ReconcileAttachmentOrphansInput {
  readonly referencedUploadIds: ReadonlySet<string>;
  readonly referencedQuarantineAttachmentIds: ReadonlySet<string>;
  readonly referencedObjectKeys: ReadonlySet<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OBJECT_KEY = /^object_[0-9a-f]{64}$/u;
const EXTRACTION_KEY = /^extraction_[0-9a-f]{64}$/u;

function fail(reason: AttachmentObjectStoreFailureReason): never {
  throw new AttachmentObjectStoreError(reason);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validLimits(value: AttachmentStoreLimits): boolean {
  return positiveSafeInteger(value.maxChunkBytes) &&
    positiveSafeInteger(value.maxFileBytes) &&
    positiveSafeInteger(value.maxExtractionBytes) &&
    value.maxChunkBytes <= value.maxFileBytes &&
    value.maxExtractionBytes <= value.maxFileBytes &&
    positiveSafeInteger(value.reconcileMaxEntries) &&
    positiveSafeInteger(value.reconcileMaxBytes);
}

function validServerId(value: string): boolean {
  return UUID.test(value);
}

function byteSequence(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) &&
    (value as { readonly BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1 &&
    typeof value.byteLength === "number";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    fail("storage_unavailable");
  }
}

async function privateRegularFile(path: string, maxBytes: number): Promise<Uint8Array> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") fail("object_missing");
    fail("storage_unavailable");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) fail("unsafe_store");
  try {
    const value = await readFile(path);
    if (value.byteLength !== stat.size || value.byteLength > maxBytes) fail("unsafe_store");
    return value;
  } catch (error) {
    if (error instanceof AttachmentObjectStoreError) throw error;
    fail("storage_unavailable");
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(path, constants.O_RDONLY);
    await directory.sync();
  } catch {
    fail("storage_unavailable");
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function installExclusive(tempPath: string, finalPath: string): Promise<"installed" | "exists"> {
  try {
    await link(tempPath, finalPath);
    await unlink(tempPath);
    return "installed";
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      await unlink(tempPath).catch(() => undefined);
      return "exists";
    }
    await unlink(tempPath).catch(() => undefined);
    fail("storage_unavailable");
  }
}

export class AttachmentObjectStore {
  readonly #root: string;
  readonly #parts: string;
  readonly #quarantine: string;
  readonly #objects: string;
  readonly #extractions: string;
  readonly #limits: AttachmentStoreLimits;
  #initialized = false;

  constructor(options: AttachmentObjectStoreOptions) {
    if (!isAbsolute(options.root) || resolve(options.root) !== options.root || !validLimits(options.limits)) {
      fail("invalid_configuration");
    }
    this.#root = options.root;
    this.#parts = join(this.#root, "parts");
    this.#quarantine = join(this.#root, "quarantine");
    this.#objects = join(this.#root, "objects");
    this.#extractions = join(this.#root, "extractions");
    this.#limits = Object.freeze({ ...options.limits });
  }

  async initialize(): Promise<void> {
    try {
      if (await pathExists(this.#root)) {
        const existing = await lstat(this.#root);
        if (!existing.isDirectory() || existing.isSymbolicLink()) fail("unsafe_store");
      } else {
        await mkdir(this.#root, { recursive: true, mode: 0o700 });
      }
      await chmod(this.#root, 0o700);
      for (const directory of [this.#parts, this.#quarantine, this.#objects, this.#extractions]) {
        if (await pathExists(directory)) {
          const existing = await lstat(directory);
          if (!existing.isDirectory() || existing.isSymbolicLink()) fail("unsafe_store");
        } else {
          await mkdir(directory, { mode: 0o700 });
        }
        await chmod(directory, 0o700);
      }
      this.#initialized = true;
    } catch (error) {
      if (error instanceof AttachmentObjectStoreError) throw error;
      fail("storage_unavailable");
    }
  }

  #ready(): void {
    if (!this.#initialized) fail("invalid_configuration");
  }

  #partDirectory(uploadId: string): string {
    if (!validServerId(uploadId)) fail("invalid_identity");
    return join(this.#parts, uploadId);
  }

  #quarantinePath(attachmentId: string): string {
    if (!validServerId(attachmentId)) fail("invalid_identity");
    return join(this.#quarantine, `${attachmentId}.blob`);
  }

  #objectPath(objectKey: string): string {
    if (!OBJECT_KEY.test(objectKey)) fail("invalid_identity");
    return join(this.#objects, `${objectKey}.blob`);
  }

  #artifactPath(objectKey: string): Readonly<{ path: string; maxBytes: number }> {
    if (OBJECT_KEY.test(objectKey)) {
      return { path: join(this.#objects, `${objectKey}.blob`), maxBytes: this.#limits.maxFileBytes };
    }
    if (EXTRACTION_KEY.test(objectKey)) {
      return {
        path: join(this.#extractions, `${objectKey}.blob`),
        maxBytes: this.#limits.maxExtractionBytes,
      };
    }
    fail("invalid_identity");
  }

  async writeChunk(input: WriteAttachmentChunkInput): Promise<Readonly<{
    byteLength: number;
    replayed: boolean;
  }>> {
    this.#ready();
    const partDirectory = this.#partDirectory(input.uploadId);
    const maxOrdinal = Math.ceil(this.#limits.maxFileBytes / this.#limits.maxChunkBytes);
    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= maxOrdinal ||
        !byteSequence(input.bytes) || input.bytes.byteLength === 0) {
      fail("invalid_chunk");
    }
    if (input.bytes.byteLength > this.#limits.maxChunkBytes) fail("chunk_too_large");
    if (!SHA256.test(input.sha256) || sha256(input.bytes) !== input.sha256) fail("digest_mismatch");

    try {
      if (!(await pathExists(partDirectory))) await mkdir(partDirectory, { mode: 0o700 });
      const partStat = await lstat(partDirectory);
      if (!partStat.isDirectory() || partStat.isSymbolicLink()) fail("unsafe_store");
      await chmod(partDirectory, 0o700);
      const finalPath = join(partDirectory, `${input.ordinal}.part`);
      if (await pathExists(finalPath)) {
        const existing = await privateRegularFile(finalPath, this.#limits.maxChunkBytes);
        if (existing.byteLength !== input.bytes.byteLength || sha256(existing) !== input.sha256) {
          fail("chunk_conflict");
        }
        return Object.freeze({ byteLength: input.bytes.byteLength, replayed: true });
      }

      const tempPath = join(partDirectory, `.tmp_${randomUUID()}`);
      const handle = await open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const installed = await installExclusive(tempPath, finalPath);
      await syncDirectory(partDirectory);
      if (installed === "exists") {
        const existing = await privateRegularFile(finalPath, this.#limits.maxChunkBytes);
        if (existing.byteLength !== input.bytes.byteLength || sha256(existing) !== input.sha256) {
          fail("chunk_conflict");
        }
        return Object.freeze({ byteLength: input.bytes.byteLength, replayed: true });
      }
      return Object.freeze({ byteLength: input.bytes.byteLength, replayed: false });
    } catch (error) {
      if (error instanceof AttachmentObjectStoreError) throw error;
      fail("storage_unavailable");
    }
  }

  async assembleQuarantine(input: AssembleAttachmentQuarantineInput): Promise<Readonly<{
    attachmentId: string;
    byteLength: number;
    sha256: string;
  }>> {
    this.#ready();
    const partDirectory = this.#partDirectory(input.uploadId);
    const quarantinePath = this.#quarantinePath(input.attachmentId);
    const maxChunks = Math.ceil(this.#limits.maxFileBytes / this.#limits.maxChunkBytes);
    if (!positiveSafeInteger(input.chunkCount) || input.chunkCount > maxChunks ||
        !positiveSafeInteger(input.expectedBytes)) {
      fail("invalid_chunk");
    }
    if (input.expectedBytes > this.#limits.maxFileBytes) fail("file_too_large");
    if (!SHA256.test(input.expectedSha256)) fail("digest_mismatch");

    if (await pathExists(quarantinePath)) {
      const existing = await privateRegularFile(quarantinePath, this.#limits.maxFileBytes);
      if (existing.byteLength !== input.expectedBytes || sha256(existing) !== input.expectedSha256) {
        fail("quarantine_conflict");
      }
      return Object.freeze({
        attachmentId: input.attachmentId,
        byteLength: existing.byteLength,
        sha256: input.expectedSha256,
      });
    }

    const tempPath = join(this.#quarantine, `.tmp_${randomUUID()}`);
    let output;
    let total = 0;
    const wholeDigest = createHash("sha256");
    try {
      output = await open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      for (let ordinal = 0; ordinal < input.chunkCount; ordinal += 1) {
        const partPath = join(partDirectory, `${ordinal}.part`);
        if (!(await pathExists(partPath))) fail("chunk_missing");
        const part = await privateRegularFile(partPath, this.#limits.maxChunkBytes);
        total += part.byteLength;
        if (total > this.#limits.maxFileBytes || total > input.expectedBytes) fail("file_too_large");
        wholeDigest.update(part);
        await output.write(part);
      }
      await output.sync();
      await output.close();
      output = undefined;
      if (total !== input.expectedBytes) fail("whole_size_mismatch");
      const actualSha256 = wholeDigest.digest("hex");
      if (actualSha256 !== input.expectedSha256) fail("whole_digest_mismatch");
      const installed = await installExclusive(tempPath, quarantinePath);
      await syncDirectory(this.#quarantine);
      if (installed === "exists") {
        const existing = await privateRegularFile(quarantinePath, this.#limits.maxFileBytes);
        if (existing.byteLength !== total || sha256(existing) !== actualSha256) {
          fail("quarantine_conflict");
        }
      }
      return Object.freeze({ attachmentId: input.attachmentId, byteLength: total, sha256: actualSha256 });
    } catch (error) {
      await output?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      if (error instanceof AttachmentObjectStoreError) throw error;
      fail("storage_unavailable");
    }
  }

  async publishCleanObject(input: Readonly<{ attachmentId: string }>): Promise<Readonly<{
    objectKey: string;
    byteLength: number;
    sha256: string;
  }>> {
    this.#ready();
    const quarantinePath = this.#quarantinePath(input.attachmentId);
    if (!(await pathExists(quarantinePath))) fail("quarantine_missing");
    const bytes = await privateRegularFile(quarantinePath, this.#limits.maxFileBytes);
    const actualSha256 = sha256(bytes);
    const objectKey = `object_${actualSha256}`;
    const objectPath = this.#objectPath(objectKey);
    try {
      if (await pathExists(objectPath)) {
        const existing = await privateRegularFile(objectPath, this.#limits.maxFileBytes);
        if (existing.byteLength !== bytes.byteLength || sha256(existing) !== actualSha256) {
          fail("object_conflict");
        }
        await unlink(quarantinePath);
      } else {
        await rename(quarantinePath, objectPath);
        await chmod(objectPath, 0o600);
      }
      await syncDirectory(this.#quarantine);
      await syncDirectory(this.#objects);
      return Object.freeze({ objectKey, byteLength: bytes.byteLength, sha256: actualSha256 });
    } catch (error) {
      if (error instanceof AttachmentObjectStoreError) throw error;
      fail("storage_unavailable");
    }
  }

  async storeExtractionArtifact(input: Readonly<{
    bytes: Uint8Array;
    sha256: string;
  }>): Promise<Readonly<{
    objectKey: string;
    byteLength: number;
    sha256: string;
    replayed: boolean;
  }>> {
    this.#ready();
    if (!byteSequence(input.bytes) || input.bytes.byteLength === 0) fail("invalid_chunk");
    if (input.bytes.byteLength > this.#limits.maxExtractionBytes) fail("file_too_large");
    if (!SHA256.test(input.sha256) || sha256(input.bytes) !== input.sha256) {
      fail("digest_mismatch");
    }
    const objectKey = `extraction_${input.sha256}`;
    const finalPath = this.#artifactPath(objectKey).path;
    try {
      if (await pathExists(finalPath)) {
        const existing = await privateRegularFile(finalPath, this.#limits.maxExtractionBytes);
        if (existing.byteLength !== input.bytes.byteLength || sha256(existing) !== input.sha256) {
          fail("object_conflict");
        }
        return Object.freeze({
          objectKey,
          byteLength: input.bytes.byteLength,
          sha256: input.sha256,
          replayed: true,
        });
      }
      const tempPath = join(this.#extractions, `.tmp_${randomUUID()}`);
      const handle = await open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const installed = await installExclusive(tempPath, finalPath);
      await syncDirectory(this.#extractions);
      if (installed === "exists") {
        const existing = await privateRegularFile(finalPath, this.#limits.maxExtractionBytes);
        if (existing.byteLength !== input.bytes.byteLength || sha256(existing) !== input.sha256) {
          fail("object_conflict");
        }
      }
      return Object.freeze({
        objectKey,
        byteLength: input.bytes.byteLength,
        sha256: input.sha256,
        replayed: installed === "exists",
      });
    } catch (error) {
      if (error instanceof AttachmentObjectStoreError) throw error;
      fail("storage_unavailable");
    }
  }

  async readForAuthorizedOperation(objectKey: string): Promise<Uint8Array> {
    this.#ready();
    const artifact = this.#artifactPath(objectKey);
    if (!(await pathExists(artifact.path))) fail("object_missing");
    return privateRegularFile(artifact.path, artifact.maxBytes);
  }

  async readAuthorizedRange(
    objectKey: string,
    offset: number,
    maximumBytes: number,
  ): Promise<Readonly<{ bytes: Uint8Array; byteSize: number; eof: boolean }>> {
    this.#ready();
    const artifact = this.#artifactPath(objectKey);
    if (!nonnegativeSafeInteger(offset) || !positiveSafeInteger(maximumBytes) ||
        maximumBytes > this.#limits.maxChunkBytes) {
      fail("invalid_chunk");
    }
    let handle;
    try {
      handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || before.size > artifact.maxBytes || offset > before.size) {
        fail("unsafe_store");
      }
      const expected = Math.min(maximumBytes, before.size - offset);
      const bytes = Buffer.alloc(expected);
      let read = 0;
      while (read < expected) {
        const result = await handle.read(bytes, read, expected - read, offset + read);
        if (result.bytesRead === 0) fail("unsafe_store");
        read += result.bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== before.size || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
        fail("unsafe_store");
      }
      return Object.freeze({ bytes, byteSize: before.size, eof: offset + read === before.size });
    } catch (error) {
      if (error instanceof AttachmentObjectStoreError) throw error;
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") fail("object_missing");
      return fail("storage_unavailable");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async reconcileOrphans(input: ReconcileAttachmentOrphansInput): Promise<Readonly<{
    deletedEntries: number;
    deletedBytes: number;
    limitReached: boolean;
  }>> {
    this.#ready();
    for (const value of input.referencedUploadIds) if (!validServerId(value)) fail("invalid_identity");
    for (const value of input.referencedQuarantineAttachmentIds) if (!validServerId(value)) fail("invalid_identity");
    for (const value of input.referencedObjectKeys) {
      if (!OBJECT_KEY.test(value) && !EXTRACTION_KEY.test(value)) fail("invalid_identity");
    }

    let deletedEntries = 0;
    let deletedBytes = 0;
    let limitReached = false;
    const atLimit = (): boolean => {
      const limited = deletedEntries >= this.#limits.reconcileMaxEntries ||
        deletedBytes >= this.#limits.reconcileMaxBytes;
      if (limited) limitReached = true;
      return limited;
    };
    const deleteEntry = async (path: string, estimatedBytes: number): Promise<void> => {
      if (atLimit() || deletedBytes + estimatedBytes > this.#limits.reconcileMaxBytes) {
        limitReached = true;
        return;
      }
      await rm(path, { recursive: true, force: true });
      deletedEntries += 1;
      deletedBytes += estimatedBytes;
    };
    const entries = async (directory: string): Promise<readonly Dirent[]> =>
      (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
        left.name.localeCompare(right.name));

    try {
      for (const entry of await entries(this.#parts)) {
        if (atLimit()) break;
        if (entry.name.startsWith(".tmp_")) {
          await deleteEntry(join(this.#parts, entry.name), 0);
          continue;
        }
        if (input.referencedUploadIds.has(entry.name)) continue;
        const path = join(this.#parts, entry.name);
        let estimatedBytes = 0;
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          for (const part of await entries(path)) {
            const stat = await lstat(join(path, part.name));
            if (stat.isFile() && !stat.isSymbolicLink()) estimatedBytes += stat.size;
          }
        }
        await deleteEntry(path, estimatedBytes);
      }
      for (const entry of await entries(this.#quarantine)) {
        if (atLimit()) break;
        const match = /^([0-9a-f-]{36})\.blob$/u.exec(entry.name);
        if (match?.[1] !== undefined && input.referencedQuarantineAttachmentIds.has(match[1])) continue;
        const path = join(this.#quarantine, entry.name);
        const stat = await lstat(path);
        await deleteEntry(path, stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0);
      }
      for (const entry of await entries(this.#objects)) {
        if (atLimit()) break;
        const match = /^(object_[0-9a-f]{64})\.blob$/u.exec(entry.name);
        if (match?.[1] !== undefined && input.referencedObjectKeys.has(match[1])) continue;
        const path = join(this.#objects, entry.name);
        const stat = await lstat(path);
        await deleteEntry(path, stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0);
      }
      for (const entry of await entries(this.#extractions)) {
        if (atLimit()) break;
        const match = /^(extraction_[0-9a-f]{64})\.blob$/u.exec(entry.name);
        if (match?.[1] !== undefined && input.referencedObjectKeys.has(match[1])) continue;
        const path = join(this.#extractions, entry.name);
        const stat = await lstat(path);
        await deleteEntry(path, stat.isFile() && !stat.isSymbolicLink() ? stat.size : 0);
      }
      limitReached ||= deletedEntries >= this.#limits.reconcileMaxEntries ||
        deletedBytes >= this.#limits.reconcileMaxBytes;
      return Object.freeze({ deletedEntries, deletedBytes, limitReached });
    } catch (error) {
      if (error instanceof AttachmentObjectStoreError) throw error;
      fail("storage_unavailable");
    }
  }
}
