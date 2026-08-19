import {
  attachmentDetectedMime,
  type AttachmentDetectedMime,
  type AttachmentFormat,
} from "@native-im/core";
import { fileTypeFromBuffer } from "file-type";
import {
  inspectOfficeContainer,
  OfficeInspectionError,
  type OfficeInspection,
} from "./office-inspector.js";

export const CONTENT_VALIDATION_LIMITS = Object.freeze({
  maxFileBytes: 50 * 1_024 * 1_024,
  maxTextCharacters: 50 * 1_024 * 1_024,
  maxTextRows: 100_000,
  maxCsvColumns: 1_024,
  maxCsvFieldCharacters: 1 * 1_024 * 1_024,
  maxCsvRowCharacters: 2 * 1_024 * 1_024,
  maxExtractionBytes: 8 * 1_024 * 1_024,
  maxExtractionCharacters: 200_000,
  maxImageDimension: 20_000,
  maxImagePixels: 40_000_000,
  maxPdfPages: 500,
  maxPdfObjects: 100_000,
  maxPdfNesting: 64,
  maxPdfDeclaredStreamBytes: 32 * 1_024 * 1_024,
  maxPdfAggregateDeclaredStreamBytes: 200 * 1_024 * 1_024,
  streamChunkBytes: 64 * 1_024,
});

export type AttachmentContentError =
  | Readonly<{ status: 413; code: "attachment_too_large" }>
  | Readonly<{ status: 415; code: "attachment_type_unsupported" | "type_mismatch" }>
  | Readonly<{
      status: 422;
      code: "attachment_malformed" | "encrypted_pdf" | "archive_bomb" | "image_bomb";
    }>;

export class AttachmentContentValidationError extends Error {
  readonly status: AttachmentContentError["status"];
  readonly code: AttachmentContentError["code"];

  constructor(error: AttachmentContentError) {
    super(`Attachment content rejected: ${error.status}/${error.code}`);
    this.name = "AttachmentContentValidationError";
    delete this.stack;
    this.status = error.status;
    this.code = error.code;
  }
}

export type AttachmentExtractionPlan =
  | Readonly<{
      kind: "builtin-text";
      method: "plain-text" | "csv-text";
      maxOutputBytes: number;
      maxCharacters: number;
    }>
  | Readonly<{
      kind: "ocr";
      tool: "tesseract";
      requiresRasterSafetyCheck: true;
    }>
  | Readonly<{
      kind: "pdf-adapter";
      inspectWith: "pdfinfo";
      extractWith: "pdftotext";
      ocrFallback: "tesseract";
      requiresSandbox: true;
    }>
  | OfficeInspection["extractionPlan"];

export type AttachmentDetectedMetadata =
  | Readonly<{
      kind: "text";
      encoding: "utf-8";
      characterCount: number;
      lineCount: number;
    }>
  | Readonly<{
      kind: "image";
      width: number;
      height: number;
      pixelCount: number;
    }>
  | Readonly<{
      kind: "pdf";
      pageCountHint: number;
      objectCountHint: number;
      complexity: "basic" | "complex";
    }>
  | Readonly<{
      kind: "office";
      entryCount: number;
      expandedBytes: number;
      relationshipCount: number;
      documentUnits: number;
    }>;

export type AttachmentContentValidation = Readonly<{
  format: AttachmentFormat;
  detectedMime: AttachmentDetectedMime;
  metadata: AttachmentDetectedMetadata;
  extractionPlan: AttachmentExtractionPlan;
}>;

export interface ValidateAttachmentContentInput {
  readonly bytes: Uint8Array;
  readonly expectedFormat: AttachmentFormat;
  readonly declaredMime: AttachmentDetectedMime | null;
}

function fail(error: AttachmentContentError): never {
  throw new AttachmentContentValidationError(error);
}

