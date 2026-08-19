import type {
  AttachmentExtractionMethod,
  AttachmentExtractionTool,
} from "@native-im/core";
import { unzipSync } from "fflate";
import { SaxesParser, type SaxesTagPlain } from "saxes";
import {
  CONTENT_VALIDATION_LIMITS,
  validateAttachmentContent,
  type AttachmentContentValidation,
} from "./content-validator.js";
import {
  BoundedProcessError,
  PROCESS_RUNNER_LIMITS,
  runBoundedProcess,
} from "./process-runner.js";

export const ATTACHMENT_EXTRACTION_LIMITS = Object.freeze({
  maxOutputBytes: 8 * 1_024 * 1_024,
  maxCharacters: 200_000,
  maxOfficeXmlBytes: 32 * 1_024 * 1_024,
  maxPdfInfoBytes: 64 * 1_024,
  maxPdfPages: 500,
  maxImageDimension: 20_000,
  maxImagePixels: 40_000_000,
  maxPdfOcrPixels: 200_000_000,
  rasterDpi: 150,
  maxExtractTimeoutMs: 60_000,
  maxOcrTimeoutMs: 180_000,
});

export type ExtractionAdapterStage = "extract" | "ocr";
export type ExtractionAdapterFailureReason =
  | "invalid_configuration"
  | "unavailable"
  | "timed_out"
  | "cancelled"
  | "output_limit"
  | "tool_failed"
  | "malformed_output";

export class AttachmentExtractionAdapterError extends Error {
  readonly stage: ExtractionAdapterStage;
  readonly reason: ExtractionAdapterFailureReason;
  readonly retryable: boolean;

  constructor(stage: ExtractionAdapterStage, reason: ExtractionAdapterFailureReason) {
    super(`Attachment ${stage} failed: ${reason}`);
    this.name = "AttachmentExtractionAdapterError";
    delete this.stack;
    this.stage = stage;
    this.reason = reason;
    this.retryable = reason === "invalid_configuration" || reason === "unavailable" ||
      reason === "timed_out";
  }
}

export interface ExtractionExecutable {
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly version: string;
}

export interface ExtractionToolchain {
  readonly cwd: string;
  readonly extractTimeoutMs: number;
  readonly ocrTimeoutMs: number;
  readonly ocrLanguage: string;
  readonly pdfinfo: ExtractionExecutable;
  readonly pdftotext: ExtractionExecutable;
  readonly pdftoppm: ExtractionExecutable;
  readonly tesseract: ExtractionExecutable;
}

export type ExtractionAdapterCheckpoint = (
  stage: ExtractionAdapterStage,
  phase: "before" | "after",
) => Promise<void>;

export type AttachmentExtractionAdapterResult = Readonly<{
  extractionBytes: Uint8Array;
  method: AttachmentExtractionMethod;
  tool: AttachmentExtractionTool;
  version: string;
  pageCount: number | null;
  ocr: Readonly<{
    kind: "tesseract";
    version: string;
    pageCount: number;
  }> | null;
}>;

export interface ExtractValidatedAttachmentOptions {
  readonly bytes: Uint8Array;
  readonly validation: AttachmentContentValidation;
  readonly tools: ExtractionToolchain;
  readonly checkpoint: ExtractionAdapterCheckpoint;
  readonly signal?: AbortSignal;
}

type ExtractionRuntimeOptions = ExtractValidatedAttachmentOptions & Readonly<{
  deadlines: Readonly<Record<ExtractionAdapterStage, number>>;
}>;

const safeVersion = (value: string): boolean => value.length > 0 && value.length <= 128 &&
  value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value);
const safeLanguage = /^[A-Za-z0-9_+.-]{1,128}$/u;

function adapterFail(
  stage: ExtractionAdapterStage,
  reason: ExtractionAdapterFailureReason,
): never {
  throw new AttachmentExtractionAdapterError(stage, reason);
}

function normalizedProcessError(stage: ExtractionAdapterStage, error: unknown): never {
  if (!(error instanceof BoundedProcessError)) adapterFail(stage, "tool_failed");
  if (error.reason === "aborted") adapterFail(stage, "cancelled");
  if (error.reason === "invalid_configuration") adapterFail(stage, "invalid_configuration");
  if (error.reason === "unavailable") adapterFail(stage, "unavailable");
  if (error.reason === "timed_out") adapterFail(stage, "timed_out");
  if (error.reason === "stdout_limit_exceeded" || error.reason === "stderr_limit_exceeded") {
    adapterFail(stage, "output_limit");
  }
  adapterFail(stage, "tool_failed");
}

