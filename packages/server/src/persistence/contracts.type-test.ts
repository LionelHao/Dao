import type {
  AgentCollaborationCommand,
  AuthenticatedCommandContext,
  HumanCollaborationCommand,
  InternalAgentCommandContext,
} from "./contracts.js";

type Assert<T extends true> = T;

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
