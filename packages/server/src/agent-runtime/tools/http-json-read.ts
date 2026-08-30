import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ToolAdapter, ToolInvocation } from "../contracts.js";
import { knownFailure } from "./adapter-outcome.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ResolvedAddress = Readonly<{ address: string; family: 4 | 6 }>;

export interface HttpJsonReadOptions {
  readonly origin: string;
  readonly pathPrefix: string;
  readonly maxResponseBytes: number;
  readonly timeoutMs?: number;
  readonly maxJsonDepth?: number;
  readonly maxJsonNodes?: number;
  /** Deep-test seam only. Production uses a DNS-pinned node:https request. */
  readonly fetch?: FetchLike;
  readonly resolveHost?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

function closedParameters(value: Readonly<Record<string, unknown>>): string {
  if (Object.keys(value).length !== 1 || typeof value.path !== "string" ||
      value.path.length === 0 || value.path.length > 256 || value.path !== value.path.normalize("NFC") ||
      !/^[A-Za-z0-9._~-]+$/.test(value.path)) {
    throw knownFailure("invalid_parameters", "HTTP JSON parameters were rejected");
  }
  return value.path;
}

function parseIpv6Words(address: string): readonly number[] | undefined {
  if (address.includes("%") || isIP(address) !== 6) return undefined;
  let source = address.toLowerCase();
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(source)?.[1];
  if (dotted !== undefined) {
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
    source = `${source.slice(0, -dotted.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((part) => Number.parseInt(part, 16));
  return words.length === 8 && words.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? words
    : undefined;
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  const words = parseIpv6Words(address);
  if (words === undefined) return false;
  const [a, b, c, d, e, f] = words;
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
  if (dotted !== undefined && !isPublicAddress(dotted)) return false;
  return !(
    a === 0 || // unspecified, loopback, IPv4-compatible, translated, and mapped forms
    (a === 0x0064 && b === 0xff9b &&
      ((c === 0 && d === 0 && e === 0 && f === 0) || c === 1)) || // both standardized NAT64 prefixes
    (a === 0x0100 && b === 0 && c === 0 && d === 0) || // discard-only
    (a === 0x2001 && b! <= 0x01ff) || // IETF protocol assignments, including Teredo
    (a === 0x2001 && b === 0x0db8) || // documentation
    a === 0x2002 || // 6to4 embeds an IPv4 target
    (a! & 0xfff0) === 0x3ff0 || // documentation
    a === 0x5f00 || // segment-routing special-purpose block
    (a! & 0xfe00) === 0xfc00 || // unique local
    (a! & 0xffc0) === 0xfe80 || // link local
    (a! & 0xffc0) === 0xfec0 || // deprecated site local
    (a! & 0xff00) === 0xff00 || // multicast
    (a === 0x2620 && b === 0x004f && c === 0x8000) // special-purpose AS112 service prefix
  );
}

function validateAddresses(addresses: readonly ResolvedAddress[]): readonly ResolvedAddress[] {
  if (addresses.length === 0 || addresses.length > 32 ||
      addresses.some(({ address, family }) => isIP(address) !== family || !isPublicAddress(address))) {
    throw knownFailure("tool_failure", "HTTP JSON DNS target was rejected");
  }
  return [...new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()];
}

function assertJsonBudget(value: unknown, maxDepth: number, maxNodes: number): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) throw knownFailure("tool_failure", "HTTP JSON shape exceeded its limit");
    if (Array.isArray(current)) {
      for (const child of current) visit(child, depth + 1);
    } else if (typeof current === "object" && current !== null) {
      const entries = Object.entries(current);
      if (entries.length > 1_024) throw knownFailure("tool_failure", "HTTP JSON object was too wide");
      for (const [key, child] of entries) {
        if (key.length > 1_024 || key !== key.normalize("NFC")) throw knownFailure("tool_failure", "HTTP JSON object key was rejected");
        visit(child, depth + 1);
      }
    }
  };
  visit(value, 0);
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) throw knownFailure("tool_failure", "HTTP JSON response body was missing");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw knownFailure("tool_failure", "HTTP JSON response exceeded its byte limit");
  }
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    throw knownFailure("tool_failure", "HTTP JSON content encoding was rejected");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw knownFailure("tool_failure", "HTTP JSON response exceeded its byte limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function pinnedFetch(url: URL, addresses: readonly ResolvedAddress[], signal: AbortSignal): Promise<Response> {
  const selected = addresses[0]!;
  return await new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(url, {
      method: "GET",
      headers: { Accept: "application/json", "Accept-Encoding": "identity" },
      signal,
      servername: url.hostname,
      lookup(_hostname, _options, callback) { callback(null, selected.address, selected.family); },
    }, (incoming) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          incoming.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          incoming.once("end", () => controller.close());
          incoming.once("error", (error) => controller.error(error));
        },
        cancel() { incoming.destroy(); },
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      resolve(new Response(stream, { status: incoming.statusCode ?? 500, headers }));
    });
    req.once("error", reject);
    req.end();
  });
}

export function createHttpJsonReadAdapter(options: HttpJsonReadOptions): ToolAdapter {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
      origin.username !== "" || origin.password !== "" || isIP(origin.hostname) !== 0) {
    throw new TypeError("HTTP JSON origin must be a credential-free HTTPS public hostname, not an IP literal");
  }
  if (!options.pathPrefix.startsWith("/") || options.pathPrefix.includes("..") || options.pathPrefix.includes("?") ||
      options.pathPrefix.includes("#") || options.pathPrefix.includes("\\") || options.pathPrefix !== options.pathPrefix.normalize("NFC")) {
    throw new TypeError("HTTP JSON pathPrefix must be an absolute closed path prefix");
  }
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 128 || options.maxResponseBytes > 1_048_576) {
    throw new TypeError("maxResponseBytes must be between 128 and 1048576");
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxJsonDepth = options.maxJsonDepth ?? 32;
  const maxJsonNodes = options.maxJsonNodes ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxJsonDepth) || maxJsonDepth < 1 || maxJsonDepth > 64 ||
      !Number.isSafeInteger(maxJsonNodes) || maxJsonNodes < 1 || maxJsonNodes > 100_000) {
    throw new TypeError("HTTP JSON safety bounds were invalid");
  }
  const resolveHost = options.resolveHost ?? (options.fetch === undefined
    ? async (hostname: string) => await lookup(hostname, { all: true, verbatim: true }) as readonly ResolvedAddress[]
    : async () => [{ address: "8.8.8.8", family: 4 as const }]);

  return Object.freeze({
    descriptor: Object.freeze({ id: "http-json.read", displayName: "HTTP JSON read", effect: "read-only", reversibility: "compensatable" }),
    async execute(invocation: ToolInvocation) {
      const path = closedParameters(invocation.parameters);
      const url = new URL(`${options.pathPrefix}${encodeURIComponent(path)}`, origin);
      if (url.origin !== origin.origin || url.username !== "" || url.password !== "") throw knownFailure("invalid_parameters", "HTTP JSON target was rejected");
      const controller = new AbortController();
      const abort = () => controller.abort(invocation.signal.reason);
      invocation.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("deadline")), timeoutMs);
      try {
        const addresses = validateAddresses(await resolveHost(origin.hostname));
        const response = options.fetch === undefined
          ? await pinnedFetch(url, addresses, controller.signal)
          : await options.fetch(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json", "Accept-Encoding": "identity" },
            redirect: "error",
            signal: controller.signal,
          });
        if (response.redirected || (response.url !== "" && new URL(response.url).origin !== origin.origin)) {
          throw knownFailure("tool_failure", "HTTP JSON redirect was rejected");
        }
        if (!response.ok) throw knownFailure(response.status >= 500 ? "tool_target_busy" : "tool_failure", "HTTP JSON target rejected the request");
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") throw knownFailure("tool_failure", "HTTP JSON content type was rejected");
        const bytes = await readBounded(response, options.maxResponseBytes);
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw knownFailure("tool_failure", "HTTP JSON UTF-8 was malformed"); }
        let parsed: unknown;
        try { parsed = JSON.parse(text); }
        catch { throw knownFailure("tool_failure", "HTTP JSON body was malformed"); }
        assertJsonBudget(parsed, maxJsonDepth, maxJsonNodes);
        return {
          outcome: "known_succeeded" as const,
          summary: { statusCategory: "success", schemaValid: true, byteCount: bytes.byteLength, bodySha256: createHash("sha256").update(bytes).digest("hex") },
          modelInput: text,
        };
      } catch (error: unknown) {
        if (typeof error === "object" && error !== null && "outcome" in error) throw error;
        throw knownFailure(controller.signal.aborted ? "tool_failure" : "tool_target_busy", "HTTP JSON target was unavailable");
      } finally {
        clearTimeout(timer);
        invocation.signal.removeEventListener("abort", abort);
      }
    },
  });
}
