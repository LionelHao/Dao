import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import {
  lstat,
  link,
  open,
  readlink,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type {
  AgentRuntimeToolAdapter,
  AgentRuntimeCompensatableToolAdapter,
  AgentRuntimeToolOutcome,
  RuntimeJsonValue,
} from "./contracts.js";

const DEFAULT_MAX_BYTES = 65_536;
const SHA256 = /^[0-9a-f]{64}$/u;
const LOCK_HOLDER_SCRIPT = [
  "process.stdout.write('locked\\n');",
  "process.stdin.resume();",
  "process.stdin.once('end', () => process.exit(0));",
].join("");

type JsonObject = { readonly [key: string]: RuntimeJsonValue };

export class AgentRuntimeToolAdapterError extends Error {
  readonly code:
    | "invalid_parameters"
    | "target_forbidden"
    | "target_conflict"
    | "response_too_large"
    | "tool_failed";
  readonly status: number;
  readonly effectOutcomeUnknown: boolean;
  readonly sealedCompensation?: string;

  constructor(
    code: AgentRuntimeToolAdapterError["code"],
    status: number,
    message: string,
    options: { readonly effectOutcomeUnknown?: boolean; readonly sealedCompensation?: string } = {},
  ) {
    super(message);
    this.name = "AgentRuntimeToolAdapterError";
    this.code = code;
    this.status = status;
    this.effectOutcomeUnknown = options.effectOutcomeUnknown ?? false;
    if (options.sealedCompensation !== undefined) {
      this.sealedCompensation = options.sealedCompensation;
    }
  }
}

function fail(
  code: AgentRuntimeToolAdapterError["code"],
  status: number,
  message: string,
): never {
  throw new AgentRuntimeToolAdapterError(code, status, message);
}

function objectParameters(value: RuntimeJsonValue, keys: readonly string[]): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("invalid_parameters", 400, "Tool parameters must be a closed object");
  }
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    return fail("invalid_parameters", 400, "Tool parameters did not match the closed schema");
  }
  return value as JsonObject;
}

