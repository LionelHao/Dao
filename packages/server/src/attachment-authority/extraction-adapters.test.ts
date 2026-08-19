// @vitest-environment node

import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAttachmentContent } from "./content-validator.js";
import {
  ATTACHMENT_EXTRACTION_LIMITS,
  AttachmentExtractionAdapterError,
  extractValidatedAttachment,
  type ExtractionToolchain,
} from "./extraction-adapters.js";

let sandbox = "";
let fixturePath = "";
const createdSandboxes: string[] = [];

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

function png(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pdf(marker = "SAFE", pageCount = 1): Uint8Array {
  const pageObjects = Array.from({ length: pageCount }, (_, index) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Note (${marker}-${index + 1}) >>`);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjects.map((_, index) => `${index + 3} 0 R`).join(" ")}] >>`,
    ...pageObjects,
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function docx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types>
      <Override PartName="/word/document.xml"
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`),
    "word/document.xml": strToU8(`<?xml version="1.0"?>
      <w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>合同正文</w:t></w:r></w:p></w:body></w:document>`),
  }, { level: 6 });
}

function xlsx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types>
      <Override PartName="/xl/workbook.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      </Types>`),
    "xl/workbook.xml": strToU8("<?xml version=\"1.0\"?><workbook/>"),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?>
      <worksheet><sheetData><row><c t="str"><f>RAW_FORMULA_CANARY</f><v>visible value</v></c></row></sheetData></worksheet>`),
  }, { level: 6 });
}

function tool(mode: string, version: string) {
  return Object.freeze({
    executable: process.execPath,
    argvPrefix: Object.freeze([fixturePath, mode]),
    version,
  });
}

function tools(overrides: Partial<ExtractionToolchain> = {}): ExtractionToolchain {
  return {
    cwd: sandbox,
    extractTimeoutMs: 2_000,
    ocrTimeoutMs: 2_000,
    ocrLanguage: "eng+chi_sim",
    pdfinfo: tool("pdfinfo", "26.07.0"),
    pdftotext: tool("pdftotext", "26.07.0"),
    pdftoppm: tool("pdftoppm", "26.07.0"),
    tesseract: tool("tesseract", "5.5.3"),
    ...overrides,
  };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "dao-ft04-extraction-"));
  createdSandboxes.push(sandbox);
  fixturePath = join(sandbox, "tool-fixture.mjs");
  const raster = Buffer.from(png()).toString("base64");
  await writeFile(fixturePath, `
import { appendFileSync } from "node:fs";
const mode = process.argv[2];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
appendFileSync("calls.log", mode + "\\n", "utf8");
if (mode === "pdfinfo") process.stdout.write("Pages: 1\\nPage    1 size: 72 x 72 pts (square)\\n");
else if (mode === "pdfinfo-mixed") process.stdout.write("Pages: 2\\nPage    1 size: 72 x 72 pts\\nPage    2 size: 72 x 72 pts\\n");
else if (mode === "pdfinfo-too-many") process.stdout.write("Pages: 501\\nPage size: 72 x 72 pts\\n");
else if (mode === "pdfinfo-huge") process.stdout.write("Pages: 1\\nPage size: 10000 x 10000 pts\\n");
else if (mode === "pdftotext") process.stdout.write(input.includes("OCR_FALLBACK") ? "  \\n" : "PDF extracted text\\f");
else if (mode === "pdftotext-mixed") process.stdout.write("page one text\\f  \\f");
else if (mode === "pdftoppm") process.stdout.write(Buffer.from("${raster}", "base64"));
else if (mode === "tesseract") process.stdout.write("OCR extracted text\\n");
else if (mode === "overflow") process.stdout.write("RAW_OUTPUT_CANARY".repeat(600000));
else if (mode === "raw-failure") { process.stderr.write("RAW_/private/tool/path_CANARY"); process.exit(9); }
else if (mode === "hang") setInterval(() => undefined, 10000);
else process.exit(11);
`, { mode: 0o600 });
});

afterEach(async () => {
  await Promise.all(createdSandboxes.splice(0).map(async (path) => await rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("FT-04 production attachment extraction adapters", () => {
  it("extracts bounded TXT/CSV and known OOXML text without executing formulas or children", async () => {
    const samples = [
      { format: "txt" as const, mime: "text/plain" as const, bytes: Buffer.from("line 1\r\nline 2\n") },
      { format: "csv" as const, mime: "text/csv" as const, bytes: Buffer.from("name,value\nalpha,1\n") },
      { format: "docx" as const, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const, bytes: docx() },
      { format: "xlsx" as const, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const, bytes: xlsx() },
    ];
    const outputs: string[] = [];
    for (const sample of samples) {
      const validation = await validateAttachmentContent({
        bytes: sample.bytes,
        expectedFormat: sample.format,
        declaredMime: sample.mime,
      });
      const result = await extractValidatedAttachment({
        bytes: sample.bytes,
        validation,
        tools: tools(),
        checkpoint: async () => undefined,
      });
      expect(result.extractionBytes.byteLength)
        .toBeLessThanOrEqual(ATTACHMENT_EXTRACTION_LIMITS.maxOutputBytes);
      outputs.push(Buffer.from(result.extractionBytes).toString("utf8"));
    }
    expect(outputs[0]).toBe("line 1\nline 2\n");
    expect(outputs[1]).toContain("alpha,1");
    expect(outputs[2]).toContain("合同正文");
    expect(outputs[3]).toContain("visible value");
    expect(outputs[3]).not.toContain("RAW_FORMULA_CANARY");
    await expect(readFile(join(sandbox, "calls.log"))).rejects.toMatchObject({ code: "ENOENT" });

    const oversizedText = Buffer.from(
      "x".repeat(ATTACHMENT_EXTRACTION_LIMITS.maxCharacters + 1_000),
    );
    const oversizedValidation = await validateAttachmentContent({
      bytes: oversizedText, expectedFormat: "txt", declaredMime: "text/plain",
    });
    const truncated = await extractValidatedAttachment({
      bytes: oversizedText,
      validation: oversizedValidation,
      tools: tools(),
      checkpoint: async () => undefined,
    });
    expect(Buffer.from(truncated.extractionBytes).toString("utf8"))
      .toHaveLength(ATTACHMENT_EXTRACTION_LIMITS.maxCharacters);
  });

  it("runs real pdfinfo then pdftotext children through the bounded runner", async () => {
    const bytes = pdf();
    const validation = await validateAttachmentContent({
      bytes, expectedFormat: "pdf", declaredMime: "application/pdf",
    });
    const checkpoints: string[] = [];
    const result = await extractValidatedAttachment({
      bytes,
      validation,
      tools: tools(),
      checkpoint: async (stage, phase) => {
        checkpoints.push(`${phase}-${stage}`);
      },
    });
    expect(Buffer.from(result.extractionBytes).toString("utf8")).toBe("PDF extracted text\n");
    expect(result).toMatchObject({
      method: "pdf-text",
      tool: "pdftotext",
      version: "26.07.0",
      pageCount: 1,
      ocr: null,
    });
    expect(await readFile(join(sandbox, "calls.log"), "utf8"))
      .toBe("pdfinfo\npdftotext\n");
    expect(checkpoints).toEqual([
      "before-extract", "after-extract", "before-extract", "after-extract",
    ]);
  });

  it("uses real Tesseract for images and rasterized PDF fallback with pixel/page caps", async () => {
    const imageBytes = png();
    const imageValidation = await validateAttachmentContent({
      bytes: imageBytes, expectedFormat: "png", declaredMime: "image/png",
    });
    const image = await extractValidatedAttachment({
      bytes: imageBytes,
      validation: imageValidation,
      tools: tools(),
      checkpoint: async () => undefined,
    });
    expect(image).toMatchObject({
      method: "ocr", tool: "tesseract", version: "5.5.3", pageCount: 1,
      ocr: { kind: "tesseract", version: "5.5.3", pageCount: 1 },
    });

    await writeFile(join(sandbox, "calls.log"), "", "utf8");
    const pdfBytes = pdf("OCR_FALLBACK");
    const pdfValidation = await validateAttachmentContent({
      bytes: pdfBytes, expectedFormat: "pdf", declaredMime: "application/pdf",
    });
    const fallback = await extractValidatedAttachment({
      bytes: pdfBytes,
      validation: pdfValidation,
      tools: tools(),
      checkpoint: async () => undefined,
    });
    expect(Buffer.from(fallback.extractionBytes).toString("utf8"))
      .toBe("OCR extracted text\n");
    expect(fallback).toMatchObject({
      method: "ocr", tool: "tesseract", pageCount: 1,
      ocr: { kind: "tesseract", version: "5.5.3", pageCount: 1 },
    });
    expect(await readFile(join(sandbox, "calls.log"), "utf8"))
      .toBe("pdfinfo\npdftotext\npdftoppm\ntesseract\n");

    await writeFile(join(sandbox, "calls.log"), "", "utf8");
    const mixedBytes = pdf("MIXED", 2);
    const mixedValidation = await validateAttachmentContent({
      bytes: mixedBytes, expectedFormat: "pdf", declaredMime: "application/pdf",
    });
    const mixed = await extractValidatedAttachment({
      bytes: mixedBytes,
      validation: mixedValidation,
      tools: tools({
        pdfinfo: tool("pdfinfo-mixed", "26.07.0"),
        pdftotext: tool("pdftotext-mixed", "26.07.0"),
      }),
      checkpoint: async () => undefined,
    });
    expect(Buffer.from(mixed.extractionBytes).toString("utf8"))
      .toBe("page one text\nOCR extracted text\n");
    expect(mixed).toMatchObject({
      method: "ocr", pageCount: 2,
      ocr: { kind: "tesseract", pageCount: 1 },
    });
    expect(await readFile(join(sandbox, "calls.log"), "utf8"))
      .toBe("pdfinfo-mixed\npdftotext-mixed\npdftoppm\ntesseract\n");

    for (const mode of ["pdfinfo-too-many", "pdfinfo-huge"]) {
      const bounded = await extractValidatedAttachment({
        bytes: pdfBytes,
        validation: pdfValidation,
        tools: tools({ pdfinfo: tool(mode, "26.07.0") }),
        checkpoint: async () => undefined,
      }).catch((error: unknown) => error);
      expect(bounded).toMatchObject({
        stage: "extract", reason: "malformed_output", retryable: false,
      });
    }
  });

  it("cancels, caps, and normalizes real child failures without raw output or paths", async () => {
    const imageBytes = png();
    const validation = await validateAttachmentContent({
      bytes: imageBytes, expectedFormat: "png", declaredMime: "image/png",
    });
    const overflow = await extractValidatedAttachment({
      bytes: imageBytes,
      validation,
      tools: tools({ tesseract: tool("overflow", "5.5.3") }),
      checkpoint: async () => undefined,
    }).catch((error: unknown) => error);
    expect(overflow).toMatchObject({ stage: "ocr", reason: "output_limit", retryable: false });

    const rawFailure = await extractValidatedAttachment({
      bytes: imageBytes,
      validation,
      tools: tools({ tesseract: tool("raw-failure", "5.5.3") }),
      checkpoint: async () => undefined,
    }).catch((error: unknown) => error);
    expect(rawFailure).toMatchObject({ stage: "ocr", reason: "tool_failed", retryable: false });
    expect(rawFailure).toBeInstanceOf(AttachmentExtractionAdapterError);
    expect((rawFailure as Error).stack).toBeUndefined();
    expect(JSON.stringify(rawFailure)).not.toContain("RAW_/private/tool/path_CANARY");
    expect(JSON.stringify(rawFailure)).not.toContain(sandbox);

    const missingPath = "/definitely/not/installed/dao-tesseract";
    const missing = await extractValidatedAttachment({
      bytes: imageBytes,
      validation,
      tools: tools({
        tesseract: { executable: missingPath, argvPrefix: [], version: "5.5.3" },
      }),
      checkpoint: async () => undefined,
    }).catch((error: unknown) => error);
    expect(missing).toMatchObject({ stage: "ocr", reason: "unavailable", retryable: true });
    expect(JSON.stringify(missing)).not.toContain(missingPath);

    const timedOut = await extractValidatedAttachment({
      bytes: imageBytes,
      validation,
      tools: tools({ tesseract: tool("hang", "5.5.3"), ocrTimeoutMs: 40 }),
      checkpoint: async () => undefined,
    }).catch((error: unknown) => error);
    expect(timedOut).toMatchObject({ stage: "ocr", reason: "timed_out", retryable: true });

    const controller = new AbortController();
    const pending = extractValidatedAttachment({
      bytes: imageBytes,
      validation,
      tools: tools({ tesseract: tool("hang", "5.5.3"), ocrTimeoutMs: 2_000 }),
      checkpoint: async () => undefined,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    setTimeout(() => controller.abort(), 40);
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ stage: "ocr", reason: "cancelled", retryable: false });
  });
});
