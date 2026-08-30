export const TOOL_SAFETY_IPC_CHANNELS = Object.freeze({
  getSurface: "tool-safety:get-surface",
  submit: "tool-safety:submit",
  repair: "tool-safety:repair",
  stateChanged: "tool-safety:state-changed",
} as const);

export type ToolSafetyConnectionState =
  | Readonly<{ status: "online" }>
  | Readonly<{ status: "offline" }>
  | Readonly<{ status: "archived" }>
  | Readonly<{ status: "repairing" }>
  | Readonly<{ status: "repair-failed"; errorCode: string }>
  | Readonly<{ status: "revoked" }>;

export type ToolSafetyCardState =
  | "pending" | "rejected" | "duplicate" | "params-changed" | "principal-revoked"
  | "confirmed" | "grant-revoked" | "dispatched" | "known-succeeded" | "known-failed"
  | "outcome-unknown" | "compensation-proposed" | "compensation-pending"
  | "compensation-confirmed" | "compensation-dispatched" | "compensation-known-succeeded"
  | "compensation-known-failed" | "compensation-outcome-unknown" | "reviewed" | "expired";

export interface ToolSafetyCardProjection {
  readonly toolCallId: string;
  readonly confirmationId: string;
  readonly dispatchId?: string;
  readonly version: number;
  readonly state: ToolSafetyCardState;
  readonly toolId: string;
  readonly safeTarget: string;
  readonly parameterSummary: string;
  readonly impact: string;
  readonly reversibility: "none" | "compensatable" | "unknown";
  readonly expiresAt: string;
  readonly sourceRef: string;
  readonly reasonCode?: string;
  readonly namedHumanDisplayRef?: string;
  readonly canDecide?: boolean;
  readonly reviewResolution?: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
  readonly evidenceSummary?: string;
  readonly handoffCandidates?: readonly Readonly<{ actorId: string; displayRef: string }>[];
  readonly handoffId?: string;
  readonly handoffVersion?: number;
  readonly compensationKnownSucceeded?: boolean;
}

export type ToolSafetyAction = "confirm" | "reject" | "handoff-offer" | "handoff-accept" |
  "review" | "compensate";

export type ToolSafetyCommand =
  | Readonly<{ type: "tool.confirmation.decide"; confirmationId: string;
      expectedVersion: number; decision: "confirm" | "reject" }>
  | Readonly<{ type: "tool.confirmation.handoff.offer"; confirmationId: string;
      expectedVersion: number; targetActorId: string }>
  | Readonly<{ type: "tool.confirmation.handoff.accept"; handoffId: string;
      expectedVersion: number }>
  | Readonly<{ type: "tool.outcome.review"; dispatchId: string; expectedVersion: number;
      resolution: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
      evidenceSummary: string }>
  | Readonly<{ type: "tool.compensation.propose"; dispatchId: string; expectedVersion: number }>;

export type ToolSafetyOperationState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "submitting" | "acknowledged"; requestId: string; action: ToolSafetyAction }>
  | Readonly<{ status: "error"; requestId: string; action: ToolSafetyAction;
      statusCode: 401 | 403 | 409 | 410 | 429 | 503; code: string;
      retryAfterSeconds?: number; retainedEvidenceSummary?: string }>;

export interface ToolSafetyRemoteState {
  readonly roomId: string;
  readonly connection: ToolSafetyConnectionState;
  readonly cards: readonly ToolSafetyCardProjection[];
  readonly operation: ToolSafetyOperationState;
}

export interface ToolSafetySurfaceQuery { readonly roomId: string }
export interface ToolSafetySubmitRequest { readonly roomId: string; readonly command: ToolSafetyCommand }
export interface ToolSafetyStateEnvelope { readonly roomId: string; readonly state: ToolSafetyRemoteState }

export interface ToolSafetyBridge {
  getSurface(query: ToolSafetySurfaceQuery): Promise<ToolSafetyRemoteState>;
  submit(request: ToolSafetySubmitRequest): Promise<ToolSafetyRemoteState>;
  repair(query: ToolSafetySurfaceQuery): Promise<ToolSafetyRemoteState>;
  onStateChanged(listener: (state: ToolSafetyStateEnvelope) => void): () => void;
}

type UnknownRecord = Record<string, unknown>;
const encoder = new TextEncoder();
function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: UnknownRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function text(value: unknown, maximum = 8_192): value is string {
  return typeof value === "string" && value.length > 0 && encoder.encode(value).byteLength <= maximum;
}
function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

const CARD_STATES = new Set<ToolSafetyCardState>([
  "pending", "rejected", "duplicate", "params-changed", "principal-revoked", "confirmed",
  "grant-revoked", "dispatched", "known-succeeded", "known-failed", "outcome-unknown",
  "compensation-proposed", "compensation-pending", "compensation-confirmed",
  "compensation-dispatched", "compensation-known-succeeded", "compensation-known-failed",
  "compensation-outcome-unknown", "reviewed", "expired",
]);
const ACTIONS = new Set<ToolSafetyAction>([
  "confirm", "reject", "handoff-offer", "handoff-accept", "review", "compensate",
]);

