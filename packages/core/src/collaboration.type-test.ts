import type {
  AgentExecution,
  AgentConfigurationRequest,
  AgentRoomMembership,
  HumanInvitationRequest,
  HumanRoomMembership,
  MessageDraft,
  PublicAgentToolDispatch,
  PublicToolConfirmationRequired,
} from "./index.js";

type Assert<T extends true> = T;
export type PublicDispatchProjectionOmitsSealedCompensation = Assert<
  "sealedCompensation" extends keyof PublicAgentToolDispatch ? false : true
>;
export type PublicConfirmationProjectionOmitsSecret = Assert<
  Extract<keyof PublicToolConfirmationRequired, "sealedCompensation" | "target" | "impact"> extends never
    ? true
    : false
>;

const humanRequest = {
  kind: "human-invitation" as const,
  roomId: "room-1",
  inviteeActorId: "human-2",
};

// @ts-expect-error A human request cannot be persisted as an agent execution.
const invalidHumanRequestExecution: AgentExecution = humanRequest;

const invalidHumanMembership: HumanRoomMembership = {
  kind: "human",
  actorId: "human-2",
  role: "member",
  joinedAt: "2026-08-09T00:00:00.000Z",
  // @ts-expect-error Human membership cannot carry agent participation.
  participation: "active",
};

const humanMembershipWithConfiguredAt = {
  kind: "human" as const,
  actorId: "human-2",
  role: "member" as const,
  joinedAt: "2026-08-09T00:00:00.000Z",
  configuredAt: "2026-08-09T00:00:00.000Z",
};

// @ts-expect-error Human membership cannot carry agent configuration time.
const invalidHumanConfiguredAt: HumanRoomMembership = humanMembershipWithConfiguredAt;

const invalidAgentMembership: AgentRoomMembership = {
  kind: "agent",
  actorId: "agent-search",
  participation: "active",
  toolPermissions: ["search"],
  configuredAt: "2026-08-09T00:00:00.000Z",
  // @ts-expect-error Agent membership cannot carry a human social role.
  role: "member",
};

const draftWithAuthorId = {
  id: "message-1",
  roomId: "room-1",
  body: "由会话决定作者",
  sentAt: "2026-08-09T00:00:00.000Z",
  authorId: "human-2",
};

// @ts-expect-error A message draft cannot select its author actor.
const invalidDraftAuthorId: MessageDraft = draftWithAuthorId;

const draftWithAuthorKind = {
  id: "message-1",
  roomId: "room-1",
  body: "由会话决定作者",
  sentAt: "2026-08-09T00:00:00.000Z",
  authorKind: "human" as const,
};

// @ts-expect-error A message draft cannot select its author kind.
const invalidDraftAuthorKind: MessageDraft = draftWithAuthorKind;

const humanInvitationWithAgentId = {
  kind: "human-invitation" as const,
  roomId: "room-1",
  inviteeActorId: "human-2",
  agentId: "agent-search",
};

// @ts-expect-error A human invitation cannot configure an agent identity.
const invalidHumanInvitationAgentId: HumanInvitationRequest =
  humanInvitationWithAgentId;

const humanInvitationWithParticipation = {
  kind: "human-invitation" as const,
  roomId: "room-1",
  inviteeActorId: "human-2",
  participation: "active" as const,
};

// @ts-expect-error A human invitation cannot configure agent participation.
const invalidHumanInvitationParticipation: HumanInvitationRequest =
  humanInvitationWithParticipation;

const humanInvitationWithToolPermissions = {
  kind: "human-invitation" as const,
  roomId: "room-1",
  inviteeActorId: "human-2",
  toolPermissions: ["search"],
};

// @ts-expect-error A human invitation cannot grant agent tool permissions.
const invalidHumanInvitationToolPermissions: HumanInvitationRequest =
  humanInvitationWithToolPermissions;

const agentConfigurationWithInviteeActorId = {
  kind: "agent-configuration" as const,
  roomId: "room-1",
  agentId: "agent-search",
  participation: "active" as const,
  toolPermissions: ["search"],
  inviteeActorId: "human-2",
};

// @ts-expect-error Agent configuration cannot target a human invitee.
const invalidAgentConfigurationInviteeActorId: AgentConfigurationRequest =
  agentConfigurationWithInviteeActorId;

void invalidHumanMembership;
void invalidHumanRequestExecution;
void invalidHumanConfiguredAt;
void invalidAgentMembership;
void invalidDraftAuthorId;
void invalidDraftAuthorKind;
void invalidHumanInvitationAgentId;
void invalidHumanInvitationParticipation;
void invalidHumanInvitationToolPermissions;
void invalidAgentConfigurationInviteeActorId;
