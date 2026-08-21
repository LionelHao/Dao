import { randomUUID } from "node:crypto";
import { ATTACHMENT_AUTHORITY_LIMITS, type Actor } from "@native-im/core";
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
import { startMessageWebSocketServer } from "./websocket.js";
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
import { AgentRuntimeError, type ProviderAdapter } from "./agent-runtime/contracts.js";
import { createEnvironmentSecretProvider } from "./agent-runtime/environment-secret-provider.js";
import { createOpenAIResponsesProvider } from "./agent-runtime/openai-responses-provider.js";
import { createWorkerRuntimeAuthority } from "./agent-runtime/worker-runtime-authority.js";
import { createHttpJsonReadAdapter } from "./agent-runtime/tools/http-json-read.js";
import { createRepositoryGitStatusAdapter } from "./agent-runtime/tools/repository-git-status.js";
import { createSandboxFileWriteAdapter } from "./agent-runtime/tools/sandbox-file-write.js";
import { createToolGateway } from "./agent-runtime/tool-gateway.js";
import { createWorkerRoomMemoryReadAdapter } from "./agent-runtime/worker-room-memory-read-adapter.js";
import { createWorkerCompiledContextBuilder } from "./context-compiler/worker-compiled-context.js";
import { createOpenAIRouterProvider } from "./route-runtime/openai-router-provider.js";
import { createRouteRuntimeService, type RouteRuntimeService } from "./route-runtime/route-runtime-service.js";
import { createWorkerRouteAuthority } from "./route-runtime/worker-route-authority.js";
import { mintInternalAgentCommandContext } from "./persistence/contracts.js";
import { createEmptyBlueprintBallProjectionPort, type BlueprintBallProjectionPort } from "./ball-runtime/contracts.js";
import { createBallRuntimeService, type BallRuntimeService } from "./ball-runtime/ball-runtime-service.js";
import {
  createHumanPreemptionRuntime,
  type HumanPreemptionRuntime,
} from "./human-preemption/human-preemption-runtime.js";
import { RoomCacheInvalidationPostCommitDispatcher } from "./access/room-cache-invalidation-port.js";
import { createProductionSharedAuthorityParticipantComposition } from "./room-governance/production-participant-composition.js";
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
import { createOpenAIMemoryStewardProvider } from "./room-memory/openai-memory-provider.js";
import { createMemoryStewardProviderAdapter } from "./room-memory/steward-provider-adapter.js";
import {
  createMemoryStewardRuntime,
  type MemoryStewardRuntime,
} from "./room-memory/memory-steward-runtime.js";

export { createProductionSharedAuthorityParticipantComposition } from "./room-governance/production-participant-composition.js";

export const AUTHORITATIVE_SERVER_DEFAULT_HOST = "127.0.0.1";
export const AUTHORITATIVE_SERVER_DEFAULT_PORT = 8_787;

export interface AuthoritativeServer {
  readonly url: string;
  close(): Promise<void>;
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
  };
  readonly agentRuntime?: {
    readonly model?: string;
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
    | "transport"
    | "attachment-authority"
    | "attachment-processing"
    | "memory"
    | "route"
    | "runtime"
    | "ball"
    | "snapshots"
    | "worker",
    () => void
  >>;
  readonly blueprintBallProjectionPort?: BlueprintBallProjectionPort;
  readonly agentRuntimeProviderForTest?: ProviderAdapter;
}

export interface AuthoritativeServerTestFacades {
  readonly auth: ReturnType<typeof createAuthenticationService>;
  readonly lifecycle: ReturnType<typeof createAuthoritativeRoomLifecycleService>;
  readonly messages: ReturnType<typeof createMessageService>;
  readonly primitives: ReturnType<typeof createAuthoritativeCollaborationPrimitives>;
}

export function startAuthoritativeServer(
  options: StartAuthoritativeServerOptions,
): Promise<AuthoritativeServer> {
  return start(options, {});
}

