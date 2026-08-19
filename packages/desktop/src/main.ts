import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  type BrowserWindowConstructorOptions,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { identityPlatformFromNode } from "./identity/device-identity.js";
import { cloneIdentityPublicState } from "./identity/contracts.js";
import {
  createDesktopIdentityRuntime,
  createIdentityDeviceLabel,
  createSafeStorageEncryption,
} from "./identity/runtime.js";
import { installDesktopWindowLifecycle } from "./main-lifecycle.js";
import {
  createDesktopGovernanceRuntime,
} from "./governance/production-runtime.js";
import { registerGovernanceIpc } from "./governance/ipc.js";
import {
  createMessageAuthorityController,
} from "./message-authority/controller.js";
import { registerMessageAuthorityIpc } from "./message-authority/ipc.js";
import { createDesktopMessageAuthorityRuntime } from "./message-authority/production-runtime.js";
import { createDesktopAttachmentAuthorityRuntime } from "./attachment-authority/production-runtime.js";
import {
  createElectronAttachmentPorts,
  type ElectronAttachmentPreviewWindow,
} from "./attachment-authority/electron-production-ports.js";
import { createElectronAttachmentRuntimeHost } from "./attachment-authority/electron-runtime-host.js";
import {
  blankGroupChatWindowOptions,
  installWindowSecurityPolicy,
} from "./window.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<void> {
  const preloadPath = join(currentDirectory, "preload.cjs");
  const rendererPath = join(currentDirectory, "renderer", "index.html");
  const window = new BrowserWindow(blankGroupChatWindowOptions(preloadPath));
  let identity: ReturnType<typeof createDesktopIdentityRuntime> | undefined;
  let governance: ReturnType<typeof createDesktopGovernanceRuntime> | undefined;
  let disposeGovernanceIpc: (() => void) | undefined;
  let messageAuthorityRuntime: ReturnType<
    typeof createDesktopMessageAuthorityRuntime
  > | undefined;
  let messageAuthority: ReturnType<typeof createMessageAuthorityController> | undefined;
  let disposeMessageAuthorityIpc: (() => void) | undefined;
  let disposeAttachmentGovernanceState: (() => void) | undefined;
  const attachmentRuntimeHost = createElectronAttachmentRuntimeHost({
    createRuntime: () => {
      const ports = createElectronAttachmentPorts({
        parentWindow: window,
        dialog: {
          showOpenDialog: (_parent, options) => dialog.showOpenDialog(
            window,
            options as unknown as OpenDialogOptions,
          ),
          showSaveDialog: (_parent, options) => dialog.showSaveDialog(
            window,
            options as unknown as SaveDialogOptions,
          ),
        },
        createPreviewWindow: (options) => new BrowserWindow(
          options as BrowserWindowConstructorOptions,
        ) as unknown as ElectronAttachmentPreviewWindow,
        randomId: randomUUID,
      });
      return createDesktopAttachmentAuthorityRuntime({
        endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
        session: () => identity?.getCurrentAuthoritySession(),
        webSocketFactory: (endpoint) => new WebSocket(endpoint),
        openFileDialog: ports.openFileDialog,
        saveDialog: ports.saveDialog,
        previewHost: ports.previewHost,
        ipcMain,
        webContents: window.webContents,
      });
    },
    onReplacementError: () => {
      console.error("Native IM desktop Attachment Authority replacement failed closed.");
    },
  });

  try {
    installWindowSecurityPolicy(window);
    const identityPlatform = identityPlatformFromNode(process.platform);
    identity = createDesktopIdentityRuntime({
      dataDirectory: app.getPath("userData"),
      deviceLabel: createIdentityDeviceLabel(app.getName(), hostname()),
      platform: identityPlatform,
      endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
      encryption: createSafeStorageEncryption({
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
        encryptString: (plaintext) => safeStorage.encryptString(plaintext),
        decryptString: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext)),
      }, identityPlatform),
      webSocketFactory: (endpoint) => new WebSocket(endpoint),
      ipcMain,
      webContents: window.webContents,
      authorizedState: {
        invalidate: () => {
          governance?.invalidateAuthorizedState();
          messageAuthorityRuntime?.invalidateAuthorizedState();
          attachmentRuntimeHost.invalidateIdentity();
        },
      },
    });
    attachmentRuntimeHost.start();
    governance = createDesktopGovernanceRuntime({
      endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
      session: () => identity?.getCurrentAuthoritySession(),
      webSocketFactory: (endpoint) => new WebSocket(endpoint),
      createRequestIdentity: () => ({
        requestId: `governance-${randomUUID()}`,
        idempotencyKey: randomUUID(),
      }),
    });
    disposeGovernanceIpc = registerGovernanceIpc({
      ipcMain,
      webContents: window.webContents,
      controller: governance.controller,
    });
    disposeAttachmentGovernanceState = governance.controller.subscribe((state) => {
      attachmentRuntimeHost.observeGovernanceState(state);
    });
    messageAuthorityRuntime = createDesktopMessageAuthorityRuntime({
      endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
      session: () => identity?.getCurrentAuthoritySession(),
      webSocketFactory: (endpoint) => new WebSocket(endpoint),
    });
    messageAuthority = createMessageAuthorityController({
      client: messageAuthorityRuntime.client,
      createRequestId: (operation) => `message-${operation}-${randomUUID()}`,
    });
    disposeMessageAuthorityIpc = registerMessageAuthorityIpc({
      ipcMain,
      webContents: window.webContents,
      controller: messageAuthority,
    });
    window.once("closed", () => {
      disposeGovernanceIpc?.();
      disposeMessageAuthorityIpc?.();
      disposeAttachmentGovernanceState?.();
      attachmentRuntimeHost.close();
      identity?.close();
      governance?.close();
      messageAuthority?.close();
      messageAuthorityRuntime?.close();
    });

    await Promise.all([window.loadFile(rendererPath), identity.initialize()]);
    const startupProbeJson = await window.webContents.executeJavaScript(
      `JSON.stringify({
        identityMethods: Object.keys(globalThis.dao?.identity ?? {}).sort(),
        governanceMethods: Object.keys(globalThis.dao?.governance ?? {}).sort(),
        messageAuthorityMethods: Object.keys(globalThis.dao?.messageAuthority ?? {}).sort(),
        attachmentAuthorityMethods: Object.keys(globalThis.dao?.attachmentAuthority ?? {}).sort(),
        namespaces: Object.keys(globalThis.dao ?? {}).sort(),
        bridgeMissing: document.querySelector("[data-identity-bridge-missing]") !== null,
        governanceRouteContract: document.querySelector("#app")?.dataset.governanceRouteContract ?? "",
        status: document.querySelector("#app")?.dataset.identityStatus ?? ""
      })`,
      true,
    ) as unknown;
    const expectedIdentityMethods = [
      "getState",
      "login",
      "logout",
      "onStateChanged",
      "refreshSessions",
      "revokeSession",
    ];
    const expectedGovernanceMethods = [
      "getDepartureConflicts",
      "getSurface",
      "onStateChanged",
      "submit",
    ];
    const expectedMessageAuthorityMethods = [
      "historyV2",
      "onAuthorityInput",
      "recall",
      "revise",
      "revisionsQuery",
      "sendV2",
    ];
    const expectedAttachmentAuthorityMethods = [
      "cancel",
      "download",
      "onAuthorityInput",
      "preview",
      "removeSelection",
      "retryProcessing",
      "select",
      "status",
      "upload",
    ];
    let startupProbe: unknown;
    try {
      startupProbe = typeof startupProbeJson === "string"
        ? JSON.parse(startupProbeJson) as unknown
        : undefined;
    } catch {
      startupProbe = undefined;
    }
    if (typeof startupProbe !== "object" || startupProbe === null ||
        !("identityMethods" in startupProbe) || !Array.isArray(startupProbe.identityMethods) ||
        startupProbe.identityMethods.length !== expectedIdentityMethods.length ||
        !startupProbe.identityMethods.every(
          (method, index) => method === expectedIdentityMethods[index],
        ) || !("governanceMethods" in startupProbe) || !Array.isArray(startupProbe.governanceMethods) ||
        startupProbe.governanceMethods.length !== expectedGovernanceMethods.length ||
        !startupProbe.governanceMethods.every(
          (method, index) => method === expectedGovernanceMethods[index],
        ) || !("messageAuthorityMethods" in startupProbe) ||
        !Array.isArray(startupProbe.messageAuthorityMethods) ||
        startupProbe.messageAuthorityMethods.length !== expectedMessageAuthorityMethods.length ||
        !startupProbe.messageAuthorityMethods.every(
          (method, index) => method === expectedMessageAuthorityMethods[index],
        ) || !("attachmentAuthorityMethods" in startupProbe) ||
        !Array.isArray(startupProbe.attachmentAuthorityMethods) ||
        startupProbe.attachmentAuthorityMethods.length !== expectedAttachmentAuthorityMethods.length ||
        !startupProbe.attachmentAuthorityMethods.every(
          (method, index) => method === expectedAttachmentAuthorityMethods[index],
        ) || !("namespaces" in startupProbe) || !Array.isArray(startupProbe.namespaces) ||
        startupProbe.namespaces.join(",") !==
          "attachmentAuthority,governance,identity,messageAuthority" ||
        !("governanceRouteContract" in startupProbe) ||
        startupProbe.governanceRouteContract !== "closed-v1" ||
        !("bridgeMissing" in startupProbe) || startupProbe.bridgeMissing !== false ||
        !("status" in startupProbe) || typeof startupProbe.status !== "string" ||
        startupProbe.status.length === 0) {
      throw new Error("Desktop Identity preload bridge failed its startup contract");
    }
    const roundTripState = cloneIdentityPublicState(
      await window.webContents.executeJavaScript(
        "globalThis.dao.identity.getState()",
        true,
      ) as unknown,
    );
    if (roundTripState.status === "starting" || roundTripState.status === "authenticating" ||
        roundTripState.status === "restoring") {
      throw new Error("Desktop Identity IPC round trip did not reach a finite startup state");
    }
    console.info("Native IM desktop Identity surface started.");
  } catch (error: unknown) {
    disposeGovernanceIpc?.();
    disposeMessageAuthorityIpc?.();
    disposeAttachmentGovernanceState?.();
    attachmentRuntimeHost.close();
    identity?.close();
    governance?.close();
    messageAuthority?.close();
    messageAuthorityRuntime?.close();
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

const windowLifecycle = installDesktopWindowLifecycle({
  platform: process.platform,
  app,
  getWindowCount: () => BrowserWindow.getAllWindows().length,
  createWindow,
  onCreationError: (error) => {
    console.error("Native IM desktop failed to recreate its window.", error);
  },
});

app
  .whenReady()
  .then(windowLifecycle.ensureWindow)
  .catch((error: unknown) => {
    console.error("Native IM desktop failed to start.", error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
