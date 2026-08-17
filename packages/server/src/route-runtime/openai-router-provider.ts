import { isRouterPlan, type RouterProviderInput } from "@native-im/core";
import type { SecretProvider } from "../agent-runtime/contracts.js";
import { RouteRuntimeError, type RouterProvider } from "./contracts.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface OpenAIRouterProviderOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly secretProvider: SecretProvider;
  readonly fetch?: FetchLike;
}

async function boundedResponseBody(response: Response, limit: number): Promise<string> {
  if (response.body === null) throw new RouteRuntimeError("provider_malformed", "Router response body was missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let output = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) throw new RouteRuntimeError("provider_malformed", "Router response exceeded its byte limit");
      output += decoder.decode(next.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch (error: unknown) {
    if (error instanceof RouteRuntimeError) throw error;
    throw new RouteRuntimeError("provider_malformed", "Router response encoding was invalid");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function outputText(response: unknown): string {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new RouteRuntimeError("provider_malformed", "Router response envelope was invalid");
  }
  const output = (response as { readonly output?: unknown }).output;
  if (!Array.isArray(output)) throw new RouteRuntimeError("provider_malformed", "Router response output was invalid");
  const texts: string[] = [];
  for (const item of output) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const content = (item as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "object" && part !== null && !Array.isArray(part) &&
          (part as { readonly type?: unknown }).type === "output_text" &&
          typeof (part as { readonly text?: unknown }).text === "string") {
        texts.push((part as { readonly text: string }).text);
      }
    }
  }
  if (texts.length !== 1) throw new RouteRuntimeError("provider_malformed", "Router response text was not singular");
  return texts[0]!;
}

export function createOpenAIRouterProvider(options: OpenAIRouterProviderOptions): RouterProvider {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.hash !== "") {
    throw new TypeError("OpenAI Router endpoint must be a credential-free HTTPS URL");
  }
  if (options.model.trim().length === 0) throw new TypeError("Router model must be non-empty");
  const fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);
  return Object.freeze({
    async decide(input: RouterProviderInput, signal: AbortSignal) {
      if (input.purpose !== "route_decision") {
        throw new RouteRuntimeError("provider_malformed", "Router input purpose was rejected");
      }
      const secret = options.secretProvider.getSecret("OPENAI_API_KEY");
      if (secret === undefined || secret.length === 0) {
        throw new RouteRuntimeError("provider_failure", "Router model authentication is not configured");
      }
      const requestBody = JSON.stringify({
        model: options.model,
        store: false,
        input: [{
          role: "user",
          content: [{
            type: "input_text",
            text: `Return only the closed route plan for this summary input:\n${JSON.stringify(input)}`,
          }],
        }],
        text: {
          format: {
            type: "json_schema",
            name: "route_plan",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["candidates"],
              properties: {
                candidates: {
                  type: "array",
                  maxItems: input.limits.maxCandidates,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["agentId", "trigger", "order", "reasonCode", "reasonText"],
                    properties: {
                      agentId: { type: "string" },
                      trigger: { type: "string", enum: ["domain", "risk", "structured_mention", "ball"] },
                      order: { type: "integer", minimum: 1 },
                      reasonCode: { type: "string", enum: ["domain_match", "risk_detected", "structured_help", "ball_due"] },
                      reasonText: { type: "string", minLength: 1, maxLength: 512 },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (Buffer.byteLength(requestBody, "utf8") > 128 * 1_024) {
        throw new RouteRuntimeError("provider_malformed", "Router input exceeded its byte limit");
      }
      let response: Response;
      try {
        response = await fetchRequest(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: requestBody,
          signal,
          redirect: "error",
        });
      } catch {
        throw new RouteRuntimeError(signal.aborted ? "provider_timeout" : "provider_failure", "Router request failed");
      }
      if (!response.ok) {
        throw new RouteRuntimeError(
          response.status === 408 || response.status === 504 ? "provider_timeout" : "provider_failure",
          "Router provider rejected the request",
        );
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new RouteRuntimeError("provider_malformed", "Router response content type was rejected");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(await boundedResponseBody(response, input.limits.maxOutputBytes));
      } catch (error: unknown) {
        if (error instanceof RouteRuntimeError) throw error;
        throw new RouteRuntimeError("provider_malformed", "Router response JSON was invalid");
      }
      let plan: unknown;
      try {
        plan = JSON.parse(outputText(envelope));
      } catch (error: unknown) {
        if (error instanceof RouteRuntimeError) throw error;
        throw new RouteRuntimeError("provider_malformed", "Router plan JSON was invalid");
      }
      if (!isRouterPlan(plan)) throw new RouteRuntimeError("provider_malformed", "Router plan was invalid");
      return plan;
    },
  });
}
