import { createHash } from "node:crypto";
import type { JsonValue } from "../persistence/contracts.js";

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key] as JsonValue)}`).join(",")}}`;
}

export type DefaultHumanRequestProjectPayload = Readonly<{
  title: "Clarification requested";
  description: "A structured Human Request is awaiting an answer.";
  acceptanceMode: "open_question";
  frozenResponsibility: Readonly<{
    kind: "open_question";
    responsibilityId: string;
    title: "Answer the open question";
    description: "Provide the answer needed to resolve the structured Human Request.";
    impact: "The Project Loop is waiting for this answer.";
    question: "What answer resolves this structured Human Request?";
    owner: Readonly<{ kind: "human"; actorId: string }>;
    dueAt: null;
    reviewAt: null;
  }>;
  frozenResponsibilityJson: string;
  frozenResponsibilitySha256: string;
}>;

export function hashProjectFrozenResponsibility(value: Readonly<Record<string, JsonValue>>): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function createDefaultHumanRequestProjectPayload(input: {
  roomId: string; requestIntentId: string; sourceTargetId: string; targetHumanActorId: string;
}): DefaultHumanRequestProjectPayload {
  const responsibilityId = `project-open-question-${createHash("sha256")
    .update(`dao.ft09.human-request.v1\0${input.roomId}\0${input.requestIntentId}\0${input.sourceTargetId}`)
    .digest("hex")}`;
  const frozenResponsibility = Object.freeze({
    kind: "open_question" as const,
    responsibilityId,
    title: "Answer the open question" as const,
    description: "Provide the answer needed to resolve the structured Human Request." as const,
    impact: "The Project Loop is waiting for this answer." as const,
    question: "What answer resolves this structured Human Request?" as const,
    owner: Object.freeze({ kind: "human" as const, actorId: input.targetHumanActorId }),
    dueAt: null,
    reviewAt: null,
  });
  const frozenResponsibilityJson = canonical(frozenResponsibility);
  return Object.freeze({
    title: "Clarification requested" as const,
    description: "A structured Human Request is awaiting an answer." as const,
    acceptanceMode: "open_question" as const,
    frozenResponsibility,
    frozenResponsibilityJson,
    frozenResponsibilitySha256: createHash("sha256").update(frozenResponsibilityJson).digest("hex"),
  });
}
