import type { IdentityAuthoritySession } from "../identity/controller.js";
import type { DesktopAuthorityCache } from "../governance/authority-cache.js";
import {
  MessageAuthorityTransportError,
  type MessageAuthorityWireTransport,
} from "../message-authority/websocket-authority.js";
import {
  cloneToolSafetyRemoteState,
  isToolSafetySubmitRequest,
  type ToolSafetyAction,
  type ToolSafetyCardProjection,
  type ToolSafetyCommand,
  type ToolSafetyRemoteState,
  type ToolSafetyStateEnvelope,
  type ToolSafetySubmitRequest,
  type ToolSafetySurfaceQuery,
} from "./contracts.js";

type ToolRecord =
  | { readonly kind: "tool-call"; readonly value: { readonly toolCallId: string; readonly toolId: string;
      readonly safePreview: string; readonly state: "prepared"; readonly version: number; readonly sourceRef: string } }
  | { readonly kind: "tool-confirmation"; readonly value: { readonly confirmationId: string;
      readonly toolCallId: string; readonly toolId: string; readonly state: "pending" | "confirmed" | "rejected" | "expired";
      readonly safePreview: string; readonly reasonCode: string | null; readonly expiresAt: string;
      readonly version: number; readonly principalActorId: string;
      readonly namedHumanDisplayRef: string | null; readonly sourceRef: string } }
  | { readonly kind: "tool-grant"; readonly value: { readonly grantId: string; readonly toolCallId: string;
      readonly state: "active" | "claimed" | "revoked" | "expired"; readonly reasonCode: string | null;
      readonly expiresAt: string; readonly version: number } }
  | { readonly kind: "tool-dispatch"; readonly value: { readonly dispatchId: string; readonly toolCallId: string;
      readonly state: "prepared" | "claimed" | "dispatched" | "known_succeeded" | "known_failed" |
        "outcome_unknown" | "reviewed"; readonly reasonCode: string | null; readonly version: number } }
  | { readonly kind: "tool-review"; readonly value: { readonly reviewId: string; readonly dispatchId: string;
      readonly resolution: "known_succeeded" | "known_failed" | "compensated" | "accepted_risk";
      readonly evidenceSummary: string; readonly namedHumanDisplayRef: string;
      readonly compensationToolCallId: string | null; readonly version: number } }
  | { readonly kind: "tool-handoff"; readonly value: { readonly handoffId: string; readonly confirmationId: string;
      readonly state: "offered" | "accepted" | "rejected" | "expired";
      readonly targetActorId: string; readonly targetNamedHumanDisplayRef: string; readonly version: number } }
  | { readonly kind: "tool-compensation"; readonly value: { readonly lineageId: string;
      readonly originalDispatchId: string; readonly compensationInvocationId: string;
      readonly compensationExecutionId: string; readonly compensationToolCallId: string;
      readonly state: "pending" | "rejected" | "expired" | "claimed" | "dispatched" |
        "known_succeeded" | "known_failed" | "outcome_unknown" | "reviewed"; readonly version: number } };

