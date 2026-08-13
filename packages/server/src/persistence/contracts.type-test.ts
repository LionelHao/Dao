import type {
  AgentCollaborationCommand,
  AuthenticatedCommandContext,
  HumanCollaborationCommand,
  InternalAgentCommandContext,
  OutboxDelivery,
} from "./contracts.js";

const legacyInterruptedTransition: AgentCollaborationCommand = {
  type: "agent.execution.transition", roomId: "room-1",
  payload: { executionId: "execution-1", sourceMessageId: "message-1", toolName: "search.web", status: "interrupted" },
};
const invalidLegacyQueuedTransition = {
  type: "agent.execution.transition" as const, roomId: "room-1",
  payload: { executionId: "execution-1", sourceMessageId: "message-1", toolName: "search.web", status: "queued" as const },
};
// @ts-expect-error Legacy transition commands cannot use canonical queued status.
const invalidLegacyQueuedCommand: AgentCollaborationCommand = invalidLegacyQueuedTransition;
const invalidLegacyCancelledTransition = {
  type: "agent.execution.transition" as const, roomId: "room-1",
  payload: { executionId: "execution-1", sourceMessageId: "message-1", toolName: "search.web", status: "cancelled" as const },
};
// @ts-expect-error Legacy transition commands cannot use canonical cancelled status.
const invalidLegacyCancelledCommand: AgentCollaborationCommand = invalidLegacyCancelledTransition;

void legacyInterruptedTransition;
void invalidLegacyQueuedCommand;
void invalidLegacyCancelledCommand;
import { mintInternalAgentCommandContext } from "./contracts.js";
import type { CanonicalIdentityEventInput } from "./authority-database-handler.js";
import type { StartAuthoritativeServerOptions } from "../index.js";

// @ts-expect-error Internal Agent capabilities must not be exported from the package root.
import type { InternalAgentCommandContext as PublicInternalAgentCommandContext } from "../index.js";
// @ts-expect-error Internal Agent runtime capabilities must not be exported from the package root.
import type { InternalAgentRuntimeContext as PublicInternalAgentRuntimeContext } from "../index.js";
import type { WorkerDatabaseClient as PublicWorkerDatabaseClient } from "../index.js";
// @ts-expect-error Raw point-query stores are server-internal and absent from the package root.
import type { SyncQueryStore as PublicSyncQueryStore } from "../index.js";
// @ts-expect-error The SQLite authority factory is server-internal and absent from the package root.
import { createSqliteAuthoritativeStore as publicCreateSqliteAuthoritativeStore } from "../index.js";
// @ts-expect-error The authoritative lifecycle composition factory is server-internal.
import { createAuthoritativeRoomLifecycleService as publicCreateAuthoritativeRoomLifecycleService } from "../index.js";

export type PackageRootInternalAgentContextMustStayUnavailable =
  PublicInternalAgentCommandContext;
export type PackageRootInternalAgentRuntimeContextMustStayUnavailable =
  PublicInternalAgentRuntimeContext;
export type PackageRootSyncQueryStoreMustStayUnavailable = PublicSyncQueryStore;
export type PackageRootSqliteFactoryMustStayUnavailable = typeof publicCreateSqliteAuthoritativeStore;
export type PackageRootAuthoritativeLifecycleFactoryMustStayUnavailable =
  typeof publicCreateAuthoritativeRoomLifecycleService;
type PublicStartOptionsWithFault = StartAuthoritativeServerOptions & {
  readonly faultPoint: "before-commit";
};

type Assert<T extends true> = T;
type DeliveryFor<Kind extends OutboxDelivery["targetKind"], Delivery = OutboxDelivery> =
  Delivery extends { readonly targetKind: infer DeliveryKind }
    ? Kind extends DeliveryKind ? Delivery : never
    : never;
type SessionFamilyEventType = DeliveryFor<"session-family"> extends {
  readonly event: { readonly type: infer EventType };
} ? EventType : never;
type PrincipalEventType = DeliveryFor<"principal"> extends {
  readonly event: { readonly type: infer EventType };
} ? EventType : never;

type ActorIdentityEventWithRoomAccessPayload = {
  readonly eventId: "event-invalid-pair";
  readonly principalId: "human-1";
  readonly eventType: "identity.actor.registered";
  readonly occurredAt: "2026-08-10T00:00:00.000Z";
  readonly payload: { readonly roomId: "room-1"; readonly change: "joined" };
};

type PublicJsonAgentContext = {
  readonly kind: "agent";
  readonly agent: { readonly actorId: "agent-1"; readonly kind: "agent" };
  readonly requestId: "request-1";
  readonly idempotencyKey: "key-1";
};

