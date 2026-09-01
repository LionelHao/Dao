import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  MessageAuthorityTransportError,
  type MessageAuthorityWireTransport,
} from "../message-authority/websocket-authority.js";
import { isNotificationClosedError, type NotificationClosedError } from "./contracts.js";
import type {
  NotificationToolResultAcknowledgeIntent,
  NotificationToolResultAcknowledgeResult,
} from "./tool-result-action-contracts.js";

export class NotificationToolResultActionError extends Error {
  readonly notificationError: NotificationClosedError;
  constructor(error: NotificationClosedError) {
    super(`Notification tool-result acknowledge failed: ${error.status} ${error.code}`);
    this.name = "NotificationToolResultActionError";
    this.notificationError = structuredClone(error);
  }
}

function closedError(error: unknown): NotificationClosedError {
  if (error instanceof MessageAuthorityTransportError && error.notificationError !== undefined) {
    return error.notificationError;
  }
  if (typeof error === "object" && error !== null && "notificationError" in error &&
      isNotificationClosedError(error.notificationError)) return structuredClone(error.notificationError);
  if (error instanceof MessageAuthorityTransportError &&
      (error.code === "authentication_required" || error.code === "session_revoked")) {
    return { status: 401, code: "authentication_required" };
  }
  if (error instanceof MessageAuthorityTransportError && error.code === "access_revoked") {
    return { status: 403, code: "notification_forbidden" };
  }
  return { status: 503, code: "storage_unavailable" };
}

export function createNotificationToolResultActionRuntime(options: Readonly<{
  transport: Pick<MessageAuthorityWireTransport, "notificationAcknowledgeToolResult">;
  session(): IdentityAuthoritySession | undefined;
  createRequestId(): string;
}>): Readonly<{
  acknowledge(intent: NotificationToolResultAcknowledgeIntent):
    Promise<NotificationToolResultAcknowledgeResult>;
}> {
  return Object.freeze({
    async acknowledge(intent) {
      const session = options.session();
      if (session === undefined) {
        throw new NotificationToolResultActionError({ status: 401, code: "authentication_required" });
      }
      const requestId = options.createRequestId();
      try {
        const result = await options.transport.notificationAcknowledgeToolResult({
          type: "notification.tool-result.acknowledge", requestId,
          notificationId: intent.notificationId,
        });
        if (result.requestId !== requestId || result.projection.notificationId !== intent.notificationId ||
            result.projection.recipientActorId !== session.actorId ||
            result.projection.notificationKind !== "tool_result" || !result.projection.handled ||
            result.projection.handledAt === null) {
          throw new MessageAuthorityTransportError("protocol_error");
        }
        return Object.freeze({ notificationId: intent.notificationId, outcome: result.outcome });
      } catch (error) {
        throw new NotificationToolResultActionError(closedError(error));
      }
    },
  });
}
