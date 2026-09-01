import { createHash } from "node:crypto";

export const DIAGNOSTICS_BUNDLE_VERSION = "dao.diagnostics.v1" as const;
export const DIAGNOSTICS_MAX_ENTRIES = 10_000;
export const DIAGNOSTICS_MAX_BYTES = 1_048_576;

export const DIAGNOSTIC_CATEGORIES = [
  "authority",
  "cache",
  "configuration",
  "context_manifest",
  "environment_capability",
  "error_classification",
  "outbox",
  "repair",
  "schema",
  "worker",
] as const;

export type DiagnosticCategory = typeof DIAGNOSTIC_CATEGORIES[number];
export type DiagnosticScalar = string | number | boolean | null;

export type DiagnosticEntry = Readonly<{
  category: DiagnosticCategory;
  code: string;
  occurredAt: string;
  stableId?: string;
  state?: string;
  sizeBytes?: number;
  durationMs?: number;
  queueDepth?: number;
  attempt?: number;
  metadata?: Readonly<Record<string, DiagnosticScalar>>;
}>;

export type DiagnosticsBundle = Readonly<{
  filename: string;
  mediaType: "application/x-ndjson";
  bytes: Uint8Array;
  manifest: Readonly<{
    version: typeof DIAGNOSTICS_BUNDLE_VERSION;
    generatedAt: string;
    entryCount: number;
    byteLength: number;
    sha256: string;
    categories: readonly DiagnosticCategory[];
  }>;
}>;

const METADATA_FIELDS_BY_CATEGORY = Object.freeze({
  authority: new Set(["authorityVersion", "configured"]),
  cache: new Set(["deadLetterCount"]),
  configuration: new Set(["configured"]),
  context_manifest: new Set(["itemCount", "manifestVersion", "sourceCount"]),
  environment_capability: new Set(["available", "capabilityVersion"]),
  error_classification: new Set(["retryable"]),
  outbox: new Set(["deadLetterCount"]),
  repair: new Set(["recordKindCount"]),
  schema: new Set(["configured", "schemaVersion", "version"]),
  worker: new Set(["deadLetterCount", "maxActive", "maxBatch", "maxQueue"]),
} satisfies Readonly<Record<DiagnosticCategory, ReadonlySet<string>>>);

const DIAGNOSTIC_CODES_BY_CATEGORY = Object.freeze({
  authority: new Set(["authority_ready", "authority_degraded"]),
  cache: new Set(["cache_invalidation_queue"]),
  configuration: new Set(["configuration_present", "configuration_missing"]),
  context_manifest: new Set(["context_manifest_health"]),
  environment_capability: new Set(["capability_present", "capability_missing"]),
  error_classification: new Set(["provider_failure", "storage_failure", "protocol_failure"]),
  outbox: new Set(["authority_outbox_queue"]),
  repair: new Set(["repair_health"]),
  schema: new Set(["authority_schema_current", "current"]),
  worker: new Set(["healthy", "backlog_warning", "backlog_critical", "dead_letter", "closed"]),
} satisfies Readonly<Record<DiagnosticCategory, ReadonlySet<string>>>);

const DIAGNOSTIC_STATES = new Set([
  "ready", "noauth", "degraded", "pending", "failed", "dead_letter", "closed",
]);
const SENSITIVE_TOKEN = /(?:^|[._:-])(?:api[_-]?key|authorization|credential|password|secret|session[_-]?token|sk|token)(?:$|[._:-])/iu;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isSafeToken(value: string, maxBytes = 128): boolean {
  return Buffer.byteLength(value, "utf8") <= maxBytes && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function assertBoundedInteger(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new TypeError(`${name} must be a bounded non-negative integer`);
  }
}

function normalizeEntry(entry: DiagnosticEntry): DiagnosticEntry {
  if (!(DIAGNOSTIC_CATEGORIES as readonly string[]).includes(entry.category)) {
    throw new TypeError("diagnostic category is not closed");
  }
  if (!isSafeToken(entry.code) || !DIAGNOSTIC_CODES_BY_CATEGORY[entry.category].has(entry.code) ||
      SENSITIVE_TOKEN.test(entry.code) || !isIsoTimestamp(entry.occurredAt)) {
    throw new TypeError("diagnostic identity or time is invalid");
  }
  if (entry.stableId !== undefined &&
      (!isSafeToken(entry.stableId) || SENSITIVE_TOKEN.test(entry.stableId))) {
    throw new TypeError("diagnostic stableId is invalid");
  }
  if (entry.state !== undefined &&
      (!isSafeToken(entry.state, 64) || !DIAGNOSTIC_STATES.has(entry.state))) {
    throw new TypeError("diagnostic state is invalid");
  }
  assertBoundedInteger("sizeBytes", entry.sizeBytes);
  assertBoundedInteger("durationMs", entry.durationMs);
  assertBoundedInteger("queueDepth", entry.queueDepth);
  assertBoundedInteger("attempt", entry.attempt);
  const metadata: Record<string, DiagnosticScalar> = {};
  for (const [key, value] of Object.entries(entry.metadata ?? {})) {
    if (!isSafeToken(key, 64) || !METADATA_FIELDS_BY_CATEGORY[entry.category].has(key)) {
      throw new TypeError("diagnostic metadata key is forbidden");
    }
    if (typeof value === "string") {
      throw new TypeError("diagnostic metadata strings are not part of the closed schema");
    }
    if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
      throw new TypeError("diagnostic metadata number is invalid");
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new TypeError("diagnostic metadata value is not a closed scalar");
    }
    metadata[key] = value;
  }
  return Object.freeze({ ...entry, ...(Object.keys(metadata).length === 0 ? {} : { metadata: Object.freeze(metadata) }) });
}

export function createDiagnosticsBundle(input: Readonly<{
  generatedAt: string;
  entries: readonly DiagnosticEntry[];
}>): DiagnosticsBundle {
  if (!isIsoTimestamp(input.generatedAt)) throw new TypeError("generatedAt must be canonical ISO time");
  if (input.entries.length > DIAGNOSTICS_MAX_ENTRIES) throw new RangeError("diagnostics entry limit exceeded");
  const entries = input.entries.map(normalizeEntry).sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.category.localeCompare(right.category) ||
    left.code.localeCompare(right.code) || (left.stableId ?? "").localeCompare(right.stableId ?? ""));
  const payload = entries.map((entry) => `${canonical(entry)}\n`).join("");
  const bytes = new TextEncoder().encode(payload);
  if (bytes.byteLength > DIAGNOSTICS_MAX_BYTES) throw new RangeError("diagnostics byte limit exceeded");
  const categories = Object.freeze([...new Set(entries.map((entry) => entry.category))].sort());
  const manifest = Object.freeze({
    version: DIAGNOSTICS_BUNDLE_VERSION,
    generatedAt: input.generatedAt,
    entryCount: entries.length,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    categories,
  });
  return Object.freeze({
    filename: `dao-diagnostics-${input.generatedAt.replaceAll(":", "-")}.ndjson`,
    mediaType: "application/x-ndjson",
    bytes,
    manifest,
  });
}
