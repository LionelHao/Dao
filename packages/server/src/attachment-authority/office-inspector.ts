import { Unzip, UnzipInflate } from "fflate";
import { SaxesParser, type SaxesTagPlain } from "saxes";

export const OFFICE_INSPECTION_LIMITS = Object.freeze({
  maxArchiveBytes: 50 * 1_024 * 1_024,
  maxEntries: 10_000,
  maxExpandedBytes: 200 * 1_024 * 1_024,
  maxCompressionRatio: 100,
  maxSingleEntryBytes: 32 * 1_024 * 1_024,
  maxEntryNameBytes: 512,
  maxXmlDepth: 64,
  maxXmlElements: 200_000,
  maxAttributesPerElement: 256,
  maxRelationshipCount: 10_000,
  streamChunkBytes: 64 * 1_024,
});

export type OfficeInspectionErrorCode = "attachment_malformed" | "archive_bomb";

export class OfficeInspectionError extends Error {
  readonly status = 422 as const;
  readonly code: OfficeInspectionErrorCode;

  constructor(code: OfficeInspectionErrorCode) {
    super(`Office attachment rejected: ${code}`);
    this.name = "OfficeInspectionError";
    delete this.stack;
    this.code = code;
  }
}

export type OfficeInspection = Readonly<{
  format: "docx" | "xlsx";
  metadata: Readonly<{
    entryCount: number;
    expandedBytes: number;
    relationshipCount: number;
    documentUnits: number;
  }>;
  extractionPlan: Readonly<{
    kind: "office-xml";
    tool: "bounded-zip";
    documentUnits: number;
  }>;
}>;

type CentralEntry = Readonly<{
  name: string;
  flags: number;
  compression: number;
  crc32: number;
  compressedBytes: number;
  expandedBytes: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
  directory: boolean;
}>;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const forbiddenActivePart =
  /(?:^|\/)(?:vbaProject\.bin|embeddings\/|activeX\/|externalLinks\/|macroSheets\/)/iu;
const externalTarget = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/u;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function fail(code: OfficeInspectionErrorCode): never {
  throw new OfficeInspectionError(code);
}

function bytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) &&
    (value as { readonly BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1;
}

function little16(value: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > value.byteLength) fail("attachment_malformed");
  return value[offset]! | (value[offset + 1]! << 8);
}

function little32(value: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > value.byteLength) fail("attachment_malformed");
  return (value[offset]! | (value[offset + 1]! << 8) |
    (value[offset + 2]! << 16) | (value[offset + 3]! << 24)) >>> 0;
}

function findEocd(value: Uint8Array): number {
  const minimum = Math.max(0, value.byteLength - 65_557);
  for (let offset = value.byteLength - 22; offset >= minimum; offset -= 1) {
    if (little32(value, offset) === EOCD_SIGNATURE) return offset;
  }
  fail("attachment_malformed");
}

function decodeEntryName(value: Uint8Array, utf8: boolean): string {
  if (value.byteLength === 0 || value.byteLength > OFFICE_INSPECTION_LIMITS.maxEntryNameBytes) {
    fail("attachment_malformed");
  }
  let name: string;
  try {
    if (utf8) name = fatalUtf8.decode(value);
    else {
      if (value.some((byte) => byte > 0x7f)) fail("attachment_malformed");
      name = Buffer.from(value).toString("ascii");
    }
  } catch (error) {
    if (error instanceof OfficeInspectionError) throw error;
    fail("attachment_malformed");
  }
  if (name.normalize("NFC") !== name || name.includes("\0") || name.includes("\\") ||
      name.startsWith("/") || name.includes("//") || /^[A-Za-z]:/u.test(name)) {
    fail("attachment_malformed");
  }
  const pathSegments = name.endsWith("/") ? name.slice(0, -1).split("/") : name.split("/");
  if (pathSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("attachment_malformed");
  }
  return name;
}

function containsZip64Extra(value: Uint8Array): boolean {
  let offset = 0;
  while (offset < value.byteLength) {
    if (offset + 4 > value.byteLength) fail("attachment_malformed");
    const identifier = little16(value, offset);
    const length = little16(value, offset + 2);
    offset += 4;
    if (offset + length > value.byteLength) fail("attachment_malformed");
    if (identifier === 0x0001) return true;
    offset += length;
  }
  return false;
}

