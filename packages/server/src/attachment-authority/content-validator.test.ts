// @vitest-environment node

import { deflateSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  AttachmentContentValidationError,
  CONTENT_VALIDATION_LIMITS,
  validateAttachmentContent,
} from "./content-validator.js";

function crc32(value: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(kind: string, data: Uint8Array): Buffer {
  const type = Buffer.from(kind, "ascii");
  const output = Buffer.alloc(12 + data.byteLength);
  output.writeUInt32BE(data.byteLength, 0);
  type.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([type, Buffer.from(data)])), 8 + data.byteLength);
  return output;
}

function png(width = 1, height = 1): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanline = Buffer.from([0, 0, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanline)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(width = 1, height = 1): Uint8Array {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x02,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x00,
    0xff, 0xd9,
  ]);
}

function pdf(extraObjects: readonly string[] = [], trailerExtra = ""): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>",
    ...extraObjects,
  ];
  let body = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra} >>\n`;
  body += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function docx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types>
      <Override PartName="/word/document.xml"
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`),
    "word/document.xml": strToU8("<?xml version=\"1.0\"?><document><p>DOCX_RAW_MARKER</p></document>"),
  }, { level: 6 });
}

function xlsx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types>
      <Override PartName="/xl/workbook.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      </Types>`),
    "xl/workbook.xml": strToU8("<?xml version=\"1.0\"?><workbook/>"),
    "xl/worksheets/sheet1.xml": strToU8("<?xml version=\"1.0\"?><worksheet/>"),
  }, { level: 6 });
}

const canonicalMimes = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
  csv: "text/csv",
} as const;