function byteSequence(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) &&
    (value as { readonly BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1;
}

function startsWith(value: Uint8Array, signature: readonly number[]): boolean {
  return value.byteLength >= signature.length &&
    signature.every((byte, index) => value[index] === byte);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validateDimensions(width: number, height: number): Readonly<{
  width: number;
  height: number;
  pixelCount: number;
}> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  const pixelCount = width * height;
  if (width > CONTENT_VALIDATION_LIMITS.maxImageDimension ||
      height > CONTENT_VALIDATION_LIMITS.maxImageDimension ||
      !Number.isSafeInteger(pixelCount) || pixelCount > CONTENT_VALIDATION_LIMITS.maxImagePixels) {
    fail({ status: 422, code: "image_bomb" });
  }
  return Object.freeze({ width, height, pixelCount });
}

function parsePng(value: Uint8Array): AttachmentDetectedMetadata {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
  if (!startsWith(value, signature)) fail({ status: 415, code: "type_mismatch" });
  let offset: number = signature.length;
  let dimensions: ReturnType<typeof validateDimensions> | undefined;
  let idatBytes = 0;
  let ended = false;
  while (offset < value.byteLength) {
    if (offset + 12 > value.byteLength) fail({ status: 422, code: "attachment_malformed" });
    const length = Buffer.from(value.buffer, value.byteOffset + offset, 4).readUInt32BE(0);
    const end = offset + 12 + length;
    if (end > value.byteLength) fail({ status: 422, code: "attachment_malformed" });
    const typeBytes = value.subarray(offset + 4, offset + 8);
    const type = Buffer.from(typeBytes).toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type) || (typeBytes[2]! & 0x20) !== 0) {
      fail({ status: 422, code: "attachment_malformed" });
    }
    const data = value.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = Buffer.from(value.buffer, value.byteOffset + offset + 8 + length, 4)
      .readUInt32BE(0);
    const crcInput = Buffer.concat([Buffer.from(typeBytes), Buffer.from(data)]);
    if (crc32(crcInput) !== expectedCrc) fail({ status: 422, code: "attachment_malformed" });
    if (offset === signature.length) {
      if (type !== "IHDR" || length !== 13) fail({ status: 422, code: "attachment_malformed" });
      const width = Buffer.from(data.buffer, data.byteOffset, 4).readUInt32BE(0);
      const height = Buffer.from(data.buffer, data.byteOffset + 4, 4).readUInt32BE(0);
      dimensions = validateDimensions(width, height);
      const bitDepth = data[8];
      const colorType = data[9];
      const validDepth = (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth!)) ||
        (colorType === 2 && [8, 16].includes(bitDepth!)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth!)) ||
        ((colorType === 4 || colorType === 6) && [8, 16].includes(bitDepth!));
      if (!validDepth || data[10] !== 0 || data[11] !== 0 ||
          (data[12] !== 0 && data[12] !== 1)) {
        fail({ status: 422, code: "attachment_malformed" });
      }
    } else if (type === "IHDR") {
      fail({ status: 422, code: "attachment_malformed" });
    }
    if (type === "IDAT") idatBytes += length;
    if (type === "IEND") {
      if (length !== 0 || end !== value.byteLength) fail({ status: 422, code: "attachment_malformed" });
      ended = true;
    } else if ((type.charCodeAt(0) & 0x20) === 0 &&
        type !== "IHDR" && type !== "PLTE" && type !== "IDAT") {
      fail({ status: 422, code: "attachment_malformed" });
    }
    offset = end;
  }
  if (!ended || dimensions === undefined || idatBytes === 0) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  return Object.freeze({ kind: "image", ...dimensions });
}

const jpegSofMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function parseJpeg(value: Uint8Array): AttachmentDetectedMetadata {
  if (!startsWith(value, [0xff, 0xd8])) fail({ status: 415, code: "type_mismatch" });
  let offset = 2;
  let dimensions: ReturnType<typeof validateDimensions> | undefined;
  let sawScan = false;
  while (offset < value.byteLength) {
    if (value[offset] !== 0xff) fail({ status: 422, code: "attachment_malformed" });
    const markerOffset = offset;
    while (value[offset] === 0xff) offset += 1;
    if (offset >= value.byteLength) fail({ status: 422, code: "attachment_malformed" });
    const marker = value[offset++]!;
    if (marker === 0xd9) {
      if (!sawScan || dimensions === undefined || offset !== value.byteLength) {
        fail({ status: 422, code: "attachment_malformed" });
      }
      return Object.freeze({ kind: "image", ...dimensions });
    }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      fail({ status: 422, code: "attachment_malformed" });
    }
    if (offset + 2 > value.byteLength) fail({ status: 422, code: "attachment_malformed" });
    const length = (value[offset]! << 8) | value[offset + 1]!;
    if (length < 2 || offset + length > value.byteLength) {
      fail({ status: 422, code: "attachment_malformed" });
    }
    if (jpegSofMarkers.has(marker)) {
      if (dimensions !== undefined || length < 11) fail({ status: 422, code: "attachment_malformed" });
      const height = (value[offset + 3]! << 8) | value[offset + 4]!;
      const width = (value[offset + 5]! << 8) | value[offset + 6]!;
      const components = value[offset + 7]!;
      if (length !== 8 + components * 3 || components < 1 || components > 4) {
        fail({ status: 422, code: "attachment_malformed" });
      }
      dimensions = validateDimensions(width, height);
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      let resumedAtMarker = false;
      while (offset < value.byteLength) {
        if (value[offset++] !== 0xff) continue;
        const scanMarkerOffset = offset - 1;
        while (value[offset] === 0xff) offset += 1;
        if (offset >= value.byteLength) fail({ status: 422, code: "attachment_malformed" });
        const scanMarker = value[offset]!;
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          offset += 1;
          continue;
        }
        offset = scanMarkerOffset;
        resumedAtMarker = true;
        break;
      }
      if (!resumedAtMarker) fail({ status: 422, code: "attachment_malformed" });
    }
    if (offset <= markerOffset) fail({ status: 422, code: "attachment_malformed" });
  }
  fail({ status: 422, code: "attachment_malformed" });
}

