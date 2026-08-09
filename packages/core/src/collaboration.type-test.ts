import type { AgentRoomMembership, HumanRoomMembership } from "./index.js";

const invalidHumanMembership: HumanRoomMembership = {
  kind: "human",
  actorId: "human-2",
  role: "member",
  joinedAt: "2026-08-09T00:00:00.000Z",
  // @ts-expect-error Human membership cannot carry agent participation.
  participation: "active",
};

const invalidAgentMembership: AgentRoomMembership = {
  kind: "agent",
  actorId: "agent-search",
  participation: "active",
  toolPermissions: ["search"],
  configuredAt: "2026-08-09T00:00:00.000Z",
  // @ts-expect-error Agent membership cannot carry a human social role.
  role: "member",
};

void invalidHumanMembership;
void invalidAgentMembership;
