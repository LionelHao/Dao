import { createHash, randomUUID, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  ATTACHMENT_AUTHORITY_LIMITS,
  CONTEXT_COMPILER_LIMITS,
  type Actor,
} from "@native-im/core";
import { isDeepStrictEqual } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createAuthenticationService,
  type IdentityAdapter,
} from "./auth.js";
import { createAesGcmInvitationSecretProtector } from "./invitation-secret-protector.js";
import { createMessageService } from "./service.js";
import { createAuthoritativeRoomLifecycleService } from "./room-lifecycle.js";
import { createAuthoritativeCollaborationPrimitives } from "./primitives.js";
import { createSyncService } from "./sync-service.js";
import {
  startMessageWebSocketServer,
  type ToolSafetyAuthorityTransport,
} from "./websocket.js";
import { createSnapshotWorkerClient } from "./persistence/snapshot-worker-client.js";
import { createSqliteAuthoritativeStore } from "./persistence/sqlite-authoritative-store.js";
import {
  createWorkerDatabaseClient,
  createWorkerRoomCacheInvalidationIntentAuthority,
  createWorkerDatabaseClientWithTransactionFaultForTest,
  type CompleteWorkerDatabaseClient,
  type WorkerDatabaseClient,
} from "./persistence/worker-database-client.js";
import { createAgentRuntimeService, type AgentRuntimeService } from "./agent-runtime/agent-runtime-service.js";
import {
  AgentRuntimeError,
  type ProviderAdapter,
  type SecretProvider,
} from "./agent-runtime/contracts.js";
import { createEnvironmentSecretProvider } from "./agent-runtime/environment-secret-provider.js";
import { createOpenAIResponsesProvider } from "./agent-runtime/openai-responses-provider.js";
import {
  createWorkerRuntimeAuthority,
  createWorkerRuntimeRecoveryAuthority,
} from "./agent-runtime/worker-runtime-authority.js";
import { createHttpJsonReadAdapter } from "./agent-runtime/tools/http-json-read.js";
import { createRepositoryGitStatusAdapter } from "./agent-runtime/tools/repository-git-status.js";
import { createSandboxFileWriteAdapter } from "./agent-runtime/tools/sandbox-file-write.js";
import { createToolGateway, createToolSafetyGateway } from "./agent-runtime/tool-gateway.js";
import { bridgePhysicalToolAdapter } from "./agent-runtime/physical-tool-adapter-bridge.js";
import { createWorkerToolSafetyAuthority } from "./tool-safety/worker-authority.js";
import { createToolSafetyRuntimeCoordinator } from "./tool-safety/runtime-coordinator.js";
import { ToolParameterSealer } from "./tool-safety/tool-parameter-sealer.js";
import { createWorkerRoomMemoryReadAdapter } from "./agent-runtime/worker-room-memory-read-adapter.js";
import { createWorkerCompiledContextBuilder } from "./context-compiler/worker-compiled-context.js";
import { createOpenAIRouterProvider } from "./route-runtime/openai-router-provider.js";
import { createRouteRuntimeService, type RouteRuntimeService } from "./route-runtime/route-runtime-service.js";
import { createWorkerRouteAuthority } from "./route-runtime/worker-route-authority.js";
import { createEmptyBlueprintBallProjectionPort, type BlueprintBallProjectionPort } from "./ball-runtime/contracts.js";
import { createBallRuntimeService, type BallRuntimeService } from "./ball-runtime/ball-runtime-service.js";
import { RoomCacheInvalidationPostCommitDispatcher } from "./access/room-cache-invalidation-port.js";
import { createProductionSharedAuthorityParticipantComposition } from "./room-governance/production-participant-composition.js";
import {
  validatePrivacyOperationsSharedAuthority,
} from "./privacy-operations/deployment-configuration.js";
import { createProviderSecurityDisclosure } from
  "./privacy-operations/provider-security-policy.js";
import { createHostedRetentionOperationsAdapter } from
  "./privacy-operations/operations-runtime.js";
import {
  createOfflineLeaseKeyringPolicy,
  requireActiveOfflineLeaseSigningKey,
} from "./privacy-operations/offline-lease-keyring-policy.js";
import {
  createAuthenticatedPrivacyOperationsTransport,
  type AuthenticatedPrivacyOperationsTransport,
} from "./privacy-operations/authoritative-host.js";
import {
  createSourceScopedRuntimeBoundary,
  type SourceScopedRuntimeBoundary,
} from "./message-authority/runtime/source-scoped-runtime-coordinator.js";
import { AttachmentObjectStore } from "./attachment-authority/object-store.js";
import { reconcileAttachmentObjectStore } from "./attachment-authority/object-reconciliation.js";
import {
  createAttachmentAuthorityService,
  type AttachmentAuthorityCommandPort,
} from "./attachment-authority/authority-service.js";
import {
  createAttachmentProcessingRuntime,
  type AttachmentProcessingRuntime,
} from "./attachment-authority/processing-runtime.js";
import { createProductionAttachmentProcessingPipeline } from "./attachment-authority/processing-pipeline.js";
import {
  createAttachmentAgentExtractionReader,
  type AttachmentAgentExtractionReadPort,
} from "./attachment-authority/agent-extraction-reader.js";
import { isAttachmentDatabaseOperationResult } from "./attachment-authority/database-contracts.js";
import {
  probeProductionAttachmentCapabilities,
  type ProductionClamdPolicy,
} from "./attachment-authority/production-capabilities.js";
import type { ClamdEndpoint } from "./attachment-authority/clamd-scanner.js";
import { createWorkerMemoryAuthority } from "./room-memory/worker-memory-authority.js";
import { WorkerAgentSettingsAdapter } from "./agent-settings/worker-agent-settings-adapter.js";
import { createOpenAIMemoryStewardProvider } from "./room-memory/openai-memory-provider.js";
import { createMemoryStewardProviderAdapter } from "./room-memory/steward-provider-adapter.js";
import {
  createMemoryStewardRuntime,
  type MemoryStewardRuntime,
} from "./room-memory/memory-steward-runtime.js";
import {
  createAuthoritativeProjectBoundaryInvocationProducer,
  createWorkerAuthoritativeProjectBoundaryInvocationAuthority,
  type ProjectBoundaryInvocationProducer,
} from "./project-boundary/project-boundary-invocation-producer.js";
import {
  createProjectBoundaryRuntime,
  type ProjectBoundaryRuntime,
} from "./project-boundary/project-boundary-runtime.js";
import { createProjectLoopWorkerAuthorityTransport } from
  "./project-loop/worker-authority-adapter.js";

export { createProductionSharedAuthorityParticipantComposition } from "./room-governance/production-participant-composition.js";

export const AUTHORITATIVE_SERVER_DEFAULT_HOST = "127.0.0.1";
export const AUTHORITATIVE_SERVER_DEFAULT_PORT = 8_787;

export interface AuthoritativeServer {
  readonly url: string;
  readonly privacyOperations: AuthenticatedPrivacyOperationsTransport;
  close(): Promise<void>;
}

export class DetachedRecoveryTerminalError extends Error {
  readonly code = "detached_recovery_shutdown_failed";
  readonly state = "closed";

  constructor(
    readonly family: string,
    readonly reason: "active_batch_failed" | "shutdown_timeout",
    readonly terminalCause?: unknown,
  ) {
    super(`Detached ${family} recovery closed with ${reason}`);
    this.name = "DetachedRecoveryTerminalError";
  }
}

export interface BoundedDetachedRecovery {
  kick(): Promise<void>;
  start(): void;
  close(): Promise<void>;
}

/**
 * Owns a detached post-commit batch so shutdown cannot close its backing worker
 * while the batch is still using it. Once close begins no new batch is accepted.
 */
