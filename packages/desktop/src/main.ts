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
import { createPublicKey, randomUUID } from "node:crypto";
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
import { createDesktopMemoryAuthorityRuntime } from "./memory-authority/production-runtime.js";
import { registerMemoryAuthorityIpc } from "./memory-authority/ipc.js";
import { createDesktopAgentSettingsRuntime } from "./agent-profile-routing/production-runtime.js";
import { registerAgentSettingsIpc } from "./agent-profile-routing/ipc.js";
import { registerInvocationIpc } from "./invocation-runtime/ipc.js";
import { createDesktopProjectLoopRuntime } from "./project-loop/production-runtime.js";
import { registerProjectLoopIpc } from "./project-loop/ipc.js";
import { createDesktopToolSafetyRuntime } from "./tool-safety/production-runtime.js";
import { registerToolSafetyIpc } from "./tool-safety/ipc.js";
import { createDesktopNotificationCenterRuntime } from "./notification-center/production-runtime.js";
import { registerNotificationCenterIpc } from "./notification-center/ipc.js";
import { createNotificationToolResultActionRuntime } from
  "./notification-center/tool-result-action-runtime.js";
import { registerNotificationToolResultActionIpc } from
  "./notification-center/tool-result-action-ipc.js";
import { createNotificationExecutionResultActionRuntime } from
  "./notification-center/execution-result-action-runtime.js";
import { registerNotificationExecutionResultActionIpc } from
  "./notification-center/execution-result-action-ipc.js";
import { createDesktopRoomExportRuntime } from "./room-export/runtime.js";
import { createElectronRoomExportSaveDialog } from "./room-export/electron-ports.js";
import { createRoomExportWebSocketTransport } from "./room-export/websocket-transport.js";
import { registerRoomExportIpc } from "./room-export/ipc.js";
import { createDesktopDiagnosticsRuntime } from "./diagnostics/runtime.js";
import { createDiagnosticsWebSocketTransport } from "./diagnostics/websocket-transport.js";
import { registerDiagnosticsIpc } from "./diagnostics/ipc.js";
import { createEncryptedAuthorityCachePersistence } from "./governance/encrypted-authority-cache.js";
import {
  createRecoverableEncryptedAuthorityGenerationStore,
} from "./governance/encrypted-generation-store.js";
import { createDesktopOfflineReadLeaseVerifier } from "./governance/offline-read-lease.js";
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

