import { describe, expect, it } from "vitest";
import {
  ToolParameterSealer,
  ToolPayloadSealingError,
  TOOL_SEALED_PAYLOAD_HARD_MAX_BYTES,
} from "./tool-parameter-sealer.js";

const NOW = Date.parse("2026-08-30T08:00:00.000Z");
const EXPIRY = "2026-08-30T08:05:00.000Z";

describe("server-private tool parameter sealer", () => {
  it("binds AES-GCM ciphertext to the full caller-provided AAD and key version", () => {
    const key = { version: "tool-key-v1", bytes: new Uint8Array(32).fill(7) };
    const sealer = new ToolParameterSealer((version) =>
      version === undefined || version === key.version ? key : undefined);
    const plaintext = new TextEncoder().encode('{"content":"private"}');
    const sealed = sealer.seal(plaintext, new TextEncoder().encode("binding-a"), EXPIRY, NOW);

    expect(Array.from(plaintext)).toEqual(new Array(plaintext.byteLength).fill(0));
    expect(new TextDecoder().decode(
      sealer.open(sealed, new TextEncoder().encode("binding-a"), NOW),
    )).toBe('{"content":"private"}');
    expect(() => sealer.open(sealed, new TextEncoder().encode("binding-b"), NOW))
      .toThrow(ToolPayloadSealingError);
    expect(JSON.stringify(sealed)).not.toContain("private");
  });

  it("fails closed for absent or malformed keys, expiry, tamper, and byte ceilings", () => {
    const unavailable = new ToolParameterSealer(() => undefined);
    expect(unavailable.readiness()).toBe("not_ready");
    expect(() => unavailable.seal(new Uint8Array([1]), new Uint8Array([2]), EXPIRY, NOW))
      .toThrow(/not_ready/);

    const key = { version: "tool-key-v1", bytes: new Uint8Array(32).fill(3) };
    const sealer = new ToolParameterSealer(() => key);
    expect(() => sealer.seal(
      new Uint8Array(TOOL_SEALED_PAYLOAD_HARD_MAX_BYTES + 1), new Uint8Array([2]), EXPIRY, NOW,
    )).toThrow(/invalid_input/);
    const sealed = sealer.seal(new Uint8Array([1]), new Uint8Array([2]), EXPIRY, NOW);
    expect(() => sealer.open({ ...sealed, ciphertext: `${sealed.ciphertext}A` }, new Uint8Array([2]), NOW))
      .toThrow(ToolPayloadSealingError);
    expect(() => sealer.open(sealed, new Uint8Array([2]), Date.parse(EXPIRY)))
      .toThrow(/expired/);
  });
});
