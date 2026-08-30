import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { mkdir, open, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ToolAdapter, ToolOutcome } from "../contracts.js";
import { ambiguousFailure, knownFailure } from "./adapter-outcome.js";

interface SandboxFileWriteOptions {
  readonly root: string;
  readonly compensationKey: Uint8Array;
  readonly maxContentBytes: number;
  readonly timeoutMs?: number;
  readonly maxPreimageBytes?: number;
  readonly maxCompensationBytes?: number;
  /** Deep-test seam for platforms where Node has no descriptor-relative child traversal. */
  readonly testOnlyAllowPathFallback?: boolean;
  /** Deep-test fault/race seam; never selected by production composition. */
  readonly testHooks?: Readonly<{
    beforeRename?: () => void | Promise<void>;
    afterRename?: () => void | Promise<void>;
    beforeDirectorySync?: () => void | Promise<void>;
  }>;
}

interface WriteParameters {
  readonly path: string;
  readonly content: string;
  readonly expectedCurrentSha256: string;
}

interface CompensationRecord {
  readonly path: string;
  readonly beforeBase64: string | null;
  readonly expectedPostSha256: string;
}

interface Identity { readonly dev: bigint; readonly ino: bigint }

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next < 0xdc00 || next > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 31 || code === 127;
  });
}

function parsePath(path: unknown): readonly string[] {
  if (typeof path !== "string" || path.length === 0 || path.length > 512 || isAbsolute(path) ||
      path.includes("\\") || path !== path.normalize("NFC") || !wellFormed(path) || hasControl(path)) {
    throw knownFailure("invalid_parameters", "Sandbox write path was rejected");
  }
  const segments = path.split("/");
  if (segments.some((part) => part.length === 0 || part === "." || part === ".." || part.length > 255)) {
    throw knownFailure("invalid_parameters", "Sandbox write path was rejected");
  }
  return segments;
}

function parseParameters(value: Readonly<Record<string, unknown>>, maxContentBytes: number): WriteParameters {
  if (Object.keys(value).sort().join("\0") !== ["content", "expectedCurrentSha256", "path"].join("\0") ||
      typeof value.content !== "string" || !wellFormed(value.content) || value.content !== value.content.normalize("NFC") ||
      typeof value.expectedCurrentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedCurrentSha256) ||
      Buffer.byteLength(value.content, "utf8") > maxContentBytes) {
    throw knownFailure("invalid_parameters", "Sandbox write parameters were rejected");
  }
  parsePath(value.path);
  return value as unknown as WriteParameters;
}

function seal(record: CompensationRecord, key: Uint8Array, limit: number): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  if (Buffer.byteLength(token, "utf8") > limit) throw knownFailure("tool_failure", "Sandbox compensation record exceeded its limit");
  return token;
}

function unseal(token: string, key: Uint8Array, limit: number): CompensationRecord {
  try {
    if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > limit) throw new Error("size");
    const packed = Buffer.from(token, "base64url");
    if (packed.length < 29) throw new Error("short");
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).sort().join("\0") !== ["beforeBase64", "expectedPostSha256", "path"].join("\0") ||
        typeof record.path !== "string" || (record.beforeBase64 !== null && typeof record.beforeBase64 !== "string") ||
        typeof record.expectedPostSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.expectedPostSha256)) throw new Error("shape");
    parsePath(record.path);
    return record as unknown as CompensationRecord;
  } catch {
    throw knownFailure("invalid_parameters", "Compensation token was rejected");
  }
}

function fdBase(fdRoot: string, handle: FileHandle, fallbackPath: string): string {
  return fdRoot === "" ? fallbackPath : `${fdRoot}/${handle.fd}`;
}