function scrubPdfStreams(value: string): string {
  return value.replace(/stream(?:\r\n|\r|\n)[\s\S]*?endstream/gu, "stream endstream");
}

function validatePdfNesting(value: string): void {
  let depth = 0;
  let inString = 0;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (comment) {
      if (character === "\n" || character === "\r") comment = false;
      continue;
    }
    if (inString > 0) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "(") inString += 1;
      else if (character === ")") inString -= 1;
      continue;
    }
    if (character === "%") {
      comment = true;
      continue;
    }
    if (character === "(") {
      inString = 1;
      continue;
    }
    if (value.startsWith("<<", index)) {
      depth += 1;
      index += 1;
    } else if (value.startsWith(">>", index)) {
      depth -= 1;
      index += 1;
    } else if (character === "[") depth += 1;
    else if (character === "]") depth -= 1;
    if (depth < 0 || depth > CONTENT_VALIDATION_LIMITS.maxPdfNesting) {
      fail({ status: 422, code: "attachment_malformed" });
    }
  }
  if (depth !== 0 || inString !== 0) fail({ status: 422, code: "attachment_malformed" });
}

function parsePdf(value: Uint8Array): AttachmentDetectedMetadata {
  const text = Buffer.from(value).toString("latin1");
  if (!/^%PDF-1\.[0-7](?:\r\n|\r|\n)/u.test(text)) fail({ status: 415, code: "type_mismatch" });
  const footer = /startxref\s+(\d+)\s+%%EOF[\t \r\n]*$/u.exec(text);
  if (footer === null) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  const startXref = Number(footer[1]);
  if (!Number.isSafeInteger(startXref) || startXref < 0 || startXref >= text.length) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  const xrefTarget = text.slice(startXref);
  const traditionalXref = /^xref(?:\r\n|\r|\n)/u.test(xrefTarget);
  const xrefStream = /^\d+\s+\d+\s+obj\b[\s\S]{0,8192}?\/Type\s*\/XRef\b/u.test(xrefTarget);
  if ((!traditionalXref && !xrefStream) ||
      (traditionalXref && !/\btrailer\b/u.test(xrefTarget))) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  if (/\/Encrypt\b/u.test(text)) fail({ status: 422, code: "encrypted_pdf" });
  if (/\/(?:JavaScript|JS|Launch|EmbeddedFile|Filespec|OpenAction|AA|RichMedia|XFA)\b/u
    .test(text)) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  const objectCount = [...text.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/gu)].length;
  const pageCount = [...text.matchAll(/\/Type\s*\/Page\b/gu)].length;
  if (objectCount === 0 || objectCount > CONTENT_VALIDATION_LIMITS.maxPdfObjects ||
      pageCount === 0 || pageCount > CONTENT_VALIDATION_LIMITS.maxPdfPages) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  for (const match of text.matchAll(/\/Count\s+(\d+)\b/gu)) {
    if (Number(match[1]) > CONTENT_VALIDATION_LIMITS.maxPdfPages) {
      fail({ status: 422, code: "attachment_malformed" });
    }
  }
  let declaredStreamBytes = 0;
  for (const match of text.matchAll(/\/Length\s+(\d+)\b/gu)) {
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 ||
        length > CONTENT_VALIDATION_LIMITS.maxPdfDeclaredStreamBytes) {
      fail({ status: 422, code: "attachment_malformed" });
    }
    declaredStreamBytes += length;
    if (declaredStreamBytes > CONTENT_VALIDATION_LIMITS.maxPdfAggregateDeclaredStreamBytes) {
      fail({ status: 422, code: "attachment_malformed" });
    }
  }
  const streamCount = [...text.matchAll(/(?:^|[\r\n])stream(?:\r\n|\r|\n)/gu)].length;
  const endStreamCount = [...text.matchAll(/(?:^|[\r\n])endstream\b/gu)].length;
  if (streamCount !== endStreamCount) {
    fail({ status: 422, code: "attachment_malformed" });
  }
  const complex = xrefStream || /\/(?:ObjStm|XRef)\b|\/Filter\b|\/Length\s+\d+\s+\d+\s+R\b/u
    .test(text);
  validatePdfNesting(scrubPdfStreams(text));
  return Object.freeze({
    kind: "pdf",
    pageCountHint: pageCount,
    objectCountHint: objectCount,
    complexity: complex ? "complex" : "basic",
  });
}

