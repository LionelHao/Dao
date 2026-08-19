import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("real Electron smoke contract", () => {
  it("runs the app bridge, real native selection, and sandbox preview security probes", () => {
    const smoke = readFileSync(resolve(import.meta.dirname, "../scripts/smoke-electron.mjs"), "utf8");
    const preview = readFileSync(resolve(import.meta.dirname, "../scripts/smoke-attachment-preview.mjs"), "utf8");
    expect(smoke).toContain("smoke-attachment-preview.mjs");
    expect(smoke).toContain("attachmentAuthority");
    expect(preview).toContain("createElectronAttachmentPorts");
    expect(preview).toContain("createNativeSelectionRegistry");
    expect(preview).toContain("NODE_NATIVE_FILE_SYSTEM");
    expect(preview).toContain("Electron Attachment native selection and preview security smoke passed");
    expect(preview).not.toMatch(/nodeIntegration:\s*true|sandbox:\s*false|contextIsolation:\s*false/iu);
  });
});