interface SafePreview {
  readonly schemaVersion: "tool-safe-preview.v1";
  readonly target: string;
  readonly summary: string;
  readonly impact: string;
  readonly reversibility: "none" | "compensatable" | "unknown";
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8_192;
}
function version(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function isToolRecord(value: unknown): value is ToolRecord {
  if (!record(value) || !record(value.value) || typeof value.kind !== "string") return false;
  const payload = value.value;
  if (value.kind === "tool-call") return text(payload.toolCallId) && text(payload.toolId) &&
    typeof payload.safePreview === "string" && payload.state === "prepared" && version(payload.version) &&
    text(payload.sourceRef);
  if (value.kind === "tool-confirmation") return text(payload.confirmationId) && text(payload.toolCallId) &&
    text(payload.toolId) && ["pending", "confirmed", "rejected", "expired"].includes(String(payload.state)) &&
    typeof payload.safePreview === "string" && (payload.reasonCode === null || text(payload.reasonCode)) &&
    text(payload.expiresAt) && version(payload.version) && text(payload.principalActorId) &&
    (payload.namedHumanDisplayRef === null || text(payload.namedHumanDisplayRef)) && text(payload.sourceRef);
  if (value.kind === "tool-grant") return text(payload.grantId) && text(payload.toolCallId) &&
    ["active", "claimed", "revoked", "expired"].includes(String(payload.state)) &&
    (payload.reasonCode === null || text(payload.reasonCode)) && text(payload.expiresAt) && version(payload.version);
  if (value.kind === "tool-dispatch") return text(payload.dispatchId) && text(payload.toolCallId) &&
    ["prepared", "claimed", "dispatched", "known_succeeded", "known_failed", "outcome_unknown", "reviewed"]
      .includes(String(payload.state)) && (payload.reasonCode === null || text(payload.reasonCode)) &&
    version(payload.version);
  if (value.kind === "tool-review") return text(payload.reviewId) && text(payload.dispatchId) &&
    ["known_succeeded", "known_failed", "compensated", "accepted_risk"].includes(String(payload.resolution)) &&
    typeof payload.evidenceSummary === "string" && text(payload.namedHumanDisplayRef) &&
    (payload.compensationToolCallId === null || text(payload.compensationToolCallId)) && version(payload.version);
  if (value.kind === "tool-handoff") return text(payload.handoffId) && text(payload.confirmationId) &&
    ["offered", "accepted", "rejected", "expired"].includes(String(payload.state)) &&
    text(payload.targetActorId) && text(payload.targetNamedHumanDisplayRef) && version(payload.version);
  return value.kind === "tool-compensation" && text(payload.lineageId) && text(payload.originalDispatchId) &&
    text(payload.compensationInvocationId) && text(payload.compensationExecutionId) &&
    text(payload.compensationToolCallId) && ["pending", "rejected", "expired", "claimed", "dispatched",
      "known_succeeded", "known_failed", "outcome_unknown", "reviewed"].includes(String(payload.state)) &&
    version(payload.version);
}

function safePreview(serialized: string): SafePreview | undefined {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return undefined; }
  if (!record(value) || Object.keys(value).sort().join(",") !==
      "impact,reversibility,schemaVersion,summary,target" || value.schemaVersion !== "tool-safe-preview.v1" ||
      !text(value.target) || !text(value.summary) || !text(value.impact) ||
      !["none", "compensatable", "unknown"].includes(String(value.reversibility))) return undefined;
  return value as unknown as SafePreview;
}

function action(command: ToolSafetyCommand): ToolSafetyAction {
  if (command.type === "tool.confirmation.decide") return command.decision;
  if (command.type === "tool.confirmation.handoff.offer") return "handoff-offer";
  if (command.type === "tool.confirmation.handoff.accept") return "handoff-accept";
  if (command.type === "tool.outcome.review") return "review";
  return "compensate";
}