function stringParameter(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    return fail("invalid_parameters", 400, `Tool parameter ${key} must be a string`);
  }
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const cleanup = (): void => signal.removeEventListener("abort", handleAbort);
    const handleAbort = (): void => {
      cleanup();
      onAbort?.();
      rejectPromise(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    void promise.then(
      (value) => { cleanup(); resolvePromise(value); },
      (error: unknown) => { cleanup(); rejectPromise(error); },
    );
  });
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function parseIpv4(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function parseIpv6(address: string): bigint | undefined {
  if (isIP(address) !== 6) return undefined;
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const [leftRaw = "", rightRaw = ""] = normalized.split("::");
  const convert = (part: string): string[] => {
    if (part === "") return [];
    const pieces = part.split(":");
    const tail = pieces.at(-1);
    if (tail !== undefined && tail.includes(".")) {
      const ipv4 = parseIpv4(tail);
      if (ipv4 === undefined) return [];
      pieces.splice(pieces.length - 1, 1,
        ((ipv4 >>> 16) & 0xffff).toString(16), (ipv4 & 0xffff).toString(16));
    }
    return pieces;
  };
  const left = convert(leftRaw);
  const right = convert(rightRaw);
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (!normalized.includes("::") && omitted !== 0)) return undefined;
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) {
    return [
      [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
      [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
      [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
      [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
    ].some(([base, prefix]) => inIpv4Range(ipv4, base as number, prefix as number));
  }
  const ipv6 = parseIpv6(normalized);
  if (ipv6 === undefined) return true;
  const mappedBase = 0xffffn;
  if ((ipv6 >> 32n) === mappedBase) {
    return isPrivateAddress([
      Number((ipv6 >> 24n) & 0xffn), Number((ipv6 >> 16n) & 0xffn),
      Number((ipv6 >> 8n) & 0xffn), Number(ipv6 & 0xffn),
    ].join("."));
  }
  const globalUnicast = inIpv6Range(ipv6, 0x20000000000000000000000000000000n, 3);
  if (!globalUnicast) return true;
  return ([
    [0x20010000000000000000000000000000n, 23],
    [0x20020000000000000000000000000000n, 16],
  ] as const).some(([base, prefix]) => inIpv6Range(ipv6, base, prefix));
}

function pinnedHttpsFetch(
  url: URL,
  signal: AbortSignal,
  address: string,
): Promise<Response> {
  return new Promise((resolveResponse, rejectResponse) => {
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      rejectResponse(new TypeError("HTTP JSON tool resolver returned a non-IP address"));
      return;
    }
    const request = httpsRequest(url, {
      method: "GET",
      signal,
      servername: url.hostname,
      headers: { accept: "application/json", "accept-encoding": "identity" },
      lookup(_hostname, _options, callback) {
        callback(null, address, family);
      },
    }, (incoming) => {
      const status = incoming.statusCode ?? 502;
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }
      const hasBody = status !== 204 && status !== 205 && status !== 304;
      const response = new Response(
        hasBody ? Readable.toWeb(incoming) as unknown as BodyInit : null,
        { status, headers },
      );
      Object.defineProperty(response, "url", { value: url.toString() });
      Object.defineProperty(response, "redirected", {
        value: status >= 300 && status < 400,
      });
      resolveResponse(response);
    });
    request.once("error", rejectResponse);
    request.end();
  });
}

export interface HttpJsonReadToolOptions {
  readonly origin: string;
  readonly pathTemplate: string;
  readonly queryParameterNames?: readonly string[];
  readonly maxResponseBytes?: number;
  readonly allowPrivateAddresses?: boolean;
  readonly resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  readonly fetchImpl?: typeof fetch;
}

export function createHttpJsonReadTool(
  options: HttpJsonReadToolOptions,
): AgentRuntimeToolAdapter {
  const originUrl = new URL(options.origin);
  if (originUrl.protocol !== "https:" || originUrl.username !== "" || originUrl.password !== "" ||
      originUrl.pathname !== "/" || originUrl.search !== "" || originUrl.hash !== "") {
    throw new TypeError("HTTP JSON tool origin must be an HTTPS origin without credentials or path");
  }
  if (!options.pathTemplate.startsWith("/") || options.pathTemplate.includes("?") ||
      options.pathTemplate.includes("#") || options.pathTemplate.split("/").includes("..")) {
    throw new TypeError("HTTP JSON tool path template must be an absolute closed path");
  }
  const placeholders = [...options.pathTemplate.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)]
    .map((match) => match[1] as string);
  if (new Set(placeholders).size !== placeholders.length) {
    throw new TypeError("HTTP JSON tool path placeholders must be unique");
  }
  const queryNames = [...(options.queryParameterNames ?? [])];
  if (new Set([...placeholders, ...queryNames]).size !== placeholders.length + queryNames.length ||
      queryNames.some((name) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(name))) {
    throw new TypeError("HTTP JSON tool parameter names must be unique identifiers");
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new TypeError("HTTP JSON tool maxResponseBytes must be a positive safe integer");
  }
  const resolveHostname = options.resolveHostname ?? (async (hostname) =>
    (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address));
  const allowedKeys = [...placeholders, ...queryNames];

  return {
    descriptor: {
      id: "http-json.read",
      description: "Read bounded JSON from one configured HTTPS endpoint",
      confirmationRequirement: "read_only",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        required: allowedKeys,
        properties: Object.fromEntries(allowedKeys.map((key) => [key, { type: "string" }])),
      },
    },
    async execute(parameters, signal) {
      abortIfNeeded(signal);
      const object = objectParameters(parameters, allowedKeys);
      let pathname = options.pathTemplate;
      for (const name of placeholders) {
        pathname = pathname.replace(`{${name}}`, encodeURIComponent(stringParameter(object, name)));
      }
      const url = new URL(pathname, originUrl);
      for (const name of queryNames) url.searchParams.set(name, stringParameter(object, name));
      if (url.origin !== originUrl.origin) {
        return fail("target_forbidden", 403, "HTTP JSON tool target escaped its configured origin");
      }
      const hostname = url.hostname.replace(/^\[|\]$/gu, "");
      if (isIP(hostname) !== 0 && !options.allowPrivateAddresses) {
        return fail("target_forbidden", 403, "HTTP JSON tool IP literals are forbidden");
      }
      const addresses = await raceAbort(resolveHostname(hostname), signal);
      if (addresses.length === 0 ||
          (!options.allowPrivateAddresses && addresses.some(isPrivateAddress))) {
        return fail("target_forbidden", 403, "HTTP JSON tool resolved to a forbidden address");
      }
      abortIfNeeded(signal);
      let response: Response;
      try {
        response = options.fetchImpl === undefined
          ? await pinnedHttpsFetch(url, signal, addresses[0] as string)
          : await options.fetchImpl(url, {
              method: "GET",
              redirect: "error",
              signal,
              headers: { accept: "application/json", "accept-encoding": "identity" },
            });
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason ?? error;
        return fail("tool_failed", 502, "HTTP JSON tool request failed");
      }
      if (response.redirected || (response.url !== "" && new URL(response.url).origin !== originUrl.origin)) {
        await response.body?.cancel();
        return fail("target_forbidden", 403, "HTTP JSON tool redirect was refused");
      }
      if (!response.ok) {
        await response.body?.cancel();
        return fail("tool_failed", 502, "HTTP JSON tool returned a non-success status");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
        await response.body?.cancel();
        return fail("tool_failed", 502, "HTTP JSON tool response was not JSON");
      }
      const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
      if (contentEncoding !== undefined && contentEncoding !== "" && contentEncoding !== "identity") {
        await response.body?.cancel();
        return fail("tool_failed", 502, "HTTP JSON tool response encoding was not identity");
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null && Number(declaredLength) > maxResponseBytes) {
        await response.body?.cancel();
        return fail("response_too_large", 413, "HTTP JSON tool response exceeded its byte limit");
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        if (reader !== undefined) {
          while (true) {
            abortIfNeeded(signal);
            const part = await raceAbort(reader.read(), signal, () => {
              void reader.cancel(signal.reason).catch(() => undefined);
            });
            if (part.done) break;
            totalBytes += part.value.byteLength;
            if (totalBytes > maxResponseBytes) {
              return fail("response_too_large", 413, "HTTP JSON tool response exceeded its byte limit");
            }
            chunks.push(part.value);
          }
        }
      } finally {
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        return fail("tool_failed", 502, "HTTP JSON tool returned malformed JSON");
      }
      if (parsed === null || typeof parsed !== "object") {
        return fail("tool_failed", 502, "HTTP JSON tool returned an unsupported JSON root");
      }
      return {
        modelInput: parsed as Exclude<RuntimeJsonValue, null>,
        closedSummary: `http_json_read:${response.status}:${totalBytes}:${sha256(bytes)}`,
      };
    },
  };
}

