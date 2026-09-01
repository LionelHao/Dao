import type { NativeSaveDialogPort } from "../attachment-authority/preview-download.js";

export interface ElectronRoomExportParentWindow {
  isDestroyed(): boolean;
}

export interface ElectronRoomExportDialogPort {
  showSaveDialog(
    parent: ElectronRoomExportParentWindow,
    options: Readonly<{
      title: string;
      defaultPath: string;
      properties: readonly ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"];
      filters: readonly [Readonly<{ name: "NDJSON"; extensions: readonly ["ndjson"] }>];
    }>,
  ): Promise<Readonly<{ canceled: boolean; filePath?: string }>>;
}

export function createElectronRoomExportSaveDialog(options: Readonly<{
  parentWindow: ElectronRoomExportParentWindow;
  dialog: ElectronRoomExportDialogPort;
}>): NativeSaveDialogPort {
  return Object.freeze<NativeSaveDialogPort>({
    async chooseDestination(suggestedName) {
      if (suggestedName.length > 255 ||
          !/^dao-room-export-[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}\.ndjson$/u.test(suggestedName)) {
        throw new TypeError("Room export save filename is not closed");
      }
      if (options.parentWindow.isDestroyed()) {
        throw new Error("Room export parent window is unavailable");
      }
      const selected = await options.dialog.showSaveDialog(options.parentWindow, {
        title: "导出 Room 数据",
        defaultPath: suggestedName,
        properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
        filters: [{ name: "NDJSON", extensions: ["ndjson"] }],
      });
      return selected.canceled ? undefined : selected.filePath;
    },
  });
}
