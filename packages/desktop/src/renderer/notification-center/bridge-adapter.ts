import {
  isNotificationReadAck,
  type NotificationReadAck,
} from "@native-im/core";
import type { NotificationCenterRemoteState } from "./view-model.js";

export type NotificationReadCommand = Readonly<{
  requestId: string;
  notificationId: string;
  expectedReadRevision: number;
}>;
export interface NotificationReadAuthorityPort {
  markRead(command: NotificationReadCommand): Promise<unknown>;
}
export type NotificationReadSubmission =
  | Readonly<{ status: "blocked"; reason: "offline" | "repairing" | "repair_failed" | "archived" |
      "revoked" | "not_found" | "already_read" | "stale_revision" }>
  | Readonly<{ status: "acknowledged"; ack: NotificationReadAck }>;

export interface NotificationCenterBridge {
  update(state: NotificationCenterRemoteState): void;
  markRead(notificationId: string, expectedReadRevision: number): Promise<NotificationReadSubmission>;
}

export function createNotificationCenterBridge(input: Readonly<{
  initialState: NotificationCenterRemoteState;
  authority: NotificationReadAuthorityPort;
  createRequestId(): string;
}>): NotificationCenterBridge {
  let state = input.initialState;
  return Object.freeze({
    update(next: NotificationCenterRemoteState): void { state = next; },
    async markRead(notificationId: string, expectedReadRevision: number): Promise<NotificationReadSubmission> {
      if (state.status === "revoked" || state.status === "loading") {
        return { status: "blocked", reason: state.status === "revoked" ? "revoked" : "not_found" };
      }
      const notification = state.notifications.find((value) => value.notificationId === notificationId);
      if (notification === undefined) return { status: "blocked", reason: "not_found" };
      if (state.connection.status !== "online") {
        if (state.connection.status !== "archived" ||
            state.connection.roomIds.includes(notification.roomId)) {
          return { status: "blocked", reason: state.connection.status === "offline" ? "offline"
            : state.connection.status === "repairing" ? "repairing"
            : state.connection.status === "repair_failed" ? "repair_failed" : "archived" };
        }
      }
      if (notification.readAt !== null) return { status: "blocked", reason: "already_read" };
      if (notification.readRevision !== expectedReadRevision) {
        return { status: "blocked", reason: "stale_revision" };
      }
      const requestId = input.createRequestId();
      const result = await input.authority.markRead({ requestId, notificationId, expectedReadRevision });
      if (!isNotificationReadAck(result) || result.requestId !== requestId ||
          result.notificationId !== notificationId ||
          result.recipientActorId !== state.recipientActorId || result.roomId !== notification.roomId ||
          result.readRevision <= expectedReadRevision) {
        throw new TypeError("Notification read authority returned a mismatched closed ACK");
      }
      return Object.freeze({ status: "acknowledged", ack: result });
    },
  });
}
