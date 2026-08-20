import { describe, expect, it, vi } from "vitest";
import {
  createConfirmedProjectCheckpointParticipant,
  evaluateMemoryRuntimeGate,
  MemoryReadinessError,
  type MemoryRuntimeReadiness,
} from "./runtime-readiness.js";

function readiness(status: MemoryRuntimeReadiness["status"]): MemoryRuntimeReadiness {
  return {
    status,
    memoryWatermark: 12,
    corpusHead: status === "healthy" ? 12 : 15,
    rawDeltaComplete: status !== "failed",
    injectableSnapshotReadable: status !== "failed",
  };
}

describe("FT-05 explicit/proactive memory health gate", () => {
  it.each(["healthy", "catching_up", "noauth", "degraded", "failed"] as const)(
    "never blocks Human chat or explicit invocation for %s",
    (status) => {
      expect(evaluateMemoryRuntimeGate({ kind: "human_chat", memory: readiness(status) })).toEqual({ allowed: true });
      expect(evaluateMemoryRuntimeGate({ kind: "explicit_invocation", memory: readiness(status) })).toEqual({
        allowed: true,
        contextMode: status === "healthy" ? "snapshot" : status === "failed" ? "unavailable" : "snapshot_plus_raw_delta",
      });
    },
  );

  it("allows semantic proactive routing only with a healthy current memory projection", () => {
    expect(evaluateMemoryRuntimeGate({ kind: "semantic_proactive", memory: readiness("healthy") })).toEqual({ allowed: true });
    for (const status of ["catching_up", "noauth", "degraded", "failed"] as const) {
      expect(evaluateMemoryRuntimeGate({ kind: "semantic_proactive", memory: readiness(status) })).toEqual({
        allowed: false,
        reason: status === "failed" ? "memory_recovery_required" : `memory_${status}`,
      });
    }
  });

  it("allows deterministic due only from an enabled healthy checkpoint with an exact source", () => {
    expect(evaluateMemoryRuntimeGate({
      kind: "deterministic_due", memory: readiness("degraded"),
      project: { mode: "enabled", status: "healthy", sourceRef: "next-action:1:v3" },
    })).toEqual({ allowed: true, projectSourceRef: "next-action:1:v3" });
    expect(evaluateMemoryRuntimeGate({
      kind: "deterministic_due", memory: readiness("degraded"), project: { mode: "disabled" },
    })).toEqual({ allowed: false, reason: "project_checkpoint_disabled" });
    expect(evaluateMemoryRuntimeGate({
      kind: "deterministic_due", memory: readiness("degraded"), project: { mode: "enabled", status: "unavailable" },
    })).toEqual({ allowed: false, reason: "project_authority_unavailable" });
  });
});

describe("FT-09 future checkpoint participant configuration", () => {
  it("is explicitly disabled before FT-09 and never calls a fake or empty adapter", async () => {
    const participant = createConfirmedProjectCheckpointParticipant({ enabled: false });
    expect(participant.mode).toBe("disabled");
    await expect(participant.read("room-1")).resolves.toEqual({ mode: "disabled" });
  });

  it("fails readiness with 503 when enabled without a real participant", () => {
    expect(() => createConfirmedProjectCheckpointParticipant({ enabled: true })).toThrowError(MemoryReadinessError);
    try {
      createConfirmedProjectCheckpointParticipant({ enabled: true });
    } catch (error: unknown) {
      expect(error).toMatchObject({ status: 503, code: "project_checkpoint_participant_missing" });
    }
  });

  it("passes through only a real enabled checkpoint result", async () => {
    const read = vi.fn(async () => ({ status: "healthy" as const, sourceRef: "decision:2:v1" }));
    const participant = createConfirmedProjectCheckpointParticipant({ enabled: true, port: { read } });
    await expect(participant.read("room-2")).resolves.toEqual({
      mode: "enabled", status: "healthy", sourceRef: "decision:2:v1",
    });
    expect(read).toHaveBeenCalledWith("room-2");
  });
});
