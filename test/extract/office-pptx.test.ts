// test/extract/office-pptx.test.ts
// U8: .pptx (DrawingML/PresentationML) OOXML slide walker + speaker notes.
// Fixtures are built programmatically as synthetic, hand-built OOXML zips
// (via fflate) so no binary fixtures need to be checked in — same approach
// as U7's office-docx.test.ts.

import { describe, expect, test } from "vitest";
import { extractPptx } from "../../src/extract/office.js";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/extract/types.js";
import {
  buildDeck,
  buildPptxZip,
  NOTES_REL_TYPE,
  SLIDE_REL_TYPE,
  textShape,
  wrapPresentation,
  wrapRelationships,
  wrapSlide,
} from "./fixtures.js";

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

  test("dangling r:id in presentation.xml.rels: the unresolved slide is dropped, no throw", async () => {
    const parts: Record<string, string> = {
      "ppt/presentation.xml": wrapPresentation(
        `<p:sldId id="256" r:id="rId999"/><p:sldId id="257" r:id="rId101"/>`,
      ),
      // rId999 is never defined here — a dangling relationship reference.
      "ppt/_rels/presentation.xml.rels": wrapRelationships([
        { id: "rId101", type: SLIDE_REL_TYPE, target: "slides/slide1.xml" },
      ]),
      "ppt/slides/slide1.xml": wrapSlide(textShape("Only real slide")),
    };

    const result = await extractPptx(buildPptxZip(parts), DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Only real slide");
    expect(result.value.text).toContain("## Slide 1");
    expect(result.value.text).not.toContain("## Slide 2");
  });

  test("missing presentation.xml.rels part entirely: all slides unresolved, returns empty, no throw", async () => {
    const parts: Record<string, string> = {
      "ppt/presentation.xml": wrapPresentation(`<p:sldId id="256" r:id="rId101"/>`),
      "ppt/slides/slide1.xml": wrapSlide(textShape("Unreachable slide")),
      // ppt/_rels/presentation.xml.rels is deliberately absent.
    };

    const result = await extractPptx(buildPptxZip(parts), DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("empty");
  });

  test("dangling notes relationship target: slide body still extracted, no [speaker notes] block, no throw", async () => {
    const parts: Record<string, string> = {
      "ppt/presentation.xml": wrapPresentation(`<p:sldId id="256" r:id="rId101"/>`),
      "ppt/_rels/presentation.xml.rels": wrapRelationships([
        { id: "rId101", type: SLIDE_REL_TYPE, target: "slides/slide1.xml" },
      ]),
      "ppt/slides/slide1.xml": wrapSlide(textShape("Slide with dangling notes ref")),
      "ppt/slides/_rels/slide1.xml.rels": wrapRelationships([
        { id: "rId1", type: NOTES_REL_TYPE, target: "../notesSlides/notesSlide1.xml" },
      ]),
      // ppt/notesSlides/notesSlide1.xml is deliberately absent — the notes
      // relationship resolves to a target that doesn't exist in the package.
    };

    const result = await extractPptx(buildPptxZip(parts), DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Slide with dangling notes ref");
    expect(result.value.text).not.toContain("[speaker notes]");
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
