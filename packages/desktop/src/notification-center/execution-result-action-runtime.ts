import type { IdentityAuthoritySession } from "../identity/controller.js";
import {
  MessageAuthorityTransportError,
  type MessageAuthorityWireTransport,
} from "../message-authority/websocket-authority.js";
import { isNotificationClosedError, type NotificationClosedError } from "./contracts.js";
import type {
  NotificationExecutionResultAcknowledgeIntent,
  NotificationExecutionResultAcknowledgeResult,
} from "./execution-result-action-contracts.js";

export class NotificationExecutionResultActionError extends Error {
  readonly notificationError: NotificationClosedError;
  constructor(error: NotificationClosedError) {
    super(`Notification execution-result acknowledge failed: ${error.status} ${error.code}`);
    this.name = "NotificationExecutionResultActionError";
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

export function createNotificationExecutionResultActionRuntime(options: Readonly<{
  transport: Pick<MessageAuthorityWireTransport, "notificationAcknowledgeExecutionResult">;
  session(): IdentityAuthoritySession | undefined;
  createRequestId(): string;
}>): Readonly<{
  acknowledge(intent: NotificationExecutionResultAcknowledgeIntent):
    Promise<NotificationExecutionResultAcknowledgeResult>;
}> {
  return Object.freeze({
    async acknowledge(intent) {
      const session = options.session();
      if (session === undefined) {
        throw new NotificationExecutionResultActionError({ status: 401,
          code: "authentication_required" });
      }
      const requestId = options.createRequestId();
      try {
        const result = await options.transport.notificationAcknowledgeExecutionResult({
          type: "notification.execution-result.acknowledge", requestId,
          notificationId: intent.notificationId,
        });
        const projection = result.projection;
        if (result.requestId !== requestId || projection.notificationId !== intent.notificationId ||
            projection.recipientActorId !== session.actorId ||
            (projection.notificationKind !== "agent_execution_completed" &&
              projection.notificationKind !== "agent_execution_failed") ||
            projection.source.sourceKind !== "agent_execution" || !projection.handled ||
            projection.handledAt === null) {
          throw new MessageAuthorityTransportError("protocol_error");
        }
        return Object.freeze({ notificationId: intent.notificationId, outcome: result.outcome });
      } catch (error) {
        throw new NotificationExecutionResultActionError(closedError(error));
      }
    },
  });
}
