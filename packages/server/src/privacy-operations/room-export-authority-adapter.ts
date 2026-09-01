import type {
  RoomExportAuthority,
  RoomExportAuthorization,
  RoomExportJson,
  RoomExportRecord,
  RoomExportSnapshot,
} from "./room-export.js";

export type RoomExportSessionFacts = Readonly<{
  actorId: string;
  sessionFamilyId: string;
  sessionId: string;
  tenantId: string;
  principalKind: "human" | "tenant_administrator";
  active: boolean;
}>;

export type RoomExportAccessFacts = Readonly<{
  actorId: string;
  tenantId: string;
  roomId: string;
  membershipRole: "owner" | "admin" | "member" | "none";
  lifecycle: "active" | "archived";
  accessRevision: number;
  exportAllowed: boolean;
}>;

export type ScopedRoomExportRecord = RoomExportRecord & Readonly<{
  tenantId: string;
  roomId: string;
  payload: RoomExportJson;
}>;

export interface RoomExportAuthorityPorts {
  sessions: Readonly<{
    inspect(input: Readonly<{ actorId: string; sessionFamilyId: string; sessionId: string }>): Promise<RoomExportSessionFacts>;
  }>;
  roomAccess: Readonly<{
    inspect(input: Readonly<{
      actorId: string;
      roomId: string;
      sessionFamilyId: string;
      sessionId: string;
    }>): Promise<RoomExportAccessFacts>;
  }>;
  snapshots: Readonly<{
    begin(input: Readonly<{
      actorId: string;
      tenantId: string;
      roomId: string;
      sessionFamilyId: string;
      sessionId: string;
      accessRevision: number;
      lifecycle: "active" | "archived";
    }>): Promise<RoomExportSnapshot>;
    reauthorize(input: Readonly<{
      actorId: string;
      tenantId: string;
      roomId: string;
      sessionFamilyId: string;
      sessionId: string;
      exportId: string;
      accessRevision: number;
      lifecycle: "active" | "archived";
      watermark: number;
      startedAt: string;
    }>): Promise<void>;
  }>;
  projections: Readonly<{
    readPage(input: Readonly<{
      tenantId: string;
      exportId: string;
      roomId: string;
      accessRevision: number;
      watermark: number;
      after?: string;
      limit: number;
      actorId: string;
      sessionFamilyId: string;
      sessionId: string;
      lifecycle: "active" | "archived";
      startedAt: string;
    }>): Promise<Readonly<{ records: readonly ScopedRoomExportRecord[]; next?: string }>>;
  }>;
  audit: Readonly<{
    append(input: Parameters<RoomExportAuthority["audit"]>[0]): Promise<void>;
  }>;
}

type AuthorizationContext = Readonly<{
  authorization: RoomExportAuthorization;
  tenantId: string;
}>;

type SnapshotContext = AuthorizationContext & Readonly<{ startedAt: string }>;

function authorizationKey(input: Readonly<{
  actorId: string;
  roomId: string;
  sessionFamilyId: string;
  sessionId: string;
  accessRevision: number;
}>): string {
  return `${input.actorId}\0${input.roomId}\0${input.sessionFamilyId}\0${input.sessionId}\0${input.accessRevision}`;
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isStorageUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    (("code" in error && error.code === "storage_unavailable") ||
      ("status" in error && error.status === 503));
}

function assertSession(
  session: RoomExportSessionFacts,
  expected: Readonly<{ actorId: string; sessionFamilyId: string; sessionId: string }>,
): void {
  if (!session.active || session.principalKind !== "human" ||
      session.actorId !== expected.actorId || session.sessionFamilyId !== expected.sessionFamilyId ||
      session.sessionId !== expected.sessionId ||
      session.tenantId.length === 0) {
    throw new Error("room export requires an active Human session");
  }
}

function assertOwnerAccess(
  access: RoomExportAccessFacts,
  expected: Readonly<{ actorId: string; roomId: string; tenantId: string }>,
): void {
  if (access.actorId !== expected.actorId || access.roomId !== expected.roomId ||
      access.tenantId !== expected.tenantId || access.membershipRole !== "owner" ||
      !access.exportAllowed || !isRevision(access.accessRevision) ||
      (access.lifecycle !== "active" && access.lifecycle !== "archived")) {
    throw new Error("room export requires current owner authorization");
  }
}

