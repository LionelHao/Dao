import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import {
  OFFICE_INSPECTION_LIMITS,
  OfficeInspectionError,
  inspectOfficeContainer,
} from "./office-inspector.js";

const contentTypesPrefix = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`;
const contentTypesSuffix = "</Types>";
const packageRelationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="officeDocument" Target="word/document.xml"/>
</Relationships>`;

function docx(extra: Record<string, Uint8Array | [Uint8Array, object]> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`${contentTypesPrefix}
      <Override PartName="/word/document.xml"
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      ${contentTypesSuffix}`),
    "_rels/.rels": strToU8(packageRelationships),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>SAFE_TEXT_MARKER</w:t></w:r></w:p></w:body></w:document>`),
    ...extra,
  }, { level: 6 });
}

function xlsx(extra: Record<string, Uint8Array | [Uint8Array, object]> = {}): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(`${contentTypesPrefix}
      <Override PartName="/xl/workbook.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml"
        ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      ${contentTypesSuffix}`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`),
    ...extra,
  }, { level: 6 });
}

function replaceAscii(value: Uint8Array, from: string, to: string): Uint8Array {
  if (from.length !== to.length) throw new Error("replacement must preserve ZIP offsets");
  const output = Buffer.from(value);
  const source = Buffer.from(from);
  const replacement = Buffer.from(to);
  let offset = 0;
  while ((offset = output.indexOf(source, offset)) !== -1) {
    replacement.copy(output, offset);
    offset += replacement.length;
  }
  return output;
}

function mutateEocdEntryCount(value: Uint8Array, count: number): Uint8Array {
  const output = Buffer.from(value);
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const offset = output.lastIndexOf(signature);
  if (offset < 0) throw new Error("missing EOCD");
  output.writeUInt16LE(count, offset + 8);
  output.writeUInt16LE(count, offset + 10);
  return output;
}

function declareExpandedSize(value: Uint8Array, namePrefix: string, expandedBytes: number): Uint8Array {
  const output = Buffer.from(value);
  const eocd = output.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("missing EOCD");
  const entryCount = output.readUInt16LE(eocd + 10);
  let offset = output.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (output.readUInt32LE(offset) !== 0x02014b50) throw new Error("missing central entry");
    const nameBytes = output.readUInt16LE(offset + 28);
    const extraBytes = output.readUInt16LE(offset + 30);
    const commentBytes = output.readUInt16LE(offset + 32);
    const name = output.subarray(offset + 46, offset + 46 + nameBytes).toString("utf8");
    if (name.startsWith(namePrefix)) {
      output.writeUInt32LE(expandedBytes, offset + 24);
      const localOffset = output.readUInt32LE(offset + 42);
      output.writeUInt32LE(expandedBytes, localOffset + 22);
    }
    offset += 46 + nameBytes + extraBytes + commentBytes;
  }
  return output;
}

