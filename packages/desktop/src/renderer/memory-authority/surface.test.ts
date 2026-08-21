import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMemoryAuthoritySurface, type MemorySurfaceActions } from "./surface.js";
import type { MemoryPanelInput } from "./view-model.js";

function state(overrides: Partial<MemoryPanelInput> = {}): MemoryPanelInput {
  return {
    roomId: "room-1", lifecycle: "active", connection: { status: "online" },
    query: { status: "ready" },
    health: { status: "healthy", memoryWatermark: 9, corpusHead: 9, lag: 0, retryable: false, recoveryRequired: false },
    viewer: { actorId: "human-1", currentHuman: true }, operation: { status: "idle" }, reducedMotion: false,
    memories: [{
      memoryRecordId: "context-1", memoryVersionId: "memory-version-2",
      version: 2, kind: "context", state: "active",
      derivedText: "Ship only after the review.", sources: [{
        sourceId: "message:1", sourceKind: "message", revision: 3, availability: "active",
        navigation: { kind: "message", messageId: "message-1" },
      }],
    }],
    ...overrides,
  };
}

function actions(): MemorySurfaceActions {
  return { onNavigateSource: vi.fn(), onDispute: vi.fn(), onResolve: vi.fn(), onRetry: vi.fn() };
}

afterEach(() => document.body.replaceChildren());

describe("FT-05 live Memory right-rail DOM contract", () => {
  it("renders five-kind identity, Context authority, watermark, and source deep link", () => {
    const root = document.createElement("aside");
    const handlers = actions();
    renderMemoryAuthoritySurface(root, state(), handlers);
    expect(root.querySelector("[data-memory-panel]")?.getAttribute("aria-label")).toBe("重要记忆 · 5 类");
    expect(root.querySelector("[data-memory-record-id='context-1']")?.textContent).toContain("CONTEXT · ACTIVE");
    expect(root.querySelector("[data-memory-version-id='memory-version-2']")).not.toBeNull();
    expect(root.querySelector("[data-memory-watermark]")?.textContent).toBe("STEWARD · #9 · 已同步");
    root.querySelector<HTMLButtonElement>("[data-source-id='message:1']")?.click();
    expect(handlers.onNavigateSource).toHaveBeenCalledWith({ kind: "message", messageId: "message-1" });
  });

  it("opens a dispute dialog locally, traps focus, submits intent, and returns focus on Escape", () => {
    const root = document.createElement("aside");
    document.body.append(root);
    const handlers = actions();
    renderMemoryAuthoritySurface(root, state(), handlers);
    const trigger = root.querySelector<HTMLButtonElement>("[data-action='dispute']")!;
    trigger.focus();
    trigger.click();
    const dialog = root.querySelector<HTMLElement>("[role='dialog'][data-memory-dialog='dispute']")!;
    expect(document.activeElement).toBe(dialog.querySelector("textarea"));
    const textarea = dialog.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "The date is no longer current.";
    dialog.querySelector<HTMLButtonElement>("[data-action='submit-dispute']")?.click();
    expect(handlers.onDispute).toHaveBeenCalledWith({
      memoryRecordId: "context-1", expectedVersion: 2, reason: "The date is no longer current.",
    });
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(trigger);
  });

  it("renders disputed Context as non-injectable and only exposes resolve to eligible authority projection", () => {
    const root = document.createElement("aside");
    renderMemoryAuthoritySurface(root, state({ memories: [{
      memoryRecordId: "context-1", version: 3, kind: "context", state: "disputed",
      derivedText: "Old date.", disputedBy: "human-1", canResolve: true, sources: [],
    }] }), actions());
    const card = root.querySelector<HTMLElement>("[data-memory-record-id='context-1']")!;
    expect(card.dataset.injectable).toBe("false");
    expect(card.textContent).toContain("DISPUTED");
    expect(card.querySelector("[data-action='resolve']")).not.toBeNull();
  });

  it("uses bounded low-frequency live status and turns source progress live-off", () => {
    const root = document.createElement("aside");
    renderMemoryAuthoritySurface(root, state({ health: {
      status: "catching_up", memoryWatermark: 9, corpusHead: 12, lag: 3,
      retryable: false, recoveryRequired: false,
    } }), actions());
    expect(root.querySelector("[data-memory-live]")?.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector("[data-memory-live]")?.textContent).not.toMatch(/9|12|3 条/u);
    expect(root.querySelector("[data-memory-sources]")?.getAttribute("aria-live")).toBe("off");
  });

  it("announces state with text/icon structure, locks archive, and honors reduced motion", () => {
    const root = document.createElement("aside");
    renderMemoryAuthoritySurface(root, state({ lifecycle: "archived", reducedMotion: true }), actions());
    const shell = root.querySelector<HTMLElement>("[data-memory-panel]")!;
    expect(shell.dataset.motion).toBe("reduced");
    expect(shell.dataset.visibleState).toBe("archived-read-only");
    expect(shell.textContent).toContain("ARCHIVED READ-ONLY");
    expect(shell.textContent).toMatch(/ICON|TEXT|LOCK/u);
    expect(root.querySelector<HTMLButtonElement>("[data-action='dispute']")?.disabled).toBe(true);
  });

  it("purges cards on revoke and never restores recalled raw content", () => {
    const root = document.createElement("aside");
    renderMemoryAuthoritySurface(root, state({ connection: { status: "revoked" } }), actions());
    expect(root.querySelectorAll("[data-memory-record-id]")).toHaveLength(0);
    expect(root.textContent).toContain("访问已撤销");
  });
});
