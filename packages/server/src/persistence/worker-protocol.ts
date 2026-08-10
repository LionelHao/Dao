import { isActor } from "@native-im/core";
import type { Actor } from "@native-im/core";
import {
  parsePersistentCommand,
} from "./contracts.js";
import type {
  AuthenticatedSessionContext,
  AuthenticatedCommandContext,
  CommandAcknowledgement,
  HashedSessionIssue,
  HashedSessionRotation,
  HumanCollaborationCommand,
  IssuedSessionRecord,
  RoomGovernanceCommand,
} from "./contracts.js";

export type AuthorityWorkerRequest =
  | { readonly type: "authority.initialize"; readonly requestId: string }
  | { readonly type: "authority.inspect-schema"; readonly requestId: string }
  | {
      readonly type: "authority.import-legacy";
      readonly requestId: string;
      readonly sessionFilePath: string;
      readonly roomFilePath: string;
      readonly messageFilePath: string;
    }
  | { readonly type: "authority.inspect-legacy-import"; readonly requestId: string }
  | {
      readonly type: "authority.register-actors";
      readonly requestId: string;
      readonly actors: readonly Actor[];
    }
  | {
      readonly type: "authority.session-issue";
      readonly requestId: string;
      readonly input: HashedSessionIssue;
    }
  | {
      readonly type: "authority.session-authenticate";
      readonly requestId: string;
      readonly accessTokenHash: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.session-rotate";
      readonly requestId: string;
      readonly input: HashedSessionRotation;
    }
  | {
      readonly type: "authority.session-validate-refresh";
      readonly requestId: string;
      readonly currentRefreshTokenHash: string;
      readonly expectedPrincipal?: {
        readonly accountId: string;
        readonly actorId: string;
      };
      readonly now: number;
    }
  | {
      readonly type: "authority.session-revoke";
      readonly requestId: string;
      readonly accessTokenHash: string;
      readonly now: number;
    }
  | {
      readonly type: "authority.execute-human";
      readonly requestId: string;
      readonly context: AuthenticatedCommandContext;
      readonly command: HumanCollaborationCommand | RoomGovernanceCommand;
      readonly now: number;
    }
  | { readonly type: "authority.close"; readonly requestId: string };

export type AuthorityWorkerResponse =
  | {
      readonly type: "authority.ready";
      readonly requestId: string;
      readonly schemaVersion: 3;
    }
  | {
      readonly type: "authority.schema";
      readonly requestId: string;
      readonly schemaVersion: 3;
    }
  | {
      readonly type: "authority.legacy-imported";
      readonly requestId: string;
      readonly imported: boolean;
      readonly actors: number;
      readonly rooms: number;
      readonly messages: number;
    }
  | {
      readonly type: "authority.legacy-import";
      readonly requestId: string;
      readonly markerVersion: 1;
      readonly actors: number;
      readonly rooms: number;
      readonly messages: number;
      readonly roomHeadSeq: number;
      readonly identityHeadSeq: number;
    }
  | {
      readonly type: "authority.actors-registered";
      readonly requestId: string;
      readonly actorCount: number;
    }
  | {
      readonly type: "authority.session-issued";
      readonly requestId: string;
      readonly session: IssuedSessionRecord;
    }
  | {
      readonly type: "authority.session-authenticated";
      readonly requestId: string;
      readonly context: AuthenticatedSessionContext;
    }
  | {
      readonly type: "authority.session-rotated";
      readonly requestId: string;
      readonly session: IssuedSessionRecord;
    }
  | {
      readonly type: "authority.session-refresh-valid";
      readonly requestId: string;
    }
  | {
      readonly type: "authority.session-revoked";
      readonly requestId: string;
    }
  | {
      readonly type: "authority.command-acknowledged";
      readonly requestId: string;
      readonly acknowledgement: CommandAcknowledgement;
    }
  | { readonly type: "authority.closed"; readonly requestId: string }
  | {
      readonly type: "authority.error";
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function hasRequestId(value: Record<string, unknown>): boolean {
  return typeof value.requestId === "string" && value.requestId.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTokenHash(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function isStrictActor(value: unknown): value is Actor {
  if (!isRecord(value) || !isActor(value)) {
    return false;
  }
  const expectedKeys =
    value.kind === "human"
      ? ["id", "kind", "displayName", "reachability"]
      : ["id", "kind", "displayName", "readiness", "toolPermissions"];
  return hasExactKeys(value, expectedKeys);
}

function isHashedSessionIssue(value: unknown): value is HashedSessionIssue {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "accountId",
      "actorId",
      "accessTokenHash",
      "refreshTokenHash",
      "accessExpiresAt",
      "refreshExpiresAt",
    ]) &&
    isText(value.accountId) &&
    isText(value.actorId) &&
    isTokenHash(value.accessTokenHash) &&
    isTokenHash(value.refreshTokenHash) &&
    value.accessTokenHash !== value.refreshTokenHash &&
    isNonNegativeSafeInteger(value.accessExpiresAt) &&
    isNonNegativeSafeInteger(value.refreshExpiresAt) &&
    value.refreshExpiresAt > value.accessExpiresAt
  );
}

