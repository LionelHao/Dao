import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderAttachmentAuthoritySurface, type AttachmentAuthoritySurfaceActions } from "./surface.js";
import { createAttachmentAuthorityViewModel, type AttachmentAuthorityInput } from "./view-model.js";

const metadata = {
  displayName: "migration-notes.pdf",
  byteSize: 4_404_019,
  mediaType: "application/pdf",
} as const;

function input(overrides: Partial<AttachmentAuthorityInput> = {}): AttachmentAuthorityInput {
  return {
    localTransport: { status: "selected" },
    durable: { status: "open" },
    sourceEligibility: "unbound",
    accessProjection: "authorized",
    metadata,
    reducedMotion: false,
    ...overrides,
  };
}

function actions(): AttachmentAuthoritySurfaceActions {
  return {
    onUpload: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onBind: vi.fn(),
    onPreview: vi.fn(),
    onDownload: vi.fn(),
    onRemove: vi.fn(),
    onReauthenticate: vi.fn(),
    onRefreshProjection: vi.fn(),
    onRestartUpload: vi.fn(),
    onSelectReplacement: vi.fn(),
    onUpgradeClient: vi.fn(),
  };
}

afterEach(() => document.body.replaceChildren());

describe("FT-04 J-02 attachment authority DOM", () => {
  it("renders progress from ACK bytes with text/icon/line authority cues and a closed cancel action", () => {
    const root = document.createElement("section");
    const handlers = actions();
    renderAttachmentAuthoritySurface(root, createAttachmentAuthorityViewModel(input({
      localTransport: { status: "uploading", acknowledgedBytes: 1_835_008, totalBytes: metadata.byteSize },
    })), handlers);

    expect(root.dataset.attachmentState).toBe("uploading");
    expect(root.querySelector("[data-status-label]")?.textContent).toContain("UPLOADING");
    expect(root.querySelector("[data-status-icon]")).not.toBeNull();
    expect(root.querySelector("[data-authority-source]")?.textContent).toContain("SERVER ACK");
    expect(root.querySelector("progress")?.getAttribute("value")).toBe("1835008");
    expect(root.querySelector("progress")?.getAttribute("max")).toBe(String(metadata.byteSize));
    const cancel = root.querySelector<HTMLButtonElement>("[data-action='cancel']");
    expect(cancel?.tagName).toBe("BUTTON");
    expect(cancel?.getAttribute("aria-label")).toContain(metadata.displayName);
    cancel?.click();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(root.querySelector("[data-action='bind']")).toBeNull();
  });

  it("renders all ten states with a finite live region and preview live=off", () => {
    const values = [
      input(),
      input({ localTransport: { status: "uploading", acknowledgedBytes: 1, totalBytes: metadata.byteSize } }),
      input({ localTransport: { status: "none" }, durable: { status: "processing", phase: "ocr", authoritySource: "stable-event" } }),
      input({ localTransport: { status: "none" }, durable: { status: "ready", authoritySource: "projection" } }),
      input({ localTransport: { status: "none" }, durable: { status: "retryable-failed", authoritySource: "projection", error: { status: 503, code: "scanner_unavailable" } } }),
      input({ localTransport: { status: "none" }, durable: { status: "nonretryable-failed", authoritySource: "projection", error: { status: 422, code: "encrypted_pdf" } } }),
      input({ localTransport: { status: "none" }, durable: { status: "cancelled", authoritySource: "projection" } }),
      input({ localTransport: { status: "local-rejected", error: { status: 413, code: "attachment_too_large" } } }),
      input({ localTransport: { status: "none" }, durable: { status: "malware-rejected", authoritySource: "stable-event" } }),
      input({ localTransport: { status: "none" }, durable: { status: "ready", authoritySource: "projection" }, accessProjection: "permission-revoked" }),
    ];
    const seen = new Set<string>();
    for (const value of values) {
      const root = document.createElement("section");
      renderAttachmentAuthoritySurface(root, createAttachmentAuthorityViewModel(value), actions());
      seen.add(root.dataset.attachmentState ?? "");
      expect(root.querySelectorAll("[role='status'][aria-live='polite']")).toHaveLength(1);
      expect(root.querySelector("[data-attachment-preview-policy]")?.getAttribute("aria-live")).toBe("off");
      expect(root.querySelector("[data-status-label]")?.textContent?.length).toBeGreaterThan(0);
    }
    expect(seen).toHaveLength(10);
  });

  it("focuses a closed error summary and exposes its HTTP/code/recovery without colour-only meaning", () => {
    const root = document.createElement("section");
    document.body.append(root);
    renderAttachmentAuthoritySurface(root, createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      closedError: { status: 503, code: "ocr_unavailable" },
    })), actions());
    const summary = root.querySelector<HTMLElement>("[data-attachment-error]");
    expect(document.activeElement).toBe(summary);
    expect(summary?.textContent).toContain("503");
    expect(summary?.textContent).toContain("ocr_unavailable");
    expect(summary?.textContent).toContain("重试");
    expect(summary?.textContent).toContain("ERROR");
  });

  it("purges visible metadata and focuses recovery after permission revocation", () => {
    const root = document.createElement("section");
    document.body.append(root);
    renderAttachmentAuthoritySurface(root, createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
      sourceEligibility: "bound-active",
      accessProjection: "permission-revoked",
    })), actions());
    expect(root.textContent).not.toContain(metadata.displayName);
    expect(root.textContent).not.toContain(metadata.mediaType);
    expect(root.querySelector("[data-action='preview']")).toBeNull();
    expect(root.querySelector("[data-action='download']")).toBeNull();
    expect(document.activeElement).toBe(root.querySelector("[data-attachment-recovery]"));
  });

  it("removes recalled attachments from the ordinary surface", () => {
    const root = document.createElement("section");
    renderAttachmentAuthoritySurface(root, createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
      sourceEligibility: "excluded-recalled",
    })), actions());
    expect(root.dataset.attachmentVisibility).toBe("excluded");
    expect(root.childElementCount).toBe(0);
    expect(root.textContent).not.toContain(metadata.displayName);
  });
});

