import {
  MESSAGE_AUTHORITY_IPC_CHANNELS,
  cloneMessageAuthorityBridgeInput,
  cloneMessageAuthorityCommandReceipt,
  cloneMessageAuthorityHistoryResult,
  cloneMessageRevisionsQueryResult,
  isMessageAuthorityBridgeInput,
  isMessageHistoryV2Query,
  isMessageRecallIntent,
  isMessageReviseIntent,
  isMessageRevisionsQuery,
  isMessageSendV2Intent,
  type MessageAuthorityBridge,
  type MessageAuthorityBridgeInput,
  type MessageHistoryV2Query,
  type MessageRecallIntent,
  type MessageRevisionsQuery,
  type MessageReviseIntent,
  type MessageSendV2Intent,
} from "./contracts.js";

type Listener = (event: unknown, input: unknown) => void;

export interface MessageAuthorityIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
  on(channel: string, listener: Listener): void;
  removeListener(channel: string, listener: Listener): void;
}

export function createMessageAuthorityBridge(
  ipcRenderer: MessageAuthorityIpcRenderer,
): MessageAuthorityBridge {
  return Object.freeze({
    async historyV2(query: MessageHistoryV2Query) {
      if (!isMessageHistoryV2Query(query)) {
        throw new TypeError("Invalid Message Authority history query");
      }
      return cloneMessageAuthorityHistoryResult(
        await ipcRenderer.invoke(MESSAGE_AUTHORITY_IPC_CHANNELS.historyV2, query),
      );
    },
    async revisionsQuery(query: MessageRevisionsQuery) {
      if (!isMessageRevisionsQuery(query)) {
        throw new TypeError("Invalid Message Authority revisions query");
      }
      return cloneMessageRevisionsQueryResult(
        await ipcRenderer.invoke(MESSAGE_AUTHORITY_IPC_CHANNELS.revisionsQuery, query),
      );
    },
    async sendV2(intent: MessageSendV2Intent) {
      if (!isMessageSendV2Intent(intent)) {
        throw new TypeError("Invalid Message Authority send intent");
      }
      return cloneMessageAuthorityCommandReceipt(
        await ipcRenderer.invoke(MESSAGE_AUTHORITY_IPC_CHANNELS.sendV2, intent),
      );
    },
    async revise(intent: MessageReviseIntent) {
      if (!isMessageReviseIntent(intent)) {
        throw new TypeError("Invalid Message Authority revise intent");
      }
      return cloneMessageAuthorityCommandReceipt(
        await ipcRenderer.invoke(MESSAGE_AUTHORITY_IPC_CHANNELS.revise, intent),
      );
    },
    async recall(intent: MessageRecallIntent) {
      if (!isMessageRecallIntent(intent)) {
        throw new TypeError("Invalid Message Authority recall intent");
      }
      return cloneMessageAuthorityCommandReceipt(
        await ipcRenderer.invoke(MESSAGE_AUTHORITY_IPC_CHANNELS.recall, intent),
      );
    },
    onAuthorityInput(listener: (input: MessageAuthorityBridgeInput) => void) {
      if (typeof listener !== "function") {
        throw new TypeError("Message Authority input listener is invalid");
      }
      const wrapped: Listener = (_event, input) => {
        if (!isMessageAuthorityBridgeInput(input)) return;
        listener(cloneMessageAuthorityBridgeInput(input));
      };
      ipcRenderer.on(MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput, wrapped);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput, wrapped);
      };
    },
  });
}