function validateUnixType(versionMadeBy: number, externalAttributes: number, directory: boolean): void {
  const host = versionMadeBy >>> 8;
  if (host !== 3 && host !== 19) return;
  const mode = externalAttributes >>> 16;
  const type = mode & 0o170000;
  if (type === 0o120000 || (type !== 0 && type !== 0o100000 && type !== 0o040000) ||
      (directory && type === 0o100000) || (!directory && type === 0o040000)) {
    fail("attachment_malformed");
  }
}

function parseCentralDirectory(value: Uint8Array): readonly CentralEntry[] {
  if (!bytes(value) || value.byteLength < 22) fail("attachment_malformed");
  if (value.byteLength > OFFICE_INSPECTION_LIMITS.maxArchiveBytes) fail("archive_bomb");
  const eocd = findEocd(value);
  const disk = little16(value, eocd + 4);
  const centralDisk = little16(value, eocd + 6);
  const entriesOnDisk = little16(value, eocd + 8);
  const entryCount = little16(value, eocd + 10);
  const centralBytes = little32(value, eocd + 12);
  const centralOffset = little32(value, eocd + 16);
  const commentBytes = little16(value, eocd + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
      eocd + 22 + commentBytes !== value.byteLength ||
      entryCount === 0 || entryCount === 0xffff ||
      centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    fail("attachment_malformed");
  }
  if (entryCount > OFFICE_INSPECTION_LIMITS.maxEntries) fail("archive_bomb");
  if (centralOffset + centralBytes !== eocd || centralOffset < 4 ||
      little32(value, 0) !== LOCAL_SIGNATURE) {
    fail("attachment_malformed");
  }

  const entries: CentralEntry[] = [];
  const normalizedNames = new Set<string>();
  const localOffsets = new Set<number>();
  let expandedTotal = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || little32(value, offset) !== CENTRAL_SIGNATURE) {
      fail("attachment_malformed");
    }
    const versionMadeBy = little16(value, offset + 4);
    const flags = little16(value, offset + 8);
    const compression = little16(value, offset + 10);
    const crc = little32(value, offset + 16);
    const compressedBytes = little32(value, offset + 20);
    const expandedBytes = little32(value, offset + 24);
    const nameBytes = little16(value, offset + 28);
    const extraBytes = little16(value, offset + 30);
    const commentLength = little16(value, offset + 32);
    const diskStart = little16(value, offset + 34);
    const externalAttributes = little32(value, offset + 38);
    const localOffset = little32(value, offset + 42);
    const end = offset + 46 + nameBytes + extraBytes + commentLength;
    if (end > eocd || diskStart !== 0 || (flags & (0x0001 | 0x0040 | 0x2000)) !== 0 ||
        (compression !== 0 && compression !== 8) ||
        compressedBytes === 0xffffffff || expandedBytes === 0xffffffff) {
      fail("attachment_malformed");
    }
    const name = decodeEntryName(value.subarray(offset + 46, offset + 46 + nameBytes),
      (flags & 0x0800) !== 0);
    const normalizedName = name.toLocaleLowerCase("en-US");
    if (normalizedNames.has(normalizedName) || localOffsets.has(localOffset)) {
      fail("attachment_malformed");
    }
    normalizedNames.add(normalizedName);
    localOffsets.add(localOffset);
    const directory = name.endsWith("/");
    validateUnixType(versionMadeBy, externalAttributes, directory);
    if (!directory && forbiddenActivePart.test(name)) fail("attachment_malformed");
    if (containsZip64Extra(value.subarray(offset + 46 + nameBytes,
      offset + 46 + nameBytes + extraBytes))) {
      fail("attachment_malformed");
    }
    if (expandedBytes > OFFICE_INSPECTION_LIMITS.maxSingleEntryBytes) fail("archive_bomb");
    if (expandedBytes > 0 &&
        expandedBytes / Math.max(1, compressedBytes) > OFFICE_INSPECTION_LIMITS.maxCompressionRatio) {
      fail("archive_bomb");
    }
    expandedTotal += expandedBytes;
    if (!Number.isSafeInteger(expandedTotal) ||
        expandedTotal > OFFICE_INSPECTION_LIMITS.maxExpandedBytes) {
      fail("archive_bomb");
    }

    if (localOffset + 30 > centralOffset || little32(value, localOffset) !== LOCAL_SIGNATURE) {
      fail("attachment_malformed");
    }
    const localFlags = little16(value, localOffset + 6);
    const localCompression = little16(value, localOffset + 8);
    const localCrc = little32(value, localOffset + 14);
    const localCompressed = little32(value, localOffset + 18);
    const localExpanded = little32(value, localOffset + 22);
    const localNameBytes = little16(value, localOffset + 26);
    const localExtraBytes = little16(value, localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameBytes + localExtraBytes;
    if (localHeaderEnd > centralOffset || localFlags !== flags || localCompression !== compression ||
        ((flags & 0x0008) === 0 &&
          (localCrc !== crc || localCompressed !== compressedBytes || localExpanded !== expandedBytes))) {
      fail("attachment_malformed");
    }
    const localName = decodeEntryName(value.subarray(localOffset + 30,
      localOffset + 30 + localNameBytes), (localFlags & 0x0800) !== 0);
    if (localName !== name || containsZip64Extra(value.subarray(
      localOffset + 30 + localNameBytes, localHeaderEnd,
    ))) {
      fail("attachment_malformed");
    }
    const dataEnd = localHeaderEnd + compressedBytes;
    if (dataEnd > centralOffset) fail("attachment_malformed");
    entries.push(Object.freeze({
      name,
      flags,
      compression,
      crc32: crc,
      compressedBytes,
      expandedBytes,
      localOffset,
      dataStart: localHeaderEnd,
      dataEnd,
      directory,
    }));
    offset = end;
  }
  if (offset !== eocd) fail("attachment_malformed");
  const sorted = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  if (sorted[0]?.localOffset !== 0) fail("attachment_malformed");
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1]!.dataEnd > sorted[index]!.localOffset) fail("attachment_malformed");
  }
  return Object.freeze(entries);
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