interface SpawnOptions {
  readonly gitBinaryPath: string;
  readonly repositoryRoot: string;
  readonly maxOutputBytes?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly spawnImpl?: typeof spawn;
}

function collectChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  maxBytes: number,
  signal: AbortSignal,
  acceptedCodes: readonly number[] = [0],
): Promise<{ readonly code: number; readonly stdout: Buffer }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const stdout: Buffer[] = [];
    let totalBytes = 0;
    let overflow = false;
    const consume = (chunk: Buffer): void => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stdout.push(chunk);
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        overflow = true;
        child.kill("SIGKILL");
      }
    });
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      child.kill("SIGKILL");
      cleanup();
      rejectPromise(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      cleanup();
      if (signal.aborted) rejectPromise(signal.reason);
      else rejectPromise(
        new AgentRuntimeToolAdapterError("tool_failed", 502, "Git status tool process failed"),
      );
    });
    child.once("close", (code) => {
      cleanup();
      if (signal.aborted) {
        rejectPromise(signal.reason);
        return;
      }
      if (overflow) {
        rejectPromise(new AgentRuntimeToolAdapterError(
          "response_too_large", 413, "Git status tool output exceeded its byte limit",
        ));
      } else if (code === null || !acceptedCodes.includes(code)) {
        rejectPromise(new AgentRuntimeToolAdapterError(
          "tool_failed", 502, "Git status tool returned a non-success status",
        ));
      } else {
        resolvePromise({ code, stdout: Buffer.concat(stdout) });
      }
    });
  });
}

