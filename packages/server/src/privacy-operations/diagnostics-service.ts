import {
  createDiagnosticsBundle,
  DIAGNOSTICS_MAX_ENTRIES,
  type DiagnosticEntry,
  type DiagnosticsBundle,
} from "./diagnostics.js";
import { DIAGNOSTICS_ARTIFACT_RETENTION_MS } from "./retention.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type DiagnosticsServiceErrorCode =
  | "invalid_request"
  | "forbidden"
  | "source_unavailable"
  | "unsafe_diagnostic"
  | "artifact_unavailable";

export class DiagnosticsServiceError extends Error {
  constructor(readonly code: DiagnosticsServiceErrorCode) {
    super(`Diagnostics generation failed: ${code}`);
    this.name = "DiagnosticsServiceError";
  }
}

export type DiagnosticsPrincipal = Readonly<{
  actorId: string;
  sessionFamilyId: string;
  sessionId: string;
  principalKind: "tenant_administrator";
}>;

export type DiagnosticsArtifactCommit = Readonly<{
  artifactId: string;
  byteLength: number;
}>;

export interface DiagnosticsServiceAuthority {
  /** Must derive the deployment principal from the authenticated session. */
  authorize(input: Readonly<{
    actorId: string;
    sessionFamilyId: string;
    sessionId: string;
  }>): Promise<DiagnosticsPrincipal>;
  /** This port deliberately has no Room identifier or Room-corpus query surface. */
  readClosedEntries(input: Readonly<{
    principal: DiagnosticsPrincipal;
    limit: number;
  }>): Promise<readonly DiagnosticEntry[]>;
  /** The production sink must atomically publish the complete bounded artifact. */
  commitArtifact(input: Readonly<{
    principal: DiagnosticsPrincipal;
    filename: string;
    mediaType: DiagnosticsBundle["mediaType"];
    bytes: Uint8Array;
    manifest: DiagnosticsBundle["manifest"];
    expiresAtMs: number;
  }>): Promise<DiagnosticsArtifactCommit>;
  /** Idempotently makes a committed artifact unavailable after audit publication fails. */
  discardArtifact(input: Readonly<{
    principal: DiagnosticsPrincipal;
    artifactId: string;
  }>): Promise<void>;
  audit(input: Readonly<{
    actorId: string;
    occurredAt: string;
    result: "succeeded" | "failed";
    failureCode?: "source_unavailable" | "unsafe_diagnostic" | "artifact_unavailable";
    artifactId?: string;
    entryCount?: number;
    byteLength?: number;
    sha256?: string;
  }>): Promise<void>;
}

export type DiagnosticsGenerationResult = Readonly<{
  artifactId: string;
  filename: string;
  mediaType: DiagnosticsBundle["mediaType"];
  expiresAt: string;
  manifest: DiagnosticsBundle["manifest"];
}>;

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function exactRequest(value: unknown): value is Readonly<{
  actorId: string;
  sessionFamilyId: string;
  sessionId: string;
}> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 3 && keys.includes("actorId") && keys.includes("sessionFamilyId") &&
    keys.includes("sessionId") && isSafeId(record.actorId) && isSafeId(record.sessionFamilyId) &&
    isSafeId(record.sessionId);
}

function validPrincipal(
  principal: DiagnosticsPrincipal,
  input: Readonly<{ actorId: string; sessionFamilyId: string; sessionId: string }>,
): boolean {
  return principal.principalKind === "tenant_administrator" &&
    principal.actorId === input.actorId && principal.sessionFamilyId === input.sessionFamilyId &&
    principal.sessionId === input.sessionId;
}

function validArtifactCommit(
  commit: DiagnosticsArtifactCommit,
  expectedByteLength: number,
): boolean {
  return isSafeId(commit.artifactId) && Number.isSafeInteger(commit.byteLength) &&
    commit.byteLength === expectedByteLength;
}

class DiagnosticsAuthorityAwaitAborted extends Error {}

function detached(action: () => void | Promise<void>): void {
  void Promise.resolve().then(action).catch(() => undefined);
}