function updateCrc32(crc: number, value: Uint8Array): number {
  let current = crc;
  for (const byte of value) current = crcTable[(current ^ byte) & 0xff]! ^ (current >>> 8);
  return current >>> 0;
}

function attribute(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function inspectXmlEntries(
  archive: Uint8Array,
  entries: readonly CentralEntry[],
): Readonly<{
  relationshipCount: number;
  docxContentType: boolean;
  xlsxContentType: boolean;
}> {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const seen = new Set<string>();
  let relationshipCount = 0;
  let xmlElementCount = 0;
  let docxContentType = false;
  let xlsxContentType = false;
  let failure: OfficeInspectionError | undefined;
  const unzip = new Unzip((file) => {
    if (failure !== undefined) return;
    const entry = byName.get(file.name);
    if (entry === undefined || seen.has(file.name)) {
      failure = new OfficeInspectionError("attachment_malformed");
      return;
    }
    seen.add(file.name);
    if (file.compression !== entry.compression ||
        (file.size !== undefined && file.size !== entry.compressedBytes) ||
        (file.originalSize !== undefined && file.originalSize !== entry.expandedBytes)) {
      failure = new OfficeInspectionError("attachment_malformed");
      return;
    }
    const inspectXml = !entry.directory &&
      (entry.name.endsWith(".xml") || entry.name.endsWith(".rels"));
    const parser = inspectXml ? new SaxesParser({ xmlns: false, position: false }) : undefined;
    const decoder = inspectXml ? new TextDecoder("utf-8", { fatal: true }) : undefined;
    let depth = 0;
    let expandedBytes = 0;
    let crc = 0xffffffff;
    let parserFailed = false;
    if (parser !== undefined) {
      parser.on("error", () => {
        parserFailed = true;
      });
      parser.on("doctype", () => {
        parserFailed = true;
      });
      parser.on("opentag", (tag) => {
        depth += 1;
        xmlElementCount += 1;
        if (depth > OFFICE_INSPECTION_LIMITS.maxXmlDepth ||
            xmlElementCount > OFFICE_INSPECTION_LIMITS.maxXmlElements ||
            Object.keys(tag.attributes).length > OFFICE_INSPECTION_LIMITS.maxAttributesPerElement) {
          parserFailed = true;
        }
        const localName = tag.name.includes(":")
          ? tag.name.slice(tag.name.lastIndexOf(":") + 1)
          : tag.name;
        if (localName === "Relationship") {
          relationshipCount += 1;
          const mode = attribute(tag, "TargetMode");
          const target = attribute(tag, "Target");
          if (relationshipCount > OFFICE_INSPECTION_LIMITS.maxRelationshipCount ||
              mode?.toLocaleLowerCase("en-US") === "external" ||
              (target !== undefined && externalTarget.test(target))) {
            parserFailed = true;
          }
        }
        if (entry.name === "[Content_Types].xml" && localName === "Override") {
          const contentType = attribute(tag, "ContentType");
          const normalizedContentType = contentType?.toLocaleLowerCase("en-US");
          if (normalizedContentType?.includes("macro") === true ||
              normalizedContentType?.includes("vbaproject") === true ||
              normalizedContentType?.includes("oleobject") === true ||
              normalizedContentType?.includes("activex") === true) {
            parserFailed = true;
          }
          if (contentType === DOCX_CONTENT_TYPE) docxContentType = true;
          if (contentType === XLSX_CONTENT_TYPE) xlsxContentType = true;
        }
      });
      parser.on("closetag", () => {
        depth -= 1;
        if (depth < 0) parserFailed = true;
      });
    }
    file.ondata = (error, data, final) => {
      if (failure !== undefined) return;
      if (error !== null) {
        failure = new OfficeInspectionError("attachment_malformed");
        return;
      }
      expandedBytes += data.byteLength;
      if (expandedBytes > entry.expandedBytes ||
          expandedBytes > OFFICE_INSPECTION_LIMITS.maxSingleEntryBytes) {
        failure = new OfficeInspectionError("archive_bomb");
        file.terminate();
        return;
      }
      crc = updateCrc32(crc, data);
      if (parser !== undefined && decoder !== undefined) {
        try {
          const text = decoder.decode(data, { stream: !final });
          parser.write(text);
          if (final) parser.close();
        } catch {
          parserFailed = true;
        }
      }
      if (final && (parserFailed || (parser !== undefined && depth !== 0) ||
          expandedBytes !== entry.expandedBytes ||
          ((crc ^ 0xffffffff) >>> 0) !== entry.crc32)) {
        failure = new OfficeInspectionError("attachment_malformed");
      }
    };
    try {
      file.start();
    } catch {
      failure = new OfficeInspectionError("attachment_malformed");
    }
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < archive.byteLength && failure === undefined;
      offset += OFFICE_INSPECTION_LIMITS.streamChunkBytes) {
      const end = Math.min(archive.byteLength, offset + OFFICE_INSPECTION_LIMITS.streamChunkBytes);
      unzip.push(archive.subarray(offset, end), end === archive.byteLength);
    }
  } catch {
    failure = new OfficeInspectionError("attachment_malformed");
  }
  if (failure !== undefined) throw failure;
  if (seen.size !== entries.length) fail("attachment_malformed");
  return Object.freeze({ relationshipCount, docxContentType, xlsxContentType });
}

export function inspectOfficeContainer(value: Uint8Array): OfficeInspection {
  const entries = parseCentralDirectory(value);
  const xml = inspectXmlEntries(value, entries);
  const names = new Set(entries.map((entry) => entry.name));
  const hasDocxCore = names.has("word/document.xml");
  const hasXlsxCore = names.has("xl/workbook.xml");
  if (xml.docxContentType === xml.xlsxContentType || hasDocxCore === hasXlsxCore ||
      xml.docxContentType !== hasDocxCore || xml.xlsxContentType !== hasXlsxCore) {
    fail("attachment_malformed");
  }
  const format = hasDocxCore ? "docx" as const : "xlsx" as const;
  const documentUnits = format === "docx"
    ? 1
    : entries.filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/u.test(entry.name)).length;
  if (documentUnits === 0) fail("attachment_malformed");
  const expandedBytes = entries.reduce((total, entry) => total + entry.expandedBytes, 0);
  return Object.freeze({
    format,
    metadata: Object.freeze({
      entryCount: entries.length,
      expandedBytes,
      relationshipCount: xml.relationshipCount,
      documentUnits,
    }),
    extractionPlan: Object.freeze({
      kind: "office-xml" as const,
      tool: "bounded-zip" as const,
      documentUnits,
    }),
  });
}