function isIssuedSessionRecord(value: unknown): value is IssuedSessionRecord {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "sessionId",
      "familyId",
      "accountId",
      "actorId",
      "accessExpiresAt",
      "refreshExpiresAt",
    ]) &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.familyId) &&
    isText(value.accountId) &&
    isText(value.actorId) &&
    isNonNegativeSafeInteger(value.accessExpiresAt) &&
    isNonNegativeSafeInteger(value.refreshExpiresAt)
  );
}

function isPrincipal(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["accountId", "actorId"]) &&
    isText(value.accountId) &&
    isText(value.actorId)
  );
}

function isHashedSessionRotation(value: unknown): value is HashedSessionRotation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "currentRefreshTokenHash",
      "accessTokenHash",
      "refreshTokenHash",
      "accessExpiresAt",
      "refreshExpiresAt",
      "now",
      ...(Object.hasOwn(value, "expectedPrincipal") ? ["expectedPrincipal"] : []),
    ]) &&
    isTokenHash(value.currentRefreshTokenHash) &&
    isTokenHash(value.accessTokenHash) &&
    isTokenHash(value.refreshTokenHash) &&
    value.accessTokenHash !== value.refreshTokenHash &&
    isNonNegativeSafeInteger(value.accessExpiresAt) &&
    isNonNegativeSafeInteger(value.refreshExpiresAt) &&
    value.refreshExpiresAt > value.accessExpiresAt &&
    isNonNegativeSafeInteger(value.now) &&
    (!Object.hasOwn(value, "expectedPrincipal") || isPrincipal(value.expectedPrincipal))
  );
}

function isAuthenticatedSessionContext(
  value: unknown,
): value is AuthenticatedSessionContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["sessionId", "sessionFamilyId", "principal"]) &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.sessionFamilyId) &&
    isRecord(value.principal) &&
    hasExactKeys(value.principal, ["accountId", "actorId"]) &&
    isText(value.principal.accountId) &&
    isText(value.principal.actorId)
  );
}

function isAuthenticatedCommandContext(
  value: unknown,
): value is AuthenticatedCommandContext {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "kind",
      "sessionId",
      "sessionFamilyId",
      "principal",
      "requestId",
      "idempotencyKey",
    ]) &&
    value.kind === "human" &&
    isTokenHash(value.sessionId) &&
    isTokenHash(value.sessionFamilyId) &&
    isPrincipal(value.principal) &&
    isText(value.requestId) &&
    isText(value.idempotencyKey)
  );
}

function isHumanCommand(value: unknown): value is HumanCollaborationCommand | RoomGovernanceCommand {
  const parsed = parsePersistentCommand(value);
  if (!parsed.ok) {
    return false;
  }
  return parsed.value.type !== "agent.judgment.record" &&
    parsed.value.type !== "agent.execution.transition";
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isCommandAcknowledgement(value: unknown): value is CommandAcknowledgement {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["aggregateId", "eventIds", "acceptedAt", "result"]) &&
    isText(value.aggregateId) &&
    Array.isArray(value.eventIds) &&
    value.eventIds.every(isText) &&
    isText(value.acceptedAt) &&
    isJsonValue(value.result)
  );
}

