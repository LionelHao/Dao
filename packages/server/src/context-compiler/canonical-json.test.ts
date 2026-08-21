import { describe, expect, it } from "vitest";
import { canonicalJsonV1, compareUtf8, sha256HexV1 } from "./canonical-json.js";

describe("canonical JSON v1", () => {
  it("orders object keys by UTF-8 bytes and ignores insertion order", () => {
    expect(canonicalJsonV1({ z: 1, a: 2, "é": 3 })).toBe('{"a":2,"z":1,"é":3}');
    expect(canonicalJsonV1({ a: 2, z: 1, "é": 3 })).toBe('{"a":2,"z":1,"é":3}');
    expect(compareUtf8("z", "é")).toBeLessThan(0);
  });

  it("rejects non-canonical or covert JavaScript values", () => {
    expect(() => canonicalJsonV1({ value: undefined })).toThrow();
    expect(() => canonicalJsonV1({ value: Number.NaN })).toThrow();
    expect(() => canonicalJsonV1(Object.defineProperty({ a: 1 }, "secret", { value: 2 }))).toThrow();
    expect(() => canonicalJsonV1({ [Symbol("secret")]: true })).toThrow();
    expect(() => canonicalJsonV1(Array(1))).toThrow();
  });

  it("hashes the exact canonical UTF-8 bytes with standard SHA-256", () => {
    expect(sha256HexV1("{}")).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });
});
