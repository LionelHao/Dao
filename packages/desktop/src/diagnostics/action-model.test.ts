import { describe, expect, it, vi } from "vitest";
import { createDiagnosticsActionModel } from "./action-model.js";

describe("FT-14 diagnostics renderer-safe action model", () => {
  it("announces saved/cancelled outcomes and deduplicates an active click", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bridge = { save: vi.fn(async () => { await gate; return { status: "saved" as const }; }) };
    const model = createDiagnosticsActionModel(bridge);
    const first = model.save();
    const second = model.save();
    expect(second).toBe(first);
    expect(model.getState()).toMatchObject({ status: "saving", disabled: true,
      ariaLive: "polite" });
    release();
    await first;
    expect(model.getState()).toEqual({ status: "saved", disabled: false,
      ariaLive: "polite", announcement: "诊断包已保存。" });
    expect(bridge.save).toHaveBeenCalledOnce();
  });

  it("exposes only closed recovery copy and never preserves raw failure material", async () => {
    const bridge = { save: vi.fn(async () => {
      throw Object.assign(new Error("provider-secret-canary /private/db.sqlite"), {
        diagnosticsError: { status: 403, code: "administrator_required" },
      });
    }) };
    const model = createDiagnosticsActionModel(bridge);
    await model.save();
    expect(model.getState()).toMatchObject({ status: "failed", disabled: false,
      ariaLive: "assertive", error: { status: 403, code: "administrator_required" } });
    expect(JSON.stringify(model.getState())).not.toMatch(/canary|private|sqlite/u);
    model.reset();
    expect(model.getState()).toMatchObject({ status: "idle", ariaLive: "off" });
  });
});