function buildCards(
  records: readonly unknown[],
  viewerActorId: string,
  roomOwnerActorId: string | undefined,
): readonly ToolSafetyCardProjection[] {
  const tools = records.filter(isToolRecord);
  const calls = tools.filter((entry): entry is Extract<ToolRecord, { kind: "tool-call" }> => entry.kind === "tool-call");
  const confirmations = tools.filter((entry): entry is Extract<ToolRecord, { kind: "tool-confirmation" }> =>
    entry.kind === "tool-confirmation");
  const grants = tools.filter((entry): entry is Extract<ToolRecord, { kind: "tool-grant" }> => entry.kind === "tool-grant");
  const dispatches = tools.filter((entry): entry is Extract<ToolRecord, { kind: "tool-dispatch" }> =>
    entry.kind === "tool-dispatch");
  const reviews = tools.filter((entry): entry is Extract<ToolRecord, { kind: "tool-review" }> => entry.kind === "tool-review");
  const handoffs = tools.filter((entry): entry is Extract<ToolRecord, { kind: "tool-handoff" }> => entry.kind === "tool-handoff");
  const compensations = tools.filter((entry): entry is Extract<ToolRecord, { kind: "tool-compensation" }> =>
    entry.kind === "tool-compensation");
  const candidates = records.flatMap((entry) => record(entry) && entry.kind === "membership" && record(entry.value) &&
      entry.value.kind === "human" && text(entry.value.actorId) && entry.value.actorId !== viewerActorId
    ? [{ actorId: entry.value.actorId, displayRef: entry.value.actorId }] : []);
  const cards: ToolSafetyCardProjection[] = [];
  for (const call of calls) {
    const confirmation = confirmations.find((entry) => entry.value.toolCallId === call.value.toolCallId);
    const grant = grants.find((entry) => entry.value.toolCallId === call.value.toolCallId);
    const dispatch = dispatches.find((entry) => entry.value.toolCallId === call.value.toolCallId);
    const review = dispatch === undefined ? undefined : reviews.find((entry) =>
      entry.value.dispatchId === dispatch.value.dispatchId);
    const handoff = confirmation === undefined ? undefined : handoffs.find((entry) =>
      entry.value.confirmationId === confirmation.value.confirmationId && entry.value.state === "offered" &&
      entry.value.targetActorId === viewerActorId);
    const lineage = compensations.find((entry) => entry.value.compensationToolCallId === call.value.toolCallId);
    const originalLineage = dispatch === undefined ? undefined : compensations.find((entry) =>
      entry.value.originalDispatchId === dispatch.value.dispatchId);
    if (confirmation === undefined && dispatch === undefined && lineage === undefined) continue;
    const preview = safePreview(confirmation?.value.safePreview ?? call.value.safePreview);
    if (preview === undefined) continue;
    let state: ToolSafetyCardProjection["state"];
    let currentVersion: number;
    if (lineage !== undefined && (review !== undefined || dispatch?.value.state === "reviewed")) {
      state = "reviewed"; currentVersion = review?.value.version ?? dispatch!.value.version;
    } else if (lineage !== undefined && dispatch !== undefined) {
      const mapping = { prepared: "compensation-dispatched", claimed: "compensation-dispatched",
        dispatched: "compensation-dispatched", known_succeeded: "compensation-known-succeeded",
        known_failed: "compensation-known-failed", outcome_unknown: "compensation-outcome-unknown" } as const;
      state = mapping[dispatch.value.state as keyof typeof mapping]; currentVersion = dispatch.value.version;
    } else if (lineage !== undefined && grant?.value.state === "revoked") {
      state = "grant-revoked"; currentVersion = grant.value.version;
    } else if (lineage !== undefined && grant?.value.state === "expired") {
      state = "expired"; currentVersion = grant.value.version;
    } else if (lineage !== undefined && confirmation !== undefined) {
      const mapping = { pending: "compensation-pending", confirmed: "compensation-confirmed",
        rejected: "rejected", expired: "expired" } as const;
      state = mapping[confirmation.value.state]; currentVersion = confirmation.value.version;
    } else if (lineage !== undefined) {
      const mapping = {
        pending: "compensation-proposed", rejected: "rejected", expired: "expired",
        claimed: "compensation-dispatched", dispatched: "compensation-dispatched",
        known_succeeded: "compensation-known-succeeded", known_failed: "compensation-known-failed",
        outcome_unknown: "compensation-outcome-unknown", reviewed: "reviewed",
      } as const;
      state = mapping[lineage.value.state]; currentVersion = lineage.value.version;
    } else if (review !== undefined || dispatch?.value.state === "reviewed") {
      state = "reviewed"; currentVersion = review?.value.version ?? dispatch!.value.version;
    } else if (dispatch !== undefined) {
      const mapping = { prepared: "dispatched", claimed: "dispatched", dispatched: "dispatched",
        known_succeeded: "known-succeeded", known_failed: "known-failed", outcome_unknown: "outcome-unknown" } as const;
      state = mapping[dispatch.value.state as keyof typeof mapping]; currentVersion = dispatch.value.version;
    } else if (grant?.value.state === "revoked") {
      state = "grant-revoked"; currentVersion = grant.value.version;
    } else if (grant?.value.state === "expired") {
      state = "expired"; currentVersion = grant.value.version;
    } else {
      const mapping = { pending: "pending", confirmed: "confirmed", rejected: "rejected", expired: "expired" } as const;
      state = mapping[confirmation!.value.state]; currentVersion = confirmation!.value.version;
      if (confirmation!.value.state === "rejected") {
        if (["principal_revoked", "permission_reduced", "permission_denied", "session_revoked"]
          .includes(confirmation!.value.reasonCode ?? "")) state = "principal-revoked";
        else if (["tool_parameters_changed", "params_changed"].includes(
          confirmation!.value.reasonCode ?? "")) state = "params-changed";
      }
    }
    if (lineage === undefined && originalLineage?.value.state === "pending" &&
        (dispatch?.value.state === "outcome_unknown" || dispatch?.value.state === "known_succeeded")) {
      state = "compensation-proposed";
      currentVersion = dispatch.value.version;
    }
    const reasonCode = dispatch?.value.reasonCode ?? confirmation?.value.reasonCode ?? grant?.value.reasonCode;
    cards.push({
      toolCallId: call.value.toolCallId,
      confirmationId: confirmation?.value.confirmationId ?? "",
      ...(dispatch === undefined ? {} : { dispatchId: dispatch.value.dispatchId }),
      version: currentVersion, state, toolId: call.value.toolId, safeTarget: preview.target,
      parameterSummary: preview.summary, impact: preview.impact,
      reversibility: preview.reversibility,
      expiresAt: grant?.value.expiresAt ?? confirmation?.value.expiresAt ?? "",
      sourceRef: confirmation?.value.sourceRef ?? call.value.sourceRef,
      ...(typeof reasonCode === "string" ? { reasonCode } : {}),
      ...(confirmation?.value.namedHumanDisplayRef === null || confirmation?.value.namedHumanDisplayRef === undefined
        ? {} : { namedHumanDisplayRef: confirmation.value.namedHumanDisplayRef }),
      canDecide: confirmation === undefined
        ? dispatch !== undefined && roomOwnerActorId === viewerActorId
        : confirmation.value.principalActorId === viewerActorId,
      ...(review === undefined ? {} : { reviewResolution: review.value.resolution,
        evidenceSummary: review.value.evidenceSummary }),
      ...(confirmation?.value.state === "pending" ? { handoffCandidates: candidates } : {}),
      ...(handoff === undefined ? {} : { handoffId: handoff.value.handoffId,
        handoffVersion: handoff.value.version }),
      ...(originalLineage?.value.state === "known_succeeded" ? { compensationKnownSucceeded: true } : {}),
    });
  }
  return cards.sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
}

