import {
  DIAGNOSTICS_IPC_CHANNELS,
  cloneDiagnosticsSaveResult,
  isDiagnosticsClosedError,
  type DiagnosticsClosedError,
} from "./contracts.js";

interface DiagnosticsIpcEvent {
  readonly sender: unknown;
  readonly senderFrame: unknown;
}

export interface DiagnosticsIpcMain {
  handle(channel: string, handler: (event: DiagnosticsIpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface DiagnosticsIpcWebContents {
  readonly mainFrame: unknown;
}

export interface DiagnosticsRuntimePort {
  save(): Promise<Readonly<{ status: "saved" | "cancelled" }>>;
}

export class DiagnosticsIpcError extends Error {
  readonly diagnosticsError: DiagnosticsClosedError;

  constructor(error: DiagnosticsClosedError) {
    super(`Diagnostics save failed: ${error.status} ${error.code}`);
    this.name = "DiagnosticsIpcError";
    this.diagnosticsError = structuredClone(error);
  }
}

function sanitized(error: unknown): never {
  if (typeof error === "object" && error !== null && "diagnosticsError" in error &&
      isDiagnosticsClosedError(error.diagnosticsError)) {
    throw new DiagnosticsIpcError(error.diagnosticsError);
  }
  throw new DiagnosticsIpcError({ status: 503, code: "diagnostics_unavailable" });
}

export function registerDiagnosticsIpc(options: Readonly<{
  ipcMain: DiagnosticsIpcMain;
  webContents: DiagnosticsIpcWebContents;
  runtime: DiagnosticsRuntimePort;
}>): () => void {
  const { ipcMain, webContents, runtime } = options;
  ipcMain.handle(DIAGNOSTICS_IPC_CHANNELS.save, async (event, ...args) => {
    if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) {
      throw new TypeError("Diagnostics IPC requires the trusted main frame");
    }
    if (args.length !== 0) throw new TypeError("Diagnostics save accepts no renderer arguments");
    try {
      return cloneDiagnosticsSaveResult(await runtime.save());
    } catch (error) {
      sanitized(error);
    }
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcMain.removeHandler(DIAGNOSTICS_IPC_CHANNELS.save);
  };
}
