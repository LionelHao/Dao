import {
  probeClamdVersion,
  type ClamdEndpoint,
} from "./clamd-scanner.js";
import {
  BoundedProcessError,
  runBoundedProcess,
} from "./process-runner.js";

export const PRODUCTION_ATTACHMENT_VERSIONS = Object.freeze({
  clamav: Object.freeze(["1.5.3", "1.4.5"] as const),
  poppler: "26.07.0",
  tesseract: "5.5.3",
});

export const PRODUCTION_CLAMD_POLICY = Object.freeze({
  streamMaxLengthBytes: 55 * 1_024 * 1_024,
  maxFileSizeBytes: 55 * 1_024 * 1_024,
  maxScanSizeBytes: 256 * 1_024 * 1_024,
  maxRecursion: 16,
  maxFiles: 10_000,
  scanTimeoutMs: 120_000,
});

export const PRODUCTION_CAPABILITY_LIMITS = Object.freeze({
  databaseFreshnessMs: 24 * 60 * 60 * 1_000,
  versionOutputBytes: 4_096,
});

export type ProductionCapabilityStatus = "ready" | "unavailable" | "degraded";

export type ProductionCapabilityReason =
  | "dependency_missing"
  | "probe_failed"
  | "unsupported_version"
  | "database_unverified"
  | "database_stale"
  | "configuration_unverified";

export interface ProductionToolProbeConfiguration {
  readonly executable: string;
  readonly argv: readonly string[];
}

export interface ProductionClamdPolicy {
  readonly streamMaxLengthBytes: number;
  readonly maxFileSizeBytes: number;
  readonly maxScanSizeBytes: number;
  readonly maxRecursion: number;
  readonly maxFiles: number;
  readonly scanTimeoutMs: number;
}

export interface ProductionAttachmentCapabilityOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly clamd: Readonly<{
    endpoint: ClamdEndpoint;
    databaseSha256: string;
    databaseUpdatedAt: string;
    policy: ProductionClamdPolicy;
  }>;
  readonly poppler: ProductionToolProbeConfiguration;
  readonly tesseract: ProductionToolProbeConfiguration;
  readonly now?: string;
}

export type SafeProductionToolCapability = Readonly<{
  status: ProductionCapabilityStatus;
  version: string | null;
  reason: ProductionCapabilityReason | null;
}>;

export type SafeProductionScannerCapability = Readonly<{
  status: ProductionCapabilityStatus;
  version: string | null;
  databaseSha256: string | null;
  databaseFreshness: "fresh" | "stale" | "unknown";
  reason: ProductionCapabilityReason | null;
}>;

export type SafeProductionAttachmentCapabilities = Readonly<{
  status: "ready" | "degraded";
  attachmentReadiness: "ready" | "unavailable";
  scanner: SafeProductionScannerCapability;
  poppler: SafeProductionToolCapability;
  tesseract: SafeProductionToolCapability;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function exactClamdPolicy(value: unknown): value is ProductionClamdPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  const keys = [
    "streamMaxLengthBytes",
    "maxFileSizeBytes",
    "maxScanSizeBytes",
    "maxRecursion",
    "maxFiles",
    "scanTimeoutMs",
  ] as const;
  const allowedKeys = new Set<string>(keys);
  if (!keys.every((key) => Object.hasOwn(policy, key)) ||
      !Reflect.ownKeys(policy).every((key) => typeof key === "string" && allowedKeys.has(key))) {
    return false;
  }
  const expected = PRODUCTION_CLAMD_POLICY;
  return policy.streamMaxLengthBytes === expected.streamMaxLengthBytes &&
    policy.maxFileSizeBytes === expected.maxFileSizeBytes &&
    policy.maxScanSizeBytes === expected.maxScanSizeBytes &&
    policy.maxRecursion === expected.maxRecursion && policy.maxFiles === expected.maxFiles &&
    policy.scanTimeoutMs === expected.scanTimeoutMs;
}

function safeToolCapability(
  status: ProductionCapabilityStatus,
  version: string | null,
  reason: ProductionCapabilityReason | null,
): SafeProductionToolCapability {
  return Object.freeze({ status, version, reason });
}

function safeScannerCapability(
  status: ProductionCapabilityStatus,
  version: string | null,
  databaseSha256: string | null,
  databaseFreshness: "fresh" | "stale" | "unknown",
  reason: ProductionCapabilityReason | null,
): SafeProductionScannerCapability {
  return Object.freeze({ status, version, databaseSha256, databaseFreshness, reason });
}

