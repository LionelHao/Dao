import {
  isMessageDraft,
  type Message,
  type MessageAcceptedAck,
  type MessageDraft,
  type PersistedIdentityEvent,
  type PersistedRoomEvent,
} from "@native-im/core";
import type { AuthenticationErrorCode } from "./auth.js";
import type { MessageErrorCode } from "./service.js";
import type { MessageStoreErrorCode } from "./store.js";

const AUTH_LOGIN_FIELDS = new Set(["type", "requestId", "accountId", "secret"]);
const AUTH_RESUME_FIELDS = new Set(["type", "requestId", "accessToken"]);
const AUTH_REFRESH_FIELDS = new Set(["type", "requestId", "refreshToken"]);
const AUTH_REVOKE_FIELDS = new Set(["type", "requestId"]);
const MESSAGE_SEND_FIELDS = new Set(["type", "requestId", "message"]);
const ROOM_FIELDS = new Set(["type", "requestId", "roomId"]);
const MESSAGE_DRAFT_FIELDS = new Set(["id", "roomId", "body", "sentAt"]);

export const PROTOCOL_FIELD_LIMITS = Object.freeze({
  requestId: 128,
  accountId: 256,
  secret: 4_096,
  token: 4_096,
  roomId: 256,
  messageId: 256,
  body: 32 * 1_024,
  sentAt: 64,
});

export interface AuthLoginFrame {
  readonly type: "auth.login";
  readonly requestId: string;
  readonly accountId: string;
  readonly secret: string;
}

export interface AuthResumeFrame {
  readonly type: "auth.resume";
  readonly requestId: string;
  readonly accessToken: string;
}

export interface AuthRefreshFrame {
  readonly type: "auth.refresh";
  readonly requestId: string;
  readonly refreshToken: string;
}

export interface AuthRevokeFrame {
  readonly type: "auth.revoke";
  readonly requestId: string;
}

export interface MessageSendFrame {
  readonly type: "message.send";
  readonly requestId: string;
  readonly message: MessageDraft;
}

export interface RoomHistoryRequestFrame {
  readonly type: "room.history";
  readonly requestId: string;
  readonly roomId: string;
}

export interface RoomSubscribeFrame {
  readonly type: "room.subscribe";
  readonly requestId: string;
  readonly roomId: string;
}

export type ClientFrame =
  | AuthLoginFrame
  | AuthResumeFrame
  | AuthRefreshFrame
  | AuthRevokeFrame
  | MessageSendFrame
  | RoomHistoryRequestFrame
  | RoomSubscribeFrame;

export interface AuthenticatedFrame {
  readonly type: "auth.authenticated";
  readonly requestId: string;
  readonly accountId: string;
  readonly actorId: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly refreshExpiresAt?: string;
}

export interface AuthRevokedFrame {
  readonly type: "auth.revoked";
  readonly requestId: string;
}

export interface MessageCreatedFrame {
  readonly type: "message.created";
  readonly message: Message;
}

export interface RoomEventFrame {
  readonly type: "room.event";
  readonly event: Exclude<PersistedRoomEvent, { readonly type: "room.message.accepted" }>;
}

export type IdentityRoomAccessChangedFrame = Extract<
  PersistedIdentityEvent,
  { readonly type: "identity.room-access.changed" }
>;

export interface AuthSessionRevokedFrame {
  readonly type: "auth.session-revoked";
  readonly eventId: string;
}

export interface RoomHistoryFrame {
  readonly type: "room.history";
  readonly requestId: string;
  readonly roomId: string;
  readonly messages: readonly Message[];
}

export interface RoomSubscribedFrame {
  readonly type: "room.subscribed";
  readonly requestId: string;
  readonly roomId: string;
}

export type ProtocolErrorCode =
  | AuthenticationErrorCode
  | MessageErrorCode
  | MessageStoreErrorCode
  | "unauthenticated"
  | "room_forbidden"
  | "identity_forbidden"
  | "already_authenticated"
  | "invalid_request"
  | "internal_error";

export interface ProtocolErrorFrame {
  readonly type: "error";
  readonly status: 400 | 401 | 403 | 409 | 500;
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly requestId?: string;
}

export type ServerFrame =
  | AuthenticatedFrame
  | AuthRevokedFrame
  | AuthSessionRevokedFrame
  | MessageAcceptedAck
  | MessageCreatedFrame
  | RoomEventFrame
  | IdentityRoomAccessChangedFrame
  | RoomHistoryFrame
  | RoomSubscribedFrame
  | ProtocolErrorFrame;

