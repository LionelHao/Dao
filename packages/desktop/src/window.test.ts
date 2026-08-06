import { describe, expect, it } from "vitest";
import * as importedWindow from "./window.js";

type WindowModuleUnderTest = {
  blankGroupChatWindowOptions?: (preloadPath: string) => {
    height: number;
    minHeight: number;
    minWidth: number;
    title: string;
    webPreferences: { contextIsolation: boolean; nodeIntegration: boolean; preload: string };
    width: number;
  };
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
      },
    });
  });
});

