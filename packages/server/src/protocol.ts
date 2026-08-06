import { isMessage, type Message, type MessageAcceptedAck } from "@native-im/core";
import type { MessageErrorCode } from "./service.js";

export interface MessageSendFrame {
  readonly type: "message.send";
  readonly requestId: string;
  readonly message: Message;
}

export interface RoomSubscribeFrame {
  readonly type: "room.subscribe";
  readonly requestId: string;
  readonly roomId: string;
}

export type ClientFrame = MessageSendFrame | RoomSubscribeFrame;

export interface MessageCreatedFrame {
  readonly type: "message.created";
  readonly message: Message;
}

export interface MessageHistoryFrame {
  readonly type: "message.history";
  readonly requestId: string;
  readonly roomId: string;
  readonly messages: readonly Message[];
}

export type ProtocolErrorCode = MessageErrorCode | "internal_error" | "invalid_request";

export interface ProtocolErrorFrame {
  readonly type: "error";
  readonly code: ProtocolErrorCode;
  readonly message: string;
  readonly requestId?: string;
}

export type ServerFrame =
  | MessageAcceptedAck
  | MessageCreatedFrame
  | MessageHistoryFrame
  | ProtocolErrorFrame;

export type ClientFrameParseResult =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly error: ProtocolErrorFrame };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(message: string, requestId?: string): ProtocolErrorFrame {
  if (requestId === undefined) {
    return { type: "error", code: "invalid_request", message };
  }

  return { type: "error", code: "invalid_request", message, requestId };
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

  const requestId = typeof value.requestId === "string" ? value.requestId : undefined;
  if (value.type === "message.send") {
    if (requestId === undefined || !isMessage(value.message)) {
      return {
        ok: false,
        error: protocolError("message.send requires a string requestId and valid message", requestId),
      };
    }

    return {
      ok: true,
      frame: { type: "message.send", requestId, message: value.message },
    };
  }

  if (value.type === "room.subscribe") {
    if (requestId === undefined || typeof value.roomId !== "string") {
      return {
        ok: false,
        error: protocolError("room.subscribe requires string requestId and roomId", requestId),
      };
    }

    return {
      ok: true,
      frame: { type: "room.subscribe", requestId, roomId: value.roomId },
    };
  }

  return { ok: false, error: protocolError("Unknown request type", requestId) };
}