export function isToolSafetyCommand(value: unknown): value is ToolSafetyCommand {
  if (!record(value) || !text(value.type, 64)) return false;
  if (value.type === "tool.confirmation.decide") return exact(value,
    ["type", "confirmationId", "expectedVersion", "decision"]) && text(value.confirmationId) &&
    version(value.expectedVersion) && (value.decision === "confirm" || value.decision === "reject");
  if (value.type === "tool.confirmation.handoff.offer") return exact(value,
    ["type", "confirmationId", "expectedVersion", "targetActorId"]) && text(value.confirmationId) &&
    version(value.expectedVersion) && text(value.targetActorId);
  if (value.type === "tool.confirmation.handoff.accept") return exact(value,
    ["type", "handoffId", "expectedVersion"]) && text(value.handoffId) && version(value.expectedVersion);
  if (value.type === "tool.outcome.review") return exact(value,
    ["type", "dispatchId", "expectedVersion", "resolution", "evidenceSummary"]) &&
    text(value.dispatchId) && version(value.expectedVersion) &&
    ["known_succeeded", "known_failed", "compensated", "accepted_risk"].includes(
      String(value.resolution)) && text(value.evidenceSummary, 2_048);
  return value.type === "tool.compensation.propose" && exact(value,
    ["type", "dispatchId", "expectedVersion"]) && text(value.dispatchId) && version(value.expectedVersion);
}

function isConnection(value: unknown): value is ToolSafetyConnectionState {
  if (!record(value)) return false;
  if (["online", "offline", "archived", "repairing", "revoked"].includes(String(value.status))) {
    return exact(value, ["status"]);
  }
  return value.status === "repair-failed" && exact(value, ["status", "errorCode"]) && text(value.errorCode);
}
function isOperation(value: unknown): value is ToolSafetyOperationState {
  if (!record(value) || !text(value.status, 32)) return false;
  if (value.status === "idle") return exact(value, ["status"]);
  if ((value.status === "submitting" || value.status === "acknowledged") &&
      exact(value, ["status", "requestId", "action"])) {
    return text(value.requestId) && ACTIONS.has(value.action as ToolSafetyAction);
  }
  return value.status === "error" && exact(value,
    ["status", "requestId", "action", "statusCode", "code"],
    ["retryAfterSeconds", "retainedEvidenceSummary"]) && text(value.requestId) &&
    ACTIONS.has(value.action as ToolSafetyAction) && [401, 403, 409, 410, 429, 503].includes(
      value.statusCode as number) && text(value.code) &&
    (value.retryAfterSeconds === undefined || version(value.retryAfterSeconds)) &&
    (value.retainedEvidenceSummary === undefined || text(value.retainedEvidenceSummary, 2_048));
}
function isCard(value: unknown): value is ToolSafetyCardProjection {
  if (!record(value) || !exact(value, [
    "toolCallId", "confirmationId", "version", "state", "toolId", "safeTarget", "parameterSummary",
    "impact", "reversibility", "expiresAt", "sourceRef",
  ], ["dispatchId", "reasonCode", "namedHumanDisplayRef", "reviewResolution", "evidenceSummary",
    "handoffCandidates", "handoffId", "handoffVersion", "compensationKnownSucceeded", "canDecide"])) return false;
  if (!text(value.toolCallId) || typeof value.confirmationId !== "string" || !version(value.version) ||
      !CARD_STATES.has(value.state as ToolSafetyCardState) || !text(value.toolId) ||
      !text(value.safeTarget) || !text(value.parameterSummary) || !text(value.impact) ||
      !["none", "compensatable", "unknown"].includes(String(value.reversibility)) ||
      typeof value.expiresAt !== "string" || !text(value.sourceRef)) return false;
  if (value.handoffCandidates !== undefined && (!Array.isArray(value.handoffCandidates) ||
      value.handoffCandidates.length > 512 || value.handoffCandidates.some((candidate) =>
        !record(candidate) || !exact(candidate, ["actorId", "displayRef"]) ||
        !text(candidate.actorId) || !text(candidate.displayRef)))) return false;
  return ["dispatchId", "reasonCode", "namedHumanDisplayRef", "reviewResolution", "evidenceSummary",
    "handoffId"].every((key) => value[key] === undefined || text(value[key])) &&
    (value.handoffVersion === undefined || version(value.handoffVersion)) &&
    (value.compensationKnownSucceeded === undefined || typeof value.compensationKnownSucceeded === "boolean") &&
    (value.canDecide === undefined || typeof value.canDecide === "boolean");
}

export function isToolSafetySurfaceQuery(value: unknown): value is ToolSafetySurfaceQuery {
  return record(value) && exact(value, ["roomId"]) && text(value.roomId);
}
export function isToolSafetySubmitRequest(value: unknown): value is ToolSafetySubmitRequest {
  return record(value) && exact(value, ["roomId", "command"]) && text(value.roomId) &&
    isToolSafetyCommand(value.command);
}
export function isToolSafetyRemoteState(value: unknown): value is ToolSafetyRemoteState {
  return record(value) && exact(value, ["roomId", "connection", "cards", "operation"]) &&
    text(value.roomId) && isConnection(value.connection) && Array.isArray(value.cards) &&
    value.cards.length <= 2_048 && value.cards.every(isCard) && isOperation(value.operation);
}
export function isToolSafetyStateEnvelope(value: unknown): value is ToolSafetyStateEnvelope {
  return record(value) && exact(value, ["roomId", "state"]) && text(value.roomId) &&
    isToolSafetyRemoteState(value.state) && value.state.roomId === value.roomId;
}
export function cloneToolSafetyRemoteState(value: unknown): ToolSafetyRemoteState {
  if (!isToolSafetyRemoteState(value)) throw new TypeError("Tool Safety state is not closed");
  return structuredClone(value);
}
export function cloneToolSafetyStateEnvelope(value: unknown): ToolSafetyStateEnvelope {
  if (!isToolSafetyStateEnvelope(value)) throw new TypeError("Tool Safety envelope is not closed");
  return structuredClone(value);
}
