// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  const root = process.cwd().endsWith("packages/desktop") ? "src" : "packages/desktop/src";
  return readFileSync(resolve(root, path), "utf8");
}

describe("notification source-action production composition", () => {
  it("wires both closed IPC actions through the existing authenticated transport into J-07", () => {
    const main = source("main.ts");
    const preload = source("preload.ts");
    const rendererMain = source("renderer/main.ts");
    const entry = source("renderer/entry.ts");
    expect(main).toContain("createNotificationToolResultActionRuntime");
    expect(main).toContain("createNotificationExecutionResultActionRuntime");
    expect(main.match(/transport: messageAuthorityRuntime\.transport/gu)?.length).toBeGreaterThanOrEqual(4);
    expect(main).toContain("registerNotificationToolResultActionIpc");
    expect(main).toContain("registerNotificationExecutionResultActionIpc");
    expect(preload).toContain("notificationToolResult: createNotificationToolResultActionBridge(ipcRenderer)");
    expect(preload).toContain(
      "notificationExecutionResult: createNotificationExecutionResultActionBridge(ipcRenderer)",
    );
    expect(rendererMain).toContain("window.dao?.notificationToolResult");
    expect(rendererMain).toContain("window.dao?.notificationExecutionResult");
    expect(entry).toContain("toolResultAction: notificationToolResult");
    expect(entry).toContain("executionResultAction: notificationExecutionResult");
    expect(`${preload}\n${entry}`).not.toMatch(/markHandled|mark-handled|genericHandled/gu);
  });
});
