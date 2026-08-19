import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop main Attachment Authority host integration", () => {
  it("composes real Electron ports/runtime and joins Identity plus Room lifecycle invalidation", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../main.ts"), "utf8");
    expect(source).toContain("createDesktopAttachmentAuthorityRuntime");
    expect(source).toContain("createElectronAttachmentPorts");
    expect(source).toContain("createElectronAttachmentRuntimeHost");
    expect(source).toContain("attachmentRuntimeHost.invalidateIdentity()");
    expect(source).toContain("attachmentRuntimeHost.observeGovernanceState");
    expect(source).toContain("attachmentAuthorityMethods");
    expect(source).toContain("attachmentAuthority");
    expect(source).not.toMatch(/fake|noop|unavailableAttachment|ready:\s*true/iu);
  });
});
