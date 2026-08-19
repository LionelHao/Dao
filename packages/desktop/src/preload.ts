import { contextBridge, ipcRenderer } from "electron";
import { createIdentityBridge } from "./identity/preload-bridge.js";
import { createGovernanceBridge } from "./governance/preload-bridge.js";

const dao = Object.freeze({
  identity: createIdentityBridge(ipcRenderer),
  governance: createGovernanceBridge(ipcRenderer),
});

contextBridge.exposeInMainWorld("dao", dao);
