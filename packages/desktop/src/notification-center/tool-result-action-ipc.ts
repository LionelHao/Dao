import { isNotificationClosedError, type NotificationClosedError } from "./contracts.js";
import {
  NOTIFICATION_TOOL_RESULT_IPC_CHANNELS,
  cloneNotificationToolResultAcknowledgeResult,
  isNotificationToolResultAcknowledgeIntent,
  type NotificationToolResultAcknowledgeIntent,
  type NotificationToolResultAcknowledgeResult,
} from "./tool-result-action-contracts.js";

interface NotificationToolResultActionIpcEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}
export interface NotificationToolResultActionIpcMain {
  handle(channel: string, handler: (
    event: NotificationToolResultActionIpcEvent,
    ...args: unknown[]
  ) => unknown): void;
  removeHandler(channel: string): void;
}
export interface NotificationToolResultActionIpcWebContents {
  readonly mainFrame: unknown;
}

export class NotificationToolResultActionIpcError extends Error {
  readonly notificationError: NotificationClosedError;
  constructor(error: NotificationClosedError) {
    super(`Notification tool-result acknowledge failed: ${error.status} ${error.code}`);
    this.name = "NotificationToolResultActionIpcError";
    this.notificationError = structuredClone(error);
  }
}

function sanitize(error: unknown): never {
  if (typeof error === "object" && error !== null && "notificationError" in error &&
      isNotificationClosedError(error.notificationError)) {
    throw new NotificationToolResultActionIpcError(error.notificationError);
  }
  throw new NotificationToolResultActionIpcError({ status: 503, code: "storage_unavailable" });
}

export function registerNotificationToolResultActionIpc(options: Readonly<{
  ipcMain: NotificationToolResultActionIpcMain;
  webContents: NotificationToolResultActionIpcWebContents;
  runtime: Readonly<{ acknowledge(intent: NotificationToolResultAcknowledgeIntent):
    Promise<NotificationToolResultAcknowledgeResult> }>;
}>): () => void {
  options.ipcMain.handle(NOTIFICATION_TOOL_RESULT_IPC_CHANNELS.acknowledge, async (event, ...args) => {
    if (event.sender !== options.webContents || event.senderFrame !== options.webContents.mainFrame) {
      throw new TypeError("Notification tool-result action IPC requires the trusted main frame");
    }
    if (args.length !== 1 || !isNotificationToolResultAcknowledgeIntent(args[0])) {
      throw new TypeError("Invalid notification tool-result acknowledge intent");
    }
    try {
      return cloneNotificationToolResultAcknowledgeResult(
        await options.runtime.acknowledge(args[0]),
      );
    } catch (error) {
      sanitize(error);
    }
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    options.ipcMain.removeHandler(NOTIFICATION_TOOL_RESULT_IPC_CHANNELS.acknowledge);
  };
}
