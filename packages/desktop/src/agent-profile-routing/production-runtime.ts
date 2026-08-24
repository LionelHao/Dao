import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  isAgentSettingsAuthorityMessage,
  isAgentSettingsMutationIntent,
  isAgentSettingsSnapshot,
  type AgentSettingsAuthorityMessage,
  type AgentSettingsBridge,
  type AgentSettingsMutationIntent,
  type AgentSettingsSnapshot,
  type AgentSettingsStableEventPayload,
} from "./contracts.js";

export interface AgentSettingsWebSocketLike {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

type Governance = Readonly<{ roomId: string; roomName: string; lifecycle: "active" | "archived";
  roomRevision: number; roomRole: "owner" | "admin" | "member" | null }>;

export function createDesktopAgentSettingsRuntime(options: {
  endpoint: string;
  session: () => IdentityAuthoritySession | undefined;
  webSocketFactory: (endpoint: string) => AgentSettingsWebSocketLike;
  governance: (roomId: string) => Promise<Governance>;
  createRequestIdentity: () => Readonly<{ requestId: string; idempotencyKey: string }>;
  timeoutMs?: number;
}): AgentSettingsBridge & { close(): void } {
  const listeners = new Set<(message: AgentSettingsAuthorityMessage) => void>();
  let closed = false;
  let currentRoomId: string | undefined;
  let lastSnapshot: AgentSettingsSnapshot | undefined;
  const publish = (message: AgentSettingsAuthorityMessage): void => {
    if (!isAgentSettingsAuthorityMessage(message)) throw new TypeError("Agent Settings message is not closed");
    for (const listener of listeners) listener(structuredClone(message));
  };
  async function exchangeOnce(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (closed) throw new Error("authority_unavailable");
    const session = options.session();
    if (session === undefined) throw Object.assign(new Error("authentication_required"), { status: 401 });
    return new Promise((resolve, reject) => {
      const socket = options.webSocketFactory(options.endpoint);
      const timeout = setTimeout(
        () => finish(undefined, new Error("authority_unavailable")),
        options.timeoutMs ?? 10_000,
      );
      let resumed = false;
      let settled = false;
      const finish = (value?: Record<string, unknown>, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout); socket.close();
        if (error !== undefined) reject(error); else resolve(value!);
      };
      const message = (event: unknown): void => {
        const raw = (event as { data?: unknown }).data;
        if (typeof raw !== "string") return finish(undefined, new Error("authority_unavailable"));
        let value: unknown;
        try { value = JSON.parse(raw); } catch { return finish(undefined, new Error("authority_unavailable")); }
        if (typeof value !== "object" || value === null) return finish(undefined, new Error("authority_unavailable"));
        const record = value as Record<string, unknown>;
        if (!resumed && record.type === "auth.authenticated") {
          resumed = true; socket.send(JSON.stringify(frame)); return;
        }
        if (record.requestId !== frame.requestId) return;
        if (record.type === "error") return finish(undefined, Object.assign(
          new Error(typeof record.code === "string" ? record.code : "authority_unavailable"),
          { status: record.status, code: record.code },
        ));
        finish(record);
      };
      socket.addEventListener("message", message);
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        type: "auth.resume", requestId: `agent-settings-resume-${frame.requestId}`,
        accessToken: session.accessToken,
      })));
      socket.addEventListener("error", () => finish(undefined, new Error("authority_unavailable")));
      socket.addEventListener("close", () => finish(undefined, new Error("authority_unavailable")));
    });
  }
  async function exchange(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await exchangeOnce(frame);
      } catch (error: unknown) {
        lastError = error;
        const status = (error as { status?: unknown }).status;
        const retryable = status === 503 ||
          (error instanceof Error && error.message === "authority_unavailable");
        if (!retryable || attempt === 2 || closed) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
      }
    }
    throw lastError;
  }
  async function snapshot(roomId: string): Promise<AgentSettingsSnapshot> {
    currentRoomId = roomId;
    const governance = await options.governance(roomId);
    const adminRequest = options.createRequestIdentity().requestId;
    let administrator = false;
    try { await exchange({ type: "tenant-administrator.list", requestId: adminRequest }); administrator = true; }
    catch (error) { if ((error as { status?: number }).status !== 403) throw error; }
    let catalog: Record<string, unknown> | undefined;
    if (administrator) catalog = await exchange({ type: "agent-profile.list",
      requestId: options.createRequestIdentity().requestId });
    let assignments: Record<string, unknown> | undefined;
    if (governance.roomRole !== null) assignments = await exchange({ type: "room-agent-assignment.list",
      requestId: options.createRequestIdentity().requestId, roomId });
    const providerWire = (catalog?.provider ?? assignments?.provider) as Record<string, unknown> | undefined;
    if (providerWire === undefined) throw Object.assign(new Error("room_forbidden"), { status: 403 });
    const assignmentValues = Array.isArray(assignments?.assignments)
      ? assignments.assignments.map((entry) => {
          const projection = { ...(entry as Record<string, unknown>) };
          delete projection.updatedAt;
          return projection;
        }) : [];
    const value = {
      recordVersion: "agent-settings.snapshot.v1", cursor: Number(catalog?.catalogRevision ?? 0),
      viewer: { actorId: options.session()!.actorId, tenantAdministrator: administrator,
        roomRole: governance.roomRole },
      provider: { providerId: providerWire.providerId, modelId: providerWire.modelId,
        credentialStatus: providerWire.credentialReadiness === "ready" ? "configured" : "missing",
        retentionDisabled: true, selectionPolicy: "server-managed-single" },
      profileCatalog: administrator ? { status: "available", revision: catalog!.catalogRevision,
        profiles: catalog!.profiles } : { status: "forbidden" },
      room: governance.roomRole === null ? { status: "forbidden", roomId } : {
        status: "available", roomId, roomName: governance.roomName,
        lifecycle: governance.lifecycle, roomRevision: assignments!.roomRevision,
        assignments: assignmentValues,
      },
    };
    if (!isAgentSettingsSnapshot(value)) throw new TypeError("Agent Settings snapshot is not closed");
    lastSnapshot = structuredClone(value);
    return structuredClone(value);
  }
  function wire(intent: AgentSettingsMutationIntent, requestId: string, idempotencyKey: string) {
    const { command, ...fields } = intent;
    const types = { "profile.create": "agent-profile.create", "profile.update": "agent-profile.update",
      "profile.disable": "agent-profile.disable", "profile.enable": "agent-profile.enable",
      "assignment.create": "room-agent-assignment.create", "assignment.update": "room-agent-assignment.update",
      "assignment.pause": "room-agent-assignment.pause", "assignment.resume": "room-agent-assignment.resume",
      "assignment.remove": "room-agent-assignment.remove" } as const;
    const mapped = { ...fields } as Record<string, unknown>;
    if ("expectedProfileRevision" in mapped && command === "profile.create") {
      mapped.expectedProfileRevision = 0;
    } else if (command === "profile.create") mapped.expectedProfileRevision = 0;
    return { type: types[command], requestId, idempotencyKey, ...mapped };
  }
  return Object.freeze({
    getSnapshot(input: { roomId: string }) { return snapshot(input.roomId); },
    async submit(input: Parameters<AgentSettingsBridge["submit"]>[0]) {
      if (!isAgentSettingsMutationIntent(input.intent)) throw new TypeError("Agent Settings intent is not closed");
      const intent = input.intent;
      const identity = options.createRequestIdentity();
      const before = lastSnapshot;
      const response = await exchange(wire(input.intent, identity.requestId, identity.idempotencyKey));
      if (response.type !== "agent-settings.ack") throw new Error("authority_unavailable");
      const ack = { type: "ack", requestId: input.requestId, command: input.intent.command,
        replayed: response.replayed, acceptedRevision: response.acceptedRevision,
        eventIds: response.eventIds } as AgentSettingsAuthorityMessage;
      publish(ack);
      if (currentRoomId !== undefined) {
        const authoritative = await snapshot(currentRoomId);
        publish({ type: "snapshot", snapshot: authoritative });
        const eventId = (response.eventIds as string[])[0];
        if (eventId !== undefined) {
          const currentProfiles = authoritative.profileCatalog.status === "available"
            ? authoritative.profileCatalog.profiles : [];
          const previousProfileIds = new Set(before?.profileCatalog.status === "available"
            ? before.profileCatalog.profiles.map((profile) => profile.profileId) : []);
          let profile = currentProfiles.find(() => false);
          switch (intent.command) {
            case "profile.create":
              profile = currentProfiles.find((candidate) =>
                !previousProfileIds.has(candidate.profileId) &&
                candidate.revision === response.acceptedRevision &&
                candidate.displayName === intent.displayName &&
                candidate.globalResponsibility === intent.globalResponsibility);
              break;
            case "profile.update":
            case "profile.disable":
            case "profile.enable":
              profile = currentProfiles.find((candidate) => candidate.profileId === intent.profileId &&
                candidate.revision === response.acceptedRevision);
              break;
          }
          const currentAssignments = authoritative.room.status === "available"
            ? authoritative.room.assignments : [];
          const previousAssignmentIds = new Set(before?.room.status === "available"
            ? before.room.assignments.map((assignment) => assignment.assignmentId) : []);
          let assignment = currentAssignments.find(() => false);
          switch (intent.command) {
            case "assignment.create":
              assignment = currentAssignments.find((candidate) =>
                !previousAssignmentIds.has(candidate.assignmentId) &&
                candidate.profileId === intent.profileId &&
                candidate.assignmentRevision === response.acceptedRevision);
              break;
            case "assignment.update":
            case "assignment.pause":
            case "assignment.resume":
              assignment = currentAssignments.find((candidate) =>
                candidate.assignmentId === intent.assignmentId &&
                candidate.assignmentRevision === response.acceptedRevision);
              break;
          }
          let event: AgentSettingsStableEventPayload | undefined;
          if (intent.command.startsWith("profile.") && profile !== undefined &&
              authoritative.profileCatalog.status === "available") {
            event = { kind: "profile.upserted",
              catalogRevision: authoritative.profileCatalog.revision, profile };
          } else if (intent.command === "assignment.remove") {
            event = { kind: "assignment.removed", roomId: currentRoomId,
              roomRevision: authoritative.room.status === "available"
                ? authoritative.room.roomRevision : 0,
              assignmentId: intent.assignmentId,
              actorId: before?.room.status === "available"
                ? before.room.assignments.find((item) =>
                    item.assignmentId === intent.assignmentId)?.actorId ?? "removed"
                : "removed",
              assignmentRevision: response.acceptedRevision as number };
          } else if (authoritative.room.status === "available" && assignment !== undefined) {
            event = { kind: "assignment.upserted",
              roomRevision: authoritative.room.roomRevision, assignment };
          }
          if (event !== undefined) {
            publish({ type: "stable-event", eventId, cursor: Math.max(1, authoritative.cursor),
              causationRequestId: input.requestId, event });
          }
        }
      }
      return structuredClone(ack);
    },
    onAuthorityMessage(listener: Parameters<AgentSettingsBridge["onAuthorityMessage"]>[0]) {
      listeners.add(listener); return () => listeners.delete(listener); },
    close() { closed = true; listeners.clear(); },
  });
}
