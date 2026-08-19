import { Buffer } from "node:buffer";
import { ATTACHMENT_AUTHORITY_LIMITS } from "@native-im/core";
import { isAttachmentPreviewPolicy } from "./contracts.js";
import type {
  NativeOpenFileDialogPort,
  ATTACHMENT_FILE_PICKER_POLICY,
} from "./native-file-selection.js";
import type {
  NativeSaveDialogPort,
  SandboxedPreviewHostPort,
} from "./preview-download.js";

type AttachmentFilePickerPolicy = typeof ATTACHMENT_FILE_PICKER_POLICY;

export interface ElectronAttachmentParentWindow {
  isDestroyed(): boolean;
  focus(): void;
}

export interface ElectronAttachmentDialogPort {
  showOpenDialog(
    parent: ElectronAttachmentParentWindow,
    options: Readonly<{
      title: string;
      properties: readonly ["openFile"];
      filters: readonly [Readonly<{ name: string; extensions: readonly string[] }>];
    }>,
  ): Promise<Readonly<{ canceled: boolean; filePaths: readonly string[] }>>;
  showSaveDialog(
    parent: ElectronAttachmentParentWindow,
    options: Readonly<{
      title: string;
      defaultPath: string;
      properties: readonly ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"];
    }>,
  ): Promise<Readonly<{ canceled: boolean; filePath?: string }>>;
}

interface ElectronAttachmentPreviewEvent {
  preventDefault(): void;
}

export interface ElectronAttachmentPreviewWindow {
  readonly webContents: {
    setWindowOpenHandler(handler: () => Readonly<{ action: "deny" }>): void;
    on(event: string, listener: (...args: never[]) => void): void;
    executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
    readonly session: {
      setPermissionRequestHandler(handler: (
        webContents: unknown,
        permission: string,
        callback: (allowed: boolean) => void,
      ) => void): void;
      readonly webRequest: {
        onBeforeRequest(handler: (
          details: Readonly<{ url: string }>,
          callback: (response: Readonly<{ cancel: boolean }>) => void,
        ) => void): void;
      };
      on(event: "will-download", listener: (event: ElectronAttachmentPreviewEvent) => void): void;
    };
  };
  loadURL(url: string): Promise<void>;
  show(): void;
  destroy(): void;
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): void;
}

export type ElectronAttachmentPreviewWindowOptions = Readonly<{
  parent: ElectronAttachmentParentWindow;
  show: false;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  autoHideMenuBar: true;
  webPreferences: Readonly<{
    contextIsolation: true;
    nodeIntegration: false;
    sandbox: true;
    webSecurity: true;
    partition: string;
  }>;
}>;

const PREVIEW_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; object-src blob:; frame-src blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">
<style>html,body{margin:0;min-height:100%;font:14px/1.6 system-ui,sans-serif;background:Canvas;color:CanvasText}main{box-sizing:border-box;min-height:100vh;padding:20px}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}img,object{display:block;max-width:100%;width:100%;height:calc(100vh - 40px);object-fit:contain;border:0}</style>
</head><body><main id="preview" aria-live="off"></main></body></html>`;
const PREVIEW_SHELL_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PREVIEW_HTML)}`;

function previewMime(first: Uint8Array, representation: "safe-rendered" | "extracted-text"): string {
  if (representation === "extracted-text") return "text/plain;charset=utf-8";
  if (first.length >= 5 && first[0] === 0x25 && first[1] === 0x50 && first[2] === 0x44 &&
    first[3] === 0x46 && first[4] === 0x2d) return "application/pdf";
  if (first.length >= 8 && first[0] === 0x89 && first[1] === 0x50 && first[2] === 0x4e &&
    first[3] === 0x47 && first[4] === 0x0d && first[5] === 0x0a && first[6] === 0x1a &&
    first[7] === 0x0a) return "image/png";
  if (first.length >= 3 && first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff) {
    return "image/jpeg";
  }
  return "text/plain;charset=utf-8";
}

function appendChunkScript(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  return `(()=>{const s=${JSON.stringify(encoded)};const b=atob(s);const c=new Uint8Array(b.length);for(let i=0;i<b.length;i+=1)c[i]=b.charCodeAt(i);globalThis.__daoAttachmentPreviewChunks.push(c)})()`;
}

function finalizeScript(mime: string): string {
  return `(async()=>{const chunks=globalThis.__daoAttachmentPreviewChunks;delete globalThis.__daoAttachmentPreviewChunks;const root=document.getElementById("preview");if(!root||!Array.isArray(chunks))throw new Error("preview shell unavailable");const blob=new Blob(chunks,{type:${JSON.stringify(mime)}});if(${JSON.stringify(mime)}.startsWith("text/")){const pre=document.createElement("pre");pre.textContent=await blob.text();root.replaceChildren(pre);return}const u=URL.createObjectURL(blob);const element=${JSON.stringify(mime)}.startsWith("image/")?document.createElement("img"):document.createElement("object");if(element instanceof HTMLImageElement){element.alt="附件安全预览";element.src=u}else{element.type=${JSON.stringify(mime)};element.data=u;element.setAttribute("aria-label","附件安全预览")}root.replaceChildren(element)})()`;
}