export function isAuthorityWorkerRequest(value: unknown): value is AuthorityWorkerRequest {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "authority.initialize":
    case "authority.inspect-schema":
    case "authority.inspect-legacy-import":
    case "authority.close":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.import-legacy":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "sessionFilePath",
          "roomFilePath",
          "messageFilePath",
        ]) &&
        typeof value.sessionFilePath === "string" &&
        value.sessionFilePath.length > 0 &&
        typeof value.roomFilePath === "string" &&
        value.roomFilePath.length > 0 &&
        typeof value.messageFilePath === "string" &&
        value.messageFilePath.length > 0
      );
    case "authority.register-actors":
      return (
        hasExactKeys(value, ["type", "requestId", "actors"]) &&
        Array.isArray(value.actors) &&
        value.actors.length > 0 &&
        value.actors.every(isStrictActor) &&
        new Set(value.actors.map((actor) => actor.id)).size === value.actors.length
      );
    case "authority.session-issue":
      return (
        hasExactKeys(value, ["type", "requestId", "input"]) &&
        isHashedSessionIssue(value.input)
      );
    case "authority.session-authenticate":
      return (
        hasExactKeys(value, ["type", "requestId", "accessTokenHash", "now"]) &&
        isTokenHash(value.accessTokenHash) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.session-rotate":
      return (
        hasExactKeys(value, ["type", "requestId", "input"]) &&
        isHashedSessionRotation(value.input)
      );
    case "authority.session-validate-refresh":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "currentRefreshTokenHash",
          "now",
          ...(Object.hasOwn(value, "expectedPrincipal") ? ["expectedPrincipal"] : []),
        ]) &&
        isTokenHash(value.currentRefreshTokenHash) &&
        isNonNegativeSafeInteger(value.now) &&
        (!Object.hasOwn(value, "expectedPrincipal") || isPrincipal(value.expectedPrincipal))
      );
    case "authority.session-revoke":
      return (
        hasExactKeys(value, ["type", "requestId", "accessTokenHash", "now"]) &&
        isTokenHash(value.accessTokenHash) &&
        isNonNegativeSafeInteger(value.now)
      );
    case "authority.execute-human":
      return (
        hasExactKeys(value, ["type", "requestId", "context", "command", "now"]) &&
        isAuthenticatedCommandContext(value.context) &&
        isHumanCommand(value.command) &&
        isNonNegativeSafeInteger(value.now)
      );
    default:
      return false;
  }
}

export function isAuthorityWorkerResponse(
  value: unknown,
): value is AuthorityWorkerResponse {
  if (!isRecord(value) || !hasRequestId(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "authority.ready":
    case "authority.schema":
      return (
        hasExactKeys(value, ["type", "requestId", "schemaVersion"]) &&
        value.schemaVersion === 3
      );
    case "authority.closed":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.actors-registered":
      return (
        hasExactKeys(value, ["type", "requestId", "actorCount"]) &&
        isNonNegativeSafeInteger(value.actorCount)
      );
    case "authority.session-issued":
      return (
        hasExactKeys(value, ["type", "requestId", "session"]) &&
        isIssuedSessionRecord(value.session)
      );
    case "authority.session-authenticated":
      return (
        hasExactKeys(value, ["type", "requestId", "context"]) &&
        isAuthenticatedSessionContext(value.context)
      );
    case "authority.session-rotated":
      return (
        hasExactKeys(value, ["type", "requestId", "session"]) &&
        isIssuedSessionRecord(value.session)
      );
    case "authority.session-refresh-valid":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.session-revoked":
      return hasExactKeys(value, ["type", "requestId"]);
    case "authority.command-acknowledged":
      return (
        hasExactKeys(value, ["type", "requestId", "acknowledgement"]) &&
        isCommandAcknowledgement(value.acknowledgement)
      );
    case "authority.legacy-imported":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "imported",
          "actors",
          "rooms",
          "messages",
        ]) &&
        typeof value.imported === "boolean" &&
        isNonNegativeSafeInteger(value.actors) &&
        isNonNegativeSafeInteger(value.rooms) &&
        isNonNegativeSafeInteger(value.messages)
      );
    case "authority.legacy-import":
      return (
        hasExactKeys(value, [
          "type",
          "requestId",
          "markerVersion",
          "actors",
          "rooms",
          "messages",
          "roomHeadSeq",
          "identityHeadSeq",
        ]) &&
        value.markerVersion === 1 &&
        isNonNegativeSafeInteger(value.actors) &&
        isNonNegativeSafeInteger(value.rooms) &&
        isNonNegativeSafeInteger(value.messages) &&
        isNonNegativeSafeInteger(value.roomHeadSeq) &&
        isNonNegativeSafeInteger(value.identityHeadSeq)
      );
    case "authority.error":
      return (
        hasExactKeys(value, ["type", "requestId", "code", "message"]) &&
        typeof value.code === "string" &&
        value.code.length > 0 &&
        typeof value.message === "string" &&
        value.message.length > 0
      );
    default:
      return false;
  }
}
