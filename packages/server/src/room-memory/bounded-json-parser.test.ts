import { describe, expect, it } from "vitest";
import { BoundedJsonParseError, parseBoundedJson } from "./bounded-json-parser.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("bounded duplicate-aware JSON parser", () => {
  it("parses one complete UTF-8 JSON value", () => {
    expect(parseBoundedJson(bytes('{"schemaVersion":1,"items":[true,null,"记忆"]}'), 1_024))
      .toEqual({ schemaVersion: 1, items: [true, null, "记忆"] });
  });

  it.each([
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"candidate":{"kind":"goal","kind":"context"}}',
    '{"source":{"sourceId":"one","\\u0073ourceId":"two"}}',
  ])("rejects duplicate keys at every depth: %s", (json) => {
    expect(() => parseBoundedJson(bytes(json), 1_024)).toThrowError(BoundedJsonParseError);
    expect(() => parseBoundedJson(bytes(json), 1_024)).toThrowError(expect.objectContaining({
      code: "duplicate_key",
    }));
  });

  it("rejects invalid UTF-8, lone surrogate escapes, truncation, and trailing data", () => {
    const cases = [
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
      bytes('{"x":"\\ud800"}'),
      bytes('{"x":'),
      bytes('{"x":1} {"y":2}'),
    ];
    for (const input of cases) {
      expect(() => parseBoundedJson(input, 1_024)).toThrowError(BoundedJsonParseError);
    }
  });

  it("enforces the byte bound before decoding", () => {
    expect(() => parseBoundedJson(bytes('{"text":"12345"}'), 8)).toThrowError(
      expect.objectContaining({ code: "too_large" }),
    );
  });

  it("treats __proto__ as inert data instead of mutating the result prototype", () => {
    const parsed = parseBoundedJson(bytes('{"__proto__":{"polluted":true}}'), 1_024) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
