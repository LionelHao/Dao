import type { AgentActor, HumanActor, RoomGovernanceView } from "./index.js";

const human: HumanActor = {
  id: "human-lionel",
  kind: "human",
  displayName: "Lionel",
  reachability: "online",
};

const agent: AgentActor = {
  id: "agent-data",
  kind: "agent",
  displayName: "Data agent",
  readiness: "ready",
  toolPermissions: ["warehouse.query"],
};

void human;
void agent;

const invalidAgent: AgentActor = {
  id: "agent-invalid",
  kind: "agent",
  displayName: "Invalid agent",
  // @ts-expect-error Agent state is readiness; human reachability is not assignable.
  reachability: "online",
  toolPermissions: [],
};

void invalidAgent;

const governance: RoomGovernanceView<"room-1"> = {
  roomId: "room-1", projectId: "room-1", lifecycle: "active",
  governanceRevision: 1, ownerActorId: "human-1", archiveGeneration: 0,
};
void governance;

const invalidProject: RoomGovernanceView<"room-1"> = {
  ...governance,
  // @ts-expect-error projectId is the same literal identity as roomId.
  projectId: "project-2",
};
void invalidProject;