/** Deep-import-only constructor for the compiled child-process harness. */
export function startAuthoritativeServerForTest(
  options: StartAuthoritativeServerOptions,
  testOptions: AuthoritativeServerTestOptions,
): Promise<AuthoritativeServer> {
  return start(options, testOptions);
}

async function start(
  options: StartAuthoritativeServerOptions,
  testOptions: AuthoritativeServerTestOptions,
): Promise<AuthoritativeServer> {
  const ballConfiguration = options.ballRuntime ?? {};
  const ballPolicy = Object.freeze({
    openItemDeadlineMs: ballConfiguration.openItemDeadlineMs ?? 24 * 60 * 60 * 1_000,
    lightTaskDeadlineMs: ballConfiguration.lightTaskDeadlineMs ?? 24 * 60 * 60 * 1_000,
  });
  createProductionSharedAuthorityParticipantComposition({
    maxOfflineReadLeaseMs: options.sharedAuthority.maxOfflineReadLeaseMs,
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
  let worker: WorkerDatabaseClient | undefined;
  let snapshots: Awaited<ReturnType<typeof createSnapshotWorkerClient>> | undefined;
  let transport: Awaited<ReturnType<typeof startMessageWebSocketServer>> | undefined;
  let runtime: AgentRuntimeService | undefined;
  let sourceScopedRuntimeBoundary: SourceScopedRuntimeBoundary | undefined;
  let routeRuntime: RouteRuntimeService | undefined;
  let ballRuntime: BallRuntimeService | undefined;
  let humanPreemptionRuntime: HumanPreemptionRuntime | undefined;
  let stopCacheInvalidationRecovery: (() => void) | undefined;
  let attachmentAuthority: AttachmentAuthorityCommandPort | undefined;
  let attachmentProcessing: AttachmentProcessingRuntime | undefined;
  let stopAttachmentRecovery: (() => void) | undefined;
  let attachmentObjectStore: AttachmentObjectStore | undefined;
  let attachmentExtractionReader: AttachmentAgentExtractionReadPort | undefined;
  let memoryRuntime: MemoryStewardRuntime | undefined;
  let stopMemoryRecovery: (() => void) | undefined;
  try {
    worker = transactionFault === undefined
      ? await createWorkerDatabaseClient({
          databasePath: options.databasePath,
          sharedAuthorityRecovery: {
            ballPolicy,
            maxOfflineReadLeaseMs: options.sharedAuthority.maxOfflineReadLeaseMs,
          },
        })
      : await createWorkerDatabaseClientWithTransactionFaultForTest(
          {
            databasePath: options.databasePath,
            sharedAuthorityRecovery: {
              ballPolicy,
              maxOfflineReadLeaseMs: options.sharedAuthority.maxOfflineReadLeaseMs,
            },
          },
          transactionFault,
        );
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
      else if (!isDeepStrictEqual(persisted, actor)) {
        throw new TypeError(`Persisted authoritative actor mismatch: ${actor.id}`);
      }
    }
    if (missingActors.length > 0) {
      if (testOptions.registerMissingActors === false) {
        throw new TypeError("Persisted authoritative actors are missing");
      }
      await authority.registerActors(missingActors);
    }
    const snapshotClient = await createSnapshotWorkerClient({
      authorityPath: options.databasePath,
      cachePath: options.snapshotCachePath,
      revalidate: (request) => authority.revalidateSnapshot(request),
      streamingAuthority: worker,
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
    });
    let cacheInvalidationDispatchRunning = false;
    const dispatchCacheInvalidations = async (): Promise<void> => {
      if (cacheInvalidationDispatchRunning) return;
      cacheInvalidationDispatchRunning = true;
      try {
        await cacheInvalidationDispatcher.dispatchReadyBatch();
      } finally {
        cacheInvalidationDispatchRunning = false;
      }
    };
    await dispatchCacheInvalidations();
    const cacheInvalidationTimer = setInterval(() => {
      void dispatchCacheInvalidations().catch(() => undefined);
    }, 1_000);
    cacheInvalidationTimer.unref();
    stopCacheInvalidationRecovery = () => clearInterval(cacheInvalidationTimer);
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
    const sync = createSyncService({ store: authority, snapshots: materializedSnapshots });
    const auth = createAuthenticationService({
      actors: {
        getActor(actorId) {
          return options.actors.find((actor) => actor.id === actorId);
        },
      },
      identities: options.identities,
      authority,
    });
    const commandStore = {
        async executeHuman(context, command) {
          try {
            const acknowledgement = await authority.executeHuman(context, command);
            if (command.type === "message.send") {
              await humanPreemptionRuntime?.handle(acknowledgement.aggregateId);
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
            routeRuntime?.notify(command.roomId, acknowledgement.aggregateId);
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
          return await authority.executeHumanGovernance(...args);
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
    await testOptions.initialize?.({ auth, lifecycle, messages: service, primitives });
    const runtimeConfiguration = options.agentRuntime ?? {};
    const authorityWorker = worker as CompleteWorkerDatabaseClient;
    const secretProvider = createEnvironmentSecretProvider();
    const memoryAuthority = createWorkerMemoryAuthority({ worker, nowMs: Date.now });
    const provider = testOptions.agentRuntimeProviderForTest ?? createOpenAIResponsesProvider({
      endpoint: runtimeConfiguration.endpoint ?? "https://api.openai.com/v1/responses",
      model: runtimeConfiguration.model ?? "gpt-5-mini",
      secretProvider,
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
      }),
      createSandboxFileWriteAdapter({
        root: sandboxRoot,
        compensationKey: new Uint8Array(options.invitationSecretKey),
        maxContentBytes: 256 * 1_024,
      }),
    ] as const;
    const roomMemoryRead = createWorkerRoomMemoryReadAdapter({
      worker: authorityWorker,
      cursorSecret: options.invitationSecretKey,
      attachmentReader: () => attachmentExtractionReader,
    });
    const runtimeTools = [...tools, roomMemoryRead] as const;
    const runtimeAuthority = createWorkerRuntimeAuthority(
      authorityWorker,
      { contextWorker: authorityWorker },
    );
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
    const toolGateway = createToolGateway({ authority: runtimeAuthority, adapters: runtimeTools });
    runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider,
      modelId: runtimeConfiguration.model ?? "gpt-5-mini",
      readiness: () => testOptions.agentRuntimeProviderForTest !== undefined ||
          secretProvider.getSecret("OPENAI_API_KEY") !== undefined
        ? "ready"
        : "noauth",
      tools: runtimeTools.map((tool) => tool.descriptor),
      toolGateway,
      toolAdapters: runtimeTools,
      async buildProviderInput(execution, invocation) {
        return contextBuilder.build(execution, invocation);
      },
      emitPreview(preview) {
        sourceScopedRuntimeBoundary?.publishPreview(preview);
      },
      onMessageCommitted(execution) {
        if (execution.resultMessageId !== undefined) {
          routeRuntime?.notify(execution.roomId, execution.resultMessageId);
          memoryRuntime?.enqueue(execution.roomId);
        }
      },
      async proposeOpenItem(input) {
        const item = await primitives.proposeOpenItem(
          mintInternalAgentCommandContext({
            agentId: input.execution.agentId,
            requestId: `runtime-open-item:${input.execution.id}:${input.callId}`,
            idempotencyKey: `runtime-open-item:${input.execution.id}:${input.callId}`,
          }),
          input.execution.roomId,
          {
            proposalKind: input.proposalKind,
            targetActorId: input.targetActorId,
            sourceExecutionId: input.execution.id,
            sourceMessageId: input.sourceMessageId,
            reason: input.reason,
            content: input.content,
          },
        );
        return { id: item.id };
      },
    });
    sourceScopedRuntimeBoundary = createSourceScopedRuntimeBoundary({
      runtime: {
        applyCommittedMessageRecall(input) {
          runtime?.applyCommittedMessageRecall(input);
        },
      },
      preview: {
        publish(preview) {
          transport?.publishAgentPreview({
            roomId: preview.roomId,
            executionId: preview.executionId,
            attemptSeq: preview.attemptSeq,
            streamSeq: preview.streamSeq,
            delta: preview.delta,
          });
        },
      },
    });
    await runtime.recover();
    const routeAuthority = createWorkerRouteAuthority(worker);
    const routerProvider = createOpenAIRouterProvider({
      endpoint: runtimeConfiguration.endpoint ?? "https://api.openai.com/v1/responses",
      model: runtimeConfiguration.model ?? "gpt-5-mini",
      secretProvider,
    });
    routeRuntime = createRouteRuntimeService({
      authority: routeAuthority,
      provider: routerProvider,
      memoryReadiness: { read: memoryAuthority.readReadiness },
      async invoke(routeJobId, intent) {
        const runtimeIntent = {
          kind: intent.kind,
          roomId: intent.roomId,
          sourceMessageId: intent.sourceMessageId,
          targetAgentId: intent.targetAgentId,
        } as const;
        const replacements = await runtime!.invokeFenceReplacements(routeJobId, runtimeIntent);
        if (replacements.length === 0) await runtime!.invokeRouted(routeJobId, runtimeIntent);
      },
    });
    await routeRuntime.recover();
    humanPreemptionRuntime = createHumanPreemptionRuntime({
      worker,
      runtime,
      notifyRoute(roomId, sourceMessageId) {
        return routeRuntime!.notify(roomId, sourceMessageId);
      },
    });
    await humanPreemptionRuntime.recover();
    ballRuntime = createBallRuntimeService({
      worker,
      blueprint: testOptions.blueprintBallProjectionPort ?? createEmptyBlueprintBallProjectionPort(),
      policy: ballPolicy,
      ...(ballConfiguration.scanIntervalMs === undefined
        ? {} : { scanIntervalMs: ballConfiguration.scanIntervalMs }),
    });
    await ballRuntime.recover();
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
    }
    const memoryProvider = createOpenAIMemoryStewardProvider({
      endpoint: runtimeConfiguration.endpoint ?? "https://api.openai.com/v1/responses",
      model: runtimeConfiguration.model ?? "gpt-5-mini",
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
    transport = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      host: options.listen?.host ?? AUTHORITATIVE_SERVER_DEFAULT_HOST,
      port: options.listen?.port ?? AUTHORITATIVE_SERVER_DEFAULT_PORT,
      outboxStore,
      outboxPollIntervalMs: 10,
      agentRuntime: runtime,
      collaboration: primitives,
      ballRuntime,
      messageAuthority,
      memoryAuthority: publicMemoryAuthority,
      ...(attachmentAuthority === undefined ? {} : { attachmentAuthority }),
      governance: governanceStore,
    });
  } catch (error: unknown) {
    stopCacheInvalidationRecovery?.();
    stopAttachmentRecovery?.();
    stopMemoryRecovery?.();
    await transport?.close().catch(() => undefined);
    await memoryRuntime?.stop().catch(() => undefined);
    attachmentAuthority?.close();
    await attachmentProcessing?.close().catch(() => undefined);
    await routeRuntime?.close().catch(() => undefined);
    await ballRuntime?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await snapshots?.close().catch(() => undefined);
    await worker?.close().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    url: transport.url,
    close() {
      closePromise ??= (async () => {
        stopCacheInvalidationRecovery?.();
        stopAttachmentRecovery?.();
        stopMemoryRecovery?.();
        const failures: unknown[] = [];
        for (const [stage, close] of [
          ["transport", () => transport.close()],
          ["attachment-authority", async () => attachmentAuthority?.close()],
          ["attachment-processing", async () => attachmentProcessing?.close()],
          ["memory", async () => memoryRuntime?.stop()],
          ["route", () => routeRuntime!.close()],
          ["runtime", () => runtime!.close()],
          ["ball", () => ballRuntime!.close()],
          ["snapshots", () => snapshots.close()],
          ["worker", () => worker.close()],
        ] as const) {
          try {
            await close();
            testOptions.afterCloseForTest?.[stage]?.();
          } catch (error: unknown) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "Authoritative server cleanup failed");
        }
      })();
      return closePromise;
    },
  };
}
