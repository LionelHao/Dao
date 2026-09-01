import type { DiagnosticsStreamTransport } from "./runtime.js";
import type {
  DiagnosticsAbortCommand,
  DiagnosticsGenerateCommand,
  DiagnosticsReadCommand,
} from "./stream-contracts.js";

export interface DiagnosticsSameSocketRpcPort {
  diagnosticsGenerate(command: DiagnosticsGenerateCommand):
    ReturnType<DiagnosticsStreamTransport["generate"]>;
  diagnosticsRead(command: DiagnosticsReadCommand):
    ReturnType<DiagnosticsStreamTransport["read"]>;
  diagnosticsAbort(command: DiagnosticsAbortCommand):
    ReturnType<DiagnosticsStreamTransport["abort"]>;
}

/** Reuses Message Authority's authenticated socket and owns no connection or scheduler. */
export function createDiagnosticsWebSocketTransport(
  transport: DiagnosticsSameSocketRpcPort,
): DiagnosticsStreamTransport {
  return Object.freeze({
    generate: (command: DiagnosticsGenerateCommand) => transport.diagnosticsGenerate(command),
    read: (command: DiagnosticsReadCommand) => transport.diagnosticsRead(command),
    abort: (command: DiagnosticsAbortCommand) => transport.diagnosticsAbort(command),
  });
}
