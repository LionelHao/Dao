export interface BlankGroupChatWindowOptions {
  readonly height: number;
  readonly minHeight: number;
  readonly minWidth: number;
  readonly title: string;
  readonly webPreferences: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly preload: string;
  };
  readonly width: number;
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
    },
  };
}
