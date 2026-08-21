import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertWellFormed(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("Ill-formed Unicode is not canonical");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Ill-formed Unicode is not canonical");
    }
  }
}

function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormed(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError("Non-canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) throw new TypeError("Symbol array key");
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("Sparse array");
    }
    if (!keys.every((key) => key === "length" || (/^(0|[1-9]\d*)$/.test(String(key)) && Number(key) < value.length))) {
      throw new TypeError("Non-canonical array property");
    }
    return `[${value.map(encode).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Non-plain canonical object");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new TypeError("Symbol object key");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys as string[]) {
      assertWellFormed(key);
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !("value" in descriptor)) throw new TypeError("Covert object property");
    }
    return `{${(keys as string[]).sort(compareUtf8).map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical value: ${typeof value}`);
}

export function canonicalJsonV1(value: unknown): string {
  return encode(value);
}

export function sha256HexV1(value: string): string {
  assertWellFormed(value);
  return createHash("sha256").update(value, "utf8").digest("hex");
}
