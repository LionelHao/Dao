import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const TOOL_SEALED_PAYLOAD_HARD_MAX_BYTES = 1024 * 1024;

export interface ToolSealingKey {
  readonly version: string;
  readonly bytes: Uint8Array;
}

export interface SealedToolPayload {
  readonly ciphertext: string;
  readonly keyVersion: string;
  readonly expiresAt: string;
}

export class ToolPayloadSealingError extends Error {
  constructor(readonly code: "not_ready" | "invalid_input" | "expired" | "authentication_failed") {
    super(`Tool payload sealing failed: ${code}`);
    this.name = "ToolPayloadSealingError";
  }
}

function validKey(key: ToolSealingKey | undefined): key is ToolSealingKey {
  return key !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(key.version) && key.bytes.byteLength === 32;
}

function boundedBytes(value: Uint8Array): void {
  if (value.byteLength === 0 || value.byteLength > TOOL_SEALED_PAYLOAD_HARD_MAX_BYTES) {
    throw new ToolPayloadSealingError("invalid_input");
  }
}

function parseExpiry(expiresAt: string, now: number): number {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now) throw new ToolPayloadSealingError("expired");
  return expiry;
}

/** Server-private. The key provider is injected only by the production composition root or deep tests. */
export class ToolParameterSealer {
  constructor(private readonly readKey: (version?: string) => ToolSealingKey | undefined) {}

  readiness(): "ready" | "not_ready" {
    return validKey(this.readKey()) ? "ready" : "not_ready";
  }

  seal(plaintext: Uint8Array, aad: Uint8Array, expiresAt: string, now: number): SealedToolPayload {
    boundedBytes(plaintext);
    boundedBytes(aad);
    parseExpiry(expiresAt, now);
    const key = this.readKey();
    if (!validKey(key)) throw new ToolPayloadSealingError("not_ready");
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key.bytes, nonce);
    cipher.setAAD(aad, { plaintextLength: plaintext.byteLength });
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const packed = Buffer.concat([nonce, cipher.getAuthTag(), body]);
    plaintext.fill(0);
    return Object.freeze({
      ciphertext: packed.toString("base64url"),
      keyVersion: key.version,
      expiresAt,
    });
  }

  open(sealed: SealedToolPayload, aad: Uint8Array, now: number): Uint8Array {
    boundedBytes(aad);
    parseExpiry(sealed.expiresAt, now);
    const key = this.readKey(sealed.keyVersion);
    if (!validKey(key) || key.version !== sealed.keyVersion) {
      throw new ToolPayloadSealingError("not_ready");
    }
    let packed: Buffer;
    try {
      packed = Buffer.from(sealed.ciphertext, "base64url");
    } catch {
      throw new ToolPayloadSealingError("invalid_input");
    }
    if (packed.byteLength <= NONCE_BYTES + TAG_BYTES ||
        packed.byteLength > TOOL_SEALED_PAYLOAD_HARD_MAX_BYTES + NONCE_BYTES + TAG_BYTES) {
      throw new ToolPayloadSealingError("invalid_input");
    }
    const nonce = packed.subarray(0, NONCE_BYTES);
    const tag = packed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const body = packed.subarray(NONCE_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv(ALGORITHM, key.bytes, nonce);
      decipher.setAAD(aad, { plaintextLength: body.byteLength });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
      boundedBytes(plaintext);
      return plaintext;
    } catch {
      throw new ToolPayloadSealingError("authentication_failed");
    } finally {
      packed.fill(0);
    }
  }

  matchesVersion(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  }
}
