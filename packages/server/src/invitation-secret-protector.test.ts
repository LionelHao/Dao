import { describe, expect, it } from "vitest";
import { createAesGcmInvitationSecretProtector } from "./invitation-secret-protector.js";

describe("AES-GCM invitation secret protection", () => {
  it("seals a token without retaining plaintext and opens it byte-identically", () => {
    const protector = createAesGcmInvitationSecretProtector(new Uint8Array(32).fill(7));
    const token = "invitation-token-with-private-bytes";

    const first = protector.seal(token);
    const second = protector.seal(token);

    expect(first).not.toBe(second);
    expect(first).not.toContain(token);
    expect(protector.open(first)).toBe(token);
    expect(protector.open(second)).toBe(token);
  });

  it("requires a 32-byte key", () => {
    expect(() =>
      createAesGcmInvitationSecretProtector(new Uint8Array(31)),
    ).toThrow(TypeError);
    expect(() =>
      createAesGcmInvitationSecretProtector(new Uint8Array(33)),
    ).toThrow(TypeError);
  });

  it("fails closed for a wrong key, malformed ciphertext, and tampering", () => {
    const first = createAesGcmInvitationSecretProtector(new Uint8Array(32).fill(1));
    const second = createAesGcmInvitationSecretProtector(new Uint8Array(32).fill(2));
    const ciphertext = first.seal("private-token");

    expect(() => second.open(ciphertext)).toThrowError(
      expect.objectContaining({ code: "invitation_secret_unavailable" }),
    );
    expect(() => first.open("not-a-sealed-token")).toThrowError(
      expect.objectContaining({ code: "invitation_secret_unavailable" }),
    );

    const parts = ciphertext.split(".");
    const tag = Buffer.from(parts[3] ?? "", "base64url");
    tag[0] = (tag[0] ?? 0) ^ 1;
    const tampered = [parts[0], parts[1], parts[2], tag.toString("base64url")].join(".");
    expect(() => first.open(tampered)).toThrowError(
      expect.objectContaining({ code: "invitation_secret_unavailable" }),
    );

    const canonicalTag = parts[3] ?? "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastIndex = alphabet.indexOf(canonicalTag.at(-1) ?? "");
    const nonCanonicalTag = `${canonicalTag.slice(0, -1)}${alphabet[lastIndex + 1]}`;
    expect(Buffer.from(nonCanonicalTag, "base64url")).toEqual(Buffer.from(canonicalTag, "base64url"));
    expect(() => first.open([parts[0], parts[1], parts[2], nonCanonicalTag].join(".")))
      .toThrowError(expect.objectContaining({ code: "invitation_secret_unavailable" }));
  });
});
