// test/extract/office-pptx.test.ts
// U8: .pptx (DrawingML/PresentationML) OOXML slide walker + speaker notes.
// Fixtures are built programmatically as synthetic, hand-built OOXML zips
// (via fflate) so no binary fixtures need to be checked in — same approach
// as U7's office-docx.test.ts.

import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { extractPptx } from "../../src/extract/office.js";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/extract/types.js";

const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

const SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const NOTES_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

function contentTypesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
}

function wrapPresentation(sldIdLstXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P_NS}><p:sldIdLst>${sldIdLstXml}</p:sldIdLst></p:presentation>`;
}

function wrapRelationships(rels: Array<{ id: string; type: string; target: string }>): string {
  const body = rels
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>${body}</Relationships>`;
}

function wrapSlide(spTreeBodyXml: string, opts: { hidden?: boolean } = {}): string {
  const showAttr = opts.hidden ? ' show="0"' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P_NS} ${A_NS}${showAttr}><p:cSld><p:spTree>${spTreeBodyXml}</p:spTree></p:cSld></p:sld>`;
}

function wrapNotesSlide(spTreeBodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${P_NS} ${A_NS}><p:cSld><p:spTree>${spTreeBodyXml}</p:spTree></p:cSld></p:notes>`;
}

function textShape(text: string, extraParagraphs: string[] = []): string {
  const paras = [text, ...extraParagraphs]
    .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
    .join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
}

function groupedTextShape(text: string): string {
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${textShape(text)}</p:grpSp>`;
}

function tableGraphicFrame(rows: string[][]): string {
  const trs = rows
    .map(
      (cells) =>
        `<a:tr>${cells
          .map((c) => `<a:tc><a:txBody><a:p><a:r><a:t>${c}</a:t></a:r></a:p></a:txBody></a:tc>`)
          .join("")}</a:tr>`,
    )
    .join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="10" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function buildPptxZip(parts: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypesXml()),
  };
  for (const [name, content] of Object.entries(parts)) {
    files[name] = strToU8(content);
  }
  return zipSync(files);
}

/**
 * Builds a full deck: N slides in the given order (each keyed by slide
 * number, e.g. `slideOrder: [2, 1]` puts slide2 before slide1 in
 * presentation order), each with an optional notes part, one slide (index 0
 * in slideOrder) getting a table + grouped shape for coverage.
 */
function buildDeck(opts: {
  slideOrder: number[];
  hiddenSlideNumbers?: number[];
  withNotes?: boolean;
  withTableAndGroup?: boolean;
}): Uint8Array {
  const { slideOrder, hiddenSlideNumbers = [], withNotes = true, withTableAndGroup = true } = opts;
  const parts: Record<string, string> = {};

  const sldIdEntries = slideOrder
    .map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${100 + n}"/>`)
    .join("");
  parts["ppt/presentation.xml"] = wrapPresentation(sldIdEntries);

  parts["ppt/_rels/presentation.xml.rels"] = wrapRelationships(
    slideOrder.map((n) => ({
      id: `rId${100 + n}`,
      type: SLIDE_REL_TYPE,
      target: `slides/slide${n}.xml`,
    })),
  );

  for (const n of slideOrder) {
    const isFirstInOrder = n === slideOrder[0];
    let body = textShape(`Slide ${n} body text`, [`Slide ${n} second paragraph`]);
    if (withTableAndGroup && isFirstInOrder) {
      body += tableGraphicFrame([
        ["Name", "Owner"],
        ["Alpha", "Mihir"],
      ]);
      body += groupedTextShape(`Slide ${n} grouped shape text`);
    }
    parts[`ppt/slides/slide${n}.xml`] = wrapSlide(body, {
      hidden: hiddenSlideNumbers.includes(n),
    });

    if (withNotes) {
      parts[`ppt/slides/_rels/slide${n}.xml.rels`] = wrapRelationships([
        { id: "rId1", type: NOTES_REL_TYPE, target: `../notesSlides/notesSlide${n}.xml` },
      ]);
      parts[`ppt/notesSlides/notesSlide${n}.xml`] = wrapNotesSlide(
        textShape(`Speaker note for slide ${n}`),
      );
    }
  }

  return buildPptxZip(parts);
}

