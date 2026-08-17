import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { AgentRuntimeError, type ToolAdapter, type ToolOutcome } from "../contracts.js";

interface SandboxFileWriteOptions {
  readonly root: string;
  readonly compensationKey: Uint8Array;
  readonly maxContentBytes: number;
}

interface WriteParameters {
  readonly path: string;
  readonly content: string;
  readonly expectedCurrentSha256: string;
}

interface CompensationRecord {
  readonly path: string;
  readonly before: string | null;
  readonly expectedPostSha256: string;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseParameters(value: Readonly<Record<string, unknown>>, maxContentBytes: number): WriteParameters {
  if (Object.keys(value).sort().join("\0") !== ["content", "expectedCurrentSha256", "path"].join("\0") ||
      typeof value.path !== "string" || typeof value.content !== "string" ||
      typeof value.expectedCurrentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedCurrentSha256) ||
      value.path.length === 0 || value.path.length > 512 || isAbsolute(value.path) || value.path.includes("\\") ||
      value.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      Buffer.byteLength(value.content, "utf8") > maxContentBytes) {
    throw new AgentRuntimeError("invalid_parameters", "Sandbox write parameters were rejected");
  }
  return value as unknown as WriteParameters;
}

function seal(record: CompensationRecord, key: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(record), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function unseal(token: string, key: Uint8Array): CompensationRecord {
  try {
    const packed = Buffer.from(token, "base64url");
    if (packed.length < 29) throw new Error("short");
    const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const parsed: unknown = JSON.parse(Buffer.concat([
      decipher.update(packed.subarray(28)),
      decipher.final(),
    ]).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
    const record = parsed as Record<string, unknown>;
    if (typeof record.path !== "string" || (record.before !== null && typeof record.before !== "string") ||
        typeof record.expectedPostSha256 !== "string") throw new Error("shape");
    return record as unknown as CompensationRecord;
  } catch {
    throw new AgentRuntimeError("invalid_parameters", "Compensation token was rejected");
  }
}

async function atomicWrite(target: string, content: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AgentRuntimeError("tool_failure", "Sandbox write was cancelled before dispatch");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.dao-${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (signal.aborted) {
    await rm(temporary, { force: true });
    throw new AgentRuntimeError("tool_failure", "Sandbox write was cancelled before dispatch");
  }
  await rename(temporary, target);
}

export function createSandboxFileWriteAdapter(options: SandboxFileWriteOptions): ToolAdapter {
  if (!isAbsolute(options.root) || options.compensationKey.byteLength !== 32 ||
      !Number.isSafeInteger(options.maxContentBytes) || options.maxContentBytes < 1 || options.maxContentBytes > 1_048_576) {
    throw new TypeError("Sandbox write configuration was invalid");
  }
  const root = resolve(options.root);
  const key = new Uint8Array(options.compensationKey);
  const resolveTarget = (path: string): string => {
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new AgentRuntimeError("invalid_parameters", "Sandbox write target escaped its root");
    }
    return target;
  };

  const adapter: ToolAdapter = {
    descriptor: Object.freeze({
      id: "sandbox-file.write",
      displayName: "Sandbox file write",
      effect: "side-effecting",
      reversibility: "compensatable",
    }),
    async execute(invocation): Promise<ToolOutcome> {
      const parameters = parseParameters(invocation.parameters, options.maxContentBytes);
      const target = resolveTarget(parameters.path);
      let before: Uint8Array | undefined;
      try {
        before = await readFile(target);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentRuntimeError("tool_failure", "Sandbox target could not be read");
      }
      const currentHash = sha256(before ?? "");
      if (currentHash !== parameters.expectedCurrentSha256) {
        throw new AgentRuntimeError("execution_conflict", "Sandbox target hash changed");
      }
      await atomicWrite(target, parameters.content, invocation.signal);
      const postHash = sha256(parameters.content);
      const token = seal({
        path: parameters.path,
        before: before === undefined ? null : Buffer.from(before).toString("base64"),
        expectedPostSha256: postHash,
      }, key);
      return {
        summary: {
          operation: before === undefined ? "created" : "replaced",
          byteCount: Buffer.byteLength(parameters.content, "utf8"),
          postSha256: postHash,
        },
        modelInput: JSON.stringify({ written: true, path: parameters.path, postSha256: postHash }),
        compensationToken: token,
      };
    },
    async compensate(token, signal): Promise<ToolOutcome> {
      const record = unseal(token, key);
      const target = resolveTarget(record.path);
      let current: Uint8Array;
      try {
        current = await readFile(target);
      } catch {
        throw new AgentRuntimeError("execution_conflict", "Sandbox compensation target was missing");
      }
      if (sha256(current) !== record.expectedPostSha256) {
        throw new AgentRuntimeError("execution_conflict", "Sandbox compensation hash fence failed");
      }
      if (signal.aborted) throw new AgentRuntimeError("tool_failure", "Sandbox compensation was cancelled");
      if (record.before === null) {
        await rm(target);
      } else {
        await atomicWrite(target, Buffer.from(record.before, "base64").toString("utf8"), signal);
      }
      return {
        summary: { operation: record.before === null ? "deleted" : "restored", compensated: true },
        modelInput: JSON.stringify({ compensated: true, path: record.path }),
      };
    },
  };
  return Object.freeze(adapter);
}
