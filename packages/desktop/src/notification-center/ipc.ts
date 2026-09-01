import {
  NOTIFICATION_CENTER_IPC_CHANNELS,
  cloneNotificationCenterRemoteState,
  cloneNotificationSourceResolution,
  isNotificationListQuery,
  isNotificationMarkReadIntent,
  isNotificationResolveSourceIntent,
  type NotificationCenterBridge,
} from "./contracts.js";

interface NotificationCenterIpcEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface NotificationCenterIpcMain {
  handle(channel: string,
    handler: (event: NotificationCenterIpcEvent, ...args: readonly unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface NotificationCenterIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, input: unknown): void;
}

function trust(event: NotificationCenterIpcEvent, webContents: NotificationCenterIpcWebContents): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Notification Center IPC requires the trusted main frame");
  }
}

export function registerNotificationCenterIpc(options: Readonly<{
  ipcMain: NotificationCenterIpcMain;
  webContents: NotificationCenterIpcWebContents;
  runtime: NotificationCenterBridge;
}>): () => void {
  const noArguments = (event: NotificationCenterIpcEvent, args: readonly unknown[]): void => {
    trust(event, options.webContents);
    if (args.length !== 0) throw new TypeError("Notification Center IPC rejected arguments");
  };
  options.ipcMain.handle(NOTIFICATION_CENTER_IPC_CHANNELS.getState, async (event, ...args) => {
    noArguments(event, args);
    return cloneNotificationCenterRemoteState(await options.runtime.getState());
  });
  options.ipcMain.handle(NOTIFICATION_CENTER_IPC_CHANNELS.list, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isNotificationListQuery(args[0])) {
      throw new TypeError("Invalid notification list query");
    }
    return cloneNotificationCenterRemoteState(await options.runtime.list(args[0]));
  });
  options.ipcMain.handle(NOTIFICATION_CENTER_IPC_CHANNELS.markRead, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isNotificationMarkReadIntent(args[0])) {
      throw new TypeError("Invalid notification read intent");
    }
    return cloneNotificationCenterRemoteState(await options.runtime.markRead(args[0]));
  });
  options.ipcMain.handle(NOTIFICATION_CENTER_IPC_CHANNELS.resolveSource, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isNotificationResolveSourceIntent(args[0])) {
      throw new TypeError("Invalid notification source intent");
    }
    return cloneNotificationSourceResolution(await options.runtime.resolveSource(args[0]));
  });
  options.ipcMain.handle(NOTIFICATION_CENTER_IPC_CHANNELS.retryRepair, async (event, ...args) => {
    noArguments(event, args);
    return cloneNotificationCenterRemoteState(await options.runtime.retryRepair());
  });
  const unsubscribe = options.runtime.onStateChanged((state) => {
    if (!options.webContents.isDestroyed()) {
      options.webContents.send(NOTIFICATION_CENTER_IPC_CHANNELS.stateChanged,
        cloneNotificationCenterRemoteState(state));
    }
  });
  const channels = [
    NOTIFICATION_CENTER_IPC_CHANNELS.getState,
    NOTIFICATION_CENTER_IPC_CHANNELS.list,
    NOTIFICATION_CENTER_IPC_CHANNELS.markRead,
    NOTIFICATION_CENTER_IPC_CHANNELS.resolveSource,
    NOTIFICATION_CENTER_IPC_CHANNELS.retryRepair,
  ] as const;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    for (const channel of channels) options.ipcMain.removeHandler(channel);
  };
}