describe("FT-16 keyboard, zoom, layout and reduced-motion contract", () => {
  it("uses native keyboard controls for every eligible core action", () => {
    const root = document.createElement("section");
    renderAttachmentAuthoritySurface(root, createAttachmentAuthorityViewModel(input({
      localTransport: { status: "none" },
      durable: { status: "ready", authoritySource: "projection" },
      sourceEligibility: "bound-active",
    })), actions());
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-attachment-actions] button"));
    expect(buttons.map((button) => button.getAttribute("data-action"))).toEqual(["preview", "download"]);
    expect(buttons.every((button) => button.getAttribute("type") === "button")).toBe(true);
    expect(buttons.every((button) => !button.hasAttribute("tabindex") || button.tabIndex >= 0)).toBe(true);
  });

  it("defines the required 1440×900/840×560 reflow, visible focus and reduced motion", () => {
    const css = readFileSync(resolve(import.meta.dirname, "attachment-authority.css"), "utf8");
    expect(css).toContain("max-inline-size: 100%");
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).toMatch(/@media\s*\(max-width:\s*52\.5rem\)/u);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(css).toContain("animation-duration: 0.01ms");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("flex-wrap: wrap");
    expect(css).not.toMatch(/display:\s*none[^}]*data-action/u);
  });

  it("marks reduced motion without changing state recognition", () => {
    const root = document.createElement("section");
    renderAttachmentAuthoritySurface(root, createAttachmentAuthorityViewModel(input({ reducedMotion: true })), actions());
    expect(root.dataset.motion).toBe("reduced");
    expect(root.querySelector("[data-status-label]")?.textContent).toContain("LOCAL SELECTED");
  });
});
