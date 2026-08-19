import { describe, expect, it, vi } from "vitest";

import { ATTACHMENT_FILE_PICKER_POLICY } from "./native-file-selection.js";
import { createElectronAttachmentPorts } from "./electron-production-ports.js";

function previewFixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let openHandler: (() => { action: "deny" }) | undefined;
  let permissionHandler: ((contents: unknown, permission: string, reply: (allowed: boolean) => void) => void) | undefined;
  let requestHandler: ((details: { url: string }, reply: (result: { cancel: boolean }) => void) => void) | undefined;
  const webContents = {
    setWindowOpenHandler: vi.fn((handler) => { openHandler = handler; }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
    executeJavaScript: vi.fn(async () => undefined),
    session: {
      setPermissionRequestHandler: vi.fn((handler) => { permissionHandler = handler; }),
      webRequest: { onBeforeRequest: vi.fn((handler) => { requestHandler = handler; }) },
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(`session:${event}`, listener)),
    },
  };
  const window = {
    webContents,
    loadURL: vi.fn(async () => undefined),
    show: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn(() => false),
    once: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(`window:${event}`, listener)),
  };
  return { window, webContents, listeners,
    openHandler: () => openHandler, permissionHandler: () => permissionHandler,
    requestHandler: () => requestHandler };
}

describe("Electron attachment production ports", () => {
  it("maps the closed file policy and native save destination without returning paths elsewhere", async () => {
    const showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: ["/private/report.pdf"] }));
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: "/private/saved.pdf" }));
    const fixture = previewFixture();
    const parent = { isDestroyed: () => false, focus: vi.fn() };
    const ports = createElectronAttachmentPorts({
      parentWindow: parent,
      dialog: { showOpenDialog, showSaveDialog },
      createPreviewWindow: vi.fn(() => fixture.window),
      randomId: () => "preview-partition",
    });
    await expect(ports.openFileDialog.showOpenFile(ATTACHMENT_FILE_PICKER_POLICY)).resolves.toEqual({
      canceled: false, filePaths: ["/private/report.pdf"],
    });
    expect(showOpenDialog).toHaveBeenCalledWith(parent, {
      title: "选择附件",
      properties: ["openFile"],
      filters: [{ name: "支持的附件", extensions: ["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "txt", "csv"] }],
    });
    await expect(ports.saveDialog.chooseDestination("report.pdf")).resolves.toBe("/private/saved.pdf");
    expect(showSaveDialog).toHaveBeenCalledWith(parent, expect.objectContaining({
      title: "保存附件", defaultPath: "report.pdf",
    }));
  });

  it("opens a separate ephemeral sandbox with no Node, navigation, windows, permission, external network, or arbitrary URL", async () => {
    const fixture = previewFixture();
    const createPreviewWindow = vi.fn(() => fixture.window);
    const parent = { isDestroyed: () => false, focus: vi.fn() };
    const ports = createElectronAttachmentPorts({
      parentWindow: parent,
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      createPreviewWindow,
      randomId: () => "preview-partition",
    });
    await ports.previewHost.openSandboxed({
      policy: {
        type: "attachment.preview.policy", attachmentId: "attachment-1",
        representation: "extracted-text", nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowNavigation: false, allowWindowOpen: false,
        allowPermissions: false, allowExternalProtocols: false, allowNetwork: false, ariaLive: "off",
      },
      byteSize: 5,
      read: vi.fn(async (offset) => offset === 0
        ? new Uint8Array([104, 101, 108, 108, 111])
        : new Uint8Array()),
    });
    expect(createPreviewWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: false,
      parent,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        partition: "attachment-preview-preview-partition",
      },
    }));
    expect(fixture.window.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html;charset=utf-8,/u));
    expect(fixture.window.loadURL.mock.calls[0]?.[0]).not.toMatch(/attachment-1|hello|private|token|https?:/iu);
    expect(fixture.openHandler()?.()).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    fixture.listeners.get("will-navigate")?.(navigation, "https://evil.example");
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    const attach = { preventDefault: vi.fn() };
    fixture.listeners.get("will-attach-webview")?.(attach);
    expect(attach.preventDefault).toHaveBeenCalledOnce();
    const permission = vi.fn();
    fixture.permissionHandler()?.({}, "openExternal", permission);
    expect(permission).toHaveBeenCalledWith(false);
    const network = vi.fn();
    fixture.requestHandler()?.({ url: "https://evil.example/pixel" }, network);
    expect(network).toHaveBeenCalledWith({ cancel: true });
    expect(fixture.webContents.executeJavaScript).toHaveBeenCalled();
    expect(fixture.window.show).toHaveBeenCalledOnce();
    ports.previewHost.closeAll();
    expect(fixture.window.destroy).toHaveBeenCalledOnce();
  });

  it("fails closed when the policy is weakened or the byte stream changes size", async () => {
    const fixture = previewFixture();
    const ports = createElectronAttachmentPorts({
      parentWindow: { isDestroyed: () => false, focus: vi.fn() },
      dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
      createPreviewWindow: () => fixture.window,
      randomId: () => "partition",
    });
    const policy = {
      type: "attachment.preview.policy", attachmentId: "attachment-1",
      representation: "safe-rendered", nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowNavigation: false, allowWindowOpen: false,
      allowPermissions: false, allowExternalProtocols: false, allowNetwork: false, ariaLive: "off",
    } as const;
    await expect(ports.previewHost.openSandboxed({ ...policy, allowNetwork: true } as never))
      .rejects.toThrow("policy");
    await expect(ports.previewHost.openSandboxed({
      policy, byteSize: 2, read: async (offset) => offset === 0
        ? new Uint8Array([1])
        : new Uint8Array(),
    })).rejects.toThrow("authorized size");
    expect(fixture.window.show).not.toHaveBeenCalled();
  });
});
