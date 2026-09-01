import {
  NOTIFICATION_TOOL_RESULT_IPC_CHANNELS,
  cloneNotificationToolResultAcknowledgeResult,
  isNotificationToolResultAcknowledgeIntent,
  type NotificationToolResultAcknowledgeIntent,
  type NotificationToolResultActionBridge,
} from "./tool-result-action-contracts.js";

export interface NotificationToolResultActionIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

export function createNotificationToolResultActionBridge(
  ipc: NotificationToolResultActionIpcRenderer,
): NotificationToolResultActionBridge {
  return Object.freeze({
    async acknowledge(intent: NotificationToolResultAcknowledgeIntent) {
      if (!isNotificationToolResultAcknowledgeIntent(intent)) {
        throw new TypeError("Invalid notification tool-result acknowledge intent");
      }
      return cloneNotificationToolResultAcknowledgeResult(await ipc.invoke(
        NOTIFICATION_TOOL_RESULT_IPC_CHANNELS.acknowledge,
        intent,
      ));
    },
  });
}
