import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("renderer document security boundary", () => {
  it("keeps network, embedding, base navigation, and inline scripts closed", () => {
    const filePath = existsSync("src/renderer/index.html")
      ? "src/renderer/index.html"
      : "packages/desktop/src/renderer/index.html";
    const document = readFileSync(filePath, "utf8");

    expect(document).toContain("http-equiv=\"Content-Security-Policy\"");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("script-src 'self'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("object-src 'none'");
    expect(document).toContain("base-uri 'none'");
    expect(document).toContain("frame-ancestors 'none'");
    expect(document).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u);
  });
});