function validateToolchain(tools: ExtractionToolchain): void {
  if (!Number.isSafeInteger(tools.extractTimeoutMs) || tools.extractTimeoutMs <= 0 ||
      tools.extractTimeoutMs > ATTACHMENT_EXTRACTION_LIMITS.maxExtractTimeoutMs ||
      !Number.isSafeInteger(tools.ocrTimeoutMs) || tools.ocrTimeoutMs <= 0 ||
      tools.ocrTimeoutMs > ATTACHMENT_EXTRACTION_LIMITS.maxOcrTimeoutMs ||
      !safeLanguage.test(tools.ocrLanguage) ||
      ![tools.pdfinfo, tools.pdftotext, tools.pdftoppm, tools.tesseract]
        .every((tool) => safeVersion(tool.version) && Array.isArray(tool.argvPrefix))) {
    adapterFail("extract", "invalid_configuration");
  }
}

async function runTool(
  tool: ExtractionExecutable,
  argv: readonly string[],
  stdin: Uint8Array,
  stage: ExtractionAdapterStage,
  options: ExtractionRuntimeOptions,
  stdoutLimitBytes = ATTACHMENT_EXTRACTION_LIMITS.maxOutputBytes,
): Promise<Uint8Array> {
  await options.checkpoint(stage, "before");
  if (options.signal?.aborted === true) adapterFail(stage, "cancelled");
  const remainingTimeoutMs = options.deadlines[stage] - Date.now();
  if (remainingTimeoutMs <= 0) adapterFail(stage, "timed_out");
  let stdout: Uint8Array;
  try {
    const result = await runBoundedProcess({
      executable: tool.executable,
      argv: [...tool.argvPrefix, ...argv],
      cwd: options.tools.cwd,
      timeoutMs: Math.min(
        stage === "ocr" ? options.tools.ocrTimeoutMs : options.tools.extractTimeoutMs,
        remainingTimeoutMs,
      ),
      stdoutLimitBytes,
      stderrLimitBytes: PROCESS_RUNNER_LIMITS.maxStderrBytes,
      stdin,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    stdout = Buffer.from(result.stdout);
  } catch (error) {
    normalizedProcessError(stage, error);
  }
  await options.checkpoint(stage, "after");
  return stdout;
}

class BoundedTextCollector {
  readonly #stage: ExtractionAdapterStage;
  readonly #chunks: string[] = [];
  #current = "";
  #characters = 0;
  #bytes = 0;
  #previousCarriageReturn = false;

  constructor(stage: ExtractionAdapterStage = "extract") {
    this.#stage = stage;
  }

  append(value: string): void {
    for (const inputCharacter of value) {
      let character = inputCharacter;
      if (this.#previousCarriageReturn) {
        this.#previousCarriageReturn = false;
        if (character === "\n") continue;
      }
      if (character === "\r") {
        character = "\n";
        this.#previousCarriageReturn = true;
      } else if (character === "\f") {
        character = "\n";
      }
      const codePoint = character.codePointAt(0)!;
      if (codePoint === 0x7f ||
          (codePoint < 0x20 && character !== "\n" && character !== "\t")) {
        adapterFail(this.#stage, "malformed_output");
      }
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (this.#characters >= ATTACHMENT_EXTRACTION_LIMITS.maxCharacters ||
          this.#bytes + characterBytes > ATTACHMENT_EXTRACTION_LIMITS.maxOutputBytes) {
        continue;
      }
      this.#characters += 1;
      this.#bytes += characterBytes;
      this.#current += character;
      if (this.#current.length >= 4_096) {
        this.#chunks.push(this.#current);
        this.#current = "";
      }
    }
  }

  bytes(): Uint8Array {
    return Buffer.from([...this.#chunks, this.#current].join(""), "utf8");
  }
}

function decodeFatal(value: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    adapterFail("extract", "malformed_output");
  }
}

function boundedText(
  value: Uint8Array,
  stage: ExtractionAdapterStage = "extract",
): Uint8Array {
  const collector = new BoundedTextCollector(stage);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let offset = 0; offset < value.byteLength; offset += 64 * 1_024) {
      const end = Math.min(value.byteLength, offset + 64 * 1_024);
      collector.append(decoder.decode(value.subarray(offset, end), {
        stream: end !== value.byteLength,
      }));
    }
    collector.append(decoder.decode());
  } catch (error) {
    if (error instanceof AttachmentExtractionAdapterError) throw error;
    adapterFail(stage, "malformed_output");
  }
  return collector.bytes();
}

function localName(name: string): string {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function attribute(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function parseXml(
  value: Uint8Array,
  handlers: Readonly<{
    open?: (tag: SaxesTagPlain) => void;
    text?: (text: string) => void;
    close?: (name: string) => void;
  }>,
): void {
  let failed = false;
  const parser = new SaxesParser({ xmlns: false, position: false });
  parser.on("error", () => {
    failed = true;
  });
  parser.on("doctype", () => {
    failed = true;
  });
  parser.on("opentag", (tag) => handlers.open?.(tag));
  parser.on("text", (text) => handlers.text?.(text));
  parser.on("closetag", (tag) => handlers.close?.(tag.name));
  try {
    parser.write(decodeFatal(value)).close();
  } catch {
    failed = true;
  }
  if (failed) adapterFail("extract", "malformed_output");
}

function selectedOfficeXml(
  value: Uint8Array,
  format: "docx" | "xlsx",
): Readonly<Record<string, Uint8Array>> {
  let selectedBytes = 0;
  try {
    return unzipSync(value, {
      filter: (entry) => {
        const selected = format === "docx"
          ? /^(?:word\/document\.xml|word\/(?:footnotes|endnotes|comments)\.xml|word\/(?:header|footer)\d+\.xml)$/u
            .test(entry.name)
          : entry.name === "xl/sharedStrings.xml" ||
            /^xl\/worksheets\/[^/]+\.xml$/u.test(entry.name);
        if (!selected) return false;
        selectedBytes += entry.originalSize;
        if (!Number.isSafeInteger(selectedBytes) ||
            selectedBytes > ATTACHMENT_EXTRACTION_LIMITS.maxOfficeXmlBytes) {
          adapterFail("extract", "output_limit");
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof AttachmentExtractionAdapterError) throw error;
    adapterFail("extract", "malformed_output");
  }
}

function extractDocx(value: Uint8Array): Uint8Array {
  const entries = selectedOfficeXml(value, "docx");
  if (entries["word/document.xml"] === undefined) adapterFail("extract", "malformed_output");
  const output = new BoundedTextCollector();
  const parts = Object.entries(entries).sort(([left], [right]) => {
    if (left === "word/document.xml") return -1;
    if (right === "word/document.xml") return 1;
    return left.localeCompare(right, "en-US");
  });
  for (const [, part] of parts) {
    let textDepth = 0;
    parseXml(part, {
      open: (tag) => {
        const name = localName(tag.name);
        if (name === "t") textDepth += 1;
        else if (name === "tab") output.append("\t");
        else if (name === "br") output.append("\n");
      },
      text: (text) => {
        if (textDepth > 0) output.append(text);
      },
      close: (qualifiedName) => {
        const name = localName(qualifiedName);
        if (name === "t") textDepth -= 1;
        else if (name === "p") output.append("\n");
      },
    });
    output.append("\n");
  }
  return output.bytes();
}

function sharedStrings(value: Uint8Array | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const strings: string[] = [];
  let inItem = false;
  let inText = 0;
  let current = "";
  let totalCharacters = 0;
  parseXml(value, {
    open: (tag) => {
      const name = localName(tag.name);
      if (name === "si") {
        inItem = true;
        current = "";
      } else if (inItem && name === "t") inText += 1;
    },
    text: (text) => {
      if (inItem && inText > 0) {
        totalCharacters += [...text].length;
        if (totalCharacters <= ATTACHMENT_EXTRACTION_LIMITS.maxCharacters) current += text;
      }
    },
    close: (qualifiedName) => {
      const name = localName(qualifiedName);
      if (name === "t" && inText > 0) inText -= 1;
      else if (name === "si") {
        strings.push(current);
        inItem = false;
      }
    },
  });
  return Object.freeze(strings);
}

function extractXlsx(value: Uint8Array): Uint8Array {
  const entries = selectedOfficeXml(value, "xlsx");
  const strings = sharedStrings(entries["xl/sharedStrings.xml"]);
  const output = new BoundedTextCollector();
  const sheets = Object.entries(entries)
    .filter(([name]) => /^xl\/worksheets\/[^/]+\.xml$/u.test(name))
    .sort(([left], [right]) => left.localeCompare(right, "en-US"));
  if (sheets.length === 0) adapterFail("extract", "malformed_output");
  for (const [, sheet] of sheets) {
    let inCell = false;
    let cellType: string | undefined;
    let valueDepth = 0;
    let inlineTextDepth = 0;
    let cellValue = "";
    parseXml(sheet, {
      open: (tag) => {
        const name = localName(tag.name);
        if (name === "c") {
          inCell = true;
          cellType = attribute(tag, "t");
          cellValue = "";
        } else if (inCell && name === "v") valueDepth += 1;
        else if (inCell && name === "t") inlineTextDepth += 1;
      },
      text: (text) => {
        if (inCell && (valueDepth > 0 || inlineTextDepth > 0)) cellValue += text;
      },
      close: (qualifiedName) => {
        const name = localName(qualifiedName);
        if (name === "v" && valueDepth > 0) valueDepth -= 1;
        else if (name === "t" && inlineTextDepth > 0) inlineTextDepth -= 1;
        else if (name === "c") {
          const resolved = cellType === "s" && /^\d+$/u.test(cellValue)
            ? strings[Number(cellValue)] ?? ""
            : cellValue;
          output.append(resolved);
          output.append("\t");
          inCell = false;
          cellType = undefined;
          cellValue = "";
        } else if (name === "row") output.append("\n");
      },
    });
  }
  return output.bytes();
}

type PdfInformation = Readonly<{
  pageCount: number;
  pagePixels: readonly number[];
}>;

function parsePdfInformation(value: Uint8Array): PdfInformation {
  const text = decodeFatal(value);
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x7f ||
        (codePoint < 0x20 && character !== "\n" && character !== "\r" && character !== "\t")) {
      adapterFail("extract", "malformed_output");
    }
  }
  const pageMatch = /^Pages:\s+(\d+)\s*$/mu.exec(text);
  const pageCount = Number(pageMatch?.[1]);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 ||
      pageCount > ATTACHMENT_EXTRACTION_LIMITS.maxPdfPages) {
    adapterFail("extract", "malformed_output");
  }
  const dimensions = [...text.matchAll(
    /^(?:Page(?:\s+\d+)? size):\s+(\d+(?:\.\d+)?)\s+x\s+(\d+(?:\.\d+)?)\s+pts(?:\s+\([^\r\n()]{1,64}\))?\s*$/gmu,
  )].map((match) => [Number(match[1]), Number(match[2])] as const);
  if (dimensions.length !== 1 && dimensions.length !== pageCount) {
    adapterFail("extract", "malformed_output");
  }
  const pagePixels: number[] = [];
  let totalPixels = 0;
  for (let page = 0; page < pageCount; page += 1) {
    const [widthPoints, heightPoints] = dimensions.length === 1 ? dimensions[0]! : dimensions[page]!;
    const width = Math.ceil(widthPoints / 72 * ATTACHMENT_EXTRACTION_LIMITS.rasterDpi);
    const height = Math.ceil(heightPoints / 72 * ATTACHMENT_EXTRACTION_LIMITS.rasterDpi);
    const pixels = width * height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
        width > ATTACHMENT_EXTRACTION_LIMITS.maxImageDimension ||
        height > ATTACHMENT_EXTRACTION_LIMITS.maxImageDimension ||
        !Number.isSafeInteger(pixels) || pixels > ATTACHMENT_EXTRACTION_LIMITS.maxImagePixels) {
      adapterFail("extract", "malformed_output");
    }
    totalPixels += pixels;
    if (!Number.isSafeInteger(totalPixels) ||
        totalPixels > ATTACHMENT_EXTRACTION_LIMITS.maxPdfOcrPixels) {
      adapterFail("extract", "output_limit");
    }
    pagePixels.push(pixels);
  }
  return Object.freeze({ pageCount, pagePixels: Object.freeze(pagePixels) });
}

async function tesseract(
  input: Uint8Array,
  pageCount: number,
  options: ExtractionRuntimeOptions,
): Promise<AttachmentExtractionAdapterResult> {
  const stdout = await runTool(
    options.tools.tesseract,
    ["stdin", "stdout", "--dpi", String(ATTACHMENT_EXTRACTION_LIMITS.rasterDpi),
      "-l", options.tools.ocrLanguage],
    input,
    "ocr",
    options,
  );
  return Object.freeze({
    extractionBytes: boundedText(stdout, "ocr"),
    method: "ocr" as const,
    tool: "tesseract" as const,
    version: options.tools.tesseract.version,
    pageCount,
    ocr: Object.freeze({
      kind: "tesseract" as const,
      version: options.tools.tesseract.version,
      pageCount,
    }),
  });
}

function pdfTextPages(value: Uint8Array, pageCount: number): readonly Uint8Array[] {
  const raw = decodeFatal(value);
  const pages = raw.split("\f");
  while (pages.length > pageCount && pages.at(-1)?.trim().length === 0) pages.pop();
  if (pages.length !== pageCount) adapterFail("extract", "malformed_output");
  return Object.freeze(pages.map((page) => boundedText(Buffer.from(page, "utf8"))));
}

async function extractPdf(
  options: ExtractionRuntimeOptions,
): Promise<AttachmentExtractionAdapterResult> {
  const information = parsePdfInformation(await runTool(
    options.tools.pdfinfo,
    ["-f", "1", "-l", String(ATTACHMENT_EXTRACTION_LIMITS.maxPdfPages), "-box", "-"],
    options.bytes,
    "extract",
    options,
    ATTACHMENT_EXTRACTION_LIMITS.maxPdfInfoBytes,
  ));
  const extractedPages = pdfTextPages(await runTool(
    options.tools.pdftotext,
    ["-enc", "UTF-8", "-", "-"],
    options.bytes,
    "extract",
    options,
  ), information.pageCount);
  const blankPages = extractedPages
    .map((page, index) => Buffer.from(page).toString("utf8").trim().length === 0 ? index : -1)
    .filter((index) => index >= 0);
  if (blankPages.length === 0) {
    const output = new BoundedTextCollector();
    for (const page of extractedPages) {
      output.append(Buffer.from(page).toString("utf8").trimEnd());
      output.append("\n");
    }
    return Object.freeze({
      extractionBytes: output.bytes(),
      method: "pdf-text" as const,
      tool: "pdftotext" as const,
      version: options.tools.pdftotext.version,
      pageCount: information.pageCount,
      ocr: null,
    });
  }
  const output = new BoundedTextCollector("ocr");
  for (let page = 1; page <= information.pageCount; page += 1) {
    const pageIndex = page - 1;
    if (information.pagePixels[pageIndex] === undefined) {
      adapterFail("extract", "malformed_output");
    }
    let pageText = Buffer.from(extractedPages[pageIndex]!).toString("utf8");
    if (blankPages.includes(pageIndex)) {
      const raster = await runTool(
        options.tools.pdftoppm,
        ["-f", String(page), "-l", String(page), "-singlefile", "-r",
          String(ATTACHMENT_EXTRACTION_LIMITS.rasterDpi), "-png", "-", "-"],
        options.bytes,
        "extract",
        options,
      );
      try {
        await validateAttachmentContent({
          bytes: raster,
          expectedFormat: "png",
          declaredMime: "image/png",
        });
      } catch {
        adapterFail("extract", "malformed_output");
      }
      const pageResult = await tesseract(raster, 1, options);
      pageText = Buffer.from(pageResult.extractionBytes).toString("utf8");
    }
    output.append(pageText.trimEnd());
    output.append("\n");
  }
  return Object.freeze({
    extractionBytes: output.bytes(),
    method: "ocr" as const,
    tool: "tesseract" as const,
    version: options.tools.tesseract.version,
    pageCount: information.pageCount,
    ocr: Object.freeze({
      kind: "tesseract" as const,
      version: options.tools.tesseract.version,
      pageCount: blankPages.length,
    }),
  });
}

export async function extractValidatedAttachment(
  options: ExtractValidatedAttachmentOptions,
): Promise<AttachmentExtractionAdapterResult> {
  validateToolchain(options.tools);
  if (options.signal?.aborted === true) adapterFail("extract", "cancelled");
  const startedAt = Date.now();
  const runtime: ExtractionRuntimeOptions = Object.freeze({
    ...options,
    deadlines: Object.freeze({
      extract: startedAt + options.tools.extractTimeoutMs,
      ocr: startedAt + options.tools.ocrTimeoutMs,
    }),
  });
  switch (runtime.validation.format) {
    case "txt":
    case "csv": {
      await runtime.checkpoint("extract", "before");
      const extractionBytes = boundedText(runtime.bytes);
      await runtime.checkpoint("extract", "after");
      return Object.freeze({
        extractionBytes,
        method: runtime.validation.format === "txt" ? "plain-text" : "csv-text",
        tool: "builtin",
        version: "1",
        pageCount: null,
        ocr: null,
      });
    }
    case "docx":
    case "xlsx": {
      await runtime.checkpoint("extract", "before");
      const extractionBytes = runtime.validation.format === "docx"
        ? extractDocx(runtime.bytes)
        : extractXlsx(runtime.bytes);
      await runtime.checkpoint("extract", "after");
      return Object.freeze({
        extractionBytes,
        method: "office-xml",
        tool: "bounded-zip",
        version: "fflate-0.8.3+saxes-6.0.0",
        pageCount: null,
        ocr: null,
      });
    }
    case "png":
    case "jpeg":
      if (runtime.validation.metadata.kind !== "image" ||
          runtime.validation.metadata.pixelCount > CONTENT_VALIDATION_LIMITS.maxImagePixels) {
        adapterFail("ocr", "malformed_output");
      }
      return await tesseract(runtime.bytes, 1, runtime);
    case "pdf":
      return await extractPdf(runtime);
  }
}