function inspectText(value: Uint8Array, csv: boolean): AttachmentDetectedMetadata {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let characterCount = 0;
  let lineCount = 1;
  let csvRows = 0;
  let columns = 1;
  let fieldCharacters = 0;
  let rowCharacters = 0;
  let inQuotes = false;
  let afterQuote = false;
  let fieldStarted = false;
  let previousCarriageReturn = false;
  let sawAny = false;

  const finishCsvRow = (): void => {
    csvRows += 1;
    if (csvRows > CONTENT_VALIDATION_LIMITS.maxTextRows) {
      fail({ status: 422, code: "attachment_malformed" });
    }
    columns = 1;
    fieldCharacters = 0;
    rowCharacters = 0;
    fieldStarted = false;
    afterQuote = false;
  };

  const consume = (text: string): void => {
    for (const character of text) {
      sawAny = true;
      characterCount += 1;
      const codePoint = character.codePointAt(0)!;
      if (characterCount > CONTENT_VALIDATION_LIMITS.maxTextCharacters ||
          codePoint === 0x7f ||
          (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)) {
        fail({ status: 422, code: "attachment_malformed" });
      }
      if (character === "\n" && previousCarriageReturn) {
        previousCarriageReturn = false;
        continue;
      }
      previousCarriageReturn = character === "\r";
      if (!csv) {
        if (character === "\n" || character === "\r") lineCount += 1;
        continue;
      }
      rowCharacters += 1;
      if (rowCharacters > CONTENT_VALIDATION_LIMITS.maxCsvRowCharacters) {
        fail({ status: 422, code: "attachment_malformed" });
      }
      if (inQuotes) {
        if (character === "\"") {
          inQuotes = false;
          afterQuote = true;
        } else {
          fieldCharacters += 1;
        }
      } else if (afterQuote) {
        if (character === "\"") {
          inQuotes = true;
          afterQuote = false;
          fieldCharacters += 1;
        } else if (character === ",") {
          columns += 1;
          fieldCharacters = 0;
          fieldStarted = false;
          afterQuote = false;
        } else if (character === "\n" || character === "\r") {
          finishCsvRow();
        } else {
          fail({ status: 422, code: "attachment_malformed" });
        }
      } else if (character === "\"") {
        if (fieldStarted) fail({ status: 422, code: "attachment_malformed" });
        inQuotes = true;
        fieldStarted = true;
      } else if (character === ",") {
        columns += 1;
        fieldCharacters = 0;
        fieldStarted = false;
      } else if (character === "\n" || character === "\r") {
        finishCsvRow();
      } else {
        fieldStarted = true;
        fieldCharacters += 1;
      }
      if (columns > CONTENT_VALIDATION_LIMITS.maxCsvColumns ||
          fieldCharacters > CONTENT_VALIDATION_LIMITS.maxCsvFieldCharacters) {
        fail({ status: 422, code: "attachment_malformed" });
      }
    }
  };

  try {
    for (let offset = 0; offset < value.byteLength; offset += CONTENT_VALIDATION_LIMITS.streamChunkBytes) {
      const end = Math.min(value.byteLength, offset + CONTENT_VALIDATION_LIMITS.streamChunkBytes);
      consume(decoder.decode(value.subarray(offset, end), { stream: end !== value.byteLength }));
    }
    consume(decoder.decode());
  } catch (error) {
    if (error instanceof AttachmentContentValidationError) throw error;
    fail({ status: 422, code: "attachment_malformed" });
  }
  if (!sawAny || (csv && inQuotes)) fail({ status: 422, code: "attachment_malformed" });
  if (csv && (rowCharacters > 0 || fieldStarted || afterQuote || columns > 1)) finishCsvRow();
  return Object.freeze({
    kind: "text",
    encoding: "utf-8",
    characterCount,
    lineCount: csv ? csvRows : lineCount,
  });
}