export function createRepositoryGitStatusTool(options: SpawnOptions): AgentRuntimeToolAdapter {
  if (!isAbsolute(options.gitBinaryPath) || !isAbsolute(options.repositoryRoot)) {
    throw new TypeError("Git status tool binary and repository root must be absolute");
  }
  const repositoryRoot = realpathSync(options.repositoryRoot);
  if (!statSync(repositoryRoot).isDirectory()) throw new TypeError("Git status root must be a directory");
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError("Git status maxOutputBytes must be a positive safe integer");
  }
  const sourceEnvironment = options.environment ?? process.env;
  const environment: Record<string, string> = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["LANG", "LC_ALL", "TMPDIR"] as const) {
    const value = sourceEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  return {
    descriptor: {
      id: "repository.git-status",
      description: "Read tracked working-tree status from one configured repository",
      confirmationRequirement: "read_only",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    async execute(parameters, signal) {
      objectParameters(parameters, []);
      abortIfNeeded(signal);
      const indexChild = spawnImpl(options.gitBinaryPath, [
        "-c", "core.fsmonitor=false", "-C", repositoryRoot, "ls-files", "--stage", "-z",
      ], {
        shell: false,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      const index = await collectChild(indexChild, maxOutputBytes, signal);
      const headChild = spawnImpl(options.gitBinaryPath, [
        "-C", repositoryRoot, "ls-tree", "-r", "-z", "HEAD",
      ], {
        shell: false,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      const head = await collectChild(headChild, maxOutputBytes, signal, [0, 128]);
      abortIfNeeded(signal);
      const parseEntries = (buffer: Buffer, source: "index" | "head") => {
        const entries = new Map<string, { readonly mode: string; readonly oid: string }>();
        for (const entry of buffer.toString("utf8").split("\0")) {
          if (entry === "") continue;
          const match = source === "index"
            ? /^(\d{6}) ([0-9a-f]{40,64}) 0\t(.+)$/u.exec(entry)
            : /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(entry);
          if (match === null) {
            return fail("tool_failed", 502, "Git status metadata was invalid");
          }
          entries.set(match[3] as string, { mode: match[1] as string, oid: match[2] as string });
        }
        return entries;
      };
      const indexEntries = parseEntries(index.stdout, "index");
      const headEntries = parseEntries(head.stdout, "head");
      const paths = [...new Set([...indexEntries.keys(), ...headEntries.keys()])].sort();
      const changes: { readonly status: string; readonly path: string }[] = [];
      for (const path of paths) {
        abortIfNeeded(signal);
        const indexed = indexEntries.get(path);
        const committed = headEntries.get(path);
        const indexStatus = indexed === undefined ? "D" : committed === undefined ? "A"
          : indexed.oid !== committed.oid || indexed.mode !== committed.mode ? "M" : " ";
        let worktreeStatus = " ";
        if (indexed !== undefined) {
          if (indexed.mode === "160000") {
            return fail("target_forbidden", 403, "Git status submodules are unsupported");
          }
          const target = resolve(repositoryRoot, path);
          if (target === repositoryRoot || !target.startsWith(`${repositoryRoot}${sep}`)) {
            return fail("target_forbidden", 403, "Git status path escaped its repository root");
          }
          const metadata = await lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (metadata === undefined) {
            worktreeStatus = "D";
          } else {
            let oid: string;
            if (indexed.mode === "120000") {
              const bytes = Buffer.from(await readlink(target), "utf8");
              oid = createHash(indexed.oid.length === 64 ? "sha256" : "sha1")
                .update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
            } else {
              const descriptor = await open(
                target,
                fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
              );
              try {
                const before = await descriptor.stat();
                if (!before.isFile()) return fail("target_forbidden", 403, "Git status tracked entry was not a regular file");
                const digest = createHash(indexed.oid.length === 64 ? "sha256" : "sha1")
                  .update(`blob ${before.size}\0`);
                const chunk = Buffer.allocUnsafe(64 * 1024);
                let position = 0;
                while (position < before.size) {
                  abortIfNeeded(signal);
                  const { bytesRead } = await raceAbort(
                    descriptor.read(chunk, 0, Math.min(chunk.byteLength, before.size - position), position),
                    signal,
                  );
                  if (bytesRead === 0) return fail("target_conflict", 409, "Git status tracked file changed while reading");
                  digest.update(chunk.subarray(0, bytesRead));
                  position += bytesRead;
                }
                const after = await descriptor.stat();
                if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
                    after.mtimeMs !== before.mtimeMs) {
                  return fail("target_conflict", 409, "Git status tracked file changed while reading");
                }
                oid = digest.digest("hex");
              } finally {
                await descriptor.close();
              }
            }
            const actualMode = indexed.mode === "120000"
              ? "120000"
              : (metadata.mode & 0o111) === 0 ? "100644" : "100755";
            if (oid !== indexed.oid || actualMode !== indexed.mode) worktreeStatus = "M";
          }
        }
        if (indexStatus !== " " || worktreeStatus !== " ") {
          changes.push({ status: `${indexStatus}${worktreeStatus}`, path });
        }
      }
      const encoded = Buffer.from(JSON.stringify(changes), "utf8");
      if (encoded.byteLength > maxOutputBytes) {
        return fail("response_too_large", 413, "Git status result exceeded its byte limit");
      }
      return {
        modelInput: { clean: changes.length === 0, changes },
        closedSummary: `git_status:${changes.length}:${sha256(encoded)}`,
      };
    },
  };
}

interface SandboxCompensationPayload {
  readonly version: 1;
  readonly path: string;
  readonly previousBase64: string | null;
  readonly postWriteSha256: string;
}

export interface SandboxFileWriteTool {
  readonly adapter: AgentRuntimeCompensatableToolAdapter;
  compensate(sealedCompensation: string, signal: AbortSignal): Promise<AgentRuntimeToolOutcome>;
}

export interface SandboxFileWriteToolOptions {
  readonly root: string;
  readonly compensationKey: Uint8Array;
  readonly maxContentBytes?: number;
  /** @internal Deterministic race seam for physical CAS tests; this module is not root-exported. */
  readonly afterTargetCapture?: (target: string) => Promise<void>;
}

function sealCompensation(key: Buffer, payload: SandboxCompensationPayload): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return ["v1", iv.toString("base64url"), ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url")].join(".");
}

function openCompensation(key: Buffer, token: string): SandboxCompensationPayload {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    return fail("invalid_parameters", 400, "Sandbox compensation token was invalid");
  }
  try {
    const iv = Buffer.from(parts[1] as string, "base64url");
    const ciphertext = Buffer.from(parts[2] as string, "base64url");
    const tag = Buffer.from(parts[3] as string, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const value: unknown = JSON.parse(Buffer.concat([
      decipher.update(ciphertext), decipher.final(),
    ]).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        Object.keys(value).sort().join("\0") !==
          "path\0postWriteSha256\0previousBase64\0version" ||
        (value as { version?: unknown }).version !== 1 ||
        typeof (value as { path?: unknown }).path !== "string" ||
        !SHA256.test(String((value as { postWriteSha256?: unknown }).postWriteSha256)) ||
        !((value as { previousBase64?: unknown }).previousBase64 === null ||
          typeof (value as { previousBase64?: unknown }).previousBase64 === "string")) {
      return fail("invalid_parameters", 400, "Sandbox compensation token was invalid");
    }
    return value as SandboxCompensationPayload;
  } catch (error: unknown) {
    if (error instanceof AgentRuntimeToolAdapterError) throw error;
    return fail("invalid_parameters", 400, "Sandbox compensation token was invalid");
  }
}

function closedRelativePath(value: string): string {
  if (value === "" || value.includes("\0") || value.includes("\\") ||
      value.includes("/") || isAbsolute(value) || value.split("/").some((part) =>
        part === "" || part === "." || part === ".." || part.startsWith(".native-im-"))) {
    return fail("invalid_parameters", 400, "Sandbox path must be a canonical relative path");
  }
  return value;
}

async function safeTarget(root: string, path: string): Promise<string> {
  const target = resolve(root, path);
  if (target === root || (!target.startsWith(`${root}${sep}`))) {
    return fail("target_forbidden", 403, "Sandbox path escaped its configured root");
  }
  const parent = await realpath(dirname(target)).catch(() => undefined);
  if (parent === undefined || (parent !== root && !parent.startsWith(`${root}${sep}`))) {
    return fail("target_forbidden", 403, "Sandbox parent was absent or escaped its configured root");
  }
  const metadata = await lstat(target).catch(() => undefined);
  if (metadata?.isSymbolicLink()) {
    return fail("target_forbidden", 403, "Sandbox symbolic-link targets are forbidden");
  }
  return target;
}

async function fsyncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

class PostEffectDurabilityError extends Error {
  constructor(readonly targetDurable: boolean) {
    super("Sandbox effect durability could not be confirmed");
    this.name = "PostEffectDurabilityError";
  }
}

function internalTargetPath(target: string, kind: "capture" | "write"): string {
  return join(
    dirname(target),
    `.native-im-${kind}-${sha256(Buffer.from(target, "utf8"))}`,
  );
}

async function writeDurableTemporary(
  target: string,
  content: Buffer,
  signal: AbortSignal,
): Promise<string> {
  abortIfNeeded(signal);
  const temporary = internalTargetPath(target, "write");
  const descriptor = await open(temporary, "wx", 0o600);
  try {
    await descriptor.writeFile(content);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  try {
    // The journal name itself is the fallback if the later target-name sync fails.
    await fsyncDirectory(dirname(target));
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new AgentRuntimeToolAdapterError(
      "tool_failed", 503, "Sandbox write journal durability could not be confirmed",
    );
  }
  return temporary;
}

async function publishNoClobber(
  temporary: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  abortIfNeeded(signal);
  try {
    await link(temporary, target);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return fail("target_conflict", 409, "Sandbox target changed before commit");
    }
    throw error;
  }
  try {
    // The new target name must be durable before the temporary name is removed.
    await fsyncDirectory(dirname(target));
  } catch {
    throw new PostEffectDurabilityError(false);
  }
  try {
    await unlink(temporary);
    await fsyncDirectory(dirname(target));
  } catch {
    throw new PostEffectDurabilityError(true);
  }
}

async function restoreCapturedTarget(captured: string, target: string): Promise<void> {
  try {
    await link(captured, target);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A non-cooperating writer published a newer target after capture. Preserve it.
  }
  // Never remove the last known durable name. First persist the restored/newer target,
  // then remove the journal and persist that removal as a separate metadata step.
  await fsyncDirectory(dirname(target));
  await unlink(captured);
  await fsyncDirectory(dirname(target));
}

async function recoverTargetJournals(
  target: string,
  maxBytes: number,
): Promise<void> {
  const captured = internalTargetPath(target, "capture");
  const write = internalTargetPath(target, "write");
  const capturedMetadata = await lstat(captured).catch(() => undefined);
  if (capturedMetadata !== undefined) {
    if (!capturedMetadata.isFile() || capturedMetadata.size > maxBytes) {
      return fail("target_conflict", 409, "Sandbox captured target journal was invalid");
    }
    // Prefer the old captured version when the target name did not survive a crash.
    await restoreCapturedTarget(captured, target);
  }
  const writeMetadata = await lstat(write).catch(() => undefined);
  if (writeMetadata === undefined) return;
  if (!writeMetadata.isFile() || writeMetadata.size > maxBytes) {
    return fail("target_conflict", 409, "Sandbox write journal was invalid");
  }
  const targetMetadata = await lstat(target).catch(() => undefined);
  if (targetMetadata === undefined) {
    // A write journal can exist before the target link is attempted. Without a
    // captured predecessor or surviving target name, recovery cannot distinguish
    // an authorized post-link crash from a pre-effect crash. Preserve the bounded
    // journal for reconciliation instead of silently publishing an uncommitted write.
    return fail("target_conflict", 409, "Sandbox write journal required reconciliation");
  }
  if (!targetMetadata.isFile()) {
    return fail("target_conflict", 409, "Sandbox recovered target was invalid");
  }
  await fsyncDirectory(dirname(target));
  await unlink(write);
  await fsyncDirectory(dirname(target));
}

async function captureTarget(target: string): Promise<string | null> {
  const captured = internalTargetPath(target, "capture");
  try {
    await rename(target, captured);
    try {
      // The journal is not a recovery point until its rename is durable.
      await fsyncDirectory(dirname(target));
    } catch {
      await restoreCapturedTarget(captured, target).catch(() => undefined);
      throw new AgentRuntimeToolAdapterError(
        "tool_failed", 503, "Sandbox target capture durability could not be confirmed",
      );
    }
    return captured;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withTargetLock<T>(
  target: string,
  operation: (assertOwnership: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const parent = dirname(target);
  const lockPath = join(parent, `.native-im-lock-${sha256(Buffer.from(target, "utf8"))}.lock`);
  const lock = await open(
    lockPath,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  ).catch(() => fail("target_conflict", 409, "Sandbox target lock could not be opened"));
  const lockMetadata = await lock.stat();
  if (!lockMetadata.isFile() || lockMetadata.size > 1024) {
    await lock.close();
    return fail("target_conflict", 409, "Sandbox target lock record was invalid");
  }
  const holder = spawn(
    "/usr/bin/lockf",
    ["-k", "-t", "0", "/dev/fd/3", process.execPath, "-e", LOCK_HOLDER_SCRIPT],
    {
      shell: false,
      env: { LANG: "C", PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe", lock.fd],
    },
  );
  const holderStdin = holder.stdin;
  const holderStdout = holder.stdout;
  const holderStderr = holder.stderr;
  if (holderStdin === null || holderStdout === null || holderStderr === null) {
    holder.kill("SIGKILL");
    await lock.close();
    return fail("target_conflict", 409, "Sandbox target lock holder was unavailable");
  }
  holderStdin.on("error", () => undefined);
  holderStderr.resume();
  const waitForClose = (): Promise<void> => new Promise((resolvePromise) => {
    if (holder.exitCode !== null || holder.signalCode !== null) resolvePromise();
    else holder.once("close", () => resolvePromise());
  });
  const acquired = await new Promise<boolean>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let settled = false;
    const cleanup = (): void => {
      holderStdout.off("data", handleStdout);
      holder.off("error", handleError);
      holder.off("close", handleClose);
    };
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const handleStdout = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > 64) {
        settled = true;
        cleanup();
        rejectPromise(new Error("Sandbox lock holder emitted invalid output"));
        return;
      }
      if (stdout === "locked\n") finish(true);
    };
    const handleError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const handleClose = (): void => finish(false);
    holderStdout.on("data", handleStdout);
    holder.once("error", handleError);
    holder.once("close", handleClose);
  }).catch(async (error: unknown) => {
    holder.kill("SIGKILL");
    await waitForClose();
    await lock.close().catch(() => undefined);
    throw error;
  });
  if (!acquired) {
    await lock.close().catch(() => undefined);
    return fail("target_conflict", 409, "Sandbox target is already being modified");
  }
  const assertOwnership = async (): Promise<void> => {
    if (holder.exitCode !== null || holder.signalCode !== null) {
      return fail("target_conflict", 409, "Sandbox target lock ownership was lost");
    }
    const current = await lstat(lockPath).catch(() => undefined);
    if (current === undefined || current.dev !== lockMetadata.dev || current.ino !== lockMetadata.ino) {
      return fail("target_conflict", 409, "Sandbox target lock identity changed");
    }
  };
  try {
    await assertOwnership();
    return await operation(assertOwnership);
  } finally {
    holderStdin.end();
    await waitForClose();
    await lock.close().catch(() => undefined);
  }
}

async function readBoundedFile(
  target: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer | null> {
  let descriptor: Awaited<ReturnType<typeof open>>;
  try {
    descriptor = await open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) return fail("target_forbidden", 403, "Sandbox target was not a regular file");
    if (before.size > maxBytes) return fail("response_too_large", 413, "Sandbox prior state exceeded its compensation limit");
    const result = Buffer.alloc(before.size);
    let position = 0;
    while (position < before.size) {
      abortIfNeeded(signal);
      const { bytesRead } = await raceAbort(
        descriptor.read(result, position, before.size - position, position), signal,
      );
      if (bytesRead === 0) return fail("target_conflict", 409, "Sandbox target changed while reading");
      position += bytesRead;
    }
    const after = await descriptor.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs) {
      return fail("target_conflict", 409, "Sandbox target changed while reading");
    }
    return result;
  } finally {
    await descriptor.close();
  }
}

export function createSandboxFileWriteTool(
  options: SandboxFileWriteToolOptions,
): SandboxFileWriteTool {
  if (!isAbsolute(options.root)) throw new TypeError("Sandbox root must be absolute");
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory()) throw new TypeError("Sandbox root must be a directory");
  const key = Buffer.from(options.compensationKey);
  if (key.byteLength !== 32) throw new TypeError("Sandbox compensation key must contain 32 bytes");
  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) {
    throw new TypeError("Sandbox maxContentBytes must be a positive safe integer");
  }
  const compensate = async (
    sealedCompensation: string,
    signal: AbortSignal,
  ): Promise<AgentRuntimeToolOutcome> => {
    const payload = openCompensation(key, sealedCompensation);
    const path = closedRelativePath(payload.path);
    const target = await safeTarget(root, path);
    return withTargetLock(target, async (assertOwnership) => {
      abortIfNeeded(signal);
      await assertOwnership();
      await recoverTargetJournals(target, maxContentBytes);
      const captured = await captureTarget(target);
      if (captured === null) {
        return fail("target_conflict", 409, "Sandbox compensation target was absent");
      }
      let capturedNeedsRecovery = true;
      let effectCommitted = false;
      let retainFallbacks = false;
      let temporary: string | undefined;
      try {
        await options.afterTargetCapture?.(target);
        const current = await readBoundedFile(captured, maxContentBytes, signal);
        if (current === null || sha256(current) !== payload.postWriteSha256) {
          await restoreCapturedTarget(captured, target);
          capturedNeedsRecovery = false;
          return fail("target_conflict", 409, "Sandbox compensation post-write hash did not match");
        }
        abortIfNeeded(signal);
        await assertOwnership();
        if (payload.previousBase64 === null) {
          // rename(target, captured) is the atomic deletion linearization point. A later
          // non-cooperating writer may create a new target and must be preserved.
          effectCommitted = true;
          await unlink(captured);
          capturedNeedsRecovery = false;
          try {
            await fsyncDirectory(dirname(target));
          } catch {
            throw new PostEffectDurabilityError(true);
          }
        } else {
          const previous = Buffer.from(payload.previousBase64, "base64");
          if (previous.byteLength > maxContentBytes) {
            return fail("response_too_large", 413, "Sandbox compensation state exceeded its byte limit");
          }
          temporary = await writeDurableTemporary(target, previous, signal);
          try {
            await publishNoClobber(temporary, target, signal);
            effectCommitted = true;
          } catch (error: unknown) {
            if (error instanceof PostEffectDurabilityError) {
              effectCommitted = true;
              retainFallbacks = !error.targetDurable;
            }
            throw error;
          }
          temporary = undefined;
          try {
            await unlink(captured);
            capturedNeedsRecovery = false;
            await fsyncDirectory(dirname(target));
          } catch {
            throw new PostEffectDurabilityError(true);
          }
        }
      } catch (error: unknown) {
        if (error instanceof PostEffectDurabilityError) {
          if (error.targetDurable) {
            capturedNeedsRecovery = false;
            await unlink(captured).catch(() => undefined);
          }
          throw new AgentRuntimeToolAdapterError(
            "tool_failed", 503, "Sandbox compensation durability could not be confirmed",
            { effectOutcomeUnknown: true },
          );
        }
        if (effectCommitted) {
          capturedNeedsRecovery = false;
          await unlink(captured).catch(() => undefined);
          throw new AgentRuntimeToolAdapterError(
            "tool_failed", 503, "Sandbox compensation outcome could not be confirmed",
            { effectOutcomeUnknown: true },
          );
        }
        if (capturedNeedsRecovery) {
          await restoreCapturedTarget(captured, target).catch(() => undefined);
          capturedNeedsRecovery = false;
        }
        throw error;
      } finally {
        if (!retainFallbacks && temporary !== undefined) {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }
      return {
        modelInput: { path, restored: payload.previousBase64 !== null },
        closedSummary: `sandbox_compensation:${payload.previousBase64 === null ? "deleted" : "restored"}:${path}`,
      };
    });
  };
  const adapter: AgentRuntimeCompensatableToolAdapter = {
    descriptor: {
      id: "sandbox-file.write",
      description: "Atomically write one bounded UTF-8 file beneath a configured sandbox root",
      confirmationRequirement: "side_effect",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content", "expectedCurrentSha256"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          expectedCurrentSha256: { type: ["string", "null"] },
        },
      },
    },
    async execute(parameters, signal) {
      const object = objectParameters(parameters, ["path", "content", "expectedCurrentSha256"]);
      const path = closedRelativePath(stringParameter(object, "path"));
      const content = stringParameter(object, "content");
      if (utf8Bytes(content) > maxContentBytes) {
        return fail("response_too_large", 413, "Sandbox content exceeded its byte limit");
      }
      const expected = object.expectedCurrentSha256;
      if (!(expected === null || (typeof expected === "string" && SHA256.test(expected)))) {
        return fail("invalid_parameters", 400, "Sandbox expected hash was invalid");
      }
      const target = await safeTarget(root, path);
      return withTargetLock(target, async (assertOwnership) => {
        await recoverTargetJournals(target, maxContentBytes);
        const next = Buffer.from(content, "utf8");
        const postWriteSha256 = sha256(next);
        let captured: string | null = null;
        let temporary = await writeDurableTemporary(target, next, signal);
        let published = false;
        let retainFallbacks = false;
        try {
          abortIfNeeded(signal);
          await assertOwnership();
          let previous: Buffer | null = null;
          if (expected !== null) {
            captured = await captureTarget(target);
            if (captured === null) {
              return fail("target_conflict", 409, "Sandbox current hash did not match");
            }
            await options.afterTargetCapture?.(target);
            previous = await readBoundedFile(captured, maxContentBytes, signal);
            if (previous === null || sha256(previous) !== expected) {
              await restoreCapturedTarget(captured, target);
              captured = null;
              return fail("target_conflict", 409, "Sandbox current hash did not match");
            }
          }
          const sealedCompensation = sealCompensation(key, {
            version: 1,
            path,
            previousBase64: previous?.toString("base64") ?? null,
            postWriteSha256,
          });
          if (utf8Bytes(sealedCompensation) > DEFAULT_MAX_BYTES) {
            return fail("response_too_large", 413, "Sandbox compensation token exceeded its byte limit");
          }
          abortIfNeeded(signal);
          await assertOwnership();
          try {
            await publishNoClobber(temporary, target, signal);
            temporary = "";
            published = true;
            if (captured !== null) {
              try {
                await unlink(captured);
                captured = null;
                await fsyncDirectory(dirname(target));
              } catch {
                throw new PostEffectDurabilityError(true);
              }
            }
          } catch (error: unknown) {
            if (error instanceof PostEffectDurabilityError) {
              published = true;
              retainFallbacks = !error.targetDurable;
              throw new AgentRuntimeToolAdapterError(
                "tool_failed", 503, "Sandbox write durability could not be confirmed",
                { effectOutcomeUnknown: true, sealedCompensation },
              );
            }
            throw error;
          }
          return {
            modelInput: { path, byteLength: next.byteLength, sha256: postWriteSha256 },
            closedSummary: `sandbox_write:${previous === null ? "create" : "replace"}:${next.byteLength}:${postWriteSha256}`,
            sealedCompensation,
          };
        } finally {
          if (!retainFallbacks && temporary !== "") {
            await rm(temporary, { force: true }).catch(() => undefined);
          }
          if (captured !== null) {
            if (retainFallbacks) {
              // Both journals are already directory-synced and intentionally survive for
              // recovery after an unconfirmed first target-name sync.
            } else if (published) await unlink(captured).catch(() => undefined);
            else await restoreCapturedTarget(captured, target).catch(() => undefined);
          }
        }
      });
    },
    compensate,
  };
  return {
    adapter,
    compensate,
  };
}
