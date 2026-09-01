import { isNotificationClosedError, type NotificationClosedError } from "./contracts.js";
import {
  NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS,
  cloneNotificationExecutionResultAcknowledgeResult,
  isNotificationExecutionResultAcknowledgeIntent,
  type NotificationExecutionResultAcknowledgeIntent,
  type NotificationExecutionResultAcknowledgeResult,
} from "./execution-result-action-contracts.js";

interface IpcEvent { readonly sender: unknown; readonly senderFrame: unknown }
export interface NotificationExecutionResultIpcMain {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}
export interface NotificationExecutionResultWebContents { readonly mainFrame: unknown }

export class NotificationExecutionResultIpcError extends Error {
  readonly notificationError: NotificationClosedError;
  constructor(error: NotificationClosedError) {
    super(`Notification execution-result acknowledge failed: ${error.status} ${error.code}`);
    this.name = "NotificationExecutionResultIpcError";
    this.notificationError = structuredClone(error);
  }
}

function sanitize(error: unknown): never {
  if (typeof error === "object" && error !== null && "notificationError" in error &&
      isNotificationClosedError(error.notificationError)) {
    throw new NotificationExecutionResultIpcError(error.notificationError);
  }
  throw new NotificationExecutionResultIpcError({ status: 503, code: "storage_unavailable" });
}

export function registerNotificationExecutionResultActionIpc(options: Readonly<{
  ipcMain: NotificationExecutionResultIpcMain;
  webContents: NotificationExecutionResultWebContents;
  runtime: Readonly<{ acknowledge(intent: NotificationExecutionResultAcknowledgeIntent):
    Promise<NotificationExecutionResultAcknowledgeResult> }>;
}>): () => void {
  options.ipcMain.handle(NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS.acknowledge,
    async (event, ...args) => {
      if (event.sender !== options.webContents || event.senderFrame !== options.webContents.mainFrame) {
        throw new TypeError("Notification execution-result IPC requires the trusted main frame");
      }
      if (args.length !== 1 || !isNotificationExecutionResultAcknowledgeIntent(args[0])) {
        throw new TypeError("Invalid notification execution-result acknowledge intent");
      }
      try {
        return cloneNotificationExecutionResultAcknowledgeResult(
          await options.runtime.acknowledge(args[0]),
        );
      } catch (error) { sanitize(error); }
    });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    options.ipcMain.removeHandler(NOTIFICATION_EXECUTION_RESULT_IPC_CHANNELS.acknowledge);
  };
}