export function createBoundedDetachedRecovery(options: Readonly<{
  family: string;
  intervalMs: number;
  shutdownTimeoutMs: number;
  runBatch: () => Promise<void>;
  onBackgroundFailure: (error: unknown) => void;
}>): BoundedDetachedRecovery {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0 ||
      !Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0) {
    throw new TypeError("Detached recovery timing limits must be positive safe integers");
  }
  let accepting = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const kick = (): Promise<void> => {
    if (!accepting) return Promise.resolve();
    if (active !== undefined) return active;
    const attempt = Promise.resolve().then(options.runBatch);
    const tracked = attempt.finally(() => {
      if (active === tracked) active = undefined;
    });
    active = tracked;
    return tracked;
  };

  const stop = (): void => {
    accepting = false;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return Object.freeze({
    kick,
    start() {
      if (!accepting || timer !== undefined) return;
      timer = setInterval(() => {
        void kick().catch(options.onBackgroundFailure);
      }, options.intervalMs);
      timer.unref();
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      stop();
      const draining = active;
      closePromise = draining === undefined
        ? Promise.resolve()
        : new Promise<void>((resolveClose, rejectClose) => {
            const timeout = setTimeout(() => rejectClose(new DetachedRecoveryTerminalError(
              options.family,
              "shutdown_timeout",
            )), options.shutdownTimeoutMs);
            timeout.unref();
            void draining.then(
              () => {
                clearTimeout(timeout);
                resolveClose();
              },
              (error: unknown) => {
                clearTimeout(timeout);
                rejectClose(new DetachedRecoveryTerminalError(
                  options.family,
                  "active_batch_failed",
                  error,
                ));
              },
            );
          });
      return closePromise;
    },
  });
}

export interface StartAuthoritativeServerOptions {
  readonly databasePath: string;
  readonly snapshotCachePath: string;
  /**
   * Deployment-owned listener configuration. The public composition defaults
   * to the Desktop loopback endpoint, 127.0.0.1:8787. Tests and embedded
   * callers that need an ephemeral listener must explicitly pass port 0.
   */
  readonly listen?: {
    readonly host?: string;
    readonly port?: number;
  };
  readonly actors: readonly Actor[];
  readonly identities: IdentityAdapter;
  readonly invitationSecretKey: Uint8Array;
  readonly sharedAuthority: {
    readonly maxOfflineReadLeaseMs: number;
    readonly offlineReadLeaseSigning?: {
      readonly tenantId: string;
      readonly serverSubject: string;
      readonly keyId: string;
      readonly privateKey: KeyObject;
      readonly activatedAtMs: number;
      readonly previous?: Readonly<{
        keyId: string;
        issuanceCutoffMs: number;
        verificationCutoffMs: number;
      }>;
    };
  };
  /**
   * Owner-controlled deployment bootstrap. The first successful startup seals
   * this exact Human principal set in SQLite; later startup configuration can
   * never replace the authoritative administrator registry.
   */
  readonly tenantAdministration?: {
    readonly bootstrapHumanActorIds: readonly string[];
  };
  readonly privacyOperations?: Readonly<{
    readonly artifactRoot?: string;
    readonly auditPath?: string;
  }>;
  readonly agentRuntime?: {
    readonly model?: string;
    /** Deployment-owned, conservative context window for models outside the built-in registry. */
    readonly modelContextWindowTokens?: number;
    readonly endpoint?: string;
    readonly httpJsonOrigin?: string;
    readonly httpJsonPathPrefix?: string;
    readonly repositoryRoot?: string;
    readonly sandboxRoot?: string;
    readonly gitBinaryPath?: string;
  };
  readonly ballRuntime?: {
    readonly openItemDeadlineMs?: number;
    readonly lightTaskDeadlineMs?: number;
    readonly scanIntervalMs?: number;
  };
  readonly attachmentRuntime?: {
    readonly storageRoot: string;
    readonly cwd: string;
    readonly ocrLanguage: string;
    readonly capabilityProbeTimeoutMs: number;
    readonly clamd: Readonly<{
      endpoint: ClamdEndpoint;
      databaseSha256: string;
      databaseUpdatedAt: string;
      policy: ProductionClamdPolicy;
    }>;
    readonly pdfinfo: Readonly<{ executable: string; argvPrefix?: readonly string[] }>;
    readonly pdftotext: Readonly<{ executable: string; argvPrefix?: readonly string[] }>;
    readonly pdftoppm: Readonly<{ executable: string; argvPrefix?: readonly string[] }>;
    readonly tesseract: Readonly<{ executable: string; argvPrefix?: readonly string[] }>;
  };
}

interface AuthoritativeServerTestOptions {
  readonly faultPoint?:
    | "after-domain-write"
    | "before-commit"
    | "after-commit-before-outbox"
    | "after-send-before-dispatch-mark";
  readonly snapshotCacheQuotaBytes?: number;
  readonly snapshotMaxRecordsPerPage?: number;
  readonly initialize?: (facades: AuthoritativeServerTestFacades) => Promise<void>;
  readonly registerMissingActors?: false;
  readonly afterCloseForTest?: Partial<Record<
    | "cache-invalidation-recovery"
    | "transport"
    | "attachment-authority"
    | "attachment-processing"
    | "memory"
    | "route"
    | "project-boundary"
    | "runtime"
    | "privacy-retention"
    | "privacy-operations"
    | "ball"
    | "snapshots"
    | "worker",
    () => void
  >>;
  readonly blueprintBallProjectionPort?: BlueprintBallProjectionPort;
  readonly agentRuntimeProviderForTest?: ProviderAdapter;
  /** Test-only cross-platform seam; production startup remains descriptor fail-closed. */
  readonly toolAdapterPathFallbackForTest?: true;
  readonly cacheInvalidationShutdownTimeoutMs?: number;
}

export interface AuthoritativeServerTestFacades {
  readonly auth: ReturnType<typeof createAuthenticationService>;
  readonly lifecycle: ReturnType<typeof createAuthoritativeRoomLifecycleService>;
  readonly messages: ReturnType<typeof createMessageService>;
  readonly primitives: ReturnType<typeof createAuthoritativeCollaborationPrimitives>;
  readonly projectBoundary: ProjectBoundaryInvocationProducer;
}

const AGENT_MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  "gpt-5-mini": 400_000,
});

export function createAgentProviderReadinessProbe(input: Readonly<{
  providerConfigured: boolean;
  secretProvider: Pick<SecretProvider, "getSecret">;
}>): () => boolean {
  return () => input.providerConfigured ||
    input.secretProvider.getSecret("OPENAI_API_KEY") !== undefined;
}

export function assertAgentRuntimeModelContextCapability(input: Readonly<{
  model: string;
  configuredContextWindowTokens?: number;
}>): number {
  const model = input.model.trim();
  if (model.length === 0) throw new TypeError("Agent runtime model must be non-empty");
  const contextWindowTokens = input.configuredContextWindowTokens ??
    AGENT_MODEL_CONTEXT_WINDOWS[model];
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens === undefined ||
      contextWindowTokens < CONTEXT_COMPILER_LIMITS.hardLimitTokens) {
    throw new TypeError(
      `Agent runtime model context capability is missing or below ${CONTEXT_COMPILER_LIMITS.hardLimitTokens}`,
    );
  }
  return contextWindowTokens;
}

export function startAuthoritativeServer(
  options: StartAuthoritativeServerOptions,
): Promise<AuthoritativeServer> {
  return start(options, {}, false);
}

/** Deep-import-only constructor for the compiled child-process harness. */
export function startAuthoritativeServerForTest(
  options: StartAuthoritativeServerOptions,
  testOptions: AuthoritativeServerTestOptions,
): Promise<AuthoritativeServer> {
  return start(options, testOptions, true);
}