function installPreviewSecurity(window: ElectronAttachmentPreviewWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", ((event: ElectronAttachmentPreviewEvent) => {
    event.preventDefault();
  }) as never);
  window.webContents.on("will-redirect", ((event: ElectronAttachmentPreviewEvent) => {
    event.preventDefault();
  }) as never);
  window.webContents.on("will-attach-webview", ((event: ElectronAttachmentPreviewEvent) => {
    event.preventDefault();
  }) as never);
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.on("will-download", (event) => event.preventDefault());
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: details.url !== PREVIEW_SHELL_URL && !details.url.startsWith("blob:") });
  });
}

export function createElectronAttachmentPorts(options: {
  readonly parentWindow: ElectronAttachmentParentWindow;
  readonly dialog: ElectronAttachmentDialogPort;
  readonly createPreviewWindow: (
    options: ElectronAttachmentPreviewWindowOptions,
  ) => ElectronAttachmentPreviewWindow;
  readonly randomId: () => string;
}): Readonly<{
  openFileDialog: NativeOpenFileDialogPort;
  saveDialog: NativeSaveDialogPort;
  previewHost: SandboxedPreviewHostPort;
}> {
  const previewWindows = new Set<ElectronAttachmentPreviewWindow>();
  const openFileDialog: NativeOpenFileDialogPort = Object.freeze({
    async showOpenFile(policy: AttachmentFilePickerPolicy) {
      if (policy.multiple || policy.directories ||
        policy.allowedExtensions.join(",") !== "pdf,png,jpg,jpeg,docx,xlsx,txt,csv") {
        throw new TypeError("Attachment file picker policy is not closed");
      }
      const selected = await options.dialog.showOpenDialog(options.parentWindow, {
        title: "选择附件",
        properties: ["openFile"],
        filters: [{ name: "支持的附件", extensions: [...policy.allowedExtensions] }],
      });
      return Object.freeze({
        canceled: selected.canceled,
        filePaths: Object.freeze([...selected.filePaths]),
      });
    },
  });
  const saveDialog: NativeSaveDialogPort = Object.freeze<NativeSaveDialogPort>({
    async chooseDestination(suggestedName) {
      if (suggestedName.length === 0 || suggestedName.length > 255 || /[\\/]/u.test(suggestedName)) {
        throw new TypeError("Attachment save filename is not closed");
      }
      const selected = await options.dialog.showSaveDialog(options.parentWindow, {
        title: "保存附件",
        defaultPath: suggestedName,
        properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
      });
      return selected.canceled ? undefined : selected.filePath;
    },
  });
  const previewHost: SandboxedPreviewHostPort = Object.freeze<SandboxedPreviewHostPort>({
    async openSandboxed(input) {
      if (!isAttachmentPreviewPolicy(input.policy)) {
        throw new TypeError("Attachment preview policy is not closed");
      }
      if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 ||
        input.byteSize > ATTACHMENT_AUTHORITY_LIMITS.maxFileBytes) {
        throw new TypeError("Attachment preview authorized size is invalid");
      }
      const partitionId = options.randomId();
      if (!/^[A-Za-z0-9-]{1,128}$/u.test(partitionId)) {
        throw new TypeError("Attachment preview partition is invalid");
      }
      const window = options.createPreviewWindow({
        parent: options.parentWindow,
        show: false,
        title: "附件安全预览",
        width: 900,
        height: 700,
        minWidth: 640,
        minHeight: 480,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          partition: `attachment-preview-${partitionId}`,
        },
      });
      previewWindows.add(window);
      window.once("closed", () => {
        previewWindows.delete(window);
        if (!options.parentWindow.isDestroyed()) options.parentWindow.focus();
      });
      try {
        await window.loadURL(PREVIEW_SHELL_URL);
        // The only navigation before the guards are installed is this immutable,
        // network-free CSP shell. Lock the window before any attachment bytes or
        // executable renderer-controlled content can enter the preview surface.
        installPreviewSecurity(window);
        await window.webContents.executeJavaScript(
          "globalThis.__daoAttachmentPreviewChunks=[]",
          false,
        );
        let offset = 0;
        let first = new Uint8Array();
        while (offset < input.byteSize) {
          const maximum = Math.min(
            ATTACHMENT_AUTHORITY_LIMITS.maxChunkBytes,
            input.byteSize - offset,
          );
          const chunk = await input.read(offset, maximum);
          if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1 ||
            chunk.byteLength > maximum || offset + chunk.byteLength > input.byteSize) {
            throw new Error("Attachment preview did not match authorized size");
          }
          if (offset === 0) first = Uint8Array.from(chunk);
          await window.webContents.executeJavaScript(appendChunkScript(chunk), false);
          offset += chunk.byteLength;
        }
        if (offset !== input.byteSize) {
          throw new Error("Attachment preview did not match authorized size");
        }
        await window.webContents.executeJavaScript(
          finalizeScript(previewMime(first, input.policy.representation)),
          false,
        );
        window.show();
      } catch (error) {
        previewWindows.delete(window);
        if (!window.isDestroyed()) window.destroy();
        if (error instanceof Error && error.message === "Attachment preview did not match authorized size") {
          throw error;
        }
        throw new Error("Attachment preview failed closed");
      }
    },
    closeAll() {
      for (const window of [...previewWindows]) {
        previewWindows.delete(window);
        if (!window.isDestroyed()) window.destroy();
      }
    },
  });
  return Object.freeze({ openFileDialog, saveDialog, previewHost });
}
