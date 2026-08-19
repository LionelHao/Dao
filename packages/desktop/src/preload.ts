import { contextBridge, ipcRenderer } from "electron";
import { createIdentityBridge } from "./identity/preload-bridge.js";
import { createGovernanceBridge } from "./governance/preload-bridge.js";
import { createMessageAuthorityBridge } from "./message-authority/preload-bridge.js";
import { createAttachmentAuthorityBridge } from "./attachment-authority/preload-bridge.js";

const dao = Object.freeze({
  identity: createIdentityBridge(ipcRenderer),
  governance: createGovernanceBridge(ipcRenderer),
  messageAuthority: createMessageAuthorityBridge(ipcRenderer),
  attachmentAuthority: createAttachmentAuthorityBridge(ipcRenderer),
});

contextBridge.exposeInMainWorld("dao", dao);