export interface DesktopToolSafetyRuntime {
  start(): void;
  getSurface(query: ToolSafetySurfaceQuery): Promise<ToolSafetyRemoteState>;
  submit(request: ToolSafetySubmitRequest): Promise<ToolSafetyRemoteState>;
  repair(query: ToolSafetySurfaceQuery): Promise<ToolSafetyRemoteState>;
  subscribe(listener: (state: ToolSafetyStateEnvelope) => void): () => void;
  invalidateAuthorizedState(): void;
  close(): void;
}

export function createDesktopToolSafetyRuntime(options: Readonly<{
  session: () => IdentityAuthoritySession | undefined;
  transport: MessageAuthorityWireTransport;
  authorityCache: DesktopAuthorityCache;
  repairRoom(roomId: string): Promise<void>;
  createRequestId(): string;
}>): DesktopToolSafetyRuntime {
  const connections = new Map<string, ToolSafetyRemoteState["connection"]>();
  const operations = new Map<string, ToolSafetyRemoteState["operation"]>();
  const displayOverrides = new Map<string, Map<string, Readonly<{
    state: "duplicate" | "params-changed"; version: number;
  }>>>();
  const listeners = new Set<(state: ToolSafetyStateEnvelope) => void>();
  const knownRooms = new Set<string>();
  let closed = false;
  let started = false;
  const state = (roomId: string): ToolSafetyRemoteState => {
    knownRooms.add(roomId);
    const session = options.session();
    const records = options.authorityCache.roomRepairRecords(roomId);
    const governance = options.authorityCache.governanceProjection(roomId);
    const connection = session === undefined
      ? { status: "revoked" as const }
      : governance?.lifecycle === "archived"
        ? { status: "archived" as const } : connections.get(roomId) ??
        (records === undefined ? { status: "repairing" as const } : { status: "online" as const });
    const cards = session === undefined || connection.status === "revoked" || records === undefined
      ? [] : buildCards(records as readonly unknown[], session.actorId, governance?.ownerActorId).map((card) => {
        const override = displayOverrides.get(roomId)?.get(card.toolCallId);
        const overrideApplicable = override?.state === "duplicate"
          ? ["pending", "confirmed", "rejected", "duplicate"].includes(card.state)
          : ["pending", "confirmed", "rejected", "params-changed"].includes(card.state);
        if (override?.version === card.version && overrideApplicable) return { ...card, state: override.state };
        if (override !== undefined && !overrideApplicable) displayOverrides.get(roomId)?.delete(card.toolCallId);
        return card;
      });
    return cloneToolSafetyRemoteState({ roomId, connection, cards,
      operation: operations.get(roomId) ?? { status: "idle" } });
  };
  const emit = (roomId: string): ToolSafetyRemoteState => {
    const current = state(roomId);
    for (const listener of listeners) listener({ roomId, state: cloneToolSafetyRemoteState(current) });
    return current;
  };
  const repair = async (roomId: string): Promise<ToolSafetyRemoteState> => {
    if (options.session() === undefined) {
      connections.set(roomId, { status: "revoked" });
      return emit(roomId);
    }
    connections.set(roomId, { status: "repairing" }); emit(roomId);
    try {
      await options.repairRoom(roomId);
      connections.set(roomId, { status: "online" });
    } catch {
      connections.set(roomId, { status: "repair-failed", errorCode: "repair_unavailable" });
    }
    return emit(roomId);
  };
  const unsubscribeCache = options.authorityCache.subscribeRoomRecords((roomId) => {
    if (!closed && connections.get(roomId)?.status !== "revoked") emit(roomId);
  });
  const unsubscribeTerminal = options.transport.onTerminalRevoked(() => {
    const roomIds = new Set([...knownRooms, ...options.authorityCache.roomIds()]);
    for (const roomId of roomIds) {
      connections.set(roomId, { status: "revoked" }); operations.set(roomId, { status: "idle" });
    }
    options.authorityCache.clear();
    for (const roomId of roomIds) {
      emit(roomId);
    }
  });
  const unsubscribeAccess = options.transport.onRoomAccessChanged((roomId, change) => {
    if (change === "removed" || change === "archived") {
      connections.set(roomId, { status: change === "removed" ? "revoked" : "archived" });
      operations.set(roomId, { status: "idle" }); emit(roomId);
      if (change === "removed") options.authorityCache.clearRoom(roomId);
    } else void repair(roomId);
  });
  const unsubscribeFailure = options.transport.onConnectionFailure(() => {
    for (const roomId of options.authorityCache.roomIds()) {
      connections.set(roomId, { status: "offline" }); emit(roomId);
    }
  });
  return Object.freeze({
    start() {
      if (closed) throw new TypeError("Tool Safety runtime is closed");
      started = true;
    },
    async getSurface(query: ToolSafetySurfaceQuery) {
      if (closed || !started) throw new TypeError("Tool Safety runtime is not started");
      if (!text(query.roomId)) throw new TypeError("Tool Safety query is invalid");
      return options.authorityCache.roomRepairRecords(query.roomId) === undefined
        ? repair(query.roomId) : emit(query.roomId);
    },
    async submit(request: ToolSafetySubmitRequest) {
      if (closed || !started || !isToolSafetySubmitRequest(request)) throw new TypeError("Tool Safety request is invalid");
      const before = state(request.roomId);
      const requestId = options.createRequestId();
      const commandAction = action(request.command);
      const retained = request.command.type === "tool.outcome.review"
        ? request.command.evidenceSummary : undefined;
      const commandCard = before.cards.find((card) =>
        request.command.type.startsWith("tool.confirmation.")
          ? ("confirmationId" in request.command && card.confirmationId === request.command.confirmationId) ||
            ("handoffId" in request.command && card.handoffId === request.command.handoffId)
          : "dispatchId" in request.command && card.dispatchId === request.command.dispatchId);
      if (before.connection.status !== "online") {
        operations.set(request.roomId, { status: "error", requestId, action: commandAction,
          statusCode: 503, code: "repair_unavailable",
          ...(retained === undefined ? {} : { retainedEvidenceSummary: retained }) });
        return emit(request.roomId);
      }
      operations.set(request.roomId, { status: "submitting", requestId, action: commandAction });
      emit(request.roomId);
      try {
        const acknowledgement = await options.transport.toolSafetyCommand({ ...request.command, requestId });
        if (acknowledgement.replayed) {
          operations.set(request.roomId, { status: "error", requestId, action: commandAction,
            statusCode: 409, code: "confirmation_replayed" });
          await repair(request.roomId);
          if (commandCard !== undefined) {
            const repairedCard = state(request.roomId).cards.find((card) =>
              card.toolCallId === commandCard.toolCallId);
            const overrides = displayOverrides.get(request.roomId) ?? new Map();
            overrides.set(commandCard.toolCallId, { state: "duplicate",
              version: repairedCard?.version ?? commandCard.version });
            displayOverrides.set(request.roomId, overrides);
          }
          operations.set(request.roomId, { status: "error", requestId, action: commandAction,
            statusCode: 409, code: "confirmation_replayed" });
          return emit(request.roomId);
        }
        operations.set(request.roomId, { status: "acknowledged", requestId, action: commandAction });
        emit(request.roomId);
        const repaired = await repair(request.roomId);
        if (repaired.connection.status === "online") operations.set(request.roomId, { status: "idle" });
        return emit(request.roomId);
      } catch (error: unknown) {
        const closedError = error instanceof MessageAuthorityTransportError ? error.toolSafetyError : undefined;
        const failure = closedError ?? { status: 503 as const, code: "service_unavailable" };
        operations.set(request.roomId, { status: "error", requestId, action: commandAction,
          statusCode: failure.status, code: failure.code,
          ...(failure.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: failure.retryAfterSeconds }),
          ...(retained === undefined ? {} : { retainedEvidenceSummary: retained }) });
        if (failure.status === 401) {
          connections.set(request.roomId, { status: "revoked" }); options.authorityCache.clear();
        } else if (failure.status === 403) {
          try { await options.repairRoom(request.roomId); connections.set(request.roomId, { status: "online" }); }
          catch { connections.set(request.roomId, { status: "repair-failed", errorCode: "repair_unavailable" }); }
        } else if (failure.status === 409 || failure.status === 410) {
          try { await options.repairRoom(request.roomId); connections.set(request.roomId, { status: "online" }); }
          catch { connections.set(request.roomId, { status: "repair-failed", errorCode: "repair_unavailable" }); }
        }
        if (failure.status === 409 && commandCard !== undefined &&
            ["tool_already_terminal", "confirmation_already_terminal", "confirmation_replayed", "already_handled"]
              .includes(failure.code)) {
          const overrides = displayOverrides.get(request.roomId) ?? new Map();
          const repairedCard = state(request.roomId).cards.find((card) =>
            card.toolCallId === commandCard.toolCallId);
          overrides.set(commandCard.toolCallId, { state: "duplicate",
            version: repairedCard?.version ?? commandCard.version });
          displayOverrides.set(request.roomId, overrides);
        } else if (failure.status === 409 && commandCard !== undefined &&
            ["tool_parameters_changed", "params_changed"].includes(failure.code)) {
          const overrides = displayOverrides.get(request.roomId) ?? new Map();
          const repairedCard = state(request.roomId).cards.find((card) =>
            card.toolCallId === commandCard.toolCallId);
          overrides.set(commandCard.toolCallId, { state: "params-changed",
            version: repairedCard?.version ?? commandCard.version });
          displayOverrides.set(request.roomId, overrides);
        }
        return emit(request.roomId);
      }
    },
    repair(query: ToolSafetySurfaceQuery) {
      if (!started || !text(query.roomId)) throw new TypeError("Tool Safety query is invalid");
      return repair(query.roomId);
    },
    subscribe(listener: (state: ToolSafetyStateEnvelope) => void) {
      listeners.add(listener); return () => listeners.delete(listener);
    },
    invalidateAuthorizedState() {
      for (const roomId of new Set([...knownRooms, ...options.authorityCache.roomIds()])) {
        connections.set(roomId, { status: "revoked" }); operations.set(roomId, { status: "idle" }); emit(roomId);
      }
    },
    close() {
      if (closed) return; closed = true; unsubscribeCache(); unsubscribeTerminal(); unsubscribeAccess();
      unsubscribeFailure(); listeners.clear(); connections.clear(); operations.clear();
      knownRooms.clear();
    },
  });
}
