import { AGENT_SETTINGS_IPC } from "./ipc.js";
import { isAgentSettingsAuthorityMessage, isAgentSettingsMutationIntent, isAgentSettingsSnapshot,
  type AgentSettingsBridge } from "./contracts.js";
export function createAgentSettingsBridge(ipc: { invoke(c:string,v:unknown):Promise<unknown>;
  on(c:string,l:(e:unknown,v:unknown)=>void):void; removeListener(c:string,l:(e:unknown,v:unknown)=>void):void }): AgentSettingsBridge {
  return Object.freeze({
    async getSnapshot(input: Parameters<AgentSettingsBridge["getSnapshot"]>[0]) { const value = await ipc.invoke(AGENT_SETTINGS_IPC.get, input);
      if (!isAgentSettingsSnapshot(value)) throw new TypeError("Invalid Agent Settings snapshot"); return structuredClone(value); },
    async submit(input: Parameters<AgentSettingsBridge["submit"]>[0]) { if (!isAgentSettingsMutationIntent(input.intent)) throw new TypeError("Invalid Agent Settings mutation");
      const value = await ipc.invoke(AGENT_SETTINGS_IPC.submit, input);
      if (!isAgentSettingsAuthorityMessage(value)) throw new TypeError("Invalid Agent Settings response"); return structuredClone(value); },
    onAuthorityMessage(listener: Parameters<AgentSettingsBridge["onAuthorityMessage"]>[0]) { const wrapped = (_e:unknown,v:unknown) => { if (isAgentSettingsAuthorityMessage(v)) listener(structuredClone(v)); };
      ipc.on(AGENT_SETTINGS_IPC.changed, wrapped); return () => ipc.removeListener(AGENT_SETTINGS_IPC.changed, wrapped); },
  });
}
