import {
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTICS_MAX_ENTRIES,
  type DiagnosticEntry,
} from "./diagnostics.js";
import {
  type RoomExportAccessFacts,
  type RoomExportSessionFacts,
  type ScopedRoomExportRecord,
} from "./room-export-authority-adapter.js";
import {
  ROOM_EXPORT_CATEGORIES,
  ROOM_EXPORT_MAX_PAGE_RECORDS,
  type RoomExportSnapshot,
} from "./room-export.js";

type BoundIdentity = Readonly<{
  actorId: string;
  sessionFamilyId: string;
  sessionId: string;
  now: number;
}>;

export type PrivacyDataAuthorityOperation =
  | Readonly<{ version: 1; type: "privacy.diagnostics.authorize" } & BoundIdentity>
  | Readonly<{ version: 1; type: "privacy.diagnostics.read-closed"; limit: number } & BoundIdentity>
  | Readonly<{ version: 1; type: "privacy.room-export.inspect-session" } & BoundIdentity>
  | Readonly<{
      version: 1;
      type: "privacy.room-export.inspect-access";
      actorId: string;
      sessionFamilyId: string;
      sessionId: string;
      roomId: string;
      now: number;
    }>
  | Readonly<{
      version: 1;
      type: "privacy.room-export.begin";
      actorId: string;
      sessionFamilyId: string;
      sessionId: string;
      roomId: string;
      tenantId: string;
      accessRevision: number;
      lifecycle: "active" | "archived";
      now: number;
    }>
  | Readonly<{
      version: 1;
      type: "privacy.room-export.reauthorize";
      actorId: string;
      sessionFamilyId: string;
      sessionId: string;
      roomId: string;
      tenantId: string;
      accessRevision: number;
      lifecycle: "active" | "archived";
      exportId: string;
      now: number;
      watermark: number;
      startedAt: string;
    }>
  | Readonly<{
      version: 1;
      type: "privacy.room-export.read-page";
      actorId: string;
      sessionFamilyId: string;
      sessionId: string;
      roomId: string;
      tenantId: string;
      accessRevision: number;
      lifecycle: "active" | "archived";
      exportId: string;
      watermark: number;
      startedAt: string;
      after?: string;
      limit: number;
      now: number;
    }>;

export type PrivacyDataAuthorityResult =
  | Readonly<{ kind: "diagnostics-principal"; actorId: string; sessionFamilyId: string; sessionId: string;
      principalKind: "tenant_administrator" }>
  | Readonly<{ kind: "diagnostics-entries"; entries: readonly DiagnosticEntry[] }>
  | Readonly<{ kind: "room-export-session"; session: RoomExportSessionFacts }>
  | Readonly<{ kind: "room-export-access"; access: RoomExportAccessFacts }>
  | Readonly<{ kind: "room-export-snapshot"; snapshot: RoomExportSnapshot }>
  | Readonly<{ kind: "room-export-reauthorized" }>
  | Readonly<{ kind: "room-export-page"; records: readonly ScopedRoomExportRecord[]; next?: string }>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CURSOR = /^c:[A-Za-z0-9_-]{1,700}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every(
    (key) => required.includes(key) || optional.includes(key),
  );
}

function isId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isTime(value: unknown): value is number {
  return isRevision(value) && new Date(Number(value)).getTime() === value;
}

function isLifecycle(value: unknown): value is "active" | "archived" {
  return value === "active" || value === "archived";
}

function validBoundIdentity(value: Record<string, unknown>): boolean {
  return isId(value.actorId) && isId(value.sessionFamilyId) && isId(value.sessionId) && isTime(value.now);
}

function validExportBinding(value: Record<string, unknown>): boolean {
  return isId(value.actorId) && isId(value.sessionFamilyId) && isId(value.sessionId) && isId(value.roomId) &&
    value.tenantId === "deployment-singleton" && isRevision(value.accessRevision) &&
    isLifecycle(value.lifecycle) && isTime(value.now);
}

export function isPrivacyDataAuthorityOperation(value: unknown): value is PrivacyDataAuthorityOperation {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return false;
  switch (value.type) {
    case "privacy.diagnostics.authorize":
    case "privacy.room-export.inspect-session":
      return hasExactKeys(value, ["version", "type", "actorId", "sessionFamilyId", "sessionId", "now"]) &&
        validBoundIdentity(value);
    case "privacy.diagnostics.read-closed":
      return hasExactKeys(value, ["version", "type", "actorId", "sessionFamilyId", "sessionId", "now", "limit"]) &&
        validBoundIdentity(value) && Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 &&
        Number(value.limit) <= DIAGNOSTICS_MAX_ENTRIES;
    case "privacy.room-export.inspect-access":
      return hasExactKeys(value, [
        "version", "type", "actorId", "sessionFamilyId", "sessionId", "roomId", "now",
      ]) && isId(value.actorId) && isId(value.sessionFamilyId) && isId(value.sessionId) &&
        isId(value.roomId) && isTime(value.now);
    case "privacy.room-export.begin":
      return hasExactKeys(value, [
        "version", "type", "actorId", "sessionFamilyId", "sessionId", "roomId", "tenantId",
        "accessRevision", "lifecycle", "now",
      ]) && validExportBinding(value);
    case "privacy.room-export.reauthorize":
      return hasExactKeys(value, [
        "version", "type", "actorId", "sessionFamilyId", "sessionId", "roomId", "tenantId",
        "accessRevision", "lifecycle", "exportId", "watermark", "startedAt", "now",
      ]) && validExportBinding(value) && isId(value.exportId) && isRevision(value.watermark) &&
        isCanonicalTime(value.startedAt);
    case "privacy.room-export.read-page":
      return hasExactKeys(value, [
        "version", "type", "actorId", "sessionFamilyId", "sessionId", "roomId", "tenantId",
        "accessRevision", "lifecycle", "exportId", "watermark", "startedAt", "limit", "now",
      ], ["after"]) && validExportBinding(value) && isId(value.exportId) && isRevision(value.watermark) &&
        isCanonicalTime(value.startedAt) &&
        Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 &&
        Number(value.limit) <= ROOM_EXPORT_MAX_PAGE_RECORDS &&
        (value.after === undefined || (typeof value.after === "string" && CURSOR.test(value.after)));
    default:
      return false;
  }
}

function isCanonicalTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

function isDiagnosticEntry(value: unknown): value is DiagnosticEntry {
  if (!isRecord(value) || !hasExactKeys(value, ["category", "code", "occurredAt"], [
    "stableId", "state", "sizeBytes", "durationMs", "queueDepth", "attempt", "metadata",
  ]) || !(DIAGNOSTIC_CATEGORIES as readonly unknown[]).includes(value.category) ||
      !isId(value.code) || !isCanonicalTime(value.occurredAt)) return false;
  for (const key of ["sizeBytes", "durationMs", "queueDepth", "attempt"] as const) {
    if (value[key] !== undefined && !isRevision(value[key])) return false;
  }
  if (value.stableId !== undefined && !isId(value.stableId)) return false;
  if (value.state !== undefined && !isId(value.state)) return false;
  if (value.metadata !== undefined && (!isRecord(value.metadata) || Object.entries(value.metadata).some(
    ([key, scalar]) => !isId(key) || (scalar !== null && !["string", "number", "boolean"].includes(typeof scalar)),
  ))) return false;
  return true;
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return isRecord(value) && Object.values(value).every(isJson);
}

function isScopedRecord(value: unknown): value is ScopedRoomExportRecord {
  return isRecord(value) && hasExactKeys(value, [
    "tenantId", "roomId", "category", "entityId", "revision", "payload",
  ]) && value.tenantId === "deployment-singleton" && isId(value.roomId) &&
    (ROOM_EXPORT_CATEGORIES as readonly unknown[]).includes(value.category) &&
    isId(value.entityId) && isRevision(value.revision) && isJson(value.payload) &&
    Buffer.byteLength(JSON.stringify(value.payload), "utf8") <= 1_048_576;
}

export function isPrivacyDataAuthorityResult(value: unknown): value is PrivacyDataAuthorityResult {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "diagnostics-principal":
      return hasExactKeys(value, ["kind", "actorId", "sessionFamilyId", "sessionId", "principalKind"]) &&
        isId(value.actorId) && isId(value.sessionFamilyId) && isId(value.sessionId) &&
        value.principalKind === "tenant_administrator";
    case "diagnostics-entries":
      return hasExactKeys(value, ["kind", "entries"]) && Array.isArray(value.entries) &&
        value.entries.length <= DIAGNOSTICS_MAX_ENTRIES && value.entries.every(isDiagnosticEntry);
    case "room-export-session": {
      if (!hasExactKeys(value, ["kind", "session"]) || !isRecord(value.session)) return false;
      const session = value.session;
      return hasExactKeys(session, ["actorId", "sessionFamilyId", "sessionId", "tenantId", "principalKind", "active"]) &&
        isId(session.actorId) && isId(session.sessionFamilyId) && isId(session.sessionId) &&
        session.tenantId === "deployment-singleton" &&
        (session.principalKind === "human" || session.principalKind === "tenant_administrator") &&
        typeof session.active === "boolean";
    }
    case "room-export-access": {
      if (!hasExactKeys(value, ["kind", "access"]) || !isRecord(value.access)) return false;
      const access = value.access;
      return hasExactKeys(access, [
        "actorId", "tenantId", "roomId", "membershipRole", "lifecycle",
        "accessRevision", "exportAllowed",
      ]) && isId(access.actorId) && access.tenantId === "deployment-singleton" &&
        isId(access.roomId) && ["owner", "admin", "member", "none"].includes(String(access.membershipRole)) &&
        isLifecycle(access.lifecycle) && isRevision(access.accessRevision) &&
        typeof access.exportAllowed === "boolean";
    }
    case "room-export-snapshot": {
      if (!hasExactKeys(value, ["kind", "snapshot"]) || !isRecord(value.snapshot)) return false;
      const snapshot = value.snapshot;
      return hasExactKeys(snapshot, ["exportId", "roomId", "watermark", "accessRevision", "startedAt"]) &&
        isId(snapshot.exportId) && isId(snapshot.roomId) && isRevision(snapshot.watermark) &&
        isRevision(snapshot.accessRevision) && isCanonicalTime(snapshot.startedAt);
    }
    case "room-export-reauthorized":
      return hasExactKeys(value, ["kind"]);
    case "room-export-page":
      return hasExactKeys(value, ["kind", "records"], ["next"]) && Array.isArray(value.records) &&
        value.records.length <= ROOM_EXPORT_MAX_PAGE_RECORDS && value.records.every(isScopedRecord) &&
        (value.next === undefined || (typeof value.next === "string" && CURSOR.test(value.next)));
    default:
      return false;
  }
}
