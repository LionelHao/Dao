import { describe, expect, it } from "vitest";
import {
  createDiagnosticsBundle,
  DIAGNOSTICS_MAX_ENTRIES,
} from "./diagnostics.js";

describe("FT-14 closed diagnostics bundle", () => {
  it("creates deterministic checksummed bounded output from allowlisted metadata", () => {
    const input = {
      generatedAt: "2026-08-31T00:00:00.000Z",
      entries: [
        { category: "worker" as const, code: "backlog_warning", occurredAt: "2026-08-31T00:00:02.000Z", stableId: "worker-2", queueDepth: 8 },
        { category: "schema" as const, code: "current", occurredAt: "2026-08-31T00:00:01.000Z", metadata: { version: 28, configured: true } },
      ],
    };
    const first = createDiagnosticsBundle(input);
    const second = createDiagnosticsBundle({ ...input, entries: [...input.entries].reverse() });
    expect(first.bytes).toEqual(second.bytes);
    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest).toMatchObject({ entryCount: 2, categories: ["schema", "worker"] });
    expect(first.filename).toMatch(/^dao-diagnostics-[A-Za-z0-9.T-]+\.ndjson$/);
  });

  it.each(["raw", "body", "message", "prompt", "secret", "token", "stack", "databasePath", "cacheKey"])(
    "rejects forbidden metadata key %s before producing bytes",
    (key) => {
      expect(() => createDiagnosticsBundle({
        generatedAt: "2026-08-31T00:00:00.000Z",
        entries: [{ category: "worker", code: "closed", occurredAt: "2026-08-31T00:00:00.000Z", metadata: { [key]: "opaque" } }],
      })).toThrow("forbidden");
    },
  );

  it("keeps corpus, credential and provider canaries out and rejects arbitrary strings", () => {
    const canaries = ["raw-message-sentinel with spaces", "sk-provider-secret", "/private/authority.sqlite"];
    for (const canary of canaries) {
      expect(() => createDiagnosticsBundle({
        generatedAt: "2026-08-31T00:00:00.000Z",
        entries: [{ category: "error_classification", code: "provider_failure", occurredAt: "2026-08-31T00:00:00.000Z", metadata: { detail: canary } }],
      })).toThrow();
    }
  });

  it.each([
    ["apiKey", "sk-provider-secret"],
    ["API_KEY", "sk-provider-secret"],
    ["messageBody", "raw-message-sentinel"],
    ["providerRequest", "opaque"],
  ])("rejects unknown case/camel metadata field %s", (key, value) => {
    expect(() => createDiagnosticsBundle({
      generatedAt: "2026-08-31T00:00:00.000Z",
      entries: [{ category: "schema", code: "current",
        occurredAt: "2026-08-31T00:00:00.000Z", metadata: { [key]: value } }],
    })).toThrow("forbidden");
  });

  it("rejects credential-shaped values in every remaining string slot", () => {
    for (const entry of [
      { category: "worker" as const, code: "sk-provider-secret",
        occurredAt: "2026-08-31T00:00:00.000Z" },
      { category: "worker" as const, code: "closed", stableId: "token:provider-secret",
        occurredAt: "2026-08-31T00:00:00.000Z" },
    ]) {
      expect(() => createDiagnosticsBundle({ generatedAt: entry.occurredAt, entries: [entry] }))
        .toThrow();
    }
  });

  it("rejects entry overflow without partial artifact output", () => {
    const entry = { category: "worker" as const, code: "ok", occurredAt: "2026-08-31T00:00:00.000Z" };
    expect(() => createDiagnosticsBundle({ generatedAt: entry.occurredAt, entries: Array.from({ length: DIAGNOSTICS_MAX_ENTRIES + 1 }, () => entry) })).toThrow("limit");
  });
});
