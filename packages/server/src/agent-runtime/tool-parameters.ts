import { createHash } from "node:crypto";
import {
  TOOL_CANONICALIZER_VERSION,
  isExternalToolId,
  type SafeToolPreview,
  type ToolId,
} from "@native-im/core";

export const TOOL_PARAMETER_SCHEMAS = Object.freeze({
  "http-json.read": "http-json.read.parameters.v1",
  "repository.git-status": "repository.git-status.parameters.v1",
  "sandbox-file.write": "sandbox-file.write.parameters.v1",
} as const);

export type ToolParameterSchemaVersion = typeof TOOL_PARAMETER_SCHEMAS[ToolId];

export type ToolParameterErrorCode =
  | "bytes_exceeded"
  | "depth_exceeded"
  | "duplicate_key"
  | "extra_field"
  | "invalid_json"
  | "invalid_number"
  | "invalid_shape"
  | "invalid_unicode"
  | "non_nfc"
  | "unknown_tool"
  | "unsupported_version"
  | "width_exceeded";

export class ToolParameterError extends TypeError {
  constructor(readonly code: ToolParameterErrorCode, message: string) {
    super(message);
    this.name = "ToolParameterError";
  }
}

export interface ToolParameterLimits {
  readonly maxInputBytes: number;
  readonly maxCanonicalBytes: number;
  readonly maxDepth: number;
  readonly maxContainerEntries: number;
  readonly maxTotalNodes: number;
  readonly maxPreviewBytes: number;
}

export const DEFAULT_TOOL_PARAMETER_LIMITS: ToolParameterLimits = Object.freeze({
  maxInputBytes: 256 * 1_024,
  maxCanonicalBytes: 256 * 1_024,
  maxDepth: 32,
  maxContainerEntries: 256,
  maxTotalNodes: 4_096,
  maxPreviewBytes: 2_048,
});

const HARD_TOOL_PARAMETER_LIMITS: ToolParameterLimits = Object.freeze({
  maxInputBytes: 1_048_576,
  maxCanonicalBytes: 1_048_576,
  maxDepth: 128,
  maxContainerEntries: 4_096,
  maxTotalNodes: 65_536,
  maxPreviewBytes: 8_192,
});

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonRecord = { readonly [key: string]: JsonValue };

interface CanonicalToolParameterBase<TToolId extends ToolId, TParsed> {
  readonly toolId: TToolId;
  readonly schemaVersion: typeof TOOL_PARAMETER_SCHEMAS[TToolId];
  readonly canonicalizerVersion: typeof TOOL_CANONICALIZER_VERSION;
  readonly parsed: Readonly<TParsed>;
  readonly canonicalParameters: string;
  readonly canonicalParameterSha256: string;
  readonly parameterBytes: number;
  readonly safePreview: SafeToolPreview;
  readonly safePreviewCanonical: string;
}

export type ParsedToolParameters =
  | CanonicalToolParameterBase<"http-json.read", { readonly path: string }>
  | CanonicalToolParameterBase<"repository.git-status", Record<never, never>>
  | CanonicalToolParameterBase<"sandbox-file.write", {
      readonly path: string;
      readonly content: string;
      readonly expectedCurrentSha256: string;
    }>;

type LimitOverrides = Partial<ToolParameterLimits>;

function limits(overrides: LimitOverrides | undefined): ToolParameterLimits {
  const merged = { ...DEFAULT_TOOL_PARAMETER_LIMITS, ...overrides };
  for (const key of Object.keys(merged) as (keyof ToolParameterLimits)[]) {
    const value = merged[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_TOOL_PARAMETER_LIMITS[key]) {
      throw new TypeError(`Tool parameter limit ${key} was invalid`);
    }
  }
  return Object.freeze(merged);
}

function validateUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ToolParameterError("invalid_unicode", "Tool parameters contained an unpaired surrogate");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new ToolParameterError("invalid_unicode", "Tool parameters contained an unpaired surrogate");
    }
  }
  if (value.normalize("NFC") !== value) {
    throw new ToolParameterError("non_nfc", "Tool parameter strings must use NFC normalization");
  }
}

