import type { AgentActor, HumanActor } from "./index.js";

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