function offlineReadLeaseVerificationFromEnvironment() {
  const keyId = process.env.NATIVE_IM_OFFLINE_LEASE_KEY_ID;
  const publicKeySpki = process.env.NATIVE_IM_OFFLINE_LEASE_PUBLIC_KEY_SPKI_BASE64;
  const tenantId = process.env.NATIVE_IM_OFFLINE_LEASE_TENANT_ID;
  const serverSubject = process.env.NATIVE_IM_OFFLINE_LEASE_SERVER_SUBJECT;
  if ([keyId, publicKeySpki, tenantId, serverSubject].every((value) => value === undefined)) {
    return undefined;
  }
  if ([keyId, publicKeySpki, tenantId, serverSubject].some(
    (value) => value === undefined || value.length === 0,
  )) throw new Error("Offline read lease verification configuration is incomplete");
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeySpki!, "base64"),
    format: "der",
    type: "spki",
  });
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Offline read lease verification key must be Ed25519");
  }
  const previousKeyId = process.env.NATIVE_IM_OFFLINE_LEASE_PREVIOUS_KEY_ID;
  const previousPublicKeySpki =
    process.env.NATIVE_IM_OFFLINE_LEASE_PREVIOUS_PUBLIC_KEY_SPKI_BASE64;
  const previousIssuanceCutoff =
    process.env.NATIVE_IM_OFFLINE_LEASE_PREVIOUS_ISSUANCE_CUTOFF_MS;
  const previousVerificationCutoff =
    process.env.NATIVE_IM_OFFLINE_LEASE_PREVIOUS_VERIFICATION_CUTOFF_MS;
  const previousValues = [previousKeyId, previousPublicKeySpki, previousIssuanceCutoff,
    previousVerificationCutoff];
  const previousConfigured = previousValues.some((value) => value !== undefined);
  if (previousConfigured && previousValues.some(
    (value) => value === undefined || value.length === 0,
  )) throw new Error("Offline read lease previous-key configuration is incomplete");
  const verificationKeys = new Map([[keyId!, publicKey]]);
  const previousKeyWindows = new Map<string, {
    issuanceCutoffMs: number;
    verificationCutoffMs: number;
  }>();
  if (previousConfigured) {
    if (previousKeyId === keyId || !/^(0|[1-9][0-9]*)$/u.test(previousIssuanceCutoff!) ||
        !/^(0|[1-9][0-9]*)$/u.test(previousVerificationCutoff!)) {
      throw new Error("Offline read lease previous-key configuration is invalid");
    }
    const issuanceCutoffMs = Number(previousIssuanceCutoff);
    const verificationCutoffMs = Number(previousVerificationCutoff);
    if (!Number.isSafeInteger(issuanceCutoffMs) || !Number.isSafeInteger(verificationCutoffMs) ||
        verificationCutoffMs - issuanceCutoffMs !== 24 * 60 * 60 * 1_000) {
      throw new Error("Offline read lease previous-key overlap must be exactly 24 hours");
    }
    const previousPublicKey = createPublicKey({
      key: Buffer.from(previousPublicKeySpki!, "base64"), format: "der", type: "spki",
    });
    if (previousPublicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Offline read lease previous verification key must be Ed25519");
    }
    verificationKeys.set(previousKeyId!, previousPublicKey);
    previousKeyWindows.set(previousKeyId!, { issuanceCutoffMs, verificationCutoffMs });
  }
  return Object.freeze({
    verifier: createDesktopOfflineReadLeaseVerifier({
      verificationKeys,
      ...(previousConfigured ? { previousKeyWindows } : {}),
    }),
    authority: Object.freeze({ tenantId: tenantId!, serverSubject: serverSubject! }),
  });
}

