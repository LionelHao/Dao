// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  TOOL_PARAMETER_SCHEMAS,
  ToolParameterError,
  canonicalizeJsonRfc8785ProfileV1,
  parseToolParameters,
} from "./tool-parameters.js";

const emptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("FT-10 canonical physical tool parameters", () => {
  it("publishes one immutable parameter schema for each exact physical adapter", () => {
    expect(TOOL_PARAMETER_SCHEMAS).toEqual({
      "http-json.read": "http-json.read.parameters.v1",
      "repository.git-status": "repository.git-status.parameters.v1",
      "sandbox-file.write": "sandbox-file.write.parameters.v1",
    });
  });

  it("parses each of the three exact parameter objects and rejects extras", () => {
    expect(parseToolParameters({ toolId: "http-json.read", argumentsJson: "{\"path\":\"release-1\"}" }))
      .toMatchObject({ parsed: { path: "release-1" }, canonicalParameters: "{\"path\":\"release-1\"}" });
    expect(parseToolParameters({ toolId: "repository.git-status", argumentsJson: "{}" }))
      .toMatchObject({ parsed: {}, canonicalParameters: "{}" });
    expect(parseToolParameters({ toolId: "sandbox-file.write", argumentsJson: JSON.stringify({
      content: "hello", expectedCurrentSha256: emptySha256, path: "notes/release.txt",
    }) })).toMatchObject({
      parsed: { content: "hello", expectedCurrentSha256: emptySha256, path: "notes/release.txt" },
      canonicalParameters: `{"content":"hello","expectedCurrentSha256":"${emptySha256}","path":"notes/release.txt"}`,
    });

    for (const input of [
      { toolId: "http-json.read", argumentsJson: "{\"path\":\"release\",\"header\":\"secret\"}" },
      { toolId: "repository.git-status", argumentsJson: "{\"cwd\":\"/tmp\"}" },
      { toolId: "sandbox-file.write", argumentsJson: `{"path":"a","content":"x","expectedCurrentSha256":"${emptySha256}","token":"secret"}` },
    ] as const) {
      expect(() => parseToolParameters(input)).toThrowError(ToolParameterError);
      expect(() => parseToolParameters(input)).toThrowError(expect.objectContaining({ code: "extra_field" }));
    }
  });

  it("rejects duplicate decoded keys before JSON materialization", () => {
    for (const argumentsJson of [
      "{\"path\":\"one\",\"path\":\"two\"}",
      "{\"path\":\"one\",\"pa\\u0074h\":\"two\"}",
      "{\"path\":\"one\",\"nested\":{\"a\":1,\"a\":2}}",
    ]) {
      expect(() => parseToolParameters({ toolId: "http-json.read", argumentsJson }))
        .toThrowError(expect.objectContaining({ code: "duplicate_key" }));
    }
  });

  it("rejects non-JSON and non-finite numeric forms", () => {
    for (const argumentsJson of [
      "{\"path\":NaN}", "{\"path\":Infinity}", "{\"path\":1e400}", "{\"path\":01}",
    ]) {
      expect(() => parseToolParameters({ toolId: "http-json.read", argumentsJson }))
        .toThrowError(ToolParameterError);
    }
    expect(() => canonicalizeJsonRfc8785ProfileV1(Number.NaN))
      .toThrowError(expect.objectContaining({ code: "invalid_number" }));
    expect(() => canonicalizeJsonRfc8785ProfileV1(Number.POSITIVE_INFINITY))
      .toThrowError(expect.objectContaining({ code: "invalid_number" }));
  });

  it("requires NFC and rejects unpaired UTF-16 surrogates", () => {
    expect(() => parseToolParameters({
      toolId: "sandbox-file.write",
      argumentsJson: `{"path":"cafe\\u0301.txt","content":"x","expectedCurrentSha256":"${emptySha256}"}`,
    })).toThrowError(expect.objectContaining({ code: "non_nfc" }));
    expect(() => parseToolParameters({
      toolId: "sandbox-file.write",
      argumentsJson: `{"path":"ok.txt","content":"\\ud800","expectedCurrentSha256":"${emptySha256}"}`,
    })).toThrowError(expect.objectContaining({ code: "invalid_unicode" }));
  });

  it("enforces input bytes, structure depth, width, and canonical bytes", () => {
    expect(() => parseToolParameters({
      toolId: "http-json.read", argumentsJson: "{\"path\":\"123456789\"}",
      limits: { maxInputBytes: 8 },
    })).toThrowError(expect.objectContaining({ code: "bytes_exceeded" }));
    expect(() => parseToolParameters({
      toolId: "http-json.read", argumentsJson: "{\"path\":{\"x\":{\"y\":\"z\"}}}",
      limits: { maxDepth: 2 },
    })).toThrowError(expect.objectContaining({ code: "depth_exceeded" }));
    expect(() => parseToolParameters({
      toolId: "http-json.read", argumentsJson: "{\"path\":\"x\",\"a\":1}",
      limits: { maxContainerEntries: 1 },
    })).toThrowError(expect.objectContaining({ code: "width_exceeded" }));
    expect(() => canonicalizeJsonRfc8785ProfileV1({ a: "123456789" }, { maxCanonicalBytes: 5 }))
      .toThrowError(expect.objectContaining({ code: "bytes_exceeded" }));
  });

  it("is RFC 8785 compatible for ordering, JSON number spelling, and negative zero", () => {
    expect(canonicalizeJsonRfc8785ProfileV1({ z: -0, a: 1e30, middle: 0.000001 }))
      .toBe("{\"a\":1e+30,\"middle\":0.000001,\"z\":0}");
    expect(canonicalizeJsonRfc8785ProfileV1({ "\u20ac": 1, "\r": 2, "1": 3, "😀": 4 }))
      .toBe("{\"\\r\":2,\"1\":3,\"€\":1,\"😀\":4}");
  });

  it("keeps hashes stable across key order and domain separates tool/schema/canonicalizer versions", () => {
    const first = parseToolParameters({
      toolId: "sandbox-file.write",
      argumentsJson: `{"path":"a.txt","content":"x","expectedCurrentSha256":"${emptySha256}"}`,
    });
    const reordered = parseToolParameters({
      toolId: "sandbox-file.write",
      argumentsJson: `{"expectedCurrentSha256":"${emptySha256}","content":"x","path":"a.txt"}`,
    });
    const changed = parseToolParameters({
      toolId: "sandbox-file.write",
      argumentsJson: `{"path":"a.txt","content":"y","expectedCurrentSha256":"${emptySha256}"}`,
    });
    expect(first.canonicalParameterSha256).toBe(reordered.canonicalParameterSha256);
    expect(first.canonicalParameterSha256).toBe("467f750c609f2e284a7b7702e1944cdba74d7e0205a6b3ed48db782b9792bdca");
    expect(first.canonicalParameterSha256).not.toBe(changed.canonicalParameterSha256);
    expect(() => parseToolParameters({
      toolId: "sandbox-file.write", argumentsJson: first.canonicalParameters,
      expectedSchemaVersion: "sandbox-file.write.parameters.v2",
    })).toThrowError(expect.objectContaining({ code: "unsupported_version" }));
    expect(() => parseToolParameters({
      toolId: "sandbox-file.write", argumentsJson: first.canonicalParameters,
      canonicalizerVersion: "rfc8785-profile.v2",
    })).toThrowError(expect.objectContaining({ code: "unsupported_version" }));
  });

  it("produces deterministic bounded safe previews without content, credentials, headers, or roots", () => {
    const secret = "CONTENT_CANARY_token_header_Bearer_root";
    const parsed = parseToolParameters({
      toolId: "sandbox-file.write",
      argumentsJson: JSON.stringify({
        path: "notes/release.txt", content: secret, expectedCurrentSha256: emptySha256,
      }),
    });
    expect(parsed.safePreview).toEqual({
      schemaVersion: "tool-safe-preview.v1",
      target: "notes/release.txt",
      summary: `Create or replace a sandbox file (39 UTF-8 bytes; expected ${emptySha256.slice(0, 12)}…)`,
      impact: "Writes one configured sandbox-relative file after an exact hash fence",
      reversibility: "compensatable",
    });
    expect(parsed.safePreviewCanonical).not.toContain(secret);
    expect(Buffer.byteLength(parsed.safePreviewCanonical, "utf8")).toBeLessThanOrEqual(2_048);
    expect(parseToolParameters({ toolId: "repository.git-status", argumentsJson: "{}" }).safePreviewCanonical)
      .not.toContain("/Users/");
    const httpCanary = parseToolParameters({
      toolId: "http-json.read", argumentsJson: "{\"path\":\"Bearer_token_secret\"}",
    });
    expect(httpCanary.safePreviewCanonical).not.toContain("Bearer_token_secret");
  });

  it("rejects unknown tools and invalid paths without widening the adapter surface", () => {
    expect(() => parseToolParameters({ toolId: "room-memory.read", argumentsJson: "{}" }))
      .toThrowError(expect.objectContaining({ code: "unknown_tool" }));
    for (const path of ["", "/absolute", "../escape", "a//b", "a/./b", "a\\b"]) {
      expect(() => parseToolParameters({
        toolId: "sandbox-file.write",
        argumentsJson: JSON.stringify({ path, content: "x", expectedCurrentSha256: emptySha256 }),
      })).toThrowError(expect.objectContaining({ code: "invalid_shape" }));
    }
  });
});
