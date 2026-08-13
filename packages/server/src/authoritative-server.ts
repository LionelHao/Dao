import type { Actor, AgentExecution } from "@native-im/core";
import { isDeepStrictEqual } from "node:util";
import {
  createAuthenticationService,
  type IdentityAdapter,
} from "./auth.js";
import { createAesGcmInvitationSecretProtector } from "./invitation-secret-protector.js";
import { createMessageService } from "./service.js";
import { createAuthoritativeRoomLifecycleService } from "./room-lifecycle.js";
import { createAuthoritativeCollaborationPrimitives } from "./primitives.js";
import { createSyncService } from "./sync-service.js";
import { startMessageWebSocketServer, type AgentRuntimeTransport } from "./websocket.js";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeInputSource,
} from "./agent-runtime/agent-runtime.js";
import {
  createEnvironmentSecretProvider,
  createOpenAiResponsesProvider,
} from "./agent-runtime/provider-openai.js";
import {
  createHttpJsonReadTool,
  createRepositoryGitStatusTool,
  createSandboxFileWriteTool,
} from "./agent-runtime/tool-adapters.js";
import type {
  AgentRuntimeContextLimits,
  AgentExecutionPreview,
  AgentRuntimeToolAdapter,
  ProviderAdapter,
} from "./agent-runtime/contracts.js";
import { mintInternalAgentRuntimeContext } from "./persistence/contracts.js";
import type {
  AuthenticatedCommandContext,
  ToolConfirmationInput,
} from "./persistence/contracts.js";
import { createSnapshotWorkerClient } from "./persistence/snapshot-worker-client.js";
import { createSqliteAuthoritativeStore } from "./persistence/sqlite-authoritative-store.js";
import {
  createWorkerDatabaseClient,
  createWorkerDatabaseClientWithTransactionFaultForTest,
  type WorkerDatabaseClient,
} from "./persistence/worker-database-client.js";

export interface AuthoritativeServer {
  readonly url: string;
  close(): Promise<void>;
}

export interface StartAuthoritativeServerOptions {
  readonly databasePath: string;
  readonly snapshotCachePath: string;
  readonly actors: readonly Actor[];
  readonly identities: IdentityAdapter;
  readonly invitationSecretKey: Uint8Array;
  readonly agentRuntime?: AgentRuntimeServerConfig;
}

export interface AgentRuntimeServerConfig {
  readonly agentIds: readonly string[];
  readonly provider: {
    readonly endpoint: string;
    readonly model: string;
    readonly secretEnvironmentKey: string;
  };
  readonly httpJsonTool: {
    readonly origin: string;
    readonly pathTemplate: string;
    readonly queryParameterNames?: readonly string[];
    readonly maxResponseBytes?: number;
  };
  readonly gitStatusTool: {
    readonly gitBinaryPath: string;
    readonly repositoryRoot: string;
    readonly maxOutputBytes?: number;
  };
  readonly sandboxFileTool: {
    readonly root: string;
    readonly compensationKey: Uint8Array;
    readonly maxContentBytes?: number;
  };
  readonly contextLimits: AgentRuntimeContextLimits;
  readonly schedulerLimits?: {
    readonly maxActiveRooms?: number;
    readonly maxQueuedPerRoom?: number;
    readonly maxPreviewBytes?: number;
    readonly closeTimeoutMs?: number;
    readonly toolGrantTtlMs?: number;
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
  readonly afterCloseForTest?: Partial<Record<"transport" | "runtime" | "snapshots" | "worker", () => void>>;
  readonly agentRuntimeAdapters?: {
    readonly provider: ProviderAdapter;
    readonly tools: readonly AgentRuntimeToolAdapter[];
    readonly inputSource?: AgentRuntimeInputSource;
  };
}

export interface AuthoritativeServerTestFacades {
  readonly auth: ReturnType<typeof createAuthenticationService>;
  readonly lifecycle: ReturnType<typeof createAuthoritativeRoomLifecycleService>;
  readonly messages: ReturnType<typeof createMessageService>;
  readonly primitives: ReturnType<typeof createAuthoritativeCollaborationPrimitives>;
}

class AgentRuntimeConfigurationError extends Error {
  readonly code = "provider_not_configured" as const;
  readonly status = 409 as const;