class StrictJsonParser {
  private cursor = 0;
  private nodes = 0;

  constructor(
    private readonly source: string,
    private readonly budget: ToolParameterLimits,
  ) {}

  parse(): JsonValue {
    this.white();
    const value = this.value(1);
    this.white();
    if (this.cursor !== this.source.length) this.fail("invalid_json", "Trailing JSON input was rejected");
    return value;
  }

  private value(depth: number): JsonValue {
    if (depth > this.budget.maxDepth) this.fail("depth_exceeded", "Tool parameters exceeded their depth limit");
    this.nodes += 1;
    if (this.nodes > this.budget.maxTotalNodes) this.fail("width_exceeded", "Tool parameters exceeded their node limit");
    const current = this.source[this.cursor];
    if (current === "{") return this.object(depth);
    if (current === "[") return this.array(depth);
    if (current === "\"") return this.string();
    if (current === "t" && this.take("true")) return true;
    if (current === "f" && this.take("false")) return false;
    if (current === "n" && this.take("null")) return null;
    if (current === "-" || (current !== undefined && current >= "0" && current <= "9")) return this.number();
    this.fail("invalid_json", "Tool parameters were not strict JSON");
  }

  private object(depth: number): JsonRecord {
    this.cursor += 1;
    this.white();
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const keys = new Set<string>();
    let entries = 0;
    if (this.source[this.cursor] === "}") {
      this.cursor += 1;
      return result;
    }
    while (true) {
      if (this.source[this.cursor] !== "\"") this.fail("invalid_json", "JSON object keys must be strings");
      const key = this.string();
      if (keys.has(key)) this.fail("duplicate_key", "Duplicate JSON object keys were rejected");
      keys.add(key);
      entries += 1;
      if (entries > this.budget.maxContainerEntries) this.fail("width_exceeded", "JSON object exceeded its width limit");
      this.white();
      if (this.source[this.cursor] !== ":") this.fail("invalid_json", "JSON object separator was missing");
      this.cursor += 1;
      this.white();
      Object.defineProperty(result, key, {
        configurable: false, enumerable: true, writable: false, value: this.value(depth + 1),
      });
      this.white();
      const separator = this.source[this.cursor];
      if (separator === "}") {
        this.cursor += 1;
        return Object.freeze(result);
      }
      if (separator !== ",") this.fail("invalid_json", "JSON object delimiter was invalid");
      this.cursor += 1;
      this.white();
    }
  }

  private array(depth: number): readonly JsonValue[] {
    this.cursor += 1;
    this.white();
    const result: JsonValue[] = [];
    if (this.source[this.cursor] === "]") {
      this.cursor += 1;
      return Object.freeze(result);
    }
    while (true) {
      if (result.length >= this.budget.maxContainerEntries) this.fail("width_exceeded", "JSON array exceeded its width limit");
      result.push(this.value(depth + 1));
      this.white();
      const separator = this.source[this.cursor];
      if (separator === "]") {
        this.cursor += 1;
        return Object.freeze(result);
      }
      if (separator !== ",") this.fail("invalid_json", "JSON array delimiter was invalid");
      this.cursor += 1;
      this.white();
    }
  }

  private string(): string {
    const start = this.cursor;
    this.cursor += 1;
    let escaped = false;
    while (this.cursor < this.source.length) {
      const code = this.source.charCodeAt(this.cursor);
      if (!escaped && code === 0x22) {
        this.cursor += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(this.source.slice(start, this.cursor));
        } catch {
          this.fail("invalid_json", "JSON string escape was invalid");
        }
        if (typeof parsed !== "string") this.fail("invalid_json", "JSON string was malformed");
        validateUnicode(parsed);
        return parsed;
      }
      if (!escaped && code < 0x20) this.fail("invalid_json", "Unescaped control character was rejected");
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.cursor += 1;
    }
    this.fail("invalid_json", "JSON string was unterminated");
  }

  private number(): number {
    const remaining = this.source.slice(this.cursor);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(remaining);
    if (match === null) this.fail("invalid_json", "JSON number was malformed");
    this.cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("invalid_number", "Non-finite JSON numbers were rejected");
    return value;
  }

  private white(): void {
    while (this.cursor < this.source.length &&
      (this.source[this.cursor] === "\t" || this.source[this.cursor] === "\n" ||
        this.source[this.cursor] === "\r" || this.source[this.cursor] === " ")) {
      this.cursor += 1;
    }
  }

  private take(token: string): boolean {
    if (!this.source.startsWith(token, this.cursor)) return false;
    this.cursor += token.length;
    return true;
  }

  private fail(code: ToolParameterErrorCode, message: string): never {
    throw new ToolParameterError(code, message);
  }
}