async function corroborateBinaryMagic(
  value: Uint8Array,
  format: "pdf" | "png" | "jpeg",
): Promise<void> {
  let detected;
  try {
    detected = await fileTypeFromBuffer(value);
  } catch {
    fail({ status: 422, code: "attachment_malformed" });
  }
  const expectedExtension = format === "jpeg" ? new Set(["jpg", "jpeg"]) : new Set([format]);
  if (detected === undefined || !expectedExtension.has(detected.ext) ||
      detected.mime !== attachmentDetectedMime(format)) {
    fail({ status: 422, code: "attachment_malformed" });
  }
}

function officeValidation(office: OfficeInspection): AttachmentContentValidation {
  return Object.freeze({
    format: office.format,
    detectedMime: attachmentDetectedMime(office.format),
    metadata: Object.freeze({ kind: "office", ...office.metadata }),
    extractionPlan: office.extractionPlan,
  });
}

export async function validateAttachmentContent(
  input: ValidateAttachmentContentInput,
): Promise<AttachmentContentValidation> {
  if (!byteSequence(input.bytes) || input.bytes.byteLength === 0) {
    fail({ status: 415, code: "attachment_type_unsupported" });
  }
  if (input.bytes.byteLength > CONTENT_VALIDATION_LIMITS.maxFileBytes) {
    fail({ status: 413, code: "attachment_too_large" });
  }
  const expectedMime = attachmentDetectedMime(input.expectedFormat);
  if (input.declaredMime !== null && input.declaredMime !== expectedMime) {
    fail({ status: 415, code: "type_mismatch" });
  }

  if (startsWith(input.bytes, [0x50, 0x4b, 0x03, 0x04])) {
    let office: OfficeInspection;
    try {
      office = inspectOfficeContainer(input.bytes);
    } catch (error) {
      if (error instanceof OfficeInspectionError) {
        fail({ status: error.status, code: error.code });
      }
      fail({ status: 422, code: "attachment_malformed" });
    }
    if (office.format !== input.expectedFormat) fail({ status: 415, code: "type_mismatch" });
    return officeValidation(office);
  }

  let actualFormat: "pdf" | "png" | "jpeg" | undefined;
  let metadata: AttachmentDetectedMetadata | undefined;
  if (startsWith(input.bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    actualFormat = "png";
    metadata = parsePng(input.bytes);
  } else if (startsWith(input.bytes, [0xff, 0xd8])) {
    actualFormat = "jpeg";
    metadata = parseJpeg(input.bytes);
  } else if (startsWith(input.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    actualFormat = "pdf";
    metadata = parsePdf(input.bytes);
  }
  if (actualFormat !== undefined && metadata !== undefined) {
    if (actualFormat !== input.expectedFormat) fail({ status: 415, code: "type_mismatch" });
    await corroborateBinaryMagic(input.bytes, actualFormat);
    const extractionPlan: AttachmentExtractionPlan = actualFormat === "pdf"
      ? Object.freeze({
          kind: "pdf-adapter",
          inspectWith: "pdfinfo",
          extractWith: "pdftotext",
          ocrFallback: "tesseract",
          requiresSandbox: true,
        })
      : Object.freeze({ kind: "ocr", tool: "tesseract", requiresRasterSafetyCheck: true });
    return Object.freeze({
      format: actualFormat,
      detectedMime: attachmentDetectedMime(actualFormat),
      metadata,
      extractionPlan,
    });
  }

  if (input.expectedFormat === "txt" || input.expectedFormat === "csv") {
    const csv = input.expectedFormat === "csv";
    return Object.freeze({
      format: input.expectedFormat,
      detectedMime: attachmentDetectedMime(input.expectedFormat),
      metadata: inspectText(input.bytes, csv),
      extractionPlan: Object.freeze({
        kind: "builtin-text",
        method: csv ? "csv-text" : "plain-text",
        maxOutputBytes: CONTENT_VALIDATION_LIMITS.maxExtractionBytes,
        maxCharacters: CONTENT_VALIDATION_LIMITS.maxExtractionCharacters,
      }),
    });
  }

  let detected;
  try {
    detected = await fileTypeFromBuffer(input.bytes);
  } catch {
    detected = undefined;
  }
  if (detected !== undefined) {
    const approvedMimes = new Set<AttachmentDetectedMime>([
      "application/pdf",
      "image/png",
      "image/jpeg",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
    if (approvedMimes.has(detected.mime as AttachmentDetectedMime)) {
      fail({ status: 415, code: "type_mismatch" });
    }
  }
  fail({ status: 415, code: "attachment_type_unsupported" });
}