function awaitAuthority<T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
  late?: Readonly<{
    resolved?(value: T): void | Promise<void>;
    rejected?(error: unknown): void | Promise<void>;
  }>,
): Promise<T> {
  if (signal?.aborted === true) return Promise.reject(new DiagnosticsAuthorityAwaitAborted());
  let source: Promise<T>;
  try {
    source = start();
  } catch (error) {
    return Promise.reject(error);
  }
  if (signal === undefined) return source;
  if (signal.aborted) {
    source.then((value) => {
      if (late?.resolved !== undefined) detached(() => late.resolved?.(value));
    }, (error: unknown) => {
      if (late?.rejected !== undefined) detached(() => late.rejected?.(error));
    });
    return Promise.reject(new DiagnosticsAuthorityAwaitAborted());
  }
  return new Promise<T>((resolve, reject) => {
    let terminal = false;
    let aborted = false;
    const onAbort = () => {
      if (terminal) return;
      terminal = true;
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      reject(new DiagnosticsAuthorityAwaitAborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    source.then((value) => {
      if (aborted) {
        if (late?.resolved !== undefined) detached(() => late.resolved?.(value));
        return;
      }
      if (terminal) return;
      terminal = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error: unknown) => {
      if (aborted) {
        if (late?.rejected !== undefined) detached(() => late.rejected?.(error));
        return;
      }
      if (terminal) return;
      terminal = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

async function safeAudit(
  authority: DiagnosticsServiceAuthority,
  input: Parameters<DiagnosticsServiceAuthority["audit"]>[0],
  signal?: AbortSignal,
): Promise<void> {
  try {
    await awaitAuthority(() => authority.audit(input), signal);
  } catch {
    // Telemetry/audit transport cannot make a rejected bundle safe or expose its input.
  }
}

async function safeDiscard(
  authority: DiagnosticsServiceAuthority,
  input: Parameters<DiagnosticsServiceAuthority["discardArtifact"]>[0],
  signal?: AbortSignal,
): Promise<void> {
  try {
    await awaitAuthority(() => authority.discardArtifact(input), signal);
  } catch {
    // The artifact port contract is idempotent; the caller still exposes only a typed failure.
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createDiagnosticsService(options: Readonly<{
  authority: DiagnosticsServiceAuthority;
  now?: () => Date;
}>): Readonly<{
  generate(input: Readonly<{ actorId: string; sessionFamilyId: string; sessionId: string }>,
    signal?: AbortSignal): Promise<DiagnosticsGenerationResult>;
}> {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async generate(input, signal) {
      if (!exactRequest(input)) throw new DiagnosticsServiceError("invalid_request");
      if (isAborted(signal)) throw new DiagnosticsServiceError("source_unavailable");
      let principal: DiagnosticsPrincipal;
      try {
        principal = await awaitAuthority(() => options.authority.authorize(input), signal);
      } catch (error) {
        if (error instanceof DiagnosticsAuthorityAwaitAborted) {
          throw new DiagnosticsServiceError("source_unavailable");
        }
        throw new DiagnosticsServiceError("forbidden");
      }
      if (!validPrincipal(principal, input)) throw new DiagnosticsServiceError("forbidden");
      if (isAborted(signal)) throw new DiagnosticsServiceError("source_unavailable");

      const generated = now();
      const generatedAtMs = generated.getTime();
      if (!Number.isSafeInteger(generatedAtMs) || generatedAtMs < 0) {
        throw new DiagnosticsServiceError("source_unavailable");
      }
      const generatedAt = generated.toISOString();

      let entries: readonly DiagnosticEntry[];
      try {
        entries = await awaitAuthority(() => options.authority.readClosedEntries({
          principal,
          limit: DIAGNOSTICS_MAX_ENTRIES,
        }), signal);
      } catch {
        await safeAudit(options.authority, {
          actorId: principal.actorId,
          occurredAt: generatedAt,
          result: "failed",
          failureCode: "source_unavailable",
        }, signal);
        throw new DiagnosticsServiceError("source_unavailable");
      }
      if (isAborted(signal)) throw new DiagnosticsServiceError("source_unavailable");

      let bundle: DiagnosticsBundle;
      try {
        bundle = createDiagnosticsBundle({ generatedAt, entries });
      } catch {
        await safeAudit(options.authority, {
          actorId: principal.actorId,
          occurredAt: generatedAt,
          result: "failed",
          failureCode: "unsafe_diagnostic",
        });
        throw new DiagnosticsServiceError("unsafe_diagnostic");
      }

      const expiresAtMs = generatedAtMs + DIAGNOSTICS_ARTIFACT_RETENTION_MS;
      let commit: DiagnosticsArtifactCommit;
      try {
        commit = await awaitAuthority(() => options.authority.commitArtifact({
          principal,
          filename: bundle.filename,
          mediaType: bundle.mediaType,
          bytes: bundle.bytes,
          manifest: bundle.manifest,
          expiresAtMs,
        }), signal, {
          resolved(lateCommit) {
            if (isSafeId(lateCommit.artifactId)) {
              detached(() => options.authority.discardArtifact({
                principal, artifactId: lateCommit.artifactId,
              }));
            }
            detached(() => options.authority.audit({
              actorId: principal.actorId,
              occurredAt: generatedAt,
              result: "failed",
              failureCode: "artifact_unavailable",
            }));
          },
          rejected() {
            detached(() => options.authority.audit({
              actorId: principal.actorId,
              occurredAt: generatedAt,
              result: "failed",
              failureCode: "artifact_unavailable",
            }));
          },
        });
      } catch (error) {
        if (error instanceof DiagnosticsAuthorityAwaitAborted) {
          throw new DiagnosticsServiceError("source_unavailable");
        }
        await safeAudit(options.authority, {
          actorId: principal.actorId,
          occurredAt: generatedAt,
          result: "failed",
          failureCode: "artifact_unavailable",
        }, signal);
        throw new DiagnosticsServiceError("artifact_unavailable");
      }
      if (!validArtifactCommit(commit, bundle.bytes.byteLength)) {
        if (isSafeId(commit.artifactId)) {
          await safeDiscard(options.authority, { principal, artifactId: commit.artifactId }, signal);
        }
        await safeAudit(options.authority, {
          actorId: principal.actorId,
          occurredAt: generatedAt,
          result: "failed",
          failureCode: "artifact_unavailable",
        }, signal);
        throw new DiagnosticsServiceError("artifact_unavailable");
      }

      // This is the final cancellable boundary before the immutable success audit is published.
      if (isAborted(signal)) {
        detached(() => options.authority.discardArtifact({
          principal, artifactId: commit.artifactId,
        }));
        detached(() => options.authority.audit({
          actorId: principal.actorId,
          occurredAt: generatedAt,
          result: "failed",
          failureCode: "source_unavailable",
        }));
        throw new DiagnosticsServiceError("source_unavailable");
      }

      try {
        await awaitAuthority(() => options.authority.audit({
          actorId: principal.actorId,
          occurredAt: generatedAt,
          result: "succeeded",
          artifactId: commit.artifactId,
          entryCount: bundle.manifest.entryCount,
          byteLength: bundle.manifest.byteLength,
          sha256: bundle.manifest.sha256,
        }), signal, {
          // Audit resolution is the terminal commit point: a later abort cannot falsify success.
          resolved() {},
          rejected() {
            detached(() => options.authority.discardArtifact({
              principal, artifactId: commit.artifactId,
            }));
            detached(() => options.authority.audit({
              actorId: principal.actorId,
              occurredAt: generatedAt,
              result: "failed",
              failureCode: "artifact_unavailable",
            }));
          },
        });
      } catch (error) {
        if (error instanceof DiagnosticsAuthorityAwaitAborted) {
          // The pending success outcome owns the artifact: late success retains it; late failure
          // discards it and publishes the closed failure record through the handlers above.
          throw new DiagnosticsServiceError("source_unavailable");
        }
        await Promise.all([
          safeDiscard(options.authority, { principal, artifactId: commit.artifactId }, signal),
          safeAudit(options.authority, {
          actorId: principal.actorId,
          occurredAt: generatedAt,
          result: "failed",
          failureCode: "artifact_unavailable",
          }, signal),
        ]);
        throw new DiagnosticsServiceError("artifact_unavailable");
      }
      return Object.freeze({
        artifactId: commit.artifactId,
        filename: bundle.filename,
        mediaType: bundle.mediaType,
        expiresAt: new Date(expiresAtMs).toISOString(),
        manifest: bundle.manifest,
      });
    },
  });
}