export function createRoomExportAuthorityAdapter(
  ports: RoomExportAuthorityPorts,
): RoomExportAuthority {
  const authorizations = new Map<string, AuthorizationContext>();
  const snapshots = new Map<string, SnapshotContext>();

  async function inspectCurrent(input: Readonly<{
    actorId: string;
    roomId: string;
    sessionFamilyId: string;
    sessionId: string;
  }>): Promise<Readonly<{
    session: RoomExportSessionFacts;
    access: RoomExportAccessFacts;
  }>> {
    const session = await ports.sessions.inspect({
      actorId: input.actorId,
      sessionFamilyId: input.sessionFamilyId,
      sessionId: input.sessionId,
    });
    assertSession(session, input);
    const access = await ports.roomAccess.inspect({
      actorId: input.actorId,
      roomId: input.roomId,
      sessionFamilyId: input.sessionFamilyId,
      sessionId: input.sessionId,
    });
    assertOwnerAccess(access, {
      actorId: input.actorId,
      roomId: input.roomId,
      tenantId: session.tenantId,
    });
    return { session, access };
  }

  return Object.freeze({
    async authorize(input: Parameters<RoomExportAuthority["authorize"]>[0]) {
      let current: Awaited<ReturnType<typeof inspectCurrent>>;
      try {
        current = await inspectCurrent(input);
      } catch (error) {
        if (isStorageUnavailable(error)) throw error;
        throw new Error("room export authorization changed");
      }
      const authorization = Object.freeze({
        actorId: input.actorId,
        roomId: input.roomId,
        sessionFamilyId: input.sessionFamilyId,
        sessionId: input.sessionId,
        accessRevision: current.access.accessRevision,
        lifecycle: current.access.lifecycle,
        role: "owner" as const,
      });
      authorizations.set(authorizationKey(authorization), Object.freeze({
        authorization,
        tenantId: current.session.tenantId,
      }));
      return authorization;
    },
    async begin(input: Parameters<RoomExportAuthority["begin"]>[0]) {
      const context = authorizations.get(authorizationKey(input));
      if (context === undefined || input.role !== "owner") {
        throw new Error("room export authorization is unknown");
      }
      const snapshot = await ports.snapshots.begin({
        actorId: input.actorId,
        tenantId: context.tenantId,
        roomId: input.roomId,
        sessionFamilyId: input.sessionFamilyId,
        sessionId: input.sessionId,
        accessRevision: input.accessRevision,
        lifecycle: input.lifecycle,
      });
      if (snapshot.roomId !== input.roomId || snapshot.accessRevision !== input.accessRevision ||
          !isRevision(snapshot.watermark)) {
        throw new Error("room export snapshot binding is invalid");
      }
      authorizations.delete(authorizationKey(input));
      snapshots.set(snapshot.exportId, Object.freeze({
        ...context,
        startedAt: snapshot.startedAt,
      }));
      return snapshot;
    },
    async reauthorize(input: Parameters<RoomExportAuthority["reauthorize"]>[0]) {
      const context = snapshots.get(input.exportId);
      if (context === undefined || authorizationKey(context.authorization) !== authorizationKey(input)) {
        throw new Error("room export snapshot authorization is unknown");
      }
      try {
        await ports.snapshots.reauthorize({
          actorId: input.actorId,
          tenantId: context.tenantId,
          roomId: input.roomId,
          sessionFamilyId: input.sessionFamilyId,
          sessionId: input.sessionId,
          exportId: input.exportId,
          accessRevision: input.accessRevision,
          lifecycle: input.lifecycle,
          watermark: input.watermark,
          startedAt: context.startedAt,
        });
      } catch (error) {
        if (isStorageUnavailable(error)) throw error;
        throw new Error("room export authorization changed");
      }
      if (input.role !== "owner") {
        throw new Error("room export authorization changed");
      }
    },
    async readPage(input: Parameters<RoomExportAuthority["readPage"]>[0]) {
      const context = snapshots.get(input.exportId);
      if (context === undefined) throw new Error("room export snapshot authorization is unknown");
      const page = await ports.projections.readPage({
        tenantId: context.tenantId,
        exportId: input.exportId,
        roomId: input.roomId,
        accessRevision: context.authorization.accessRevision,
        watermark: input.watermark,
        actorId: context.authorization.actorId,
        sessionFamilyId: context.authorization.sessionFamilyId,
        sessionId: context.authorization.sessionId,
        lifecycle: context.authorization.lifecycle,
        startedAt: context.startedAt,
        ...(input.after === undefined ? {} : { after: input.after }),
        limit: input.limit,
      });
      const records: RoomExportRecord[] = [];
      for (const scoped of page.records) {
        if (scoped.tenantId !== context.tenantId || scoped.roomId !== input.roomId) {
          throw new Error("room export projection returned a cross-scope record");
        }
        records.push(Object.freeze({
          category: scoped.category,
          entityId: scoped.entityId,
          revision: scoped.revision,
          payload: scoped.payload,
        }));
      }
      return Object.freeze({ records: Object.freeze(records), ...(page.next === undefined ? {} : { next: page.next }) });
    },
    async release(input: Parameters<RoomExportAuthority["release"]>[0]) {
      authorizations.delete(authorizationKey(input.authorization));
      if (input.exportId !== undefined) snapshots.delete(input.exportId);
    },
    async audit(input: Parameters<RoomExportAuthority["audit"]>[0]) {
      const terminal = input.result === "succeeded" || input.result === "failed" ||
        input.result === "forbidden" || input.result === "aborted";
      try {
        await ports.audit.append(input);
      } finally {
        if (terminal) snapshots.delete(input.exportId);
      }
    },
  });
}