type HumanReadWithInjectedActor = {
  readonly type: "human.read.record";
  readonly roomId: "room-1";
  readonly payload: { readonly messageId: "message-1"; readonly actorId: "human-1" };
};

type HumanReadWithInjectedAgent = {
  readonly type: "human.read.record";
  readonly roomId: "room-1";
  readonly payload: { readonly messageId: "message-1"; readonly agentId: "agent-1" };
};

type AgentJudgementWithInjectedAgent = {
  readonly type: "agent.judgment.record";
  readonly roomId: "room-1";
  readonly payload: {
    readonly messageId: "message-1";
    readonly outcome: "suppressed";
    readonly reason: "cooldown";
    readonly agentId: "agent-1";
  };
};

type HumanMessageWithInjectedAuthor = {
  readonly type: "message.send";
  readonly roomId: "room-1";
  readonly payload: {
    readonly id: "message-1";
    readonly roomId: "room-1";
    readonly body: "hello";
    readonly sentAt: "2026-08-10T00:00:00.000Z";
    readonly authorKind: "human";
  };
};

export type PublicJsonCannotConstructInternalContext = Assert<
  PublicJsonAgentContext extends InternalAgentCommandContext ? false : true
>;
export type IdentityEventTypeRejectsMismatchedPayload = Assert<
  ActorIdentityEventWithRoomAccessPayload extends CanonicalIdentityEventInput
    ? false
    : true
>;
export type PublicClientHasNoExecuteHuman = Assert<
  "executeHuman" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type PublicClientHasNoExecuteAgent = Assert<
  "executeAgent" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type PublicClientHasNoRawAgentRuntimeAuthority = Assert<
  Extract<keyof PublicWorkerDatabaseClient,
    | "invokeAgentRuntime" | "claimNextAgentRuntime" | "commitAgentRuntimeStep"
    | "completeAgentRuntimeExecution" | "completeAgentRuntimeCompensation"
    | "scheduleAgentRuntimeRetry" | "failAgentRuntimeExecution" | "interruptAgentRuntime" | "manualRetryAgentRuntime"
    | "compensateAgentRuntime" | "resumeAgentRuntimeCompensation"
    | "recoverAgentRuntimePage"
    | "prepareAgentRuntimeTool" | "confirmAgentRuntimeTool" | "resumeConfirmedAgentRuntimeTool"
    | "dispatchAgentRuntimeTool" | "settleAgentRuntimeTool" | "readAgentRuntimeExecution"
  > extends never ? true : false
>;
export type PublicClientCannotReadActor = Assert<
  "readActor" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type PublicClientCannotReadRoom = Assert<
  "readRoom" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type PublicClientCannotListOutbox = Assert<
  "listPendingOutbox" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type PublicClientCannotAuthorizeOutbox = Assert<
  "authorizeOutboxCandidate" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type PublicClientCannotMarkOutboxDispatched = Assert<
  "markOutboxDispatched" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type PublicClientCannotMarkOutboxFailed = Assert<
  "markOutboxFailed" extends keyof PublicWorkerDatabaseClient ? false : true
>;
export type SessionFamilyDeliveryCarriesOnlyRevocation = Assert<
  Exclude<SessionFamilyEventType, "identity.session.revoked"> extends never ? true : false
>;
export type PrincipalDeliveryCarriesOnlyRoomAccess = Assert<
  Exclude<PrincipalEventType, "identity.room-access.changed"> extends never ? true : false
>;
export type MintedContextIsInternal = Assert<
  ReturnType<typeof mintInternalAgentCommandContext> extends InternalAgentCommandContext
    ? true
    : false
>;
export type HumanReadCannotInjectActor = Assert<
  HumanReadWithInjectedActor extends HumanCollaborationCommand ? false : true
>;
export type HumanReadCannotInjectAgent = Assert<
  HumanReadWithInjectedAgent extends HumanCollaborationCommand ? false : true
>;
export type AgentJudgementCannotInjectAgent = Assert<
  AgentJudgementWithInjectedAgent extends AgentCollaborationCommand ? false : true
>;
export type HumanMessageCannotInjectAuthorKind = Assert<
  HumanMessageWithInjectedAuthor extends HumanCollaborationCommand ? false : true
>;
export type HumanContextHasServerPrincipal = Assert<
  AuthenticatedCommandContext["principal"] extends { readonly actorId: string } ? true : false
>;
export type PublicStartOptionsHaveNoFaultPoint = Assert<
  PublicStartOptionsWithFault extends StartAuthoritativeServerOptions
    ? "faultPoint" extends keyof StartAuthoritativeServerOptions ? false : true
    : false
>;