  constructor() {
    super("provider_not_configured");
    this.name = "AgentRuntimeConfigurationError";
  }
}

function productionInputSource(
  authority: Pick<ReturnType<typeof createSqliteAuthoritativeStore>, "loadProviderContext">,
  runtimeContext: ReturnType<typeof mintInternalAgentRuntimeContext>,
  tools: readonly AgentRuntimeToolAdapter[],
  limits: AgentRuntimeContextLimits,
): AgentRuntimeInputSource {
  return {
    async load(execution) {
      const context = await authority.loadProviderContext(runtimeContext, execution.id);
      return {
        purpose: "agent_runtime",
        invocation: context.invocation,
        visibleConversation: context.visibleConversation,
        availableTools: tools.map(({ descriptor }) => descriptor),
        committedSteps: context.committedSteps,
        limits,
      };
    },
  };
}

function runtimeTransport(
  runtimes: ReadonlyMap<string, AgentRuntime>,
  readExecution: (
    context: AuthenticatedCommandContext, executionId: string,
  ) => Promise<AgentExecution>,
  providerId: string,
  modelId: string,
  configured: boolean,
  executionRooms: Map<string, string>,
): AgentRuntimeTransport {
  const runtimeForAgent = (agentId: string): AgentRuntime => {
    const runtime = runtimes.get(agentId);
    if (runtime === undefined) throw new AgentRuntimeConfigurationError();
    return runtime;
  };
  const readBoundExecution = async (
    context: AuthenticatedCommandContext, executionId: string,
  ): Promise<AgentExecution> => {
    const execution = await readExecution(context, executionId);
    executionRooms.set(execution.id, execution.roomId);
    return execution;
  };
  const runtimeForExecution = async (
    context: AuthenticatedCommandContext, executionId: string,
  ): Promise<AgentRuntime> => runtimeForAgent((await readBoundExecution(context, executionId)).agentId);
  return {
    async invoke(context, input) {
      if (!configured) throw new AgentRuntimeConfigurationError();
      const execution = await runtimeForAgent(input.targetAgentId).invoke(context, {
        ...input, providerId, modelId,
      });
      executionRooms.set(execution.id, execution.roomId);
      return execution;
    },
    async interrupt(context, executionId, reason) {
      return (await runtimeForExecution(context, executionId)).interrupt(context, executionId, reason);
    },
    async retry(context, executionId) {
      return (await runtimeForExecution(context, executionId)).retry(context, executionId);
    },
    async confirmTool(context, input: ToolConfirmationInput) {
      return (await runtimeForExecution(context, input.executionId)).confirmTool(context, input);
    },
    async compensate(context, executionId, dispatchId) {
      return (await runtimeForExecution(context, executionId)).compensate(
        context, executionId, dispatchId,
      );
    },
  };
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
  const runtimeSecretProvider = options.agentRuntime === undefined
    ? undefined
    : createEnvironmentSecretProvider();
  const runtimeConfigured = options.agentRuntime === undefined ||
    testOptions.agentRuntimeAdapters !== undefined ||
    runtimeSecretProvider?.read(options.agentRuntime.provider.secretEnvironmentKey) !== undefined;
  const runtimeAgentIds = new Set(options.agentRuntime?.agentIds ?? []);
  const effectiveActors = options.actors.map((actor): Actor =>
    !runtimeConfigured && actor.kind === "agent" && runtimeAgentIds.has(actor.id)
      ? { ...actor, readiness: "noauth" }
      : actor);
  const actorIds = new Set<string>();
  for (const actor of effectiveActors) {
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
  let runtimes: readonly AgentRuntime[] = [];
  const executionRooms = new Map<string, string>();
  let publishPreview: (
    roomId: string,
    preview: AgentExecutionPreview,
  ) => Promise<boolean> = async () => false;
  try {
    worker = transactionFault === undefined
      ? await createWorkerDatabaseClient({ databasePath: options.databasePath })
      : await createWorkerDatabaseClientWithTransactionFaultForTest(
          { databasePath: options.databasePath },
          transactionFault,
        );
    const authority = createSqliteAuthoritativeStore(worker, {
      invitationSecretProtector: createAesGcmInvitationSecretProtector(
        options.invitationSecretKey,
      ),
      ...(testOptions.faultPoint === "after-commit-before-outbox"
        ? { afterCommitHuman: () => process.exit(83) }
        : {}),
    });
    const missingActors: Actor[] = [];
    for (const actor of effectiveActors) {
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
          return effectiveActors.find((actor) => actor.id === actorId);
        },
      },
      identities: options.identities,
      authority,
    });
    const commandStore = {
        async executeHuman(context, command) {
          try {
            return await authority.executeHuman(context, command);
          } catch (error: unknown) {
            if (transactionFault !== undefined) {
              process.exit(transactionFault === "after-domain-write" ? 81 : 82);
            }
            throw error;
          }
        },
        executeAgent: (context, command) => authority.executeAgent(context, command),
      } satisfies Parameters<typeof createMessageService>[0]["commandStore"];
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
    let agentRuntimeTransport: AgentRuntimeTransport | undefined;
    if (options.agentRuntime !== undefined) {
      const config = options.agentRuntime;
      const secretProvider = runtimeSecretProvider!;
      const provider = testOptions.agentRuntimeAdapters?.provider ?? createOpenAiResponsesProvider({
        endpoint: config.provider.endpoint,
        model: config.provider.model,
        secretEnvironmentKey: config.provider.secretEnvironmentKey,
        secretProvider,
      });
      const tools = testOptions.agentRuntimeAdapters?.tools ?? [
        createHttpJsonReadTool(config.httpJsonTool),
        createRepositoryGitStatusTool(config.gitStatusTool),
        createSandboxFileWriteTool(config.sandboxFileTool).adapter,
      ];
      const uniqueAgentIds = new Set(config.agentIds);
      if (uniqueAgentIds.size !== config.agentIds.length || uniqueAgentIds.size === 0) {
        throw new TypeError("Agent runtime agentIds must be non-empty and unique");
      }
      const runtimeMap = new Map<string, AgentRuntime>();
      for (const agentId of uniqueAgentIds) {
        const actor = effectiveActors.find((candidate) => candidate.id === agentId);
        if (actor?.kind !== "agent") throw new TypeError(`Agent runtime actor is invalid: ${agentId}`);
        const runtimeContext = mintInternalAgentRuntimeContext({
          runtimeId: `authoritative:${agentId}`,
          agentId,
        });
        const inputSource = testOptions.agentRuntimeAdapters?.inputSource ??
          productionInputSource(authority, runtimeContext, tools, config.contextLimits);
        runtimeMap.set(agentId, createAgentRuntime({
          authority,
          runtimeContext,
          provider,
          inputSource,
          tools,
          ...(config.schedulerLimits === undefined ? {} : { limits: config.schedulerLimits }),
          coordinatorIdentity: authority,
          preview: (preview) => {
            const roomId = executionRooms.get(preview.executionId);
            return roomId === undefined ? false : publishPreview(roomId, preview);
          },
        }));
      }
      runtimes = [...runtimeMap.values()];
      agentRuntimeTransport = runtimeTransport(
        runtimeMap,
        (context, executionId) => authority.readExecution(context, executionId),
        provider.id,
        config.provider.model,
        runtimeConfigured,
        executionRooms,
      );
    }
    const outboxStore = testOptions.faultPoint === "after-send-before-dispatch-mark"
      ? {
          listPendingOutbox: (limit: number) => authority.listPendingOutbox(limit),
          authorizeOutboxCandidate: authority.authorizeOutboxCandidate,
          markOutboxFailed: authority.markOutboxFailed,
          markOutboxDispatched(): Promise<void> {
            process.exit(84);
          },
        }
      : authority;
    transport = await startMessageWebSocketServer({
      auth,
      service,
      sync,
      outboxStore,
      outboxPollIntervalMs: 10,
      ...(agentRuntimeTransport === undefined ? {} : { agentRuntime: agentRuntimeTransport }),
      ...(agentRuntimeTransport === undefined ? {} : {
        authorizeAgentExecutionPreview: (
          context: Parameters<typeof authority.canAccessRoom>[0], roomId: string,
        ) => authority.canAccessRoom(context, roomId),
      }),
    });
    publishPreview = transport.publishAgentExecutionPreview.bind(transport);
    for (const runtime of runtimes) await runtime.start();
  } catch (error: unknown) {
    await transport?.close().catch(() => undefined);
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    await snapshots?.close().catch(() => undefined);
    await worker?.close().catch(() => undefined);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    url: transport.url,
    close() {
      closePromise ??= (async () => {
        const failures: unknown[] = [];
        for (const [stage, close] of [
          ["transport", () => transport.close()],
          ["runtime", async () => {
            const results = await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
            const rejected = results.filter((result) => result.status === "rejected");
            if (rejected.length > 0) throw new AggregateError(
              rejected.map((result) => result.reason), "Agent runtime close failed",
            );
          }],
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
