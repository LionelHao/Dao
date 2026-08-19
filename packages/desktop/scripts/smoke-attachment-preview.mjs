import {
  app,
  BrowserWindow,
  session,
} from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createElectronAttachmentPorts,
} from "../dist/attachment-authority/electron-production-ports.js";
import {
  createNativeSelectionRegistry,
  NODE_NATIVE_FILE_SYSTEM,
} from "../dist/attachment-authority/native-file-selection.js";

const timeout = setTimeout(() => {
  console.error("Electron Attachment preview security smoke timed out.");
  app.exit(1);
}, 15_000);

async function runPreviewSecuritySmoke() {
  const parent = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "dao-ft04-native-selection-"));
  const selectedPath = join(temporaryDirectory, "smoke-evidence.txt");
  const expected = new TextEncoder().encode("safe preview text");
  await writeFile(selectedPath, expected, { mode: 0o600 });
  const ports = createElectronAttachmentPorts({
    parentWindow: parent,
    dialog: {
      async showOpenDialog() {
        return { canceled: false, filePaths: [selectedPath] };
      },
      async showSaveDialog() {
        return { canceled: true };
      },
    },
    createPreviewWindow: (options) => new BrowserWindow(options),
    randomId: () => "smoke-preview",
  });
  let selectionId = 0;
  const selections = createNativeSelectionRegistry({
    dialog: ports.openFileDialog,
    fs: NODE_NATIVE_FILE_SYSTEM,
    randomId: () => `smoke-selection-${++selectionId}`,
  });
  const selected = await selections.select();
  if (selected.status !== "selected" || selected.selection.displayName !== "smoke-evidence.txt" ||
    selected.selection.format !== "txt" || selected.selection.byteSize !== expected.byteLength ||
    JSON.stringify(selected).includes(selectedPath)) {
    throw new Error("native file selection did not preserve its closed DTO boundary");
  }
  const handle = await selections.openForRead(selected.selection.selectionHandle);
  const selectedBytes = await handle.read(0, expected.byteLength);
  await handle.close();
  if (new TextDecoder().decode(selectedBytes) !== "safe preview text") {
    throw new Error("native bounded file read did not return the selected content");
  }
  await ports.previewHost.openSandboxed({
    policy: {
      type: "attachment.preview.policy",
      attachmentId: "smoke-attachment",
      representation: "extracted-text",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowNavigation: false,
      allowWindowOpen: false,
      allowPermissions: false,
      allowExternalProtocols: false,
      allowNetwork: false,
      ariaLive: "off",
    },
    byteSize: selectedBytes.byteLength,
    async read(offset, maximumBytes) {
      return selectedBytes.slice(offset, offset + maximumBytes);
    },
  });
  const preview = BrowserWindow.getAllWindows().find((candidate) => candidate !== parent);
  if (preview === undefined) throw new Error("preview window was not created");
  const preferences = preview.webContents.getLastWebPreferences();
  if (preferences.nodeIntegration !== false || preferences.contextIsolation !== true ||
    preferences.sandbox !== true || preferences.webSecurity !== true ||
    preview.webContents.session !== session.fromPartition("attachment-preview-smoke-preview")) {
    throw new Error("preview BrowserWindow preferences were weakened");
  }
  const result = JSON.parse(await preview.webContents.executeJavaScript(`(async()=>JSON.stringify({
    nodeAbsent: typeof process === "undefined" && typeof require === "undefined",
    text: document.querySelector("#preview")?.textContent ?? "",
    openDenied: window.open("https://example.invalid") === null,
    networkDenied: await fetch("https://example.invalid/resource").then(
      () => false,
      () => true
    )
  }))()`, false));
  if (result.nodeAbsent !== true || result.text !== "safe preview text" ||
    result.openDenied !== true || result.networkDenied !== true) {
    throw new Error("preview renderer security probe failed");
  }
  ports.previewHost.closeAll();
  if (!preview.isDestroyed()) throw new Error("preview closeAll did not destroy the sandbox");
  await selections.remove(selected.selection.selectionHandle);
  await selections.invalidate();
  await rm(temporaryDirectory, { force: true, recursive: true });
  console.info("Electron Attachment native selection and preview security smoke passed.");
  clearTimeout(timeout);
  if (!parent.isDestroyed()) parent.destroy();
  app.quit();
}

function failClosed(error) {
  clearTimeout(timeout);
  const detail = error instanceof Error ? error.message : "unknown failure";
  console.error(`Electron Attachment preview security smoke failed closed: ${detail}`);
  app.exit(1);
}

void app.whenReady().then(runPreviewSecuritySmoke).catch(failClosed);
