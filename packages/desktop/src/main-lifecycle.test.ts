import { describe, expect, it, vi } from "vitest";
import { installDesktopWindowLifecycle } from "./main-lifecycle.js";

describe("Desktop main-process window lifecycle", () => {
  it("recreates the window on macOS activate only when no window exists", async () => {
    let activate: (() => void) | undefined;
    let windowCount = 1;
    const createWindow = vi.fn(async () => undefined);
    const onCreationError = vi.fn();
    const lifecycle = installDesktopWindowLifecycle({
      platform: "darwin",
      app: {
        on(event, listener) {
          expect(event).toBe("activate");
          activate = listener;
        },
      },
      getWindowCount: () => windowCount,
      createWindow,
      onCreationError,
    });

    activate?.();
    await Promise.resolve();
    expect(createWindow).not.toHaveBeenCalled();

    windowCount = 0;
    activate?.();
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledOnce());
    await expect(lifecycle.ensureWindow()).resolves.toBeUndefined();
    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(onCreationError).not.toHaveBeenCalled();
  });

  it("coalesces concurrent creation and permits retry after a rejected attempt", async () => {
    let activate: (() => void) | undefined;
    let rejectAttempt!: (error: Error) => void;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectAttempt = reject;
    });
    const createWindow = vi.fn()
      .mockReturnValueOnce(firstAttempt)
      .mockResolvedValueOnce(undefined);
    const onCreationError = vi.fn();
    const lifecycle = installDesktopWindowLifecycle({
      platform: "darwin",
      app: { on: (_event, listener) => { activate = listener; } },
      getWindowCount: () => 0,
      createWindow,
      onCreationError,
    });

    activate?.();
    activate?.();
    await Promise.resolve();
    expect(createWindow).toHaveBeenCalledOnce();
    rejectAttempt(new Error("window creation failed"));
    await vi.waitFor(() => expect(onCreationError).toHaveBeenCalledOnce());

    activate?.();
    await vi.waitFor(() => expect(createWindow).toHaveBeenCalledTimes(2));
    await expect(lifecycle.ensureWindow()).resolves.toBeUndefined();
  });

  it("does not register macOS reactivation on other platforms", () => {
    const app = { on: vi.fn() };
    installDesktopWindowLifecycle({
      platform: "linux",
      app,
      getWindowCount: () => 0,
      createWindow: vi.fn(async () => undefined),
      onCreationError: vi.fn(),
    });
    expect(app.on).not.toHaveBeenCalled();
  });
});
