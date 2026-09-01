import {
  NOTIFICATION_CENTER_IPC_CHANNELS,
  cloneNotificationCenterRemoteState,
  cloneNotificationSourceResolution,
  isNotificationCenterRemoteState,
  isNotificationListQuery,
  isNotificationMarkReadIntent,
  isNotificationResolveSourceIntent,
  type NotificationCenterBridge,
  type NotificationListQuery,
  type NotificationMarkReadIntent,
  type NotificationResolveSourceIntent,
} from "./contracts.js";
import type { NotificationCenterRemoteState } from "../renderer/notification-center/view-model.js";

type Listener = (event: unknown, input: unknown) => void;

export interface NotificationCenterIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createNotificationCenterPreloadBridge(
  ipcRenderer: NotificationCenterIpcRenderer,
): NotificationCenterBridge {
  return Object.freeze({
    async getState() {
      return cloneNotificationCenterRemoteState(
        await ipcRenderer.invoke(NOTIFICATION_CENTER_IPC_CHANNELS.getState),
      );
    },
    async list(query: NotificationListQuery) {
      if (!isNotificationListQuery(query)) throw new TypeError("Invalid notification list query");
      return cloneNotificationCenterRemoteState(
        await ipcRenderer.invoke(NOTIFICATION_CENTER_IPC_CHANNELS.list, query),
      );
    },
    async markRead(intent: NotificationMarkReadIntent) {
      if (!isNotificationMarkReadIntent(intent)) throw new TypeError("Invalid notification read intent");
      return cloneNotificationCenterRemoteState(
        await ipcRenderer.invoke(NOTIFICATION_CENTER_IPC_CHANNELS.markRead, intent),
      );
    },
    async resolveSource(intent: NotificationResolveSourceIntent) {
      if (!isNotificationResolveSourceIntent(intent)) {
        throw new TypeError("Invalid notification source intent");
      }
      return cloneNotificationSourceResolution(
        await ipcRenderer.invoke(NOTIFICATION_CENTER_IPC_CHANNELS.resolveSource, intent),
      );
    },
    async retryRepair() {
      return cloneNotificationCenterRemoteState(
        await ipcRenderer.invoke(NOTIFICATION_CENTER_IPC_CHANNELS.retryRepair),
      );
    },
    onStateChanged(listener: (state: NotificationCenterRemoteState) => void) {
      if (typeof listener !== "function") throw new TypeError("Notification state listener is invalid");
      const wrapped: Listener = (_event, input) => {
        if (isNotificationCenterRemoteState(input)) listener(cloneNotificationCenterRemoteState(input));
      };
      ipcRenderer.on(NOTIFICATION_CENTER_IPC_CHANNELS.stateChanged, wrapped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(NOTIFICATION_CENTER_IPC_CHANNELS.stateChanged, wrapped);
      };
    },
  });
}
