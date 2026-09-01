import { describe, expect, it } from "vitest";
import {
  DIAGNOSTICS_IPC_CHANNELS,
  isDiagnosticsClosedError,
  isDiagnosticsSaveResult,
} from "./contracts.js";

describe("FT-14 diagnostics renderer contract", () => {
  it("exposes one no-argument save result and a closed error set", () => {
    expect(DIAGNOSTICS_IPC_CHANNELS).toEqual({ save: "diagnostics:save" });
    expect(isDiagnosticsSaveResult({ status: "saved" })).toBe(true);
    expect(isDiagnosticsSaveResult({ status: "cancelled" })).toBe(true);
    expect(isDiagnosticsSaveResult({ status: "saved", path: "/private/diagnostics" })).toBe(false);
    expect(isDiagnosticsClosedError({
      status: 429, code: "diagnostics_capacity_limited", retryAfterMs: 1_000,
    })).toBe(true);
    expect(isDiagnosticsClosedError({
      status: 503, code: "generic_fs", detail: "secret",
    })).toBe(false);
  });
});
