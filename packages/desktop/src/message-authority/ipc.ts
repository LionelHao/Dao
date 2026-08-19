import type { MessageAuthorityController } from "./controller.js";
import {
  MESSAGE_AUTHORITY_IPC_CHANNELS,
  cloneMessageAuthorityBridgeInput,
  cloneMessageAuthorityCommandReceipt,
  cloneMessageAuthorityHistoryResult,
  cloneMessageRevisionsQueryResult,
  isMessageHistoryV2Query,
  isMessageRecallIntent,
  isMessageReviseIntent,
  isMessageRevisionsQuery,
  isMessageSendV2Intent,
} from "./contracts.js";

interface MessageAuthorityIpcEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface MessageAuthorityIpcMain {
  handle(
    channel: string,
    handler: (event: MessageAuthorityIpcEvent, ...args: unknown[]) => unknown,
  ): void;
  removeHandler(channel: string): void;
}

export interface MessageAuthorityIpcWebContents {
  readonly mainFrame: unknown;
  isDestroyed(): boolean;
  send(channel: string, input: unknown): void;
}

function trust(
  event: MessageAuthorityIpcEvent,
  webContents: MessageAuthorityIpcWebContents,
): void {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
    throw new TypeError("Message Authority IPC requires the trusted main frame");
  }
}

export function registerMessageAuthorityIpc(options: {
  readonly ipcMain: MessageAuthorityIpcMain;
  readonly webContents: MessageAuthorityIpcWebContents;
  readonly controller: Pick<
    MessageAuthorityController,
    "historyV2" | "revisionsQuery" | "sendV2" | "revise" | "recall" | "subscribe"
  >;
}): () => void {
  options.ipcMain.handle(MESSAGE_AUTHORITY_IPC_CHANNELS.historyV2, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isMessageHistoryV2Query(args[0])) {
      throw new TypeError("Invalid Message Authority history query");
    }
    return cloneMessageAuthorityHistoryResult(await options.controller.historyV2(args[0]));
  });
  options.ipcMain.handle(MESSAGE_AUTHORITY_IPC_CHANNELS.revisionsQuery, async (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isMessageRevisionsQuery(args[0])) {
      throw new TypeError("Invalid Message Authority revisions query");
    }
    return cloneMessageRevisionsQueryResult(await options.controller.revisionsQuery(args[0]));
  });
  options.ipcMain.handle(MESSAGE_AUTHORITY_IPC_CHANNELS.sendV2, (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isMessageSendV2Intent(args[0])) {
      throw new TypeError("Invalid Message Authority send intent");
    }
    return cloneMessageAuthorityCommandReceipt(options.controller.sendV2(args[0]));
  });
  options.ipcMain.handle(MESSAGE_AUTHORITY_IPC_CHANNELS.revise, (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isMessageReviseIntent(args[0])) {
      throw new TypeError("Invalid Message Authority revise intent");
    }
    return cloneMessageAuthorityCommandReceipt(options.controller.revise(args[0]));
  });
  options.ipcMain.handle(MESSAGE_AUTHORITY_IPC_CHANNELS.recall, (event, ...args) => {
    trust(event, options.webContents);
    if (args.length !== 1 || !isMessageRecallIntent(args[0])) {
      throw new TypeError("Invalid Message Authority recall intent");
    }
    return cloneMessageAuthorityCommandReceipt(options.controller.recall(args[0]));
  });

  const unsubscribe = options.controller.subscribe((input) => {
    if (options.webContents.isDestroyed()) return;
    options.webContents.send(
      MESSAGE_AUTHORITY_IPC_CHANNELS.authorityInput,
      cloneMessageAuthorityBridgeInput(input),
    );
  });
  const channels = [
    MESSAGE_AUTHORITY_IPC_CHANNELS.historyV2,
    MESSAGE_AUTHORITY_IPC_CHANNELS.revisionsQuery,
    MESSAGE_AUTHORITY_IPC_CHANNELS.sendV2,
    MESSAGE_AUTHORITY_IPC_CHANNELS.revise,
    MESSAGE_AUTHORITY_IPC_CHANNELS.recall,
  ] as const;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    for (const channel of channels) options.ipcMain.removeHandler(channel);
  };
}
