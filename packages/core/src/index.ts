export type ActorKind = "human" | "agent";

export type HumanReachability = "online" | "dnd" | "offline";
export type AgentReadiness = "ready" | "busy" | "paused" | "noauth";

export interface HumanActor {
  readonly id: string;
  readonly kind: "human";
  readonly displayName: string;
  readonly reachability: HumanReachability;
}

export interface AgentActor {
  readonly id: string;
  readonly kind: "agent";
  readonly displayName: string;
  readonly readiness: AgentReadiness;
  readonly toolPermissions: readonly string[];
}

export type Actor = HumanActor | AgentActor;

export interface Event {
  readonly id: string;
  readonly type: string;
  readonly actorId: string;
  readonly actorKind: ActorKind;
  readonly roomId: string;
  readonly occurredAt: string;
}

export interface Message {
  readonly id: string;
  readonly roomId: string;
  readonly authorId: string;
  readonly authorKind: ActorKind;
  readonly body: string;
  readonly sentAt: string;
}

export interface Room {
  readonly id: string;
  readonly name: string;
  readonly memberIds: readonly string[];
  readonly createdAt: string;
}

type UnknownRecord = Record<string, unknown>;

const humanReachability = new Set<HumanReachability>(["online", "dnd", "offline"]);
const agentReadiness = new Set<AgentReadiness>(["ready", "busy", "paused", "noauth"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function hasStringArray(value: UnknownRecord, key: string): boolean {
  return Array.isArray(value[key]) && value[key].every((entry) => typeof entry === "string");
}

function isActorKind(value: unknown): value is ActorKind {
  return value === "human" || value === "agent";
}

function isHumanReachability(value: unknown): value is HumanReachability {
  return typeof value === "string" && humanReachability.has(value as HumanReachability);
}

function isAgentReadiness(value: unknown): value is AgentReadiness {
  return typeof value === "string" && agentReadiness.has(value as AgentReadiness);
}

export function isHumanActor(value: unknown): value is HumanActor {
  return (
    isRecord(value) &&
    value.kind === "human" &&
    hasString(value, "id") &&
    hasString(value, "displayName") &&
    isHumanReachability(value.reachability) &&
    !("readiness" in value) &&
    !("toolPermissions" in value)
  );
}

export function isAgentActor(value: unknown): value is AgentActor {
  return (
    isRecord(value) &&
    value.kind === "agent" &&
    hasString(value, "id") &&
    hasString(value, "displayName") &&
    isAgentReadiness(value.readiness) &&
    hasStringArray(value, "toolPermissions") &&
    !("reachability" in value)
  );
}

export function isActor(value: unknown): value is Actor {
  return isHumanActor(value) || isAgentActor(value);
}

export function isEvent(value: unknown): value is Event {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "type") &&
    hasString(value, "actorId") &&
    isActorKind(value.actorKind) &&
    hasString(value, "roomId") &&
    hasString(value, "occurredAt")
  );
}

export function isMessage(value: unknown): value is Message {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "roomId") &&
    hasString(value, "authorId") &&
    isActorKind(value.authorKind) &&
    hasString(value, "body") &&
    hasString(value, "sentAt")
  );
}

export function isRoom(value: unknown): value is Room {
  return (
    isRecord(value) &&
    hasString(value, "id") &&
    hasString(value, "name") &&
    hasStringArray(value, "memberIds") &&
    hasString(value, "createdAt")
  );
}
