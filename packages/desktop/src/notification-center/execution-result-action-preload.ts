import {
  NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS,
  cloneNotificationExecutionResultAcknowledgeResult,
  isNotificationExecutionResultAcknowledgeIntent,
  type NotificationExecutionResultAcknowledgeIntent,
  type NotificationExecutionResultActionBridge,
} from "./execution-result-action-contracts.js";

export interface NotificationExecutionResultIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

export function createNotificationExecutionResultActionBridge(
  ipc: NotificationExecutionResultIpcRenderer,
): NotificationExecutionResultActionBridge {
  return Object.freeze({
    async acknowledge(intent: NotificationExecutionResultAcknowledgeIntent) {
      if (!isNotificationExecutionResultAcknowledgeIntent(intent)) {
        throw new TypeError("Invalid notification execution-result acknowledge intent");
      }
      return cloneNotificationExecutionResultAcknowledgeResult(await ipc.invoke(
        NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS.acknowledge,
        intent,
      ));
    },
  });
}
