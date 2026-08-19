import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
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
        invalidate: () => governance?.invalidateAuthorizedState(),
      },
    });
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
    window.once("closed", () => {
      disposeGovernanceIpc?.();
      identity?.close();
      governance?.close();
    });

    await Promise.all([window.loadFile(rendererPath), identity.initialize()]);
    const startupProbeJson = await window.webContents.executeJavaScript(
      `JSON.stringify({
        identityMethods: Object.keys(globalThis.dao?.identity ?? {}).sort(),
        governanceMethods: Object.keys(globalThis.dao?.governance ?? {}).sort(),
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
        ) || !("namespaces" in startupProbe) || !Array.isArray(startupProbe.namespaces) ||
        startupProbe.namespaces.join(",") !== "governance,identity" ||
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
    identity?.close();
    governance?.close();
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
