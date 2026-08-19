import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { IdentityAuthoritySession } from "../identity/controller.js";
import { createAttachmentAuthorityController, type AttachmentAuthorityController } from "./controller.js";
import { registerAttachmentAuthorityIpc, type AttachmentAuthorityIpcMain, type AttachmentAuthorityIpcWebContents } from "./ipc.js";
import {
  createNativeSelectionRegistry,
  NODE_NATIVE_FILE_SYSTEM,
  type NativeOpenFileDialogPort,
} from "./native-file-selection.js";
import {
  createPreviewDownloadService,
  type NativeAtomicSaveFileSystemPort,
  type NativeSaveDialogPort,
  type SandboxedPreviewHostPort,
} from "./preview-download.js";
import {
  createAttachmentAuthorityWebSocketTransport,
  type AttachmentAuthorityWebSocketLike,
} from "./websocket-authority.js";

export const NODE_ATOMIC_SAVE_FILE_SYSTEM: NativeAtomicSaveFileSystemPort =
Object.freeze<NativeAtomicSaveFileSystemPort>({
  async openTemporary(temporaryPath) {
    const descriptor = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    let closed = false;
    return Object.freeze({
      async write(bytes: Uint8Array) {
        if (closed || !(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
          throw new TypeError("Invalid attachment temporary write");
        }
        let written = 0;
        while (written < bytes.byteLength) {
          const result = await descriptor.write(bytes, written, bytes.byteLength - written);
          if (result.bytesWritten <= 0) throw new Error("Attachment temporary write made no progress");
          written += result.bytesWritten;
        }
      },
      async sync() {
        if (closed) throw new Error("Attachment temporary file is closed");
        await descriptor.sync();
      },
      async close() {
        if (closed) return;
        closed = true;
        await descriptor.close();
      },
    });
  },
  async rename(temporaryPath, destinationPath) {
    await rename(temporaryPath, destinationPath);
    const directory = await open(dirname(destinationPath), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  },
  async remove(temporaryPath) {
    await rm(temporaryPath, { force: true });
  },
});

export interface DesktopAttachmentAuthorityRuntime {
  readonly controller: AttachmentAuthorityController;
  invalidateAuthorizedState(reason?: "session_revoked" | "membership_revoked" | "terminal_auth_failure"): void;
  close(): void;
}

export function createDesktopAttachmentAuthorityRuntime(options: {
  readonly endpoint: string;
  readonly session: () => IdentityAuthoritySession | undefined;
  readonly webSocketFactory: (endpoint: string) => AttachmentAuthorityWebSocketLike;
  readonly openFileDialog: NativeOpenFileDialogPort;
  readonly saveDialog: NativeSaveDialogPort;
  readonly previewHost: SandboxedPreviewHostPort;
  readonly ipcMain: AttachmentAuthorityIpcMain;
  readonly webContents: AttachmentAuthorityIpcWebContents;
  readonly timeoutMs?: number;
}): DesktopAttachmentAuthorityRuntime {
  // All dependencies are required production ports. Construction does not claim network readiness;
  // the first operation must authenticate and receive a matching authority response.
  const authority = createAttachmentAuthorityWebSocketTransport({
    endpoint: options.endpoint,
    session: options.session,
    webSocketFactory: options.webSocketFactory,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const selections = createNativeSelectionRegistry({
    dialog: options.openFileDialog,
    fs: NODE_NATIVE_FILE_SYSTEM,
    randomId: randomUUID,
  });
  const previews = createPreviewDownloadService({
    authority,
    previewHost: options.previewHost,
    saveDialog: options.saveDialog,
    fs: NODE_ATOMIC_SAVE_FILE_SYSTEM,
    randomId: randomUUID,
  });
  const controller = createAttachmentAuthorityController({ selections, authority, previews });
  const unregisterIpc = registerAttachmentAuthorityIpc({
    ipcMain: options.ipcMain,
    webContents: options.webContents,
    controller,
  });
  const stopTerminal = authority.onTerminalRevoked((reason) => {
    controller.invalidateAuthorizedState(reason);
  });
  let closed = false;
  const runtime: DesktopAttachmentAuthorityRuntime = {
    controller,
    invalidateAuthorizedState(reason = "session_revoked") {
      if (!closed) controller.invalidateAuthorizedState(reason);
    },
    close() {
      if (closed) return;
      closed = true;
      stopTerminal();
      unregisterIpc();
      controller.close();
    },
  };
  return Object.freeze(runtime);
}