function detectedVersion(
  tool: "poppler" | "tesseract",
  stdout: Uint8Array,
  stderr: Uint8Array,
): string | undefined {
  const output = `${Buffer.from(stdout).toString("utf8")}\n${Buffer.from(stderr).toString("utf8")}`;
  return tool === "poppler"
    ? /(?:^|\n)(?:pdfinfo|pdftotext) version (\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1]
    : /(?:^|\n)tesseract (\d+\.\d+\.\d+)(?:\s|$)/u.exec(output)?.[1];
}

async function probeTool(
  configuration: ProductionToolProbeConfiguration,
  tool: "poppler" | "tesseract",
  expectedVersion: string,
  cwd: string,
  timeoutMs: number,
): Promise<SafeProductionToolCapability> {
  try {
    const result = await runBoundedProcess({
      executable: configuration.executable,
      argv: configuration.argv,
      cwd,
      timeoutMs,
      stdoutLimitBytes: PRODUCTION_CAPABILITY_LIMITS.versionOutputBytes,
      stderrLimitBytes: PRODUCTION_CAPABILITY_LIMITS.versionOutputBytes,
    });
    const version = detectedVersion(tool, result.stdout, result.stderr);
    if (version === undefined) return safeToolCapability("unavailable", null, "probe_failed");
    if (version !== expectedVersion) {
      return safeToolCapability("degraded", version, "unsupported_version");
    }
    return safeToolCapability("ready", version, null);
  } catch (error) {
    return safeToolCapability(
      "unavailable",
      null,
      error instanceof BoundedProcessError && error.reason === "unavailable"
        ? "dependency_missing"
        : "probe_failed",
    );
  }
}

async function probeScanner(
  options: ProductionAttachmentCapabilityOptions,
  now: string,
): Promise<SafeProductionScannerCapability> {
  let probe;
  try {
    probe = await probeClamdVersion({
      endpoint: options.clamd.endpoint,
      timeoutMs: options.timeoutMs,
    });
  } catch {
    return safeScannerCapability(
      "unavailable", null, null, "unknown", "configuration_unverified",
    );
  }
  if (probe.status === "unavailable") {
    return safeScannerCapability("unavailable", null, null, "unknown", "dependency_missing");
  }
  if (!exactClamdPolicy(options.clamd.policy)) {
    return safeScannerCapability(
      "unavailable", probe.version, null, "unknown", "configuration_unverified",
    );
  }
  if (!SHA256.test(options.clamd.databaseSha256) ||
      !isCanonicalTimestamp(options.clamd.databaseUpdatedAt)) {
    return safeScannerCapability(
      "unavailable", probe.version, null, "unknown", "database_unverified",
    );
  }
  const age = Date.parse(now) - Date.parse(options.clamd.databaseUpdatedAt);
  if (age < 0) {
    return safeScannerCapability(
      "unavailable", probe.version, null, "unknown", "database_unverified",
    );
  }
  if (age > PRODUCTION_CAPABILITY_LIMITS.databaseFreshnessMs) {
    return safeScannerCapability(
      "unavailable", probe.version, options.clamd.databaseSha256, "stale", "database_stale",
    );
  }
  if (!PRODUCTION_ATTACHMENT_VERSIONS.clamav.includes(
    probe.version as typeof PRODUCTION_ATTACHMENT_VERSIONS.clamav[number],
  )) {
    return safeScannerCapability(
      "degraded", probe.version, options.clamd.databaseSha256, "fresh", "unsupported_version",
    );
  }
  return safeScannerCapability(
    "ready", probe.version, options.clamd.databaseSha256, "fresh", null,
  );
}

export async function probeProductionAttachmentCapabilities(
  options: ProductionAttachmentCapabilityOptions,
): Promise<SafeProductionAttachmentCapabilities> {
  const now = options.now ?? new Date().toISOString();
  if (!isCanonicalTimestamp(now)) {
    return Object.freeze({
      status: "degraded",
      attachmentReadiness: "unavailable",
      scanner: safeScannerCapability("unavailable", null, null, "unknown", "probe_failed"),
      poppler: safeToolCapability("unavailable", null, "probe_failed"),
      tesseract: safeToolCapability("unavailable", null, "probe_failed"),
    });
  }
  const [scanner, poppler, tesseract] = await Promise.all([
    probeScanner(options, now),
    probeTool(options.poppler, "poppler", PRODUCTION_ATTACHMENT_VERSIONS.poppler,
      options.cwd, options.timeoutMs),
    probeTool(options.tesseract, "tesseract", PRODUCTION_ATTACHMENT_VERSIONS.tesseract,
      options.cwd, options.timeoutMs),
  ]);
  const ready = scanner.status === "ready" && poppler.status === "ready" &&
    tesseract.status === "ready";
  return Object.freeze({
    status: ready ? "ready" : "degraded",
    attachmentReadiness: ready ? "ready" : "unavailable",
    scanner,
    poppler,
    tesseract,
  });
}
