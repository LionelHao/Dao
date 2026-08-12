import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export interface InvitationSecretProtector {
  seal(token: string): string;
  open(ciphertext: string): string;
}

class InvitationSecretUnavailableError extends Error {
  readonly status = 503 as const;
  readonly code = "invitation_secret_unavailable" as const;

  constructor() {
    super("invitation_secret_unavailable");
    this.name = "InvitationSecretUnavailableError";
  }
}

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function unavailable(): never {
  throw new InvitationSecretUnavailableError();
}

function decodeCanonicalBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return unavailable();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    return unavailable();
  }
  return decoded;
}

export function createAesGcmInvitationSecretProtector(
  key: Uint8Array,
): InvitationSecretProtector {
  if (key.byteLength !== 32) {
    throw new TypeError("Invitation secret protector key must be exactly 32 bytes");
  }
  const keyBytes = Buffer.from(key);

  return {
    seal(token: string): string {
      if (typeof token !== "string" || token.length === 0) {
        throw new TypeError("Invitation token must be a non-empty string");
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, keyBytes, iv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(FORMAT_VERSION, "utf8"));
      const encrypted = Buffer.concat([
        cipher.update(token, "utf8"),
        cipher.final(),
      ]);
      return [
        FORMAT_VERSION,
        iv.toString("base64url"),
        encrypted.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
    },

    open(ciphertext: string): string {
      try {
        const parts = ciphertext.split(".");
        if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
          return unavailable();
        }
        const iv = decodeCanonicalBase64url(parts[1] ?? "");
        const encrypted = decodeCanonicalBase64url(parts[2] ?? "");
        const authTag = decodeCanonicalBase64url(parts[3] ?? "");
        if (
          iv.byteLength !== IV_BYTES ||
          encrypted.byteLength === 0 ||
          authTag.byteLength !== AUTH_TAG_BYTES
        ) {
          return unavailable();
        }
        const decipher = createDecipheriv(ALGORITHM, keyBytes, iv, {
          authTagLength: AUTH_TAG_BYTES,
        });
        decipher.setAAD(Buffer.from(FORMAT_VERSION, "utf8"));
        decipher.setAuthTag(authTag);
        const opened = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]).toString("utf8");
        return opened.length > 0 ? opened : unavailable();
      } catch {
        return unavailable();
      }
    },
  };
}