function canonicalValue(value: unknown, budget: ToolParameterLimits, depth: number, state: { nodes: number }): string {
  if (depth > budget.maxDepth) throw new ToolParameterError("depth_exceeded", "Canonical JSON exceeded its depth limit");
  state.nodes += 1;
  if (state.nodes > budget.maxTotalNodes) throw new ToolParameterError("width_exceeded", "Canonical JSON exceeded its node limit");
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ToolParameterError("invalid_number", "Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    validateUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > budget.maxContainerEntries) throw new ToolParameterError("width_exceeded", "Canonical array exceeded its width limit");
    return `[${value.map((entry) => canonicalValue(entry, budget, depth + 1, state)).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new ToolParameterError("invalid_shape", "Canonical JSON accepts only JSON values");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolParameterError("invalid_shape", "Canonical JSON object prototype was rejected");
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new ToolParameterError("invalid_shape", "Canonical JSON symbol keys were rejected");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length > budget.maxContainerEntries) throw new ToolParameterError("width_exceeded", "Canonical object exceeded its width limit");
  for (const key of keys) validateUnicode(key);
  keys.sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key], budget, depth + 1, state)}`).join(",")}}`;
}

export function canonicalizeJsonRfc8785ProfileV1(
  value: unknown,
  overrides?: LimitOverrides,
): string {
  const budget = limits(overrides);
  const canonical = canonicalValue(value, budget, 1, { nodes: 0 });
  if (Buffer.byteLength(canonical, "utf8") > budget.maxCanonicalBytes) {
    throw new ToolParameterError("bytes_exceeded", "Canonical JSON exceeded its byte limit");
  }
  return canonical;
}

function strictObject(value: JsonValue): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolParameterError("invalid_shape", "Tool parameters must be a JSON object");
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, required: readonly string[]): void {
  const actual = Object.keys(value);
  const extras = actual.filter((key) => !required.includes(key));
  if (extras.length > 0) throw new ToolParameterError("extra_field", "Extra tool parameter fields were rejected");
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new ToolParameterError("invalid_shape", "Required tool parameter fields were missing");
  }
}

function parseHttp(value: JsonRecord): Readonly<{ path: string }> {
  exactKeys(value, ["path"]);
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.length > 256 ||
      !/^[A-Za-z0-9._~-]+$/u.test(value.path)) {
    throw new ToolParameterError("invalid_shape", "HTTP JSON path slot was rejected");
  }
  return Object.freeze({ path: value.path });
}

function parseGit(value: JsonRecord): Readonly<Record<never, never>> {
  exactKeys(value, []);
  return Object.freeze({});
}

function parseSandbox(value: JsonRecord, budget: ToolParameterLimits): Readonly<{
  path: string; content: string; expectedCurrentSha256: string;
}> {
  exactKeys(value, ["path", "content", "expectedCurrentSha256"]);
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.length > 512 ||
      value.path.startsWith("/") || value.path.includes("\\") ||
      value.path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
      typeof value.content !== "string" || Buffer.byteLength(value.content, "utf8") > budget.maxCanonicalBytes ||
      typeof value.expectedCurrentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.expectedCurrentSha256)) {
    throw new ToolParameterError("invalid_shape", "Sandbox file parameters were rejected");
  }
  return Object.freeze({
    path: value.path,
    content: value.content,
    expectedCurrentSha256: value.expectedCurrentSha256,
  });
}

function safePreview(toolId: ToolId, parsed: ParsedToolParameters["parsed"]): SafeToolPreview {
  switch (toolId) {
    case "http-json.read":
      return Object.freeze({
        schemaVersion: "tool-safe-preview.v1",
        target: "Configured HTTP JSON source",
        summary: `Read configured path slot (${Buffer.byteLength((parsed as { path: string }).path, "utf8")} UTF-8 bytes; sha256 ${createHash("sha256").update((parsed as { path: string }).path, "utf8").digest("hex").slice(0, 12)}…)`,
        impact: "Reads bounded JSON through the configured credential-free endpoint",
        reversibility: "none",
      });
    case "repository.git-status":
      return Object.freeze({
        schemaVersion: "tool-safe-preview.v1",
        target: "Configured repository",
        summary: "Read bounded working-tree status",
        impact: "Runs the fixed read-only Git status operation",
        reversibility: "none",
      });
    case "sandbox-file.write": {
      const write = parsed as { path: string; content: string; expectedCurrentSha256: string };
      return Object.freeze({
        schemaVersion: "tool-safe-preview.v1",
        target: write.path,
        summary: `Create or replace a sandbox file (${Buffer.byteLength(write.content, "utf8")} UTF-8 bytes; expected ${write.expectedCurrentSha256.slice(0, 12)}…)`,
        impact: "Writes one configured sandbox-relative file after an exact hash fence",
        reversibility: "compensatable",
      });
    }
  }
}

function hashDomain(parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("dao.tool-parameters.binding.v1\0", "utf8");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")), "ascii");
    hash.update(":", "ascii");
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export function parseToolParameters(input: Readonly<{
  readonly toolId: unknown;
  readonly argumentsJson: string;
  readonly expectedSchemaVersion?: string;
  readonly canonicalizerVersion?: string;
  readonly limits?: LimitOverrides;
}>): ParsedToolParameters {
  if (!isExternalToolId(input.toolId)) {
    throw new ToolParameterError("unknown_tool", "Unknown physical tool was rejected");
  }
  const toolId = input.toolId;
  const budget = limits(input.limits);
  if (typeof input.argumentsJson !== "string" || Buffer.byteLength(input.argumentsJson, "utf8") > budget.maxInputBytes) {
    throw new ToolParameterError("bytes_exceeded", "Tool parameter input exceeded its byte limit");
  }
  const schemaVersion = TOOL_PARAMETER_SCHEMAS[toolId];
  if ((input.expectedSchemaVersion !== undefined && input.expectedSchemaVersion !== schemaVersion) ||
      (input.canonicalizerVersion !== undefined && input.canonicalizerVersion !== TOOL_CANONICALIZER_VERSION)) {
    throw new ToolParameterError("unsupported_version", "Tool parameter version was not supported");
  }
  let json: JsonValue;
  try {
    json = new StrictJsonParser(input.argumentsJson, budget).parse();
  } catch (error: unknown) {
    if (error instanceof ToolParameterError) throw error;
    throw new ToolParameterError("invalid_json", "Tool parameters were not strict JSON");
  }
  const object = strictObject(json);
  const parsed = toolId === "http-json.read" ? parseHttp(object) :
    toolId === "repository.git-status" ? parseGit(object) : parseSandbox(object, budget);
  const canonicalParameters = canonicalizeJsonRfc8785ProfileV1(parsed, budget);
  const preview = safePreview(toolId, parsed);
  const safePreviewCanonical = canonicalizeJsonRfc8785ProfileV1(preview, {
    ...budget,
    maxCanonicalBytes: budget.maxPreviewBytes,
  });
  const common = {
    toolId,
    schemaVersion,
    canonicalizerVersion: TOOL_CANONICALIZER_VERSION,
    parsed,
    canonicalParameters,
    canonicalParameterSha256: hashDomain([
      toolId, schemaVersion, TOOL_CANONICALIZER_VERSION, canonicalParameters,
    ]),
    parameterBytes: Buffer.byteLength(canonicalParameters, "utf8"),
    safePreview: preview,
    safePreviewCanonical,
  };
  return common as ParsedToolParameters;
}
