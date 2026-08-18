import { describe, expect, it, vi } from "vitest";
import * as importedWindow from "./window.js";

type WindowModuleUnderTest = {
  blankGroupChatWindowOptions?: (preloadPath: string) => {
    height: number;
    minHeight: number;
    minWidth: number;
    title: string;
    webPreferences: {
      contextIsolation: boolean;
      nodeIntegration: boolean;
      preload: string;
      sandbox: boolean;
      webSecurity: boolean;
    };
    width: number;
  };
  installWindowSecurityPolicy?: (window: {
    readonly webContents: {
      setWindowOpenHandler(handler: () => { readonly action: "deny" }): void;
      on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): void;
      session: {
        setPermissionRequestHandler(
          handler: (
            webContents: unknown,
            permission: string,
            callback: (allowed: boolean) => void,
          ) => void,
        ): void;
      };
    };
  }) => void;
};

const windowModule = importedWindow as unknown as WindowModuleUnderTest;

describe("blank group chat window", () => {
  it("creates a secure, visible desktop window for an empty collaborative room", () => {
    expect(windowModule.blankGroupChatWindowOptions).toBeTypeOf("function");

    const options = windowModule.blankGroupChatWindowOptions?.("/tmp/preload.js");

    expect(options).toMatchObject({
      title: "原生人机协作 IM",
      width: 1100,
      height: 720,
      minWidth: 840,
      minHeight: 560,
      webPreferences: {
        preload: "/tmp/preload.js",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
  });

  it("denies renderer navigation, new windows, and permissions by default", () => {
    let openHandler: (() => { readonly action: "deny" }) | undefined;
    let navigationHandler: ((event: { preventDefault(): void }) => void) | undefined;
    let permissionHandler:
      | ((webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
      | undefined;
    windowModule.installWindowSecurityPolicy?.({
      webContents: {
        setWindowOpenHandler(handler) {
          openHandler = handler;
        },
        on(_event, listener) {
          navigationHandler = listener;
        },
        session: {
          setPermissionRequestHandler(handler) {
            permissionHandler = handler;
          },
        },
      },
    });

    expect(windowModule.installWindowSecurityPolicy).toBeTypeOf("function");
    expect(openHandler?.()).toEqual({ action: "deny" });
    const navigation = { preventDefault: vi.fn() };
    navigationHandler?.(navigation);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    const permission = vi.fn();
    permissionHandler?.({}, "clipboard-read", permission);
    expect(permission).toHaveBeenCalledWith(false);
  });
});
