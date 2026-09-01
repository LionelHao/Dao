export const DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES = 48 * 1_024;
export const DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES = 1_048_576;
export const DIAGNOSTICS_TRANSPORT_MAX_STREAMS_PER_CONNECTION = 1;

export type DiagnosticsTransportClientFrame =
  | Readonly<{ type: "diagnostics.generate"; requestId: string }>
  | Readonly<{ type: "diagnostics.read"; requestId: string; streamId: string; offset: number }>
  | Readonly<{ type: "diagnostics.abort"; requestId: string; streamId: string }>;

export type DiagnosticsTransportServerFrame =
  | Readonly<{
      type: "diagnostics.generated";
      requestId: string;
      streamId: string;
      artifactId: string;
      filename: string;
      mediaType: "application/x-ndjson";
      byteLength: number;
      sha256: string;
      expiresAt: string;
      chunkSize: typeof DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES;
    }>
  | Readonly<{
      type: "diagnostics.chunk";
      requestId: string;
      streamId: string;
      offset: number;
      byteLength: number;
      base64: string;
      eof: boolean;
    }>
  | Readonly<{
      type: "diagnostics.aborted";
      requestId: string;
      streamId: string;
    }>;

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exact = (value: UnknownRecord, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) =>
    typeof key === "string" && keys.includes(key));
};

const identifier = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);

const boundedInteger = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

export function isDiagnosticsTransportFrameType(
  value: unknown,
): value is DiagnosticsTransportClientFrame["type"] {
  return value === "diagnostics.generate" || value === "diagnostics.read" ||
    value === "diagnostics.abort";
}

export function parseDiagnosticsTransportClientFrame(value: unknown):
  Readonly<{ ok: true; frame: DiagnosticsTransportClientFrame }> |
  Readonly<{ ok: false; requestId?: string }> {
  const correlated = record(value) && identifier(value.requestId, 128)
    ? value.requestId : undefined;
  if (!record(value) || !isDiagnosticsTransportFrameType(value.type)) {
    return Object.freeze({ ok: false,
      ...(correlated === undefined ? {} : { requestId: correlated }) });
  }
  const valid = value.type === "diagnostics.generate"
    ? exact(value, ["type", "requestId"]) && identifier(value.requestId, 128)
    : value.type === "diagnostics.read"
      ? exact(value, ["type", "requestId", "streamId", "offset"]) &&
        identifier(value.requestId, 128) && identifier(value.streamId) &&
        boundedInteger(value.offset, DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES)
      : exact(value, ["type", "requestId", "streamId"]) &&
        identifier(value.requestId, 128) && identifier(value.streamId);
  return valid
    ? Object.freeze({ ok: true, frame: value as DiagnosticsTransportClientFrame })
    : Object.freeze({ ok: false,
      ...(correlated === undefined ? {} : { requestId: correlated }) });
}

export function isSafeDiagnosticsFilename(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 &&
    /^dao-diagnostics-[A-Za-z0-9.T-]+\.ndjson$/u.test(value) &&
    !value.includes("..") && !value.includes("/") && !value.includes("\\");
}

function canonicalBase64(value: unknown, expectedBytes: number): boolean {
  if (typeof value !== "string" || value.length >
      Math.ceil(DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES / 3) * 4) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === expectedBytes && bytes.toString("base64") === value;
}

export function isDiagnosticsTransportServerFrame(
  value: unknown,
): value is DiagnosticsTransportServerFrame {
  if (!record(value)) return false;
  if (value.type === "diagnostics.generated") {
    return exact(value, ["type", "requestId", "streamId", "artifactId", "filename",
      "mediaType", "byteLength", "sha256", "expiresAt", "chunkSize"]) &&
      identifier(value.requestId, 128) && identifier(value.streamId) &&
      identifier(value.artifactId) && isSafeDiagnosticsFilename(value.filename) &&
      value.mediaType === "application/x-ndjson" &&
      boundedInteger(value.byteLength, DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES) &&
      typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256) &&
      canonicalTimestamp(value.expiresAt) &&
      value.chunkSize === DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES;
  }
  if (value.type === "diagnostics.aborted") {
    return exact(value, ["type", "requestId", "streamId"]) &&
      identifier(value.requestId, 128) && identifier(value.streamId);
  }
  return value.type === "diagnostics.chunk" &&
    exact(value, ["type", "requestId", "streamId", "offset", "byteLength", "base64", "eof"]) &&
    identifier(value.requestId, 128) && identifier(value.streamId) &&
    boundedInteger(value.offset, DIAGNOSTICS_TRANSPORT_MAX_ARTIFACT_BYTES) &&
    boundedInteger(value.byteLength, DIAGNOSTICS_TRANSPORT_MAX_CHUNK_BYTES) &&
    canonicalBase64(value.base64, value.byteLength) && typeof value.eof === "boolean";
}