describe("extractPptx", () => {
  test("extracts 3 slides in order with notes, a table, and a grouped shape (includeSpeakerNotes: true)", async () => {
    const bytes = buildDeck({ slideOrder: [1, 2, 3] });

    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = result.value.text;
    expect(text).toContain("## Slide 1");
    expect(text).toContain("## Slide 2");
    expect(text).toContain("## Slide 3");
    expect(text).toContain("Slide 1 body text");
    expect(text).toContain("Slide 2 body text");
    expect(text).toContain("Slide 3 body text");
    expect(text).toContain("Name | Owner");
    expect(text).toContain("Alpha | Mihir");
    expect(text).toContain("Slide 1 grouped shape text");
    expect(text).toContain("[speaker notes]");
    expect(text).toContain("Speaker note for slide 1");
    expect(text).toContain("Speaker note for slide 2");
    expect(text).toContain("Speaker note for slide 3");

    // slide headers should precede their own body text, in order
    expect(text.indexOf("## Slide 1")).toBeLessThan(text.indexOf("## Slide 2"));
    expect(text.indexOf("## Slide 2")).toBeLessThan(text.indexOf("## Slide 3"));
  });

  test("same deck with includeSpeakerNotes: false omits [speaker notes] blocks but keeps slide bodies", async () => {
    const bytes = buildDeck({ slideOrder: [1, 2, 3] });

    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = result.value.text;
    expect(text).not.toContain("[speaker notes]");
    expect(text).not.toContain("Speaker note for slide");
    expect(text).toContain("## Slide 1");
    expect(text).toContain("Slide 1 body text");
    expect(text).toContain("Slide 2 body text");
    expect(text).toContain("Slide 3 body text");
    expect(text).toContain("Name | Owner");
  });

  test('excludes a hidden slide (show="0") and keeps visible indices contiguous', async () => {
    const bytes = buildDeck({ slideOrder: [1, 2, 3], hiddenSlideNumbers: [2] });

    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = result.value.text;
    expect(text).toContain("## Slide 1");
    expect(text).toContain("## Slide 2"); // this is the visible index for slide3, not a gap
    expect(text).not.toContain("## Slide 3");
    expect(text).toContain("Slide 1 body text");
    expect(text).not.toContain("Slide 2 body text");
    expect(text).toContain("Slide 3 body text");
  });

  test("follows presentation order, not filename order, when they differ", async () => {
    const bytes = buildDeck({ slideOrder: [2, 1], withTableAndGroup: false, withNotes: false });

    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = result.value.text;
    const slide1Header = text.indexOf("## Slide 1");
    const slide2Header = text.indexOf("## Slide 2");
    expect(slide1Header).toBeGreaterThanOrEqual(0);
    expect(slide2Header).toBeGreaterThanOrEqual(0);
    // presentation.xml lists slide2 first, so visible "## Slide 1" must be
    // slide2's body, and "## Slide 2" must be slide1's body.
    expect(text.indexOf("Slide 2 body text")).toBeGreaterThan(slide1Header);
    expect(text.indexOf("Slide 2 body text")).toBeLessThan(slide2Header);
    expect(text.indexOf("Slide 1 body text")).toBeGreaterThan(slide2Header);
  });

  test("returns empty for a valid pptx with no slides", async () => {
    const bytes = buildDeck({ slideOrder: [], withNotes: false, withTableAndGroup: false });

    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("empty");
  });

  test("classifies an OLE compound-file (EncryptedPackage) container as encrypted", async () => {
    const oleHeader = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

    const result = await extractPptx(oleHeader, DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("encrypted");
  });

  test("rejects truncated / non-zip bytes as malformed", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("malformed");
  });

  test("rejects a zip missing ppt/presentation.xml as malformed", async () => {
    const bytes = buildPptxZip({ "ppt/slides/slide1.xml": wrapSlide(textShape("orphan slide")) });

    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("malformed");
  });
});
