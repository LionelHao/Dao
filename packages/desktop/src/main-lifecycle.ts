export interface DesktopAppActivationSource {
  on(event: "activate", listener: () => void): void;
}

export interface DesktopWindowLifecycle {
  ensureWindow(): Promise<void>;
}

/**
 * Owns the single in-flight window creation attempt and the macOS dock-reactivation path.
 * A rejected attempt is released so a later activation can retry instead of stranding the app.
 */
export function installDesktopWindowLifecycle(options: {
  readonly platform: NodeJS.Platform;
  readonly app: DesktopAppActivationSource;
  readonly getWindowCount: () => number;
  readonly createWindow: () => Promise<void>;
  readonly onCreationError: (error: unknown) => void;
}): DesktopWindowLifecycle {
  let creation: Promise<void> | undefined;
  let activationObservation: Promise<void> | undefined;

  const ensureWindow = (): Promise<void> => {
    if (options.getWindowCount() > 0) return Promise.resolve();
    if (creation !== undefined) return creation;

    const attempt = Promise.resolve().then(options.createWindow);
    creation = attempt;
    void attempt.then(
      () => {
        if (creation === attempt) creation = undefined;
      },
      () => {
        if (creation === attempt) creation = undefined;
      },
    );
    return attempt;
  };

  if (options.platform === "darwin") {
    options.app.on("activate", () => {
      const attempt = ensureWindow();
      if (activationObservation === attempt) return;
      activationObservation = attempt;
      void attempt.then(
        () => {
          if (activationObservation === attempt) activationObservation = undefined;
        },
        (error: unknown) => {
          if (activationObservation === attempt) activationObservation = undefined;
          options.onCreationError(error);
        },
      );
    });
  }

  return Object.freeze({ ensureWindow });
}
