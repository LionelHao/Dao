import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  isAgentSettingsAuthorityMessage,
  isAgentSettingsMutationIntent,
  isAgentSettingsSnapshot,
  type AgentSettingsAuthorityMessage,
  type AgentSettingsBridge,
  type AgentSettingsMutationIntent,
  type AgentSettingsSnapshot,
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
}): AgentSettingsBridge & { close(): void } {
  const listeners = new Set<(message: AgentSettingsAuthorityMessage) => void>();
  let closed = false;
  let currentRoomId: string | undefined;
  let lastSnapshot: AgentSettingsSnapshot | undefined;
  const publish = (message: AgentSettingsAuthorityMessage): void => {
    if (!isAgentSettingsAuthorityMessage(message)) throw new TypeError("Agent Settings message is not closed");
    for (const listener of listeners) listener(structuredClone(message));
  };
  async function exchange(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (closed) throw new Error("authority_unavailable");
    const session = options.session();
    if (session === undefined) throw Object.assign(new Error("authentication_required"), { status: 401 });
    return new Promise((resolve, reject) => {
      const socket = options.webSocketFactory(options.endpoint);
      const timeout = setTimeout(() => finish(undefined, new Error("authority_unavailable")), 10_000);
      let resumed = false;
      const finish = (value?: Record<string, unknown>, error?: Error) => {
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
    });
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
          const event = input.intent.command.startsWith("profile.") &&
              authoritative.profileCatalog.status === "available"
            ? { kind: "profile.upserted" as const,
                catalogRevision: authoritative.profileCatalog.revision,
                profile: authoritative.profileCatalog.profiles.find((item) =>
                  item.revision === response.acceptedRevision)! }
            : input.intent.command === "assignment.remove"
              ? { kind: "assignment.removed" as const, roomId: currentRoomId,
                  roomRevision: authoritative.room.status === "available" ? authoritative.room.roomRevision : 0,
                  assignmentId: "assignmentId" in input.intent ? input.intent.assignmentId : "removed",
                  actorId: before?.room.status === "available"
                    ? before.room.assignments.find((item) => item.assignmentId ===
                      ("assignmentId" in input.intent ? input.intent.assignmentId : "removed"))?.actorId ?? "removed"
                    : "removed", assignmentRevision: response.acceptedRevision as number }
              : authoritative.room.status === "available"
                ? { kind: "assignment.upserted" as const,
                    roomRevision: authoritative.room.roomRevision,
                    assignment: authoritative.room.assignments.find((item) =>
                      item.assignmentRevision === response.acceptedRevision)! }
                : undefined;
          if (event !== undefined && !("profile" in event && event.profile === undefined) &&
              !("assignment" in event && event.assignment === undefined)) {
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