describe("FT-04 closed attachment content validator", () => {
  it("strictly detects all seven approved formats and returns metadata plus a real extraction plan", async () => {
    const samples = {
      pdf: pdf(),
      png: png(),
      jpeg: jpeg(),
      docx: docx(),
      xlsx: xlsx(),
      txt: Buffer.from("plain UTF-8 text\n", "utf8"),
      csv: Buffer.from("name,value\nalpha,1\n", "utf8"),
    } as const;
    for (const format of Object.keys(samples) as Array<keyof typeof samples>) {
      const result = await validateAttachmentContent({
        bytes: samples[format],
        expectedFormat: format,
        declaredMime: canonicalMimes[format],
      });
      expect(result).toMatchObject({ format, detectedMime: canonicalMimes[format] });
      expect(result).toHaveProperty("metadata");
      expect(result).toHaveProperty("extractionPlan");
      expect(Object.keys(result).sort()).toEqual([
        "detectedMime", "extractionPlan", "format", "metadata",
      ]);
      const metadataKeys = format === "pdf"
        ? ["complexity", "kind", "objectCountHint", "pageCountHint"]
        : format === "png" || format === "jpeg"
          ? ["height", "kind", "pixelCount", "width"]
          : format === "docx" || format === "xlsx"
            ? ["documentUnits", "entryCount", "expandedBytes", "kind", "relationshipCount"]
            : ["characterCount", "encoding", "kind", "lineCount"];
      expect(Object.keys(result.metadata).sort()).toEqual(metadataKeys);
      const planKeys = format === "pdf"
        ? ["extractWith", "inspectWith", "kind", "ocrFallback", "requiresSandbox"]
        : format === "png" || format === "jpeg"
          ? ["kind", "requiresRasterSafetyCheck", "tool"]
          : format === "docx" || format === "xlsx"
            ? ["documentUnits", "kind", "tool"]
            : ["kind", "maxCharacters", "maxOutputBytes", "method"];
      expect(Object.keys(result.extractionPlan).sort()).toEqual(planKeys);
      expect(result).not.toHaveProperty("bytes");
      expect(result).not.toHaveProperty("text");
      expect(result).not.toHaveProperty("path");
      expect(result).not.toHaveProperty("url");
    }
  });

  it("rejects oversized, unsupported, declared-MIME mismatch, and magic mismatch with closed errors", async () => {
    await expect(validateAttachmentContent({
      bytes: new Uint8Array(CONTENT_VALIDATION_LIMITS.maxFileBytes + 1),
      expectedFormat: "png",
      declaredMime: "image/png",
    })).rejects.toMatchObject({ status: 413, code: "attachment_too_large" });
    await expect(validateAttachmentContent({
      bytes: Buffer.from("MZ executable"), expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 415, code: "attachment_type_unsupported" });
    await expect(validateAttachmentContent({
      bytes: png(), expectedFormat: "png", declaredMime: "image/jpeg",
    })).rejects.toMatchObject({ status: 415, code: "type_mismatch" });
    await expect(validateAttachmentContent({
      bytes: png(), expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 415, code: "type_mismatch" });
  });

  it("classifies bounded UTF-8 TXT/CSV and rejects invalid encoding, controls, rows, columns, and quotes", async () => {
    await expect(validateAttachmentContent({
      bytes: Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("合同\n")]),
      expectedFormat: "txt",
      declaredMime: "text/plain",
    })).resolves.toMatchObject({ metadata: { kind: "text", encoding: "utf-8" } });

    for (const { bytes, format, mime } of [
      { bytes: new Uint8Array([0xc3, 0x28]), format: "txt" as const, mime: "text/plain" as const },
      { bytes: Buffer.from("safe\0hidden"), format: "txt" as const, mime: "text/plain" as const },
      { bytes: Buffer.from("a,\"unterminated\n"), format: "csv" as const, mime: "text/csv" as const },
      {
        bytes: Buffer.from(`${Array.from({ length: CONTENT_VALIDATION_LIMITS.maxCsvColumns + 1 }, () => "x").join(",")}\n`),
        format: "csv" as const,
        mime: "text/csv" as const,
      },
      {
        bytes: Buffer.from("a,b\n".repeat(CONTENT_VALIDATION_LIMITS.maxTextRows + 1)),
        format: "csv" as const,
        mime: "text/csv" as const,
      },
      {
        bytes: Buffer.from(`"${"x".repeat(CONTENT_VALIDATION_LIMITS.maxCsvFieldCharacters + 1)}"\n`),
        format: "csv" as const,
        mime: "text/csv" as const,
      },
    ]) {
      await expect(validateAttachmentContent({
        bytes, expectedFormat: format, declaredMime: mime,
      })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    }
  });

  it("bounds PNG/JPEG dimensions and pixels and rejects truncation/corrupt framing", async () => {
    await expect(validateAttachmentContent({
      bytes: png(CONTENT_VALIDATION_LIMITS.maxImageDimension + 1, 1),
      expectedFormat: "png", declaredMime: "image/png",
    })).rejects.toMatchObject({ status: 422, code: "image_bomb" });
    await expect(validateAttachmentContent({
      bytes: jpeg(10_000, 5_000), expectedFormat: "jpeg", declaredMime: "image/jpeg",
    })).rejects.toMatchObject({ status: 422, code: "image_bomb" });
    await expect(validateAttachmentContent({
      bytes: png().subarray(0, png().byteLength - 5),
      expectedFormat: "png", declaredMime: "image/png",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    await expect(validateAttachmentContent({
      bytes: jpeg().subarray(0, jpeg().byteLength - 2),
      expectedFormat: "jpeg", declaredMime: "image/jpeg",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
  });

  it("requires a real PDF adapter plan for complex input and fails closed on encryption and hazards", async () => {
    const complex = await validateAttachmentContent({
      bytes: pdf(["<< /Type /ObjStm /N 0 /First 0 /Length 0 >>\nstream\n\nendstream"]),
      expectedFormat: "pdf", declaredMime: "application/pdf",
    });
    expect(complex).toMatchObject({
      metadata: { kind: "pdf", complexity: "complex" },
      extractionPlan: {
        kind: "pdf-adapter",
        inspectWith: "pdfinfo",
        extractWith: "pdftotext",
        ocrFallback: "tesseract",
      },
    });

    await expect(validateAttachmentContent({
      bytes: pdf(["<< /Filter /Standard >>"], "/Encrypt 4 0 R"),
      expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "encrypted_pdf" });
    await expect(validateAttachmentContent({
      bytes: pdf(["<< /S /JavaScript /JS (RAW_SCRIPT_CANARY) >>"]),
      expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    const pages = Array.from({ length: CONTENT_VALIDATION_LIMITS.maxPdfPages }, () =>
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>");
    await expect(validateAttachmentContent({
      bytes: pdf(pages), expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    await expect(validateAttachmentContent({
      bytes: pdf().subarray(0, pdf().byteLength - 7),
      expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    const invalidXrefOffset = Buffer.from(
      Buffer.from(pdf()).toString("latin1").replace(/startxref\n\d+/u, "startxref\n9999999"),
      "latin1",
    );
    await expect(validateAttachmentContent({
      bytes: invalidXrefOffset,
      expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    await expect(validateAttachmentContent({
      bytes: pdf([`<< /Nested ${"[".repeat(CONTENT_VALIDATION_LIMITS.maxPdfNesting + 1)}${"]".repeat(CONTENT_VALIDATION_LIMITS.maxPdfNesting + 1)} >>`]),
      expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    await expect(validateAttachmentContent({
      bytes: pdf([`<< /Length ${CONTENT_VALIDATION_LIMITS.maxPdfDeclaredStreamBytes + 1} >>`]),
      expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
    const objectOverflow = Array.from(
      { length: CONTENT_VALIDATION_LIMITS.maxPdfObjects - 2 },
      () => "<< /Safe true >>",
    );
    await expect(validateAttachmentContent({
      bytes: pdf(objectOverflow), expectedFormat: "pdf", declaredMime: "application/pdf",
    })).rejects.toMatchObject({ status: 422, code: "attachment_malformed" });
  });

  it("never places raw content, active payloads, path, or URL data in results and errors", async () => {
    const marker = "RAW_ATTACHMENT_SENTINEL";
    const result = await validateAttachmentContent({
      bytes: Buffer.from(`${marker}\n`), expectedFormat: "txt", declaredMime: "text/plain",
    });
    expect(JSON.stringify(result)).not.toContain(marker);

    const failure = await validateAttachmentContent({
      bytes: Buffer.from([0xff, 0xfe, 0x00, 0x00]),
      expectedFormat: "txt",
      declaredMime: "text/plain",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AttachmentContentValidationError);
    expect((failure as Error).stack).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(marker);
    expect(JSON.stringify(failure)).not.toContain("path");
    expect(JSON.stringify(failure)).not.toContain("url");
  });
});
