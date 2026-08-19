export type BoundedJsonParseErrorCode =
  | "too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "duplicate_key"
  | "too_deep";

export class BoundedJsonParseError extends Error {
  constructor(readonly code: BoundedJsonParseErrorCode) {
    super("Bounded JSON input was rejected");
    this.name = "BoundedJsonParseError";
  }
}

const MAX_DEPTH = 64;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

class Parser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) this.fail("invalid_json");
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail("too_deep");
    const next = this.source[this.offset];
    if (next === "{") return this.parseObject(depth + 1);
    if (next === "[") return this.parseArray(depth + 1);
    if (next === "\"") return this.parseString();
    if (next === "t") return this.parseLiteral("true", true);
    if (next === "f") return this.parseLiteral("false", false);
    if (next === "n") return this.parseLiteral("null", null);
    if (next === "-" || (next !== undefined && next >= "0" && next <= "9")) return this.parseNumber();
    return this.fail("invalid_json");
  }

  private parseObject(depth: number): Record<string, unknown> {
    this.offset += 1;
    const output: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return output;
    }
    while (true) {
      if (this.source[this.offset] !== "\"") this.fail("invalid_json");
      const key = this.parseString();
      if (keys.has(key)) this.fail("duplicate_key");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.offset] !== ":") this.fail("invalid_json");
      this.offset += 1;
      this.skipWhitespace();
      const value = this.parseValue(depth);
      Object.defineProperty(output, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "}") {
        this.offset += 1;
        return output;
      }
      if (separator !== ",") this.fail("invalid_json");
      this.offset += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): unknown[] {
    this.offset += 1;
    const output: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return output;
    }
    while (true) {
      output.push(this.parseValue(depth));
      this.skipWhitespace();
      const separator = this.source[this.offset];
      if (separator === "]") {
        this.offset += 1;
        return output;
      }
      if (separator !== ",") this.fail("invalid_json");
      this.offset += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const current = this.source.charCodeAt(this.offset);
      if (current === 0x22) {
        this.offset += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.offset));
        } catch {
          return this.fail("invalid_json");
        }
        if (typeof value !== "string" || hasUnpairedSurrogate(value)) return this.fail("invalid_json");
        return value;
      }
      if (current < 0x20) return this.fail("invalid_json");
      if (current === 0x5c) {
        this.offset += 1;
        const escape = this.source[this.offset];
        if (escape === "u") {
          const hex = this.source.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return this.fail("invalid_json");
          this.offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return this.fail("invalid_json");
      }
      this.offset += 1;
    }
    return this.fail("invalid_json");
  }

  private parseNumber(): number {
    const remainder = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remainder);
    if (match === null) return this.fail("invalid_json");
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return this.fail("invalid_json");
    return value;
  }

  private parseLiteral<T>(token: string, value: T): T {
    if (!this.source.startsWith(token, this.offset)) return this.fail("invalid_json");
    this.offset += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (true) {
      const current = this.source.charCodeAt(this.offset);
      if (current !== 0x20 && current !== 0x09 && current !== 0x0a && current !== 0x0d) return;
      this.offset += 1;
    }
  }

  private fail(code: BoundedJsonParseErrorCode): never {
    throw new BoundedJsonParseError(code);
  }
}

export function parseBoundedJson(input: Uint8Array, maxBytes: number): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
  if (input.byteLength > maxBytes) throw new BoundedJsonParseError("too_large");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw new BoundedJsonParseError("invalid_utf8");
  }
  return new Parser(decoded).parse();
}
