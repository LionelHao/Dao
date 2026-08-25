import { contextBridge, ipcRenderer } from "electron";
import { createIdentityBridge } from "./identity/preload-bridge.js";
import { createGovernanceBridge } from "./governance/preload-bridge.js";
import { createMessageAuthorityBridge } from "./message-authority/preload-bridge.js";
import { createAttachmentAuthorityBridge } from "./attachment-authority/preload-bridge.js";
import { createMemoryAuthorityBridge } from "./memory-authority/preload-bridge.js";
import { createAgentSettingsBridge } from "./agent-profile-routing/preload-bridge.js";
import { createInvocationBridge } from "./invocation-runtime/preload-bridge.js";
import { createProjectLoopBridge } from "./project-loop/preload-bridge.js";

const dao = Object.freeze({
  identity: createIdentityBridge(ipcRenderer),
  governance: createGovernanceBridge(ipcRenderer),
  messageAuthority: createMessageAuthorityBridge(ipcRenderer),
  attachmentAuthority: createAttachmentAuthorityBridge(ipcRenderer),
  memoryAuthority: createMemoryAuthorityBridge(ipcRenderer),
  agentSettings: createAgentSettingsBridge(ipcRenderer),
  invocation: createInvocationBridge(ipcRenderer),
  projectLoop: createProjectLoopBridge(ipcRenderer),
});

contextBridge.exposeInMainWorld("dao", dao);
