import { randomUUID } from "node:crypto";
import {
  createDiagnosticsService,
  DiagnosticsServiceError,
  type DiagnosticsGenerationResult,
  type DiagnosticsServiceAuthority,
} from "./diagnostics-service.js";
import {
  createHostedRetentionOperationsAdapter,
  type HostedOperationsTrigger,
  type HostedRetentionBatchPort,
  type HostedRetentionRunResult,
  type OperationsRuntimeAlertSink,
} from "./operations-runtime.js";
import {
  createRoomExportAuthorityAdapter,
  type RoomExportAuthorityPorts,
} from "./room-export-authority-adapter.js";
import { createRoomDataExport } from "./room-export.js";
import { requireOperationsWorkerPolicy } from "./worker-inventory.js";
import {
  createOperationsWorkerLimiter,
  OperationsWorkerLimitError,
} from "./worker-limiter.js";

export class PrivacyOperationsRuntimeError extends Error {
  constructor(readonly code: "closed") {
    super(`Privacy operations runtime failed: ${code}`);
    this.name = "PrivacyOperationsRuntimeError";
  }
}

export interface PrivacyOperationsProductionIntegration {
  /**
   * Deliberately data-only. There is no mutation function until an approved,
   * durable production secret backend is composed.
   */
  readonly credentialRotation: Readonly<{
    readonly status: "configuration_unsupported";
  }>;
  generateDiagnostics(input: Readonly<{
    actorId: string;
    sessionFamilyId: string;
    sessionId: string;
  }>, signal?: AbortSignal): Promise<DiagnosticsGenerationResult>;
  streamRoomExport(input: Readonly<{
    actorId: string;
    roomId: string;
    sessionFamilyId: string;
    sessionId: string;
  }>, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  /** Runs one AuthorityWorker-owned batch. The existing host decides rescheduling. */
  runHostedRetention(
    trigger: HostedOperationsTrigger,
    nowMs: number,
  ): Promise<HostedRetentionRunResult>;
  shutdown(): Promise<Readonly<{ status: "drained" | "shutdown_timeout" }>>;
}

/**
 * Composes the FT-14 closed services without starting a timer, scheduler,
 * event bus, HTTP listener, or second persistence writer.
 */
export function createPrivacyOperationsProductionIntegration(options: Readonly<{
  diagnosticsAuthority: DiagnosticsServiceAuthority;
  roomExportAuthority: RoomExportAuthorityPorts;
  retentionBatchPort: HostedRetentionBatchPort;
  alertSink?: OperationsRuntimeAlertSink;
  now?: () => Date;
  retentionTimeoutMs?: number;
  shutdownDrainMs?: number;
}>): PrivacyOperationsProductionIntegration {
  const diagnostics = createDiagnosticsService({
    authority: options.diagnosticsAuthority,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const roomExport = createRoomDataExport({
    authority: createRoomExportAuthorityAdapter(options.roomExportAuthority),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const diagnosticsLimiter = createOperationsWorkerLimiter(
    requireOperationsWorkerPolicy("diagnostics_generation"),
  );
  const roomExportLimiter = createOperationsWorkerLimiter(
    requireOperationsWorkerPolicy("room_export"),
  );
  const retention = createHostedRetentionOperationsAdapter({
    batchPort: options.retentionBatchPort,
    ...(options.alertSink === undefined ? {} : { alertSink: options.alertSink }),
    ...(options.retentionTimeoutMs === undefined
      ? {} : { timeoutMs: options.retentionTimeoutMs }),
    ...(options.shutdownDrainMs === undefined
      ? {} : { shutdownDrainMs: options.shutdownDrainMs }),
  });
  let closed = false;
  let closeResult: Promise<Readonly<{ status: "drained" | "shutdown_timeout" }>> | undefined;

  return Object.freeze({
    credentialRotation: Object.freeze({ status: "configuration_unsupported" as const }),
    async generateDiagnostics(
      input: Parameters<PrivacyOperationsProductionIntegration["generateDiagnostics"]>[0],
      externalSignal?: AbortSignal,
    ) {
      if (closed) throw new PrivacyOperationsRuntimeError("closed");
      try {
        return await diagnosticsLimiter.run(async (limitSignal) => {
          if (externalSignal === undefined) return diagnostics.generate(input, limitSignal);
          const controller = new AbortController();
          const abort = () => controller.abort();
          limitSignal.addEventListener("abort", abort, { once: true });
          externalSignal.addEventListener("abort", abort, { once: true });
          if (limitSignal.aborted || externalSignal.aborted) abort();
          try {
            return await diagnostics.generate(input, controller.signal);
          } finally {
            limitSignal.removeEventListener("abort", abort);
            externalSignal.removeEventListener("abort", abort);
          }
        });
      } catch (error) {
        if (error instanceof OperationsWorkerLimitError) {
          await options.diagnosticsAuthority.audit({
            actorId: input.actorId,
            occurredAt: (options.now ?? (() => new Date()))().toISOString(),
            result: "failed",
            failureCode: "source_unavailable",
          }).catch(() => undefined);
          throw error;
        }
        if (error instanceof DiagnosticsServiceError) throw error;
        throw new DiagnosticsServiceError("source_unavailable");
      }
    },
    async *streamRoomExport(
      input: Parameters<PrivacyOperationsProductionIntegration["streamRoomExport"]>[0],
      externalSignal?: AbortSignal,
    ) {
      if (closed) throw new PrivacyOperationsRuntimeError("closed");
      try {
        for await (const chunk of roomExportLimiter.stream(
          (limitSignal) => roomExport.stream(input, externalSignal === undefined
            ? limitSignal
            : AbortSignal.any([limitSignal, externalSignal])),
        )) {
          yield chunk;
        }
      } catch (error) {
        if (error instanceof OperationsWorkerLimitError &&
            error.code === "operations_capacity_limited") {
          const occurredAt = (options.now ?? (() => new Date()))().toISOString();
          await options.roomExportAuthority.audit.append({
            exportId: `rejected:${randomUUID()}`,
            requesterActorId: input.actorId,
            roomId: input.roomId,
            watermark: 0,
            startedAt: occurredAt,
            result: "failed",
            failureCode: "capacity_exceeded",
          }).catch(() => undefined);
        }
        throw error;
      }
    },
    runHostedRetention(trigger: HostedOperationsTrigger, nowMs: number) {
      if (closed) return Promise.resolve(Object.freeze({ status: "closed" as const }));
      return retention.run(trigger, nowMs);
    },
    shutdown() {
      closed = true;
      closeResult ??= retention.shutdown();
      return closeResult;
    },
  });
}
