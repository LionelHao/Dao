export const STRUCTURAL_OVERHEAD_V1 = Object.freeze({
  content: 32,
  trusted: 48,
  identity: 64,
  tool: 64,
  manifest: 48,
});

export type StructuredTokenKindV1 = keyof typeof STRUCTURAL_OVERHEAD_V1;

function assertWellFormed(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("Ill-formed Unicode cannot be estimated");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Ill-formed Unicode cannot be estimated");
    }
  }
}

export function utf8ByteLength(value: string): number {
  assertWellFormed(value);
  return Buffer.byteLength(value, "utf8");
}

export function estimateStructuredTokensV1(value: string, kind: StructuredTokenKindV1): number {
  return utf8ByteLength(value) + STRUCTURAL_OVERHEAD_V1[kind];
}