describe("FT-04 bounded OOXML inspector", () => {
  it("streams and validates minimal DOCX/XLSX without returning XML, names, paths, or URLs", () => {
    const word = inspectOfficeContainer(docx());
    const sheet = inspectOfficeContainer(xlsx());
    expect(word).toEqual({
      format: "docx",
      metadata: {
        entryCount: 3,
        expandedBytes: expect.any(Number),
        relationshipCount: 1,
        documentUnits: 1,
      },
      extractionPlan: { kind: "office-xml", tool: "bounded-zip", documentUnits: 1 },
    });
    expect(sheet).toMatchObject({
      format: "xlsx",
      metadata: { entryCount: 4, relationshipCount: 1, documentUnits: 1 },
      extractionPlan: { kind: "office-xml", tool: "bounded-zip", documentUnits: 1 },
    });
    const serialized = JSON.stringify([word, sheet]);
    expect(serialized).not.toContain("SAFE_TEXT_MARKER");
    expect(serialized).not.toContain("document.xml");
    expect(serialized).not.toContain("worksheets");
    expect(serialized).not.toContain("http");
  });

  it("rejects traversal, duplicate normalized names, symlinks, macros, OLE, and external links", () => {
    const traversal = docx({ "../escape.xml": strToU8("<escape/>") });
    expect(() => inspectOfficeContainer(traversal)).toThrowError(
      expect.objectContaining({ status: 422, code: "attachment_malformed" }),
    );

    const duplicate = replaceAscii(docx({
      "custom/a.xml": strToU8("<a/>"),
      "custom/b.xml": strToU8("<b/>"),
    }), "custom/b.xml", "custom/a.xml");
    expect(() => inspectOfficeContainer(duplicate)).toThrowError(
      expect.objectContaining({ status: 422, code: "attachment_malformed" }),
    );

    const symlinkAttributes = (0o120777 * 65_536) >>> 0;
    const symlink = docx({
      "word/media/link": [strToU8("target"), { os: 3, attrs: symlinkAttributes }],
    });
    expect(() => inspectOfficeContainer(symlink)).toThrowError(
      expect.objectContaining({ status: 422, code: "attachment_malformed" }),
    );

    for (const active of [
      docx({ "word/vbaProject.bin": new Uint8Array([1]) }),
      docx({ "word/embeddings/oleObject1.bin": new Uint8Array([1]) }),
      docx({ "word/activeX/activeX1.bin": new Uint8Array([1]) }),
      docx({
        "[Content_Types].xml": strToU8(`${contentTypesPrefix}
          <Override PartName="/word/document.xml"
            ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
          <Override PartName="/xl/MacroSheets/sheet1.xml"
            ContentType="application/vnd.ms-excel.MacroSheet+xml"/>
          ${contentTypesSuffix}`),
        "xl/MacroSheets/sheet1.xml": strToU8("<macroSheet/>"),
      }),
    ]) {
      expect(() => inspectOfficeContainer(active)).toThrowError(
        expect.objectContaining({ status: 422, code: "attachment_malformed" }),
      );
    }

    const urlCanary = "https://private.example.invalid/sentinel";
    const external = docx({
      "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0"?>
        <Relationships><Relationship Id="r2" TargetMode="External" Target="${urlCanary}"/></Relationships>`),
    });
    const failure = (() => {
      try {
        inspectOfficeContainer(external);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(OfficeInspectionError);
    expect(failure).toMatchObject({ status: 422, code: "attachment_malformed" });
    expect(JSON.stringify(failure)).not.toContain(urlCanary);
  });

  it("rejects entry-count, single-entry, expanded-size, and compression-ratio bombs", () => {
    expect(() => inspectOfficeContainer(mutateEocdEntryCount(
      docx(), OFFICE_INSPECTION_LIMITS.maxEntries + 1,
    ))).toThrowError(expect.objectContaining({ status: 422, code: "archive_bomb" }));

    const singleEntryBomb = docx({
      "word/media/zeros.bin": new Uint8Array(OFFICE_INSPECTION_LIMITS.maxSingleEntryBytes + 1),
    });
    expect(() => inspectOfficeContainer(singleEntryBomb)).toThrowError(
      expect.objectContaining({ status: 422, code: "archive_bomb" }),
    );

    const ratioDenominator = Math.ceil(
      OFFICE_INSPECTION_LIMITS.maxSingleEntryBytes / OFFICE_INSPECTION_LIMITS.maxCompressionRatio,
    );
    const aggregateEntries: Record<string, [Uint8Array, { level: 0 }]> = {};
    for (let index = 0; index < 7; index += 1) {
      aggregateEntries[`word/media/aggregate-${index}.bin`] = [
        new Uint8Array(ratioDenominator), { level: 0 },
      ];
    }
    const aggregateBomb = declareExpandedSize(
      docx(aggregateEntries), "word/media/aggregate-", OFFICE_INSPECTION_LIMITS.maxSingleEntryBytes,
    );
    expect(() => inspectOfficeContainer(aggregateBomb)).toThrowError(
      expect.objectContaining({ status: 422, code: "archive_bomb" }),
    );

    const ratioBomb = docx({ "word/media/compressible.bin": new Uint8Array(1_024 * 1_024) });
    expect(() => inspectOfficeContainer(ratioBomb)).toThrowError(
      expect.objectContaining({ status: 422, code: "archive_bomb" }),
    );
  });

  it("fails closed for malformed central directories, bounded XML violations, and ambiguous format", () => {
    const truncated = docx().subarray(0, docx().byteLength - 12);
    expect(() => inspectOfficeContainer(truncated)).toThrowError(
      expect.objectContaining({ status: 422, code: "attachment_malformed" }),
    );
    const corruptStoredPayload = replaceAscii(docx({
      "word/media/blob.bin": [strToU8("BINARY_CORRUPTION"), { level: 0 }],
    }), "BINARY_CORRUPTION", "BINARY_CORRUPT-ON");
    expect(() => inspectOfficeContainer(corruptStoredPayload)).toThrowError(
      expect.objectContaining({ status: 422, code: "attachment_malformed" }),
    );
    const doctype = docx({
      "word/document.xml": strToU8(`<?xml version="1.0"?>
        <!DOCTYPE x [<!ENTITY x "EXPANSION">]><w:document xmlns:w="urn:word"><w:body>&x;</w:body></w:document>`),
    });
    expect(() => inspectOfficeContainer(doctype)).toThrowError(
      expect.objectContaining({ status: 422, code: "attachment_malformed" }),
    );
    const ambiguous = zipSync({
      "[Content_Types].xml": strToU8(`${contentTypesPrefix}
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        ${contentTypesSuffix}`),
      "word/document.xml": strToU8("<document/>"),
      "xl/workbook.xml": strToU8("<workbook/>"),
    });
    expect(() => inspectOfficeContainer(ambiguous)).toThrowError(
      expect.objectContaining({ status: 422, code: "attachment_malformed" }),
    );
  });
});