export type ClientFrameParseResult =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly error: ProtocolErrorFrame };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: UnknownRecord, fields: ReadonlySet<string>): boolean {
  return (
    Reflect.ownKeys(value).length === fields.size &&
    Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && fields.has(key),
    )
  );
}

function isStrictMessageDraft(value: unknown): value is MessageDraft {
  return (
    isRecord(value) &&
    hasOnlyFields(value, MESSAGE_DRAFT_FIELDS) &&
    isMessageDraft(value) &&
    isBoundedString(value.id, PROTOCOL_FIELD_LIMITS.messageId) &&
    isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId) &&
    isBoundedString(value.body, PROTOCOL_FIELD_LIMITS.body) &&
    isBoundedString(value.sentAt, PROTOCOL_FIELD_LIMITS.sentAt)
  );
}

function protocolError(
  message: string,
  requestId?: string,
  status: ProtocolErrorFrame["status"] = 400,
  code: ProtocolErrorFrame["code"] = "invalid_request",
): ProtocolErrorFrame {
  if (requestId === undefined) {
    return { type: "error", status, code, message };
  }
  return { type: "error", status, code, message, requestId };
}

function isBoundedString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

export function parseClientFrame(raw: string): ClientFrameParseResult {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: protocolError("Request must be valid JSON") };
  }

  if (!isRecord(value)) {
    return { ok: false, error: protocolError("Request must be an object") };
  }

  const requestId = isBoundedString(
    value.requestId,
    PROTOCOL_FIELD_LIMITS.requestId,
  )
    ? value.requestId
    : undefined;
  switch (value.type) {
    case "auth.login":
      if (
        !hasOnlyFields(value, AUTH_LOGIN_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.accountId, PROTOCOL_FIELD_LIMITS.accountId) ||
        !isBoundedString(value.secret, PROTOCOL_FIELD_LIMITS.secret)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.login requires string requestId, accountId, and secret",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "auth.login",
          requestId,
          accountId: value.accountId,
          secret: value.secret,
        },
      };
    case "auth.resume":
      if (
        !hasOnlyFields(value, AUTH_RESUME_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.accessToken, PROTOCOL_FIELD_LIMITS.token)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.resume requires string requestId and accessToken",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "auth.resume",
          requestId,
          accessToken: value.accessToken,
        },
      };
    case "auth.refresh":
      if (
        !hasOnlyFields(value, AUTH_REFRESH_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.refreshToken, PROTOCOL_FIELD_LIMITS.token)
      ) {
        return {
          ok: false,
          error: protocolError(
            "auth.refresh requires string requestId and refreshToken",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: "auth.refresh",
          requestId,
          refreshToken: value.refreshToken,
        },
      };
    case "auth.revoke":
      if (!hasOnlyFields(value, AUTH_REVOKE_FIELDS) || requestId === undefined) {
        return {
          ok: false,
          error: protocolError("auth.revoke requires a string requestId", requestId),
        };
      }
      return { ok: true, frame: { type: "auth.revoke", requestId } };
    case "message.send": {
      if (!hasOnlyFields(value, MESSAGE_SEND_FIELDS) || requestId === undefined) {
        return {
          ok: false,
          error: protocolError(
            "message.send requires a string requestId and message",
            requestId,
          ),
        };
      }
      if (
        isRecord(value.message) &&
        ("authorId" in value.message || "authorKind" in value.message)
      ) {
        return {
          ok: false,
          error: protocolError(
            "Message identity is server-controlled",
            requestId,
            401,
            "identity_forbidden",
          ),
        };
      }
      if (!isStrictMessageDraft(value.message)) {
        return {
          ok: false,
          error: protocolError(
            "message.send requires a strict message draft",
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: { type: "message.send", requestId, message: value.message },
      };
    }
    case "room.history":
    case "room.subscribe":
      if (
        !hasOnlyFields(value, ROOM_FIELDS) ||
        requestId === undefined ||
        !isBoundedString(value.roomId, PROTOCOL_FIELD_LIMITS.roomId)
      ) {
        return {
          ok: false,
          error: protocolError(
            `${value.type} requires string requestId and roomId`,
            requestId,
          ),
        };
      }
      return {
        ok: true,
        frame: {
          type: value.type,
          requestId,
          roomId: value.roomId,
        },
      };
    default:
      return { ok: false, error: protocolError("Unknown request type", requestId) };
  }
}