function probeDescriptorChildren(root: string, rootIdentity: Identity, fdRoot: string): boolean {
  const probeName = `.dao-capability-${randomUUID()}`;
  const renamedName = `${probeName}.renamed`;
  let rootFd: number | undefined;
  let childFd: number | undefined;
  let fileFd: number | undefined;
  let fileCreated = false;
  let fileRenamed = false;
  let directoryCreated = false;
  try {
    rootFd = openSync(root, DIRECTORY_FLAGS);
    const rootStat = fstatSync(rootFd, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.dev !== rootIdentity.dev || rootStat.ino !== rootIdentity.ino) return false;
    const base = `${fdRoot}/${rootFd}`;
    const descriptorStat = lstatSync(`${base}/.`, { bigint: true });
    if (!descriptorStat.isDirectory() || descriptorStat.dev !== rootIdentity.dev || descriptorStat.ino !== rootIdentity.ino) return false;

    mkdirSync(`${base}/${probeName}`, { mode: 0o700 });
    directoryCreated = true;
    childFd = openSync(`${base}/${probeName}`, DIRECTORY_FLAGS);
    if (!fstatSync(childFd).isDirectory()) return false;
    rmdirSync(`${base}/${probeName}`);
    directoryCreated = false;
    closeSync(childFd);
    childFd = undefined;

    fileFd = openSync(`${base}/${probeName}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fileCreated = true;
    if (!fstatSync(fileFd).isFile()) return false;
    closeSync(fileFd);
    fileFd = undefined;
    renameSync(`${base}/${probeName}`, `${base}/${renamedName}`);
    fileCreated = false;
    fileRenamed = true;
    unlinkSync(`${base}/${renamedName}`);
    fileRenamed = false;
    return true;
  } catch {
    return false;
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (childFd !== undefined) closeSync(childFd);
    if (rootFd !== undefined) {
      const base = `${fdRoot}/${rootFd}`;
      if (fileCreated) try { unlinkSync(`${base}/${probeName}`); } catch { /* fail closed below */ }
      if (fileRenamed) try { unlinkSync(`${base}/${renamedName}`); } catch { /* fail closed below */ }
      if (directoryCreated) try { rmdirSync(`${base}/${probeName}`); } catch { /* fail closed below */ }
      closeSync(rootFd);
    }
  }
}

async function openParent(
  root: string,
  rootIdentity: Identity,
  fdRoot: string,
  segments: readonly string[],
): Promise<Readonly<{ parent: FileHandle; parentPath: string; handles: readonly FileHandle[]; targetName: string }>> {
  let rootHandle: FileHandle;
  try { rootHandle = await open(root, DIRECTORY_FLAGS); }
  catch { throw knownFailure("tool_failure", "Sandbox root identity changed"); }
  const handles: FileHandle[] = [rootHandle];
  try {
    const metadata = await rootHandle.stat({ bigint: true });
    if (metadata.dev !== rootIdentity.dev || metadata.ino !== rootIdentity.ino || !metadata.isDirectory()) {
      throw knownFailure("tool_failure", "Sandbox root identity changed");
    }
    let parent = rootHandle;
    let parentPath = root;
    for (const segment of segments.slice(0, -1)) {
      const childPath = `${fdBase(fdRoot, parent, parentPath)}/${segment}`;
      try { await mkdir(childPath, { mode: 0o700 }); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let child: FileHandle;
      try { child = await open(childPath, DIRECTORY_FLAGS); }
      catch { throw knownFailure("tool_failure", "Sandbox parent traversal was rejected"); }
      handles.push(child);
      parent = child;
      parentPath = childPath;
    }
    return { parent, parentPath, handles, targetName: segments.at(-1)! };
  } catch (error) {
    await Promise.allSettled(handles.map(async (handle) => await handle.close()));
    throw error;
  }
}

async function closeHandles(handles: readonly FileHandle[]): Promise<void> {
  await Promise.allSettled([...handles].reverse().map(async (handle) => await handle.close()));
}

async function readBoundedFile(path: string, limit: number): Promise<Uint8Array | undefined> {
  let handle: FileHandle;
  try { handle = await open(path, FILE_READ_FLAGS); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw knownFailure("tool_failure", "Sandbox target traversal was rejected");
  }
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n || initial.size > BigInt(limit)) {
      throw knownFailure("tool_failure", "Sandbox target type or preimage size was rejected");
    }
    const result = Buffer.alloc(Number(initial.size));
    let offset = 0;
    while (offset < result.length) {
      const next = await handle.read(result, offset, result.length - offset, offset);
      if (next.bytesRead === 0) break;
      offset += next.bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    if (offset !== result.length || final.dev !== initial.dev || final.ino !== initial.ino ||
        final.size !== initial.size || final.nlink !== 1n) {
      throw knownFailure("execution_conflict", "Sandbox target changed while it was read");
    }
    return new Uint8Array(result);
  } finally { await handle.close(); }
}

async function waitForSandboxHook(
  hook: (() => void | Promise<void>) | undefined,
  signal: AbortSignal,
  mutationMayHaveOccurred: boolean,
): Promise<void> {
  if (hook === undefined) return;
  if (signal.aborted) {
    if (mutationMayHaveOccurred) throw ambiguousFailure("Sandbox operation was interrupted after mutation");
    throw knownFailure("tool_failure", "Sandbox operation was interrupted before mutation");
  }
  const work = Promise.resolve().then(hook);
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => reject(mutationMayHaveOccurred
      ? ambiguousFailure("Sandbox operation was interrupted after mutation")
      : knownFailure("tool_failure", "Sandbox operation was interrupted before mutation"));
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
      .catch(() => undefined);
  });
  void work.catch(() => undefined);
}

async function atomicReplace(
  parent: FileHandle,
  parentPath: string,
  fdRoot: string,
  targetName: string,
  content: Uint8Array,
  signal: AbortSignal,
  hooks?: SandboxFileWriteOptions["testHooks"],
): Promise<void> {
  const base = fdBase(fdRoot, parent, parentPath);
  const temporary = `.dao-${randomUUID()}.tmp`;
  const temporaryPath = `${base}/${temporary}`;
  const targetPath = `${base}/${targetName}`;
  let renamed = false;
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } catch {
    throw knownFailure("tool_failure", "Sandbox temporary write failed");
  } finally { await handle.close(); }
  try {
    if (signal.aborted) throw knownFailure("tool_failure", "Sandbox write was cancelled before rename");
    await waitForSandboxHook(hooks?.beforeRename, signal, false);
    if (signal.aborted) throw knownFailure("tool_failure", "Sandbox write was cancelled before rename");
    await rename(temporaryPath, targetPath);
    renamed = true;
    await waitForSandboxHook(hooks?.afterRename, signal, true);
    if (signal.aborted) throw ambiguousFailure("Sandbox write was cancelled after rename");
    await waitForSandboxHook(hooks?.beforeDirectorySync, signal, true);
    await parent.sync();
  } catch (error: unknown) {
    if (renamed) {
      if (typeof error === "object" && error !== null && "outcome" in error && error.outcome === "ambiguous") throw error;
      throw ambiguousFailure("Sandbox write may have completed but durability could not be proven");
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (typeof error === "object" && error !== null && "outcome" in error) throw error;
    throw knownFailure("tool_failure", "Sandbox atomic rename failed");
  }
}

async function withinSandboxDeadline<T>(
  timeoutMs: number,
  upstreamSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (upstreamSignal.aborted) {
    throw knownFailure("tool_failure", "Sandbox operation was cancelled before mutation");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort(upstreamSignal.reason);
  upstreamSignal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("deadline")), timeoutMs);
  const work = operation(controller.signal);
  const interrupted = new Promise<never>((_resolve, reject) => {
    const rejectUnknown = (): void => reject(ambiguousFailure(
      "Sandbox operation exceeded its real-time deadline; outcome is unknown",
    ));
    controller.signal.addEventListener("abort", rejectUnknown, { once: true });
    work.finally(() => controller.signal.removeEventListener("abort", rejectUnknown))
      .catch(() => undefined);
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    clearTimeout(timer);
    upstreamSignal.removeEventListener("abort", abort);
    void work.catch(() => undefined);
  }
}

export function createSandboxFileWriteAdapter(options: SandboxFileWriteOptions): ToolAdapter {
  if (!isAbsolute(options.root) || options.compensationKey.byteLength !== 32 ||
      !Number.isSafeInteger(options.maxContentBytes) || options.maxContentBytes < 1 || options.maxContentBytes > 1_048_576) {
    throw new TypeError("Sandbox write configuration was invalid");
  }
  const root = resolve(options.root);
  const rootMetadata = lstatSync(root, { bigint: true });
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new TypeError("Sandbox root must be a real directory");
  const rootIdentity = { dev: rootMetadata.dev, ino: rootMetadata.ino };
  const fdRoot = existsSync("/proc/self/fd") ? "/proc/self/fd" : existsSync("/dev/fd") ? "/dev/fd" : undefined;
  if (fdRoot === undefined) throw new TypeError("Sandbox descriptor-relative filesystem access is unavailable");
  const descriptorChildrenReady = probeDescriptorChildren(root, rootIdentity, fdRoot);
  if (!descriptorChildrenReady && options.testOnlyAllowPathFallback !== true) {
    throw new TypeError("Sandbox descriptor-relative child traversal is unavailable; startup refused");
  }
  const probe = lstatSync(root);
  if (!probe.isDirectory()) throw new TypeError("Sandbox root identity was rejected");
  const maxPreimageBytes = options.maxPreimageBytes ?? options.maxContentBytes;
  const maxCompensationBytes = options.maxCompensationBytes ?? Math.min(1_048_576, Math.max(4_096, maxPreimageBytes * 2));
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(maxPreimageBytes) || maxPreimageBytes < 1 || maxPreimageBytes > 1_048_576 ||
      !Number.isSafeInteger(maxCompensationBytes) || maxCompensationBytes < 256 || maxCompensationBytes > 1_048_576 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError("Sandbox compensation bounds were invalid");
  }
  const key = new Uint8Array(options.compensationKey);
  void realpathSync(root); // Fail startup if the configured root cannot be resolved now.

  const adapter: ToolAdapter = {
    descriptor: Object.freeze({ id: "sandbox-file.write", displayName: "Sandbox file write", effect: "side-effecting", reversibility: "compensatable" }),
    async execute(invocation): Promise<ToolOutcome> {
      const parameters = parseParameters(invocation.parameters, options.maxContentBytes);
      return await withinSandboxDeadline(timeoutMs, invocation.signal, async (signal) => {
        const segments = parsePath(parameters.path);
        const opened = await openParent(root, rootIdentity, descriptorChildrenReady ? fdRoot : "", segments);
        try {
          const targetPath = `${fdBase(descriptorChildrenReady ? fdRoot : "", opened.parent, opened.parentPath)}/${opened.targetName}`;
          const before = await readBoundedFile(targetPath, maxPreimageBytes);
          if (sha256(before ?? "") !== parameters.expectedCurrentSha256) throw knownFailure("execution_conflict", "Sandbox target hash changed");
          const content = new TextEncoder().encode(parameters.content);
          const postHash = sha256(content);
          const token = seal({
            path: parameters.path,
            beforeBase64: before === undefined ? null : Buffer.from(before).toString("base64"),
            expectedPostSha256: postHash,
          }, key, maxCompensationBytes);
          // Recheck immediately at the descriptor-anchored rename boundary.
          const current = await readBoundedFile(targetPath, maxPreimageBytes);
          if (sha256(current ?? "") !== parameters.expectedCurrentSha256) throw knownFailure("execution_conflict", "Sandbox target hash changed");
          await atomicReplace(opened.parent, opened.parentPath, descriptorChildrenReady ? fdRoot : "", opened.targetName, content, signal, options.testHooks);
          const postimage = await readBoundedFile(targetPath, options.maxContentBytes);
          if (postimage === undefined || sha256(postimage) !== postHash) throw ambiguousFailure("Sandbox postimage could not be proven");
          return {
            outcome: "known_succeeded" as const,
            summary: { operation: before === undefined ? "created" : "replaced", byteCount: content.byteLength, postSha256: postHash },
            modelInput: JSON.stringify({ written: true, path: parameters.path, postSha256: postHash }),
            compensationToken: token,
          };
        } finally { await closeHandles(opened.handles); }
      });
    },
    async compensate(token, signal): Promise<ToolOutcome> {
      const record = unseal(token, key, maxCompensationBytes);
      return await withinSandboxDeadline(timeoutMs, signal, async (operationSignal) => {
        const segments = parsePath(record.path);
        const opened = await openParent(root, rootIdentity, descriptorChildrenReady ? fdRoot : "", segments);
        try {
          const targetPath = `${fdBase(descriptorChildrenReady ? fdRoot : "", opened.parent, opened.parentPath)}/${opened.targetName}`;
          const current = await readBoundedFile(targetPath, options.maxContentBytes);
          if (current === undefined || sha256(current) !== record.expectedPostSha256) {
            throw knownFailure("execution_conflict", "Sandbox compensation hash fence failed");
          }
          if (operationSignal.aborted) throw knownFailure("tool_failure", "Sandbox compensation was cancelled before mutation");
          if (record.beforeBase64 === null) {
            try {
              await unlink(targetPath);
              if (operationSignal.aborted) throw ambiguousFailure("Sandbox compensation was cancelled after delete");
              await opened.parent.sync();
            } catch (error: unknown) {
              if (typeof error === "object" && error !== null && "outcome" in error) throw error;
              throw ambiguousFailure("Sandbox compensation delete may have completed");
            }
          } else {
            const before = Buffer.from(record.beforeBase64, "base64");
            if (before.byteLength > maxPreimageBytes) throw knownFailure("invalid_parameters", "Compensation preimage was rejected");
            await atomicReplace(opened.parent, opened.parentPath, descriptorChildrenReady ? fdRoot : "", opened.targetName, before, operationSignal, options.testHooks);
          }
          return {
            outcome: "known_succeeded" as const,
            summary: { operation: record.beforeBase64 === null ? "deleted" : "restored", compensated: true },
            modelInput: JSON.stringify({ compensated: true, path: record.path }),
          };
        } finally { await closeHandles(opened.handles); }
      });
    },
  };
  return Object.freeze(adapter);
}