const currentDirectory = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<void> {
  const preloadPath = join(currentDirectory, "preload.cjs");
  const rendererPath = join(currentDirectory, "renderer", "index.html");
  const window = new BrowserWindow(blankGroupChatWindowOptions(preloadPath));
  let identity: ReturnType<typeof createDesktopIdentityRuntime> | undefined;
  let governance: ReturnType<typeof createDesktopGovernanceRuntime> | undefined;
  let disposeGovernanceIpc: (() => void) | undefined;
  let disposeInvocationIpc: (() => void) | undefined;
  let messageAuthorityRuntime: ReturnType<
    typeof createDesktopMessageAuthorityRuntime
  > | undefined;
  let messageAuthority: ReturnType<typeof createMessageAuthorityController> | undefined;
  let disposeMessageAuthorityIpc: (() => void) | undefined;
  let memoryAuthorityRuntime: ReturnType<typeof createDesktopMemoryAuthorityRuntime> | undefined;
  let disposeMemoryAuthorityIpc: (() => void) | undefined;
  let projectLoop: ReturnType<typeof createDesktopProjectLoopRuntime> | undefined;
  let disposeProjectLoopIpc: (() => void) | undefined;
  let toolSafety: ReturnType<typeof createDesktopToolSafetyRuntime> | undefined;
  let disposeToolSafetyIpc: (() => void) | undefined;
  let disposeAttachmentGovernanceState: (() => void) | undefined;
  let agentSettings: ReturnType<typeof createDesktopAgentSettingsRuntime> | undefined;
  let disposeAgentSettingsIpc: (() => void) | undefined;
  let notificationCenter: ReturnType<typeof createDesktopNotificationCenterRuntime> | undefined;
  let disposeNotificationCenterIpc: (() => void) | undefined;
  let disposeNotificationToolResultIpc: (() => void) | undefined;
  let disposeNotificationExecutionResultIpc: (() => void) | undefined;
  let roomExport: ReturnType<typeof createDesktopRoomExportRuntime> | undefined;
  let disposeRoomExportIpc: (() => void) | undefined;
  let diagnostics: ReturnType<typeof createDesktopDiagnosticsRuntime> | undefined;
  let disposeDiagnosticsIpc: (() => void) | undefined;
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
    const desktopEncryption = createSafeStorageEncryption({
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
      encryptString: (plaintext) => safeStorage.encryptString(plaintext),
      decryptString: (ciphertext) => safeStorage.decryptString(Buffer.from(ciphertext)),
    }, identityPlatform);
    const offlineReadLeaseVerification = offlineReadLeaseVerificationFromEnvironment();
    identity = createDesktopIdentityRuntime({
      dataDirectory: app.getPath("userData"),
      deviceLabel: createIdentityDeviceLabel(app.getName(), hostname()),
      platform: identityPlatform,
      endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
      encryption: desktopEncryption,
      webSocketFactory: (endpoint) => new WebSocket(endpoint),
      ipcMain,
      webContents: window.webContents,
      authorizedState: {
        invalidate: () => {
          toolSafety?.invalidateAuthorizedState();
          governance?.invalidateAuthorizedState();
          agentSettings?.invalidateAuthorizedState();
          messageAuthorityRuntime?.invalidateAuthorizedState();
          memoryAuthorityRuntime?.invalidateAuthorizedState();
          projectLoop?.invalidateAuthorizedState();
          notificationCenter?.invalidateAuthorizedState();
          void roomExport?.invalidateAuthorizedState();
          void diagnostics?.invalidateAuthorizedState();
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
      cachePersistence: createEncryptedAuthorityCachePersistence({
        filePath: join(app.getPath("userData"), "authority-cache.v1.enc"),
        encryption: desktopEncryption,
      }),
      generationStoreFactory: (actorId) => createRecoverableEncryptedAuthorityGenerationStore({
        databasePath: join(app.getPath("userData"), "authority-cache.v2.sqlite"),
        accountId: identity?.getCurrentAuthoritySession()?.accountId ?? (() => {
          void actorId;
          throw new Error("Authority cache account binding is unavailable");
        })(),
        tenantId: offlineReadLeaseVerification?.authority.tenantId ??
          process.env.NATIVE_IM_TENANT_ID ?? "dao-local-tenant",
        encryption: desktopEncryption,
      }),
      ...(offlineReadLeaseVerification === undefined ? {} : {
        offlineReadLeaseVerifier: offlineReadLeaseVerification.verifier,
        offlineReadLeaseAuthority: offlineReadLeaseVerification.authority,
      }),
    });
    disposeGovernanceIpc = registerGovernanceIpc({
      ipcMain,
      webContents: window.webContents,
      controller: governance.controller,
      clearCache: (roomId) => governance!.clearCache(roomId),
    });
    disposeInvocationIpc = registerInvocationIpc({
      ipcMain, webContents: window.webContents, controller: governance.invocations,
    });
    agentSettings = createDesktopAgentSettingsRuntime({
      endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
      session: () => identity?.getCurrentAuthoritySession(),
      webSocketFactory: (endpoint) => new WebSocket(endpoint),
      createRequestIdentity: () => ({ requestId: `agent-settings-${randomUUID()}`,
        idempotencyKey: randomUUID() }),
      async governance(roomId) {
        const state = await governance!.controller.getSurface({ roomId });
        if (state.status !== "ready") return { roomId, roomName: "Room", lifecycle: "active" as const,
          roomRevision: 0, roomRole: null };
        const member = state.projection.members.find((entry) => entry.kind === "human" &&
          entry.actorId === state.viewerActorId);
        const roomRole = state.projection.ownerActorId === state.viewerActorId ? "owner" as const
          : member?.kind === "human" ? member.role : null;
        return { roomId, roomName: state.projection.roomName,
          lifecycle: state.projection.lifecycle, roomRevision: state.projection.governanceRevision,
          roomRole };
      },
    });
    disposeAgentSettingsIpc = registerAgentSettingsIpc({ ipcMain,
      webContents: window.webContents, runtime: agentSettings });
    disposeAttachmentGovernanceState = governance.controller.subscribe((state) => {
      attachmentRuntimeHost.observeGovernanceState(state);
    });
    messageAuthorityRuntime = createDesktopMessageAuthorityRuntime({
      endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
      session: () => identity?.getCurrentAuthoritySession(),
      webSocketFactory: (endpoint) => new WebSocket(endpoint),
    });
    roomExport = createDesktopRoomExportRuntime({
      transport: createRoomExportWebSocketTransport(messageAuthorityRuntime.transport),
      saveDialog: createElectronRoomExportSaveDialog({
        parentWindow: window,
        dialog: { showSaveDialog: (_parent, options) => dialog.showSaveDialog(
          window,
          options as unknown as SaveDialogOptions,
        ) },
      }),
      createRequestId: (operation) => `room-export-${operation}-${randomUUID()}`,
      randomId: randomUUID,
    });
    disposeRoomExportIpc = registerRoomExportIpc({
      ipcMain, webContents: window.webContents, runtime: roomExport,
    });
    diagnostics = createDesktopDiagnosticsRuntime({
      transport: createDiagnosticsWebSocketTransport(messageAuthorityRuntime.transport),
      saveDialog: {
        async chooseDestination(suggestedName) {
          const result = await dialog.showSaveDialog(window, {
            title: "导出无正文诊断包",
            defaultPath: suggestedName,
            filters: [{ name: "NDJSON", extensions: ["ndjson"] }],
          });
          return result.canceled || result.filePath === undefined ? undefined : result.filePath;
        },
      },
      createRequestId: (operation) => `diagnostics-${operation}-${randomUUID()}`,
      randomId: randomUUID,
    });
    disposeDiagnosticsIpc = registerDiagnosticsIpc({
      ipcMain, webContents: window.webContents, runtime: diagnostics,
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
    notificationCenter = createDesktopNotificationCenterRuntime({
      session: () => identity?.getCurrentAuthoritySession(),
      transport: messageAuthorityRuntime.transport,
      cache: governance.cache,
      restoreWorkspace: () => governance!.restoreWorkspace(),
      createRequestId: (operation) => `notification-${operation}-${randomUUID()}`,
    });
    disposeNotificationCenterIpc = registerNotificationCenterIpc({
      ipcMain, webContents: window.webContents, runtime: notificationCenter,
    });
    const notificationToolResult = createNotificationToolResultActionRuntime({
      session: () => identity?.getCurrentAuthoritySession(),
      transport: messageAuthorityRuntime.transport,
      createRequestId: () => `notification-tool-result-${randomUUID()}`,
    });
    disposeNotificationToolResultIpc = registerNotificationToolResultActionIpc({
      ipcMain, webContents: window.webContents, runtime: notificationToolResult,
    });
    const notificationExecutionResult = createNotificationExecutionResultActionRuntime({
      session: () => identity?.getCurrentAuthoritySession(),
      transport: messageAuthorityRuntime.transport,
      createRequestId: () => `notification-execution-result-${randomUUID()}`,
    });
    disposeNotificationExecutionResultIpc = registerNotificationExecutionResultActionIpc({
      ipcMain, webContents: window.webContents, runtime: notificationExecutionResult,
    });
    memoryAuthorityRuntime = createDesktopMemoryAuthorityRuntime({
      endpoint: process.env.NATIVE_IM_IDENTITY_WS_URL ?? "ws://127.0.0.1:8787",
      session: () => identity?.getCurrentAuthoritySession(),
      webSocketFactory: (endpoint) => new WebSocket(endpoint),
    });
    disposeMemoryAuthorityIpc = registerMemoryAuthorityIpc({
      ipcMain,
      webContents: window.webContents,
      runtime: memoryAuthorityRuntime,
    });
    projectLoop = createDesktopProjectLoopRuntime({
      session: () => identity?.getCurrentAuthoritySession(),
      transport: messageAuthorityRuntime.transport,
      authorityCache: governance.cache,
      repairRoom: (roomId) => governance!.repairRoom(roomId),
      restoreAuthorityCache: (actorId) => governance!.restoreCache(actorId),
      createRequestIdentity: () => ({
        requestId: `project-loop-${randomUUID()}`,
        idempotencyKey: randomUUID(),
      }),
    });
    disposeProjectLoopIpc = registerProjectLoopIpc({
      ipcMain,
      webContents: window.webContents,
      runtime: projectLoop,
    });
    toolSafety = createDesktopToolSafetyRuntime({
      session: () => identity?.getCurrentAuthoritySession(),
      transport: messageAuthorityRuntime.transport,
      authorityCache: governance.cache,
      repairRoom: (roomId) => governance!.repairRoom(roomId),
      createRequestId: () => `tool-safety-${randomUUID()}`,
    });
    toolSafety.start();
    disposeToolSafetyIpc = registerToolSafetyIpc({
      ipcMain, webContents: window.webContents, runtime: toolSafety,
    });
    window.once("closed", () => {
      disposeGovernanceIpc?.();
      disposeInvocationIpc?.();
      disposeMessageAuthorityIpc?.();
      disposeMemoryAuthorityIpc?.();
      disposeProjectLoopIpc?.();
      disposeToolSafetyIpc?.();
      disposeAgentSettingsIpc?.();
      disposeNotificationCenterIpc?.();
      disposeNotificationToolResultIpc?.();
      disposeNotificationExecutionResultIpc?.();
      disposeRoomExportIpc?.();
      disposeDiagnosticsIpc?.();
      disposeAttachmentGovernanceState?.();
      attachmentRuntimeHost.close();
      identity?.close();
      governance?.close();
      messageAuthority?.close();
      messageAuthorityRuntime?.close();
      memoryAuthorityRuntime?.close();
      projectLoop?.close();
      toolSafety?.close();
      agentSettings?.close();
      notificationCenter?.close();
      void roomExport?.close();
      void diagnostics?.close();
    });

    await Promise.all([window.loadFile(rendererPath), identity.initialize()]);
    const startupProbeJson = await window.webContents.executeJavaScript(
      `JSON.stringify({
        identityMethods: Object.keys(globalThis.dao?.identity ?? {}).sort(),
        governanceMethods: Object.keys(globalThis.dao?.governance ?? {}).sort(),
        messageAuthorityMethods: Object.keys(globalThis.dao?.messageAuthority ?? {}).sort(),
        attachmentAuthorityMethods: Object.keys(globalThis.dao?.attachmentAuthority ?? {}).sort(),
        memoryAuthorityMethods: Object.keys(globalThis.dao?.memoryAuthority ?? {}).sort(),
        agentSettingsMethods: Object.keys(globalThis.dao?.agentSettings ?? {}).sort(),
        invocationMethods: Object.keys(globalThis.dao?.invocation ?? {}).sort(),
        projectLoopMethods: Object.keys(globalThis.dao?.projectLoop ?? {}).sort(),
        toolSafetyMethods: Object.keys(globalThis.dao?.toolSafety ?? {}).sort(),
        notificationCenterMethods: Object.keys(globalThis.dao?.notificationCenter ?? {}).sort(),
        notificationToolResultMethods: Object.keys(globalThis.dao?.notificationToolResult ?? {}).sort(),
        notificationExecutionResultMethods: Object.keys(globalThis.dao?.notificationExecutionResult ?? {}).sort(),
        roomExportMethods: Object.keys(globalThis.dao?.roomExport ?? {}).sort(),
        diagnosticsMethods: Object.keys(globalThis.dao?.diagnostics ?? {}).sort(),
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
      "clearCache",
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
    const expectedMemoryAuthorityMethods = ["context", "onAuthorityInput", "request"];
    const expectedAgentSettingsMethods = ["getSnapshot", "onAuthorityMessage", "submit"];
    const expectedInvocationMethods = ["cancel", "getSurface", "onStateChanged", "retry"];
    const expectedProjectLoopMethods = ["getSurface", "onStateChanged", "submit"];
    const expectedToolSafetyMethods = ["getSurface", "onStateChanged", "repair", "submit"];
    const expectedNotificationCenterMethods = [
      "getState", "list", "markRead", "onStateChanged", "resolveSource", "retryRepair",
    ];
    const expectedNotificationSourceActionMethods = ["acknowledge"];
    const expectedRoomExportMethods = ["save"];
    const expectedDiagnosticsMethods = ["save"];
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
        ) || !("memoryAuthorityMethods" in startupProbe) ||
        !Array.isArray(startupProbe.memoryAuthorityMethods) ||
        startupProbe.memoryAuthorityMethods.length !== expectedMemoryAuthorityMethods.length ||
        !startupProbe.memoryAuthorityMethods.every(
          (method, index) => method === expectedMemoryAuthorityMethods[index],
        ) || !("agentSettingsMethods" in startupProbe) || !Array.isArray(startupProbe.agentSettingsMethods) ||
        startupProbe.agentSettingsMethods.join(",") !== expectedAgentSettingsMethods.join(",") ||
        !("invocationMethods" in startupProbe) || !Array.isArray(startupProbe.invocationMethods) ||
        startupProbe.invocationMethods.join(",") !== expectedInvocationMethods.join(",") ||
        !("projectLoopMethods" in startupProbe) || !Array.isArray(startupProbe.projectLoopMethods) ||
        startupProbe.projectLoopMethods.join(",") !== expectedProjectLoopMethods.join(",") ||
        !("toolSafetyMethods" in startupProbe) || !Array.isArray(startupProbe.toolSafetyMethods) ||
        startupProbe.toolSafetyMethods.join(",") !== expectedToolSafetyMethods.join(",") ||
        !("notificationCenterMethods" in startupProbe) ||
        !Array.isArray(startupProbe.notificationCenterMethods) ||
        startupProbe.notificationCenterMethods.join(",") !== expectedNotificationCenterMethods.join(",") ||
        !("notificationToolResultMethods" in startupProbe) ||
        !Array.isArray(startupProbe.notificationToolResultMethods) ||
        startupProbe.notificationToolResultMethods.join(",") !==
          expectedNotificationSourceActionMethods.join(",") ||
        !("notificationExecutionResultMethods" in startupProbe) ||
        !Array.isArray(startupProbe.notificationExecutionResultMethods) ||
        startupProbe.notificationExecutionResultMethods.join(",") !==
          expectedNotificationSourceActionMethods.join(",") ||
        !("roomExportMethods" in startupProbe) || !Array.isArray(startupProbe.roomExportMethods) ||
        startupProbe.roomExportMethods.join(",") !== expectedRoomExportMethods.join(",") ||
        !("diagnosticsMethods" in startupProbe) || !Array.isArray(startupProbe.diagnosticsMethods) ||
        startupProbe.diagnosticsMethods.join(",") !== expectedDiagnosticsMethods.join(",") ||
        !("namespaces" in startupProbe) || !Array.isArray(startupProbe.namespaces) ||
        startupProbe.namespaces.join(",") !==
          "agentSettings,attachmentAuthority,diagnostics,governance,identity,invocation,memoryAuthority,messageAuthority,notificationCenter,notificationExecutionResult,notificationToolResult,projectLoop,roomExport,toolSafety" ||
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
    disposeInvocationIpc?.();
    disposeMessageAuthorityIpc?.();
    disposeMemoryAuthorityIpc?.();
    disposeProjectLoopIpc?.();
    disposeToolSafetyIpc?.();
    disposeAgentSettingsIpc?.();
    disposeNotificationCenterIpc?.();
    disposeNotificationToolResultIpc?.();
    disposeNotificationExecutionResultIpc?.();
    disposeRoomExportIpc?.();
    disposeDiagnosticsIpc?.();
    disposeAttachmentGovernanceState?.();
    attachmentRuntimeHost.close();
    identity?.close();
    governance?.close();
    messageAuthority?.close();
    messageAuthorityRuntime?.close();
    memoryAuthorityRuntime?.close();
    projectLoop?.close();
    toolSafety?.close();
    agentSettings?.close();
    notificationCenter?.close();
    void roomExport?.close();
    void diagnostics?.close();
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
