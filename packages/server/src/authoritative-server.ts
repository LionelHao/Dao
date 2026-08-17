import type { Actor } from "@native-im/core";
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
  createWorkerDatabaseClientWithTransactionFaultForTest,
  type WorkerDatabaseClient,
} from "./persistence/worker-database-client.js";
import { createAgentRuntimeService, type AgentRuntimeService } from "./agent-runtime/agent-runtime-service.js";
import { createEnvironmentSecretProvider } from "./agent-runtime/environment-secret-provider.js";
import { createOpenAIResponsesProvider } from "./agent-runtime/openai-responses-provider.js";
import { createWorkerRuntimeAuthority } from "./agent-runtime/worker-runtime-authority.js";
import { createHttpJsonReadAdapter } from "./agent-runtime/tools/http-json-read.js";
import { createRepositoryGitStatusAdapter } from "./agent-runtime/tools/repository-git-status.js";
import { createSandboxFileWriteAdapter } from "./agent-runtime/tools/sandbox-file-write.js";
import { createToolGateway } from "./agent-runtime/tool-gateway.js";

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
  readonly agentRuntime?: {
    readonly model?: string;
    readonly endpoint?: string;
    readonly httpJsonOrigin?: string;
    readonly httpJsonPathPrefix?: string;
    readonly repositoryRoot?: string;
    readonly sandboxRoot?: string;
    readonly gitBinaryPath?: string;
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
    const runtimeConfiguration = options.agentRuntime ?? {};
    const secretProvider = createEnvironmentSecretProvider();
    const provider = createOpenAIResponsesProvider({
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
    const runtimeAuthority = createWorkerRuntimeAuthority(worker);
    const toolGateway = createToolGateway({ authority: runtimeAuthority, adapters: tools });
    runtime = createAgentRuntimeService({
      authority: runtimeAuthority,
      provider,
      modelId: runtimeConfiguration.model ?? "gpt-5-mini",
      readiness: () => secretProvider.getSecret("OPENAI_API_KEY") === undefined ? "noauth" : "ready",
      tools: tools.map((tool) => tool.descriptor),
      toolGateway,
      toolAdapters: tools,
      async buildProviderInput(execution, intent) {
        const runtimeContext = await runtimeAuthority.readContext(execution.id);
        const allowed = new Set(runtimeContext.toolIds);
        return {
          purpose: "agent_runtime",
          invocation: intent,
          visibleConversation: runtimeContext.visibleConversation,
          availableTools: tools.map((tool) => tool.descriptor).filter((tool) => allowed.has(tool.id)),
          committedSteps: [],
          limits: { maxInputBytes: 256 * 1_024, maxOutputBytes: 256 * 1_024, timeoutMs: 30_000 },
        };
      },
      emitPreview(preview) {
        transport?.publishAgentPreview(preview);
      },
    });
    await runtime.recover();
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
      agentRuntime: runtime,
    });
  } catch (error: unknown) {
    await transport?.close().catch(() => undefined);
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
        const failures: unknown[] = [];
        for (const [stage, close] of [
          ["transport", () => transport.close()],
          ["runtime", () => runtime!.close()],
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
