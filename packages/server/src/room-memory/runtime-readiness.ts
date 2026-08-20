export type MemoryRuntimeHealth = "healthy" | "catching_up" | "noauth" | "degraded" | "failed";

export interface MemoryRuntimeReadiness {
  readonly status: MemoryRuntimeHealth;
  readonly memoryWatermark: number;
  readonly corpusHead: number;
  readonly rawDeltaComplete: boolean;
  readonly injectableSnapshotReadable: boolean;
}

export type ProjectCheckpointReadiness =
  | { readonly mode: "disabled" }
  | { readonly mode: "enabled"; readonly status: "healthy"; readonly sourceRef: string }
  | { readonly mode: "enabled"; readonly status: "unavailable" };

export type MemoryRuntimeGateInput =
  | { readonly kind: "human_chat"; readonly memory: MemoryRuntimeReadiness }
  | { readonly kind: "explicit_invocation"; readonly memory: MemoryRuntimeReadiness }
  | { readonly kind: "semantic_proactive"; readonly memory: MemoryRuntimeReadiness }
  | { readonly kind: "deterministic_due"; readonly memory: MemoryRuntimeReadiness; readonly project: ProjectCheckpointReadiness };

export type MemoryRuntimeGateResult =
  | { readonly allowed: true; readonly contextMode?: "snapshot" | "snapshot_plus_raw_delta" | "unavailable"; readonly projectSourceRef?: string }
  | { readonly allowed: false; readonly reason: string };

function validReadiness(value: MemoryRuntimeReadiness): void {
  if (!Number.isSafeInteger(value.memoryWatermark) || value.memoryWatermark < 0 ||
      !Number.isSafeInteger(value.corpusHead) || value.corpusHead < value.memoryWatermark) {
    throw new TypeError("Memory readiness watermark was invalid");
  }
  if (value.status === "healthy" && value.memoryWatermark !== value.corpusHead) {
    throw new TypeError("Healthy memory readiness cannot have lag");
  }
}

export function evaluateMemoryRuntimeGate(input: MemoryRuntimeGateInput): MemoryRuntimeGateResult {
  validReadiness(input.memory);
  if (input.kind === "human_chat") return Object.freeze({ allowed: true });
  if (input.kind === "explicit_invocation") {
    const contextMode = input.memory.status === "healthy"
      ? "snapshot"
      : input.memory.injectableSnapshotReadable && input.memory.rawDeltaComplete
        ? "snapshot_plus_raw_delta"
        : "unavailable";
    return Object.freeze({ allowed: true, contextMode });
  }
  if (input.kind === "semantic_proactive") {
    if (input.memory.status === "healthy") return Object.freeze({ allowed: true });
    return Object.freeze({
      allowed: false,
      reason: input.memory.status === "failed" ? "memory_recovery_required" : `memory_${input.memory.status}`,
    });
  }
  if (input.project.mode === "disabled") {
    return Object.freeze({ allowed: false, reason: "project_checkpoint_disabled" });
  }
  if (input.project.status !== "healthy") {
    return Object.freeze({ allowed: false, reason: "project_authority_unavailable" });
  }
  if (input.project.sourceRef.length < 1 || input.project.sourceRef.length > 512) {
    return Object.freeze({ allowed: false, reason: "project_source_invalid" });
  }
  return Object.freeze({ allowed: true, projectSourceRef: input.project.sourceRef });
}

export class MemoryReadinessError extends Error {
  public readonly status = 503 as const;
  public constructor(public readonly code: "project_checkpoint_participant_missing") {
    super("Confirmed project checkpoint participant is unavailable");
    this.name = "MemoryReadinessError";
  }
}

export interface ConfirmedProjectCheckpointPort {
  readonly read: (roomId: string) => Promise<
    | { readonly status: "healthy"; readonly sourceRef: string }
    | { readonly status: "unavailable" }
  >;
}

export interface ConfirmedProjectCheckpointParticipant {
  readonly mode: "disabled" | "enabled";
  readonly read: (roomId: string) => Promise<ProjectCheckpointReadiness>;
}

function roomId(value: string): string {
  if (value.length < 1 || value.length > 256) throw new TypeError("roomId was invalid");
  return value;
}

export function createConfirmedProjectCheckpointParticipant(options:
  | { readonly enabled: false }
  | { readonly enabled: true; readonly port?: ConfirmedProjectCheckpointPort },
): ConfirmedProjectCheckpointParticipant {
  if (!options.enabled) {
    return Object.freeze({
      mode: "disabled" as const,
      async read(inputRoomId: string): Promise<ProjectCheckpointReadiness> {
        roomId(inputRoomId);
        return Object.freeze({ mode: "disabled" as const });
      },
    });
  }
  if (options.port === undefined) throw new MemoryReadinessError("project_checkpoint_participant_missing");
  const port = options.port;
  return Object.freeze({
    mode: "enabled" as const,
    async read(inputRoomId: string): Promise<ProjectCheckpointReadiness> {
      const result = await port.read(roomId(inputRoomId));
      if (result.status === "unavailable") {
        return Object.freeze({ mode: "enabled" as const, status: "unavailable" as const });
      }
      if (result.sourceRef.length < 1 || result.sourceRef.length > 512) {
        return Object.freeze({ mode: "enabled" as const, status: "unavailable" as const });
      }
      return Object.freeze({
        mode: "enabled" as const,
        status: "healthy" as const,
        sourceRef: result.sourceRef,
      });
    },
  });
}
