import type { OutboxDelivery } from "../persistence/contracts.js";
import type {
  NotificationAuthorityOperation,
  NotificationAuthorityResult,
} from "./authority-protocol.js";

export type NotificationRecallRecoveryAuthority = Readonly<{
  execute(operation: NotificationAuthorityOperation): Promise<NotificationAuthorityResult>;
}>;

/**
 * Uses the durable pending recall delivery as the recovery marker. A poll that appended any
 * missing revoke events is deferred so recall is sent only after a later clean-tail observation.
 */
export function createNotificationRecallOutboxPreparation(
  authority: NotificationRecallRecoveryAuthority,
): (delivery: OutboxDelivery) => Promise<"ready" | "deferred"> {
  return async (delivery) => {
    if (delivery.targetKind !== "room" ||
        delivery.event.type !== "room.message.recalled") return "ready";
    const sourceId = delivery.event.payload.id;
    if (typeof sourceId !== "string" || sourceId.length === 0) {
      throw new TypeError("Recalled message outbox payload was invalid");
    }
    const result = await authority.execute({
      type: "notification.recover-source-revocations",
      roomId: delivery.targetId,
      sourceKind: "message_mention",
      sourceId,
      limit: 256,
    });
    if (result.kind !== "source-revocations-recovered") {
      throw new Error("Notification source revocation recovery returned a closed failure");
    }
    return result.hasMore || result.recoveredCount > 0 ? "deferred" : "ready";
  };
}
