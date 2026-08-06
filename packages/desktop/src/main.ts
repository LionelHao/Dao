import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blankGroupChatWindowOptions } from "./window.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));

async function createWindow(): Promise<void> {
  const preloadPath = join(currentDirectory, "preload.js");
  const rendererPath = join(currentDirectory, "renderer", "index.html");
  const window = new BrowserWindow(blankGroupChatWindowOptions(preloadPath));

  await window.loadFile(rendererPath);
  console.info("Native IM desktop started with an empty group chat window.");
}

app
  .whenReady()
  .then(createWindow)
  .catch((error: unknown) => {
    console.error("Native IM desktop failed to start.", error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
