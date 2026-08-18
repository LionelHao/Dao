export interface BlankGroupChatWindowOptions {
  readonly height: number;
  readonly minHeight: number;
  readonly minWidth: number;
  readonly title: string;
  readonly webPreferences: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly preload: string;
    readonly sandbox: true;
    readonly webSecurity: true;
  };
  readonly width: number;
}

export interface SecurityPolicyWindow {
  readonly webContents: {
    setWindowOpenHandler(handler: () => { readonly action: "deny" }): void;
    on(
      event: "will-navigate",
      listener: (event: { preventDefault(): void }) => void,
    ): void;
    readonly session: {
      setPermissionRequestHandler(
        handler: (
          webContents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
        ) => void,
      ): void;
    };
  };
}

export function blankGroupChatWindowOptions(
  preloadPath: string,
): BlankGroupChatWindowOptions {
  return {
    title: "原生人机协作 IM",
    width: 1100,
    height: 720,
    minWidth: 840,
    minHeight: 560,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
}

export function installWindowSecurityPolicy(window: SecurityPolicyWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
}
