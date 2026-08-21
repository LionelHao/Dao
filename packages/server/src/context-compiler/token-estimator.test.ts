import { describe, expect, it } from "vitest";
import {
  STRUCTURAL_OVERHEAD_V1,
  estimateStructuredTokensV1,
  utf8ByteLength,
} from "./token-estimator.js";

describe("deterministic_utf8_v1", () => {
  it("counts UTF-8 bytes plus a fixed structural overhead", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("🙂")).toBe(4);
    expect(utf8ByteLength("e\u0301")).toBe(3);
    expect(estimateStructuredTokensV1("abc", "content")).toBe(3 + STRUCTURAL_OVERHEAD_V1.content);
  });

  it("has an exact budget boundary with no tokenizer or model dependency", () => {
    const budget = 64;
    const exact = "x".repeat(budget - STRUCTURAL_OVERHEAD_V1.content);
    expect(estimateStructuredTokensV1(exact, "content")).toBe(budget);
    expect(estimateStructuredTokensV1(`${exact}x`, "content")).toBe(budget + 1);
  });

  it("rejects ill-formed UTF-16 rather than silently replacing it", () => {
    expect(() => utf8ByteLength("\ud800")).toThrow(/Unicode/);
  });
});
