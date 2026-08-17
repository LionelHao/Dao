import { createHash } from "node:crypto";
import { AgentRuntimeError, type ToolAdapter, type ToolInvocation } from "../contracts.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface HttpJsonReadOptions {
  readonly origin: string;
  readonly pathPrefix: string;
  readonly maxResponseBytes: number;
  readonly fetch?: FetchLike;
}

function closedParameters(value: Readonly<Record<string, unknown>>): string {
  if (Object.keys(value).length !== 1 || typeof value.path !== "string" ||
      value.path.length === 0 || value.path.length > 256 || !/^[A-Za-z0-9._~-]+$/.test(value.path)) {
    throw new AgentRuntimeError("invalid_parameters", "HTTP JSON parameters were rejected");
  }
  return value.path;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) throw new AgentRuntimeError("tool_failure", "HTTP JSON response body was missing");
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    throw new AgentRuntimeError("tool_failure", "HTTP JSON response exceeded its byte limit");
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
        throw new AgentRuntimeError("tool_failure", "HTTP JSON response exceeded its byte limit");
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

export function createHttpJsonReadAdapter(options: HttpJsonReadOptions): ToolAdapter {
  const origin = new URL(options.origin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search !== "" || origin.hash !== "" ||
      origin.username !== "" || origin.password !== "") {
    throw new TypeError("HTTP JSON origin must be a credential-free HTTPS origin");
  }
  if (!options.pathPrefix.startsWith("/") || options.pathPrefix.includes("..") || options.pathPrefix.includes("?")) {
    throw new TypeError("HTTP JSON pathPrefix must be an absolute closed path prefix");
  }
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 128 || options.maxResponseBytes > 1_048_576) {
    throw new TypeError("maxResponseBytes must be between 128 and 1048576");
  }
  const fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);

  return Object.freeze({
    descriptor: Object.freeze({
      id: "http-json.read",
      displayName: "HTTP JSON read",
      effect: "read-only",
      reversibility: "compensatable",
    }),
    async execute(invocation: ToolInvocation) {
      const path = closedParameters(invocation.parameters);
      const url = new URL(`${options.pathPrefix}${encodeURIComponent(path)}`, origin);
      if (url.origin !== origin.origin) throw new AgentRuntimeError("invalid_parameters", "HTTP JSON target was rejected");
      let response: Response;
      try {
        response = await fetchRequest(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: invocation.signal,
        });
      } catch (error: unknown) {
        void error;
        throw new AgentRuntimeError(invocation.signal.aborted ? "tool_failure" : "tool_target_busy", "HTTP JSON target was unavailable");
      }
      if (!response.ok) throw new AgentRuntimeError(response.status >= 500 ? "tool_target_busy" : "tool_failure", "HTTP JSON target rejected the request");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw new AgentRuntimeError("tool_failure", "HTTP JSON content type was rejected");
      const bytes = await readBounded(response, options.maxResponseBytes);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      try {
        JSON.parse(text);
      } catch {
        throw new AgentRuntimeError("tool_failure", "HTTP JSON body was malformed");
      }
      return {
        summary: {
          statusCategory: "success",
          schemaValid: true,
          byteCount: bytes.byteLength,
          bodySha256: createHash("sha256").update(bytes).digest("hex"),
        },
        modelInput: text,
      };
    },
  });
}