async function start(
  options: StartAuthoritativeServerOptions,
  testOptions: AuthoritativeServerTestOptions,
  testOnlyAllowEphemeralOfflineLeaseSigning: boolean,
): Promise<AuthoritativeServer> {
  const releaseLeasePolicy = validatePrivacyOperationsSharedAuthority({
    maxOfflineReadLeaseMs: options.sharedAuthority.maxOfflineReadLeaseMs,
  });
  const ephemeralLeaseKey = options.sharedAuthority.offlineReadLeaseSigning === undefined &&
      testOnlyAllowEphemeralOfflineLeaseSigning
    ? generateKeyPairSync("ed25519").privateKey
    : undefined;
  const offlineReadLeaseSigning = options.sharedAuthority.offlineReadLeaseSigning ??
    (ephemeralLeaseKey === undefined ? undefined : {
      tenantId: "dao-test-tenant",
      serverSubject: "dao-test-authority",
      keyId: "dao-test-ephemeral-key",
      privateKey: ephemeralLeaseKey,
      activatedAtMs: 0,
    });
  if (offlineReadLeaseSigning === undefined) {
    throw new TypeError("offlineReadLeaseSigning is required for production composition");
  }
  const offlineLeaseKeyring = createOfflineLeaseKeyringPolicy({
    active: {
      keyId: offlineReadLeaseSigning.keyId,
      activatedAtMs: offlineReadLeaseSigning.activatedAtMs,
    },
    ...(offlineReadLeaseSigning.previous === undefined
      ? {} : { previous: offlineReadLeaseSigning.previous }),
  });
  requireActiveOfflineLeaseSigningKey(
    offlineLeaseKeyring,
    Date.now(),
    offlineReadLeaseSigning.keyId,
  );
  const offlineReadLeaseWorkerSigning = Object.freeze({
    tenantId: offlineReadLeaseSigning.tenantId,
    serverSubject: offlineReadLeaseSigning.serverSubject,
    keyId: offlineReadLeaseSigning.keyId,
    privateKey: offlineReadLeaseSigning.privateKey,
  });
  const runtimeModel = options.agentRuntime?.model ?? "gpt-5-mini";
  assertAgentRuntimeModelContextCapability({
    model: runtimeModel,
    ...(options.agentRuntime?.modelContextWindowTokens === undefined ? {} : {
      configuredContextWindowTokens: options.agentRuntime.modelContextWindowTokens,
    }),
  });
  const ballConfiguration = options.ballRuntime ?? {};
  const ballPolicy = Object.freeze({
    openItemDeadlineMs: ballConfiguration.openItemDeadlineMs ?? 24 * 60 * 60 * 1_000,
    lightTaskDeadlineMs: ballConfiguration.lightTaskDeadlineMs ?? 24 * 60 * 60 * 1_000,
  });
  createProductionSharedAuthorityParticipantComposition({
    maxOfflineReadLeaseMs: releaseLeasePolicy.maxOfflineReadLeaseMs,
    ballPolicy,
  });
  const actorIds = new Set<string>();
  for (const actor of options.actors) {
    if (actorIds.has(actor.id)) {
      throw new TypeError(`Duplicate authoritative actor: ${actor.id}`);
    }
    actorIds.add(actor.id);
  }
  const transactionFault =
    testOptions.faultPoint === "after-domain-write" || testOptions.faultPoint === "before-commit"
      ? testOptions.faultPoint
      : undefined;
  const secretProvider = createEnvironmentSecretProvider();
  const providerSecurityDisclosure = createProviderSecurityDisclosure({
    modelId: runtimeModel,
    readiness:
      testOptions.agentRuntimeProviderForTest !== undefined ||
        secretProvider.getSecret("OPENAI_API_KEY") !== undefined
        ? "ready" as const
        : "noauth" as const,
    disclosureRevision: 1,
    disclosedAt: new Date().toISOString(),
  });
  const deploymentProviderDisclosure = Object.freeze({
    providerId: providerSecurityDisclosure.providerId,
    modelId: providerSecurityDisclosure.modelId,
    credentialReadiness: providerSecurityDisclosure.readiness,
    retentionDisabled: providerSecurityDisclosure.retentionDisabled,
    selectionPolicy: providerSecurityDisclosure.selectionPolicy,
    disclosureRevision: providerSecurityDisclosure.disclosureRevision,
    disclosedAt: providerSecurityDisclosure.disclosedAt,
  });
  let worker: WorkerDatabaseClient | undefined;
  let snapshots: Awaited<ReturnType<typeof createSnapshotWorkerClient>> | undefined;
  let transport: Awaited<ReturnType<typeof startMessageWebSocketServer>> | undefined;
  let runtime: AgentRuntimeService | undefined;
  let kickDirectIntentConsumer: () => void = () => undefined;
  let stopRuntimeRecovery: (() => void) | undefined;
  let retentionOperations: ReturnType<typeof createHostedRetentionOperationsAdapter> | undefined;
  let privacyOperations: AuthenticatedPrivacyOperationsTransport | undefined;
  let projectBoundaryRuntime: ProjectBoundaryRuntime | undefined;
  let sourceScopedRuntimeBoundary: SourceScopedRuntimeBoundary | undefined;
  let routeRuntime: RouteRuntimeService | undefined;
  let ballRuntime: BallRuntimeService | undefined;
  let cacheInvalidationRecovery: BoundedDetachedRecovery | undefined;
  let attachmentAuthority: AttachmentAuthorityCommandPort | undefined;
  let attachmentProcessing: AttachmentProcessingRuntime | undefined;
  let stopAttachmentRecovery: (() => void) | undefined;
  let attachmentObjectStore: AttachmentObjectStore | undefined;
  let attachmentExtractionReader: AttachmentAgentExtractionReadPort | undefined;
  let attachmentReaderReadySettled = false;
  let settleAttachmentReaderReady!: (reader: AttachmentAgentExtractionReadPort | undefined) => void;
  const attachmentReaderReady = new Promise<AttachmentAgentExtractionReadPort | undefined>(
    (resolveReady) => { settleAttachmentReaderReady = resolveReady; },
  );
  const settleAttachmentReader = (reader: AttachmentAgentExtractionReadPort | undefined): void => {
    if (attachmentReaderReadySettled) return;
    attachmentReaderReadySettled = true;
    settleAttachmentReaderReady(reader);
  };
  if (options.attachmentRuntime === undefined) settleAttachmentReader(undefined);
  let memoryRuntime: MemoryStewardRuntime | undefined;
  let stopMemoryRecovery: (() => void) | undefined;
  try {
    worker = transactionFault === undefined
      ? await createWorkerDatabaseClient({
          databasePath: options.databasePath,
          sharedAuthorityRecovery: {
            ballPolicy,
            maxOfflineReadLeaseMs: releaseLeasePolicy.maxOfflineReadLeaseMs,
          },
          deploymentProviderDisclosure,
          offlineReadLeaseSigning: offlineReadLeaseWorkerSigning,
        })
      : await createWorkerDatabaseClientWithTransactionFaultForTest(
          {
            databasePath: options.databasePath,
            sharedAuthorityRecovery: {
              ballPolicy,
              maxOfflineReadLeaseMs: releaseLeasePolicy.maxOfflineReadLeaseMs,
            },
            deploymentProviderDisclosure,
            offlineReadLeaseSigning: offlineReadLeaseWorkerSigning,
          },
          transactionFault,
        );
    retentionOperations = createHostedRetentionOperationsAdapter({
      batchPort: worker as CompleteWorkerDatabaseClient,
      alertSink: {
        emit(alert) {
          process.stderr.write(`${JSON.stringify({ source: "privacy-retention", ...alert })}\n`);
        },
      },
    });
    await retentionOperations.run("startup_recovery", Date.now());
    const authority = createSqliteAuthoritativeStore(worker, {
      invitationSecretProtector: createAesGcmInvitationSecretProtector(
        options.invitationSecretKey,
      ),
      ...(testOptions.faultPoint === "after-commit-before-outbox"
        ? { afterCommitHuman: () => process.exit(83) }
        : {}),
      async afterCommitGovernance(context, command, acknowledgement) {
        if (testOptions.faultPoint === "after-commit-before-outbox") process.exit(83);
        if (command.type !== "room.reopen" || acknowledgement.replayed ||
            acknowledgement.eventIds.length === 0) return;
        try {
          const current = await worker!.readRoomGovernance(context, command.roomId, Date.now());
          if (current.lifecycle !== "active" ||
              current.archiveGeneration !== acknowledgement.governance.archiveGeneration ||
              current.governanceRevision !== acknowledgement.governance.governanceRevision) {
            return;
          }
          ballRuntime?.track(command.roomId);
          void ballRuntime?.scan(command.roomId).catch(() => undefined);
          memoryRuntime?.enqueue(command.roomId);
        } catch {
          // The committed ACK remains authoritative; normal recovery performs a bounded rescan.
        }
      },
    });
    const missingActors: Actor[] = [];
    for (const actor of options.actors) {
      const persisted = await worker.readActor(actor.id);
      if (persisted === undefined) missingActors.push(actor);
      else if (persisted.kind !== actor.kind ||
          (actor.kind === "human" && !isDeepStrictEqual(persisted, actor))) {
        throw new TypeError(`Persisted authoritative actor mismatch: ${actor.id}`);
      }
    }
    if (missingActors.length > 0) {
      if (testOptions.registerMissingActors === false) {
        throw new TypeError("Persisted authoritative actors are missing");
      }
      await authority.registerActors(missingActors);
    }
    if (options.tenantAdministration !== undefined) {
      const principalIds = [...options.tenantAdministration.bootstrapHumanActorIds]
        .sort((left, right) => left.localeCompare(right));
      if (principalIds.length === 0 || principalIds.some((principalId) =>
        principalId.trim() !== principalId || principalId.length === 0) ||
        new Set(principalIds).size !== principalIds.length) {
        throw new TypeError("Tenant administrator bootstrap principals must be non-empty, unique Human actor IDs");
      }
      const configurationSha256 = createHash("sha256")
        .update(JSON.stringify({ version: 1, principalIds }), "utf8")
        .digest("hex");
      await worker.executeTenantAdministration({
        version: 1,
        type: "tenant-administrator.bootstrap",
        principalIds,
        configurationSha256,
        now: Date.now(),
      });
    }
    const snapshotClient = await createSnapshotWorkerClient({
      authorityPath: options.databasePath,
      cachePath: options.snapshotCachePath,
      revalidate: (request) => authority.revalidateSnapshot(request),
      streamingAuthority: worker,
      deploymentProviderCredentialReadiness:
        deploymentProviderDisclosure.credentialReadiness,
      ...(testOptions.snapshotCacheQuotaBytes === undefined &&
          testOptions.snapshotMaxRecordsPerPage === undefined
        ? {}
        : {
            limits: {
              ...(testOptions.snapshotCacheQuotaBytes === undefined
                ? {}
                : { cacheQuotaBytes: testOptions.snapshotCacheQuotaBytes }),
              ...(testOptions.snapshotMaxRecordsPerPage === undefined
                ? {}
                : { maxRecordsPerPage: testOptions.snapshotMaxRecordsPerPage }),
            },
          }),
    });
    snapshots = snapshotClient;
    const cacheInvalidationDispatcher = new RoomCacheInvalidationPostCommitDispatcher({
      authority: createWorkerRoomCacheInvalidationIntentAuthority(worker),
      purge: snapshotClient,
      batchLimit: 64,
      alertSink: {
        emit(alert) {
          process.stderr.write(`${JSON.stringify({ source: "authority-outbox", ...alert })}\n`);
        },
      },
    });
    cacheInvalidationRecovery = createBoundedDetachedRecovery({
      family: "room-cache-invalidation",
      intervalMs: 1_000,
      shutdownTimeoutMs: testOptions.cacheInvalidationShutdownTimeoutMs ?? 5_000,
      runBatch: async () => {
        await cacheInvalidationDispatcher.dispatchReadyBatch();
      },
      onBackgroundFailure: () => {
        process.stderr.write(`${JSON.stringify({
          severity: "critical",
          code: "outbox_dispatcher_failure",
          family: "room-cache-invalidation",
          reason: "storage_unavailable",
        })}\n`);
      },
    });
    await cacheInvalidationRecovery.kick();
    cacheInvalidationRecovery.start();
    const materializedSnapshots = {
      async beginRoomRepair(...args: Parameters<typeof snapshotClient.beginRoomRepair>) {
        const result = await snapshotClient.beginRoomRepair(...args);
        if ("kind" in result) throw new Error("Snapshot streaming fallback was unavailable");
        return result;
      },
      readRoomRepairPage: snapshotClient.readRoomRepairPage.bind(snapshotClient),
      async beginWorkspaceBootstrap(
        ...args: Parameters<typeof snapshotClient.beginWorkspaceBootstrap>
      ) {
        const result = await snapshotClient.beginWorkspaceBootstrap(...args);
        if ("kind" in result) throw new Error("Snapshot streaming fallback was unavailable");
        return result;
      },
      readWorkspaceBootstrapPage: snapshotClient.readWorkspaceBootstrapPage.bind(snapshotClient),
      completeSnapshot: snapshotClient.completeSnapshot.bind(snapshotClient),
      releaseSnapshot: snapshotClient.releaseSnapshot.bind(snapshotClient),
    };
    let scopedReceiptCursor = 0;
    let scopedReceiptDrain: Promise<void> | undefined;
    const drainCommittedScopedProducerReceipts = (): Promise<void> => {
      if (runtime === undefined) return Promise.resolve();
      scopedReceiptDrain ??= (async () => {
        let hasMore = true;
        while (hasMore && runtime !== undefined && worker !== undefined) {
          const result = await worker.executeRuntime({
            type: "runtime.scan-internal-scoped-receipts",
            afterRowId: scopedReceiptCursor,
            limit: 256,
            now: Date.now(),
          });
          if (typeof result !== "object" || result === null || !("kind" in result) ||
              result.kind !== "internal-scoped-producer-receipts" ||
              !("records" in result) || !Array.isArray(result.records) ||
              !("hasMore" in result) || typeof result.hasMore !== "boolean") {
            throw new Error("Internal scoped producer post-commit scan was malformed");
          }
          for (const record of result.records) {
            if (typeof record !== "object" || record === null ||
                !("committedAt" in record) || typeof record.committedAt !== "string" ||
                !("requestId" in record) || typeof record.requestId !== "string" ||
                !("rowId" in record) || typeof record.rowId !== "number" ||
                !("receipt" in record)) {
              throw new Error("Internal scoped producer post-commit record was malformed");
            }
            runtime.applyCommittedScopedProducerReceipt(record.receipt as never);
            scopedReceiptCursor = record.rowId;
          }
          hasMore = result.hasMore;
          if (hasMore && result.records.length === 0) {
            throw new Error("Internal scoped producer post-commit cursor did not advance");
          }
        }
      })().finally(() => { scopedReceiptDrain = undefined; });
      return scopedReceiptDrain;
    };
    const afterCommittedProducerCommand = async (): Promise<void> => {
      try { await drainCommittedScopedProducerReceipts(); } catch { /* recovery retries on next command */ }
    };
    const agentSettings = new WorkerAgentSettingsAdapter(
      worker,
      Date.now,
      afterCommittedProducerCommand,
    );
    const sync = createSyncService({ store: authority, snapshots: materializedSnapshots,
      agentSettings });
    const auth = createAuthenticationService({
      actors: {
        getActor(actorId) {
          return options.actors.find((actor) => actor.id === actorId);
        },
      },
      identities: options.identities,
      authority,
    });
    const privacyRoot = resolve(
      dirname(options.snapshotCachePath),
      "privacy-operations",
    );
    privacyOperations = await createAuthenticatedPrivacyOperationsTransport({
      auth,
      worker: worker as CompleteWorkerDatabaseClient,
      artifactRoot: options.privacyOperations?.artifactRoot ?? resolve(privacyRoot, "artifacts"),
      auditPath: options.privacyOperations?.auditPath ?? resolve(privacyRoot, "audit.jsonl"),
    });
    const commandStore = {
        async executeHuman(context, command) {
          try {
            const acknowledgement = await authority.executeHuman(context, command);
            await afterCommittedProducerCommand();
            if (command.type === "message.send") {
              const route = await worker!.executeRuntime({
                type: "runtime.create-route-for-human-message",
                sourceHumanMessageId: acknowledgement.aggregateId,
                now: Date.now(),
              });
              if (typeof route !== "object" || route === null ||
                  !("kind" in route) || route.kind !== "human-message-route" ||
                  !("roomId" in route) || typeof route.roomId !== "string" ||
                  !("sourceHumanMessageId" in route) ||
                  typeof route.sourceHumanMessageId !== "string") {
                throw new Error("Authority human message route result was malformed");
              }
              routeRuntime?.notify(route.roomId, route.sourceHumanMessageId);
              memoryRuntime?.enqueue(command.roomId);
            }
            if (command.type === "open-item.create" || command.type === "open-item.transition" ||
                command.type === "light-task.create" || command.type === "light-task.transition" ||
                command.type === "light-task.criterion.set") {
              ballRuntime?.track(command.roomId);
              void ballRuntime?.scan(command.roomId).catch(() => undefined);
            }
            return acknowledgement;
          } catch (error: unknown) {
            if (transactionFault !== undefined) {
              process.exit(transactionFault === "after-domain-write" ? 81 : 82);
            }
            throw error;
          }
        },
        async executeAgent(context, command) {
          const acknowledgement = await authority.executeAgent(context, command);
          if (command.type === "message.send") {
            memoryRuntime?.enqueue(command.roomId);
          }
          if (command.type.startsWith("open-item.")) {
            ballRuntime?.track(command.roomId);
            void ballRuntime?.scan(command.roomId).catch(() => undefined);
          }
          return acknowledgement;
        },
      } satisfies Parameters<typeof createMessageService>[0]["commandStore"];
    const governanceStore = {
      executeHuman: commandStore.executeHuman,
      readRoomGovernance: authority.readRoomGovernance,
      readDepartureConflicts: authority.readDepartureConflicts,
      async executeHumanGovernance(
        ...args: Parameters<typeof authority.executeHumanGovernance>
      ) {
        try {
          const acknowledgement = await authority.executeHumanGovernance(...args);
          await afterCommittedProducerCommand();
          return acknowledgement;
        } catch (error: unknown) {
          if (transactionFault !== undefined) {
            process.exit(transactionFault === "after-domain-write" ? 81 : 82);
          }
          throw error;
        }
      },
    } satisfies NonNullable<Parameters<typeof startMessageWebSocketServer>[0]["governance"]>;
    const service = createMessageService({
      commandStore,
      queryStore: authority,
    });
    const lifecycle = createAuthoritativeRoomLifecycleService({
      commandStore,
      queryStore: authority,
    });
    const primitives = createAuthoritativeCollaborationPrimitives({ commandStore });
    const runtimeConfiguration = options.agentRuntime ?? {};
    const authorityWorker = worker as CompleteWorkerDatabaseClient;
    const memoryAuthority = createWorkerMemoryAuthority({ worker, nowMs: Date.now });
    const provider = testOptions.agentRuntimeProviderForTest ?? createOpenAIResponsesProvider({
      endpoint: runtimeConfiguration.endpoint ?? "https://api.openai.com/v1/responses",
      model: runtimeModel,
      secretProvider,
    });
    const agentProviderReady = createAgentProviderReadinessProbe({
      providerConfigured: testOptions.agentRuntimeProviderForTest !== undefined,
      secretProvider,
    });
    projectBoundaryRuntime = createProjectBoundaryRuntime({
      authority: authorityWorker,
      provider,
    });
    const authoritativeProjectBoundary = createAuthoritativeProjectBoundaryInvocationProducer({
      authority: createWorkerAuthoritativeProjectBoundaryInvocationAuthority(authorityWorker, {
        providerId: provider.id,
        modelId: runtimeModel,
      }),
    });
    const projectBoundary: ProjectBoundaryInvocationProducer = Object.freeze({
      async consume(request: Parameters<ProjectBoundaryInvocationProducer["consume"]>[0]) {
        const result = await authoritativeProjectBoundary.consume(request);
        if (result.status === "intent-created" && agentProviderReady()) {
          await projectBoundaryRuntime?.scan();
        }
        return result;
      },
    });
    await testOptions.initialize?.({
      auth, lifecycle, messages: service, primitives, projectBoundary,
    });
    let projectBoundaryScan: Promise<void> | undefined;
    const scanProjectBoundaries = (): Promise<void> => {
      projectBoundaryScan ??= (async () => {
        const now = Date.now();
        const ready = agentProviderReady();
        const agentScan = await authorityWorker.executeRuntime({
          type: "runtime.scan-project-agent-boundaries",
          providerId: provider.id,
          modelId: runtimeModel,
          agentProviderReady: ready,
          limit: 256,
          now,
        });
        if (typeof agentScan !== "object" || agentScan === null ||
            !("kind" in agentScan) || agentScan.kind !== "project-agent-boundary-scan") {
          throw new Error("Project Agent boundary scan result was malformed");
        }
        const reminderScan = await authorityWorker.executeRuntime({
          type: "runtime.scan-project-reminders",
          providerId: provider.id,
          modelId: runtimeModel,
          agentProviderReady: ready,
          limit: 256,
          now,
        });
        if (typeof reminderScan !== "object" || reminderScan === null ||
            !("kind" in reminderScan) || reminderScan.kind !== "project-reminder-scan") {
          throw new Error("Project reminder scan result was malformed");
        }
        if (ready) {
          await projectBoundaryRuntime?.scan();
        }
      })().finally(() => { projectBoundaryScan = undefined; });
      return projectBoundaryScan;
    };
    const baseProjectLoopAuthority = createProjectLoopWorkerAuthorityTransport(authorityWorker);
    const projectLoopAuthority = Object.freeze({
      executeQuery: baseProjectLoopAuthority.executeQuery,
      async executeMutation(
        ...args: Parameters<typeof baseProjectLoopAuthority.executeMutation>
      ) {
        const result = await baseProjectLoopAuthority.executeMutation(...args);
        void scanProjectBoundaries().catch(() => undefined);
        return result;
      },
    });
    const sandboxRoot = resolve(
      runtimeConfiguration.sandboxRoot ?? resolve(dirname(options.databasePath), "agent-sandbox"),
    );
    await mkdir(sandboxRoot, { recursive: true, mode: 0o700 });
    const tools = [
      createHttpJsonReadAdapter({
        origin: runtimeConfiguration.httpJsonOrigin ?? "https://api.github.com",
        pathPrefix: runtimeConfiguration.httpJsonPathPrefix ?? "/users/",
        maxResponseBytes: 256 * 1_024,
      }),
      createRepositoryGitStatusAdapter({
        binaryPath: runtimeConfiguration.gitBinaryPath ?? "/usr/bin/git",
        repositoryRoot: resolve(runtimeConfiguration.repositoryRoot ?? process.cwd()),
        maxOutputBytes: 256 * 1_024,
        timeoutMs: 5_000,
        ...(testOptions.toolAdapterPathFallbackForTest === true
          ? { testOnlyAllowPathFallback: true } : {}),
      }),
      createSandboxFileWriteAdapter({
        root: sandboxRoot,
        compensationKey: new Uint8Array(options.invitationSecretKey),
        maxContentBytes: 256 * 1_024,
        ...(testOptions.toolAdapterPathFallbackForTest === true
          ? { testOnlyAllowPathFallback: true } : {}),
      }),
    ] as const;
    const roomMemoryRead = createWorkerRoomMemoryReadAdapter({
      worker: authorityWorker,
      cursorSecret: options.invitationSecretKey,
      attachmentReader: () => attachmentReaderReady,
    });
    const runtimeTools = [...tools, roomMemoryRead] as const;
    const runtimeAuthority = createWorkerRuntimeAuthority(
      authorityWorker,
      { contextWorker: authorityWorker },
    );
    const runtimeRecoveryAuthority = createWorkerRuntimeRecoveryAuthority(authorityWorker);
    const contextBuilder = createWorkerCompiledContextBuilder({
      worker: authorityWorker,
      availableTools: runtimeTools.map((tool) => tool.descriptor),
      timeoutMs: 30_000,
      async attachmentAuthorizationRevision(sourceId, sourceRevision, preparation) {
        const prefix = "attachment-extraction:";
        if (!sourceId.startsWith(prefix) || sourceId.length === prefix.length) {
          throw new AgentRuntimeError("context_snapshot_conflict", "Attachment source identity was malformed");
        }
        const result = await authorityWorker.executeAttachment({
          kind: "agent-extraction-authorize",
          context: {
            kind: "agent-execution",
            executionId: preparation.executionId,
            expectedExecutionGeneration: preparation.executionGeneration,
          },
          attachmentId: sourceId.slice(prefix.length),
          expectedAttachmentGeneration: sourceRevision,
        }, Date.now());
        if (!isAttachmentDatabaseOperationResult(result) || !("kind" in result) ||
            result.kind !== "agent-extraction" ||
            result.attachmentGeneration !== sourceRevision) {
          throw new AgentRuntimeError("context_storage_unavailable", "Attachment source authority was malformed");
        }
        return result.roomAccessRevision;
      },
    });
    const toolGateway = createToolGateway({ authority: runtimeAuthority, adapters: [roomMemoryRead] });
    const toolSafetyAuthority = createWorkerToolSafetyAuthority({ worker: authorityWorker, now: Date.now });
    const toolParameterKey = Object.freeze({
      version: "dao-ft10-parameter-key.v1",
      bytes: new Uint8Array(options.invitationSecretKey),
    });
    const toolParameterSealer = new ToolParameterSealer((version) =>
      version === undefined || version === toolParameterKey.version ? toolParameterKey : undefined);
    if (toolParameterSealer.readiness() !== "ready") {
      throw new TypeError("FT-10 parameter sealing key is unavailable");
    }
    const toolSafetyCoordinator = createToolSafetyRuntimeCoordinator({
      authority: toolSafetyAuthority,
      sealer: toolParameterSealer,
      now: Date.now,
    });
    const toolSafetyGateway = createToolSafetyGateway({
      authority: toolSafetyAuthority,
      adapters: tools.map(bridgePhysicalToolAdapter),
    });
    runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      recoveryAuthority: runtimeRecoveryAuthority,
      provider,
      modelId: runtimeModel,
      readiness: () => testOptions.agentRuntimeProviderForTest !== undefined ||
          secretProvider.getSecret("OPENAI_API_KEY") !== undefined
        ? "ready"
        : "noauth",
      tools: runtimeTools.map((tool) => tool.descriptor),
      toolGateway,
      toolAdapters: [roomMemoryRead],
      toolSafety: { coordinator: toolSafetyCoordinator, gateway: toolSafetyGateway },
      async buildProviderInput(execution, invocation) {
        return contextBuilder.build(execution, invocation);
      },
      emitPreview(preview) {
        sourceScopedRuntimeBoundary?.publishPreview(preview);
      },
      resetPreview(preview) {
        void transport?.resetAgentPreview(preview);
      },
      onMessageCommitted(execution) {
        if (execution.resultMessageId !== undefined) {
          memoryRuntime?.enqueue(execution.roomId);
        }
      },
    });
    let directIntentConsumer: Promise<void> | undefined;
    const runtimeReady = (): boolean => testOptions.agentRuntimeProviderForTest !== undefined ||
      secretProvider.getSecret("OPENAI_API_KEY") !== undefined;
    kickDirectIntentConsumer = () => {
      if (!runtimeReady() || directIntentConsumer !== undefined) return;
      directIntentConsumer = (async () => {
        while (runtime !== undefined && worker !== undefined) {
          const result = await worker.executeRuntime({
            type: "runtime.claim-pending-direct-intents",
            providerId: provider.id,
            modelId: runtimeModel,
            limit: 256,
            now: Date.now(),
          });
          if (typeof result !== "object" || result === null ||
              !("kind" in result) || result.kind !== "direct-intent-claims" ||
              !("records" in result) || !Array.isArray(result.records) ||
              !("hasMore" in result) || typeof result.hasMore !== "boolean") {
            throw new Error("Authority direct intent claim result was malformed");
          }
          if (result.records.length === 0) return;
          await runtime.recover();
          await runtime.whenIdle();
        }
      })().catch(() => undefined).finally(() => {
        directIntentConsumer = undefined;
      });
    };
    sourceScopedRuntimeBoundary = createSourceScopedRuntimeBoundary({
      runtime: {
        applyCommittedMessageRecall(input) {
          runtime?.applyCommittedMessageRecall(input);
        },
      },
      preview: {
        publish(preview) {
          void transport?.publishAgentPreview({
            roomId: preview.roomId,
            executionId: preview.executionId,
            attemptSeq: preview.attemptSeq,
            streamSeq: preview.streamSeq,
            delta: preview.delta,
          });
        },
      },
    });
    const routeAuthority = createWorkerRouteAuthority(worker);
    const routerProvider = createOpenAIRouterProvider({
      endpoint: runtimeConfiguration.endpoint ?? "https://api.openai.com/v1/responses",
      model: runtimeModel,
      secretProvider,
    });
    routeRuntime = createRouteRuntimeService({
      authority: routeAuthority,
      provider: routerProvider,
      memoryReadiness: { read: memoryAuthority.readReadiness },
      projectFacts: {
        async read(roomId) {
          const result = await authorityWorker.executeRuntime({
            type: "runtime.read-project-route-facts", roomId, now: Date.now(),
          });
          if (typeof result !== "object" || result === null || !("kind" in result) ||
              result.kind !== "project-route-facts" || !("result" in result)) {
            throw new Error("Project route facts result was malformed");
          }
          const facts = result.result;
          if (typeof facts !== "object" || facts === null || !("status" in facts)) {
            throw new Error("Project route facts result was malformed");
          }
          if (facts.status === "dependency_unavailable") {
            return { status: "dependency_unavailable" } as const;
          }
          if (facts.status !== "ready" || !("goalRevision" in facts) ||
              !("projectRevision" in facts) || typeof facts.goalRevision !== "number" ||
              !Number.isSafeInteger(facts.goalRevision) || facts.goalRevision < 1 ||
              typeof facts.projectRevision !== "number" ||
              !Number.isSafeInteger(facts.projectRevision) || facts.projectRevision < 1) {
            throw new Error("Project route facts result was malformed");
          }
          return { status: "ready", goalRevision: facts.goalRevision,
            projectRevision: facts.projectRevision } as const;
        },
      },
      agentReadiness: () => testOptions.agentRuntimeProviderForTest !== undefined ||
          secretProvider.getSecret("OPENAI_API_KEY") !== undefined
        ? "ready"
        : "noauth",
    });
    ballRuntime = createBallRuntimeService({
      worker,
      blueprint: testOptions.blueprintBallProjectionPort ?? createEmptyBlueprintBallProjectionPort(),
      policy: ballPolicy,
      ...(ballConfiguration.scanIntervalMs === undefined
        ? {} : { scanIntervalMs: ballConfiguration.scanIntervalMs }),
    });
    const sendBeforeMarkFaultDeliveries = new Set<string>();
    const outboxStore = testOptions.faultPoint === "after-send-before-dispatch-mark"
      ? {
          async listPendingOutbox(limit: number) {
            const deliveries = await authority.listPendingOutbox(limit);
            for (const delivery of deliveries) {
              if (delivery.targetKind === "room" && delivery.event.type === "room.message.accepted") {
                sendBeforeMarkFaultDeliveries.add(delivery.deliveryId);
              }
            }
            return deliveries;
          },
          authorizeOutboxCandidate: authority.authorizeOutboxCandidate,
          markOutboxFailed: authority.markOutboxFailed,
          markOutboxDispatched(deliveryId: string): Promise<void> {
            if (sendBeforeMarkFaultDeliveries.has(deliveryId)) process.exit(84);
            return authority.markOutboxDispatched(deliveryId);
          },
        }
      : authority;
    const messageAuthority = {
      async submitHumanMessage(...args: Parameters<typeof authority.submitHumanMessage>) {
        const receipt = await authority.submitHumanMessage(...args);
        memoryRuntime?.enqueue(args[1].roomId);
        kickDirectIntentConsumer();
        return {
          messageId: receipt.messageId,
          persistedAt: receipt.persistedAt,
          targetOutcomes: receipt.targetOutcomes,
        };
      },
      async reviseHumanMessage(...args: Parameters<typeof authority.reviseHumanMessage>) {
        const receipt = await authority.reviseHumanMessage(...args);
        memoryRuntime?.enqueue(args[1].roomId);
        return {
          messageId: receipt.messageId,
          revision: receipt.revision,
          persistedAt: receipt.persistedAt,
        };
      },
      async recallHumanMessage(...args: Parameters<typeof authority.recallHumanMessage>) {
        const receipt = await sourceScopedRuntimeBoundary!.coordinateRecallCommit(
          () => authority.recallHumanMessage(...args),
          (committed) => ({
            sourceMessageId: committed.messageId,
            cancellations: committed.abortTargets,
          }),
        );
        memoryRuntime?.enqueue(args[1].roomId);
        return {
          messageId: receipt.messageId,
          revision: receipt.revision,
          recalledAt: receipt.recalledAt,
        };
      },
      readMessageHistory: authority.readMessageHistory,
      readMessageRevisions: authority.readMessageRevisions,
    } satisfies NonNullable<Parameters<typeof startMessageWebSocketServer>[0]["messageAuthority"]>;
    const attachmentConfiguration = options.attachmentRuntime;
    if (attachmentConfiguration !== undefined) {
      const capabilities = await probeProductionAttachmentCapabilities({
        cwd: attachmentConfiguration.cwd,
        timeoutMs: attachmentConfiguration.capabilityProbeTimeoutMs,
        clamd: attachmentConfiguration.clamd,
        poppler: {
          executable: attachmentConfiguration.pdfinfo.executable,
          argv: [...(attachmentConfiguration.pdfinfo.argvPrefix ?? []), "-v"],
        },
        tesseract: {
          executable: attachmentConfiguration.tesseract.executable,
          argv: [...(attachmentConfiguration.tesseract.argvPrefix ?? []), "--version"],
        },
      });
      if (capabilities.attachmentReadiness === "ready" &&
          capabilities.scanner.version !== null && capabilities.poppler.version !== null &&
          capabilities.tesseract.version !== null) {
        const objectStore = new AttachmentObjectStore({
          root: attachmentConfiguration.storageRoot,
          limits: {
            maxChunkBytes: ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes,
            maxFileBytes: ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes,
            maxExtractionBytes: ATTACHMENT_AUTHORITY_LIMITS.maxExtractionArtifactBytes,
            reconcileMaxEntries: 1_024,
            reconcileMaxBytes: 512 * 1_024 * 1_024,
          },
        });
        await objectStore.initialize();
        attachmentObjectStore = objectStore;
        attachmentExtractionReader = createAttachmentAgentExtractionReader({
          database: authorityWorker,
          objectStore,
          nowMs: Date.now,
        });
        await reconcileAttachmentObjectStore({
          database: worker,
          objectStore,
          nowMs: Date.now,
          maxPasses: 64,
        });
        const tools = Object.freeze({
          cwd: attachmentConfiguration.cwd,
          extractTimeoutMs: 60_000,
          ocrTimeoutMs: 180_000,
          ocrLanguage: attachmentConfiguration.ocrLanguage,
          pdfinfo: Object.freeze({
            executable: attachmentConfiguration.pdfinfo.executable,
            argvPrefix: Object.freeze([...(attachmentConfiguration.pdfinfo.argvPrefix ?? [])]),
            version: capabilities.poppler.version,
          }),
          pdftotext: Object.freeze({
            executable: attachmentConfiguration.pdftotext.executable,
            argvPrefix: Object.freeze([...(attachmentConfiguration.pdftotext.argvPrefix ?? [])]),
            version: capabilities.poppler.version,
          }),
          pdftoppm: Object.freeze({
            executable: attachmentConfiguration.pdftoppm.executable,
            argvPrefix: Object.freeze([...(attachmentConfiguration.pdftoppm.argvPrefix ?? [])]),
            version: capabilities.poppler.version,
          }),
          tesseract: Object.freeze({
            executable: attachmentConfiguration.tesseract.executable,
            argvPrefix: Object.freeze([...(attachmentConfiguration.tesseract.argvPrefix ?? [])]),
            version: capabilities.tesseract.version,
          }),
        });
        attachmentProcessing = createAttachmentProcessingRuntime({
          database: worker,
          objectStore,
          tools,
          scanner: {
            name: "clamav",
            version: capabilities.scanner.version,
            timeoutMs: attachmentConfiguration.clamd.policy.scanTimeoutMs,
          },
          nowMs: Date.now,
          createPipeline: (generation) => createProductionAttachmentProcessingPipeline({
            clamd: {
              endpoint: attachmentConfiguration.clamd.endpoint,
              timeoutMs: attachmentConfiguration.clamd.policy.scanTimeoutMs,
              version: capabilities.scanner.version!,
            },
            generation,
            tools,
          }),
        });
        await attachmentProcessing.recover();
        const recoveryTimer = setInterval(() => {
          void attachmentProcessing?.recover().catch(() => undefined);
        }, 5_000);
        recoveryTimer.unref();
        stopAttachmentRecovery = () => clearInterval(recoveryTimer);
        attachmentAuthority = createAttachmentAuthorityService({
          database: worker,
          objectStore,
          processor: attachmentProcessing,
          nowMs: Date.now,
          nextGrantId: randomUUID,
        });
      }
      settleAttachmentReader(attachmentExtractionReader);
    }
    await runtime.recover();
    await afterCommittedProducerCommand();
    kickDirectIntentConsumer();
    await scanProjectBoundaries();
    const runtimeRecoveryTimer = setInterval(() => {
      void runtime?.recover().catch(() => undefined);
      void retentionOperations?.run("periodic", Date.now()).catch(() => undefined);
      void privacyOperations?.runMaintenance(Date.now()).catch(() => undefined);
      void afterCommittedProducerCommand();
      kickDirectIntentConsumer();
      void scanProjectBoundaries().catch(() => undefined);
    }, 1_000);
    runtimeRecoveryTimer.unref();
    stopRuntimeRecovery = () => clearInterval(runtimeRecoveryTimer);
    await routeRuntime.recover();
    await ballRuntime.recover();
    const memoryProvider = createOpenAIMemoryStewardProvider({
      endpoint: runtimeConfiguration.endpoint ?? "https://api.openai.com/v1/responses",
      model: runtimeModel,
      secretProvider,
    });
    memoryRuntime = createMemoryStewardRuntime({
      authority: memoryAuthority,
      provider: createMemoryStewardProviderAdapter({
        authority: memoryAuthority,
        provider: memoryProvider,
        readiness: () => secretProvider.getSecret("OPENAI_API_KEY") === undefined ? "noauth" : "ready",
        ...(attachmentObjectStore === undefined ? {} : { objectStore: attachmentObjectStore }),
      }),
    });
    await memoryRuntime.recover();
    const memoryRecoveryTimer = setInterval(() => {
      void memoryRuntime?.recover().catch(() => undefined);
    }, 5_000);
    memoryRecoveryTimer.unref();
    stopMemoryRecovery = () => clearInterval(memoryRecoveryTimer);
    const publicMemoryAuthority = {
      async execute(
        context: Parameters<typeof memoryAuthority.executePublic>[0],
        request: Parameters<typeof memoryAuthority.executePublic>[1],
      ) {
        const frame = await memoryAuthority.executePublic(context, request);
        if (request.type === "room.memory.retry.v1") memoryRuntime?.enqueue(request.roomId);
        return frame;
      },
    };
    const publicToolSafetyAuthority: ToolSafetyAuthorityTransport = Object.freeze({
      async executePublicCommand(
        context: Parameters<ToolSafetyAuthorityTransport["executePublicCommand"]>[0],
        command: Parameters<ToolSafetyAuthorityTransport["executePublicCommand"]>[1],
      ) {
        if (command.type === "tool.confirmation.decide") {
          const result = await runtime!.decideToolSafetyConfirmation(
            context, command.confirmationId, command.expectedVersion, command.decision,
          );
          return Object.freeze({ operation: command.type,
            objectId: result.confirmationId, version: result.version, replayed: result.replayed });
        }
        if (command.type === "tool.outcome.review") {
          const evidenceSummary = command.evidenceSummary.trim();
          const result = await toolSafetyAuthority.execute({
            type: "tool-safety.outcome-review",
            context,
            dispatchId: command.dispatchId,
            expectedVersion: command.expectedVersion,
            resolution: command.resolution,
            evidenceSummary,
            evidenceSha256: createHash("sha256").update(evidenceSummary).digest("hex"),
            now: Date.now(),
          });
          if (result.kind !== "reviewed") {
            throw new AgentRuntimeError("execution_conflict", "Tool review result was malformed");
          }
          return Object.freeze({ operation: command.type,
            objectId: result.reviewId, version: result.version, replayed: result.replayed });
        }
        if (command.type === "tool.confirmation.handoff.offer") {
          const result = await toolSafetyCoordinator.offerHandoff({ context,
            confirmationId: command.confirmationId, expectedVersion: command.expectedVersion,
            targetActorId: command.targetActorId });
          if (result.kind !== "handoff" || result.state !== "offered") {
            throw new AgentRuntimeError("execution_conflict", "Tool handoff offer was malformed");
          }
          return Object.freeze({ operation: command.type, objectId: result.handoffId,
            version: result.version, replayed: result.replayed });
        }
        if (command.type === "tool.confirmation.handoff.accept") {
          const result = await toolSafetyCoordinator.acceptHandoff({ context,
            handoffId: command.handoffId, expectedVersion: command.expectedVersion });
          if (result.kind !== "handoff" || result.state !== "accepted") {
            throw new AgentRuntimeError("execution_conflict", "Tool handoff accept was malformed");
          }
          return Object.freeze({ operation: command.type, objectId: result.handoffId,
            version: result.version, replayed: result.replayed });
        }
        if (command.type === "tool.compensation.propose") {
          const result = await toolSafetyCoordinator.proposeCompensation({ context,
            dispatchId: command.dispatchId, expectedVersion: command.expectedVersion });
          if (result.kind !== "compensation-proposed") {
            throw new AgentRuntimeError("execution_conflict", "Tool compensation proposal was malformed");
          }
          await runtime!.recover();
          return Object.freeze({ operation: command.type, objectId: result.lineageId,
            version: result.version, replayed: result.replayed });
        }
        throw new AgentRuntimeError(
          "execution_conflict",
          "Tool safety operation requires an authoritative transition not yet available",
        );
      },
    });
    transport = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      host: options.listen?.host ?? AUTHORITATIVE_SERVER_DEFAULT_HOST,
      port: options.listen?.port ?? AUTHORITATIVE_SERVER_DEFAULT_PORT,
      outboxStore,
      outboxPollIntervalMs: 10,
      outboxFailureLifecycle: {
        scheduleRetry: (input) => authorityWorker.scheduleOutboxRetry(input),
        deadLetter: (input) => authorityWorker.deadLetterOutbox(input),
      },
      outboxAlertSink: {
        emit(alert) {
          process.stderr.write(`${JSON.stringify({ source: "authority-outbox", ...alert })}\n`);
        },
      },
      offlineReadLeaseAuthority: {
        issue: (context, roomId) => {
          const nowMs = Date.now();
          requireActiveOfflineLeaseSigningKey(
            offlineLeaseKeyring,
            nowMs,
            offlineReadLeaseSigning.keyId,
          );
          return authorityWorker.issueOfflineReadLease(
            context,
            roomId,
            releaseLeasePolicy.defaultLeaseMs,
            nowMs,
          );
        },
      },
      agentRuntime: runtime,
      toolSafetyAuthority: publicToolSafetyAuthority,
      previewAuthority: {
        async deliver(input, sendSynchronously) {
          await authorityWorker.executeRuntimeWithSynchronousDelivery({
            type: "runtime.preview-authorize",
            context: input.context,
            roomId: input.roomId,
            executionId: input.executionId,
            attemptSeq: input.attemptSeq,
            deliveryKind: input.deliveryKind,
            subscriptionGeneration: input.subscriptionGeneration,
            ...(input.expectedAuthorityEpoch === undefined
              ? {}
              : { expectedAuthorityEpoch: input.expectedAuthorityEpoch }),
            now: Date.now(),
          }, (result) => {
            if (typeof result !== "object" || result === null ||
                !("kind" in result) || result.kind !== "preview-authority" ||
                !("subscriptionGeneration" in result) ||
                result.subscriptionGeneration !== input.subscriptionGeneration ||
                !("authorized" in result) ||
                typeof result.authorized !== "boolean" ||
                !("authorityEpoch" in result) ||
                typeof result.authorityEpoch !== "string" ||
                result.authorityEpoch.length === 0) {
              throw new AgentRuntimeError(
                "context_storage_unavailable",
                "Preview delivery authority returned a malformed receipt",
              );
            }
            sendSynchronously({
              authorized: result.authorized,
              authorityEpoch: result.authorityEpoch,
            });
            return undefined;
          });
        },
      },
      collaboration: primitives,
      ballRuntime,
      messageAuthority,
      memoryAuthority: publicMemoryAuthority,
      projectLoopAuthority,
      notificationAuthority: {
        execute: (operation) => authorityWorker.executeNotification(operation),
      },
      roomExportAuthority: privacyOperations,
      diagnosticsAuthority: privacyOperations,
      agentSettingsAuthority: agentSettings,
      ...(attachmentAuthority === undefined ? {} : { attachmentAuthority }),
      governance: governanceStore,
    });
  } catch (error: unknown) {
    settleAttachmentReader(undefined);
    await cacheInvalidationRecovery?.close().catch(() => undefined);
    stopRuntimeRecovery?.();
    stopAttachmentRecovery?.();
    stopMemoryRecovery?.();
    await transport?.close().catch(() => undefined);
    await memoryRuntime?.stop().catch(() => undefined);
    attachmentAuthority?.close();
    await attachmentProcessing?.close().catch(() => undefined);
    await routeRuntime?.close().catch(() => undefined);
    await ballRuntime?.close().catch(() => undefined);
    await projectBoundaryRuntime?.close().catch(() => undefined);
    let runtimeSafetySettled = true;
    await runtime?.close().catch(() => { runtimeSafetySettled = false; });
    await retentionOperations?.shutdown().catch(() => undefined);
    await privacyOperations?.close().catch(() => undefined);
    await snapshots?.close().catch(() => undefined);
    if (runtimeSafetySettled) await worker?.close().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    url: transport.url,
    privacyOperations: privacyOperations!,
    close() {
      if (closePromise !== undefined) return closePromise;
      const attempt = (async () => {
        stopRuntimeRecovery?.();
        stopAttachmentRecovery?.();
        stopMemoryRecovery?.();
        const failures: unknown[] = [];
        let runtimeSafetySettled = true;
        for (const [stage, close] of [
          ["cache-invalidation-recovery", () => cacheInvalidationRecovery!.close()],
          ["transport", () => transport.close()],
          ["attachment-authority", async () => attachmentAuthority?.close()],
          ["attachment-processing", async () => attachmentProcessing?.close()],
          ["memory", async () => memoryRuntime?.stop()],
          ["route", () => routeRuntime!.close()],
          ["project-boundary", () => projectBoundaryRuntime!.close()],
          ["runtime", () => runtime!.close()],
          ["privacy-retention", async () => {
            const result = await retentionOperations?.shutdown();
            if (result?.status === "shutdown_timeout") {
              throw new Error("Privacy retention shutdown timed out");
            }
          }],
          ["privacy-operations", () => privacyOperations!.close()],
          ["ball", () => ballRuntime!.close()],
          ["snapshots", () => snapshots.close()],
          ["worker", () => worker.close()],
        ] as const) {
          if (stage === "worker" && !runtimeSafetySettled) continue;
          try {
            await close();
            testOptions.afterCloseForTest?.[stage]?.();
          } catch (error: unknown) {
            failures.push(error);
            if (stage === "runtime") runtimeSafetySettled = false;
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Authoritative server cleanup failed");
        }
      })();
      const retryable = attempt.catch((error: unknown) => {
        if (closePromise === retryable) closePromise = undefined;
        throw error;
      });
      closePromise = retryable;
      return closePromise;
    },
  };
}
