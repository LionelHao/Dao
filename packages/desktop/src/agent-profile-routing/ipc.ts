import { isAgentSettingsAuthorityMessage, isAgentSettingsMutationIntent, isAgentSettingsSnapshot,
  type AgentSettingsBridge } from "./contracts.js";
export const AGENT_SETTINGS_IPC = Object.freeze({ get: "agent-settings:get", submit: "agent-settings:submit",
  changed: "agent-settings:changed" });
export function registerAgentSettingsIpc(options: { ipcMain: { handle(c:string,h:(e:unknown,...a:unknown[])=>unknown):void;
  removeHandler(c:string):void }; webContents: { mainFrame: unknown; isDestroyed():boolean; send(c:string,v:unknown):void };
  runtime: AgentSettingsBridge }): () => void {
  const trust = (event: unknown) => { if ((event as { senderFrame?: unknown }).senderFrame !== options.webContents.mainFrame)
    throw new TypeError("Agent Settings IPC requires trusted main frame"); };
  options.ipcMain.handle(AGENT_SETTINGS_IPC.get, async (event, value) => { trust(event);
    if (typeof value !== "object" || value === null || Object.keys(value).join() !== "roomId") throw new TypeError("Invalid query");
    const result = await options.runtime.getSnapshot(value as { roomId: string });
    if (!isAgentSettingsSnapshot(result)) throw new TypeError("Invalid snapshot"); return structuredClone(result); });
  options.ipcMain.handle(AGENT_SETTINGS_IPC.submit, async (event, value) => { trust(event);
    const input = value as { requestId?: unknown; intent?: unknown };
    if (typeof input?.requestId !== "string" || !isAgentSettingsMutationIntent(input.intent)) throw new TypeError("Invalid mutation");
    return structuredClone(await options.runtime.submit(input as never)); });
  const unsubscribe = options.runtime.onAuthorityMessage((value) => {
    if (!options.webContents.isDestroyed() && isAgentSettingsAuthorityMessage(value))
      options.webContents.send(AGENT_SETTINGS_IPC.changed, structuredClone(value));
  });
  return () => { unsubscribe(); options.ipcMain.removeHandler(AGENT_SETTINGS_IPC.get);
    options.ipcMain.removeHandler(AGENT_SETTINGS_IPC.submit); };
}
