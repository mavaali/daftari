// test/extract/office-docx.test.ts
// U7: .docx (WordprocessingML) OOXML text-run walker. Fixtures are built
// programmatically as synthetic, hand-built OOXML zips (via fflate) so no
// binary fixtures need to be checked in.

import { describe, expect, test } from "vitest";
import { extractDocx, readOoxmlParts } from "../../src/extract/office.js";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/extract/types.js";
import {
  buildDocxZip,
  forgeUncompressedSize,
  V_NS,
  wrapDocument,
  wrapFootnotes,
} from "./fixtures.js";

describe("extractDocx", () => {
  test("extracts headings, lists, two tables, and a footnote", async () => {
    const body = `
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project Charter</w:t></w:r></w:p>
      <w:p><w:r><w:t>We will proceed with plan A.</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Second bullet</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>Alpha</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Mihir</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>Risk</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Severity</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>Scope creep</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>High</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
      <w:p><w:r><w:t>See details</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
    `;
    const footnotes = `<w:footnote w:id="1"><w:p><w:r><w:t>Approved by finance on 2026-01-01.</w:t></w:r></w:p></w:footnote>`;

    const bytes = buildDocxZip({
      "word/document.xml": wrapDocument(body),
      "word/footnotes.xml": wrapFootnotes(footnotes),
    });

    const result = await extractDocx(bytes, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const text = result.value.text;
    expect(text).toContain("We will proceed with plan A.");
    expect(text).toContain("First bullet");
    expect(text).toContain("Second bullet");
    expect(text).toContain("Name | Owner");
    expect(text).toContain("Alpha | Mihir");
    expect(text).toContain("Risk | Severity");
    expect(text).toContain("Scope creep | High");
    expect(text).toContain("--- notes ---");
    expect(text).toContain("Approved by finance on 2026-01-01.");
  });

  test("keeps inserted text (w:ins) and drops deleted text (w:del)", async () => {
    const body = `
      <w:p>
        <w:ins><w:r><w:t>added text survives</w:t></w:r></w:ins>
        <w:del><w:r><w:delText>removed text is gone</w:delText></w:r></w:del>
      </w:p>
    `;
    const bytes = buildDocxZip({ "word/document.xml": wrapDocument(body) });

    const result = await extractDocx(bytes, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.text).toContain("added text survives");
    expect(result.value.text).not.toContain("removed text is gone");
  });

  test("includes text-box (w:txbxContent) content", async () => {
    const body = `
      <w:p><w:r>
        <w:pict>
          <v:shape ${V_NS}>
            <v:textbox>
              <w:txbxContent><w:p><w:r><w:t>Text box content lands here</w:t></w:r></w:p></w:txbxContent>
            </v:textbox>
          </v:shape>
        </w:pict>
      </w:r></w:p>
    `;
    const bytes = buildDocxZip({ "word/document.xml": wrapDocument(body) });

    const result = await extractDocx(bytes, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.text).toContain("Text box content lands here");
  });

  test("decodes named and numeric XML entities", async () => {
    const body = `<w:p><w:r><w:t>Q&amp;A caf&#233;, 5 &lt; 10 &amp; caf&#xE9;</w:t></w:r></w:p>`;
    const bytes = buildDocxZip({ "word/document.xml": wrapDocument(body) });

    const result = await extractDocx(bytes, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.text).toContain("Q&A café, 5 < 10 & café");
  });

  test("returns empty for a valid docx with no extractable text", async () => {
    const body = `<w:sectPr/>`;
    const bytes = buildDocxZip({ "word/document.xml": wrapDocument(body) });

    const result = await extractDocx(bytes, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("empty");
  });

  test("rejects truncated / non-zip bytes as malformed", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const result = await extractDocx(bytes, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("malformed");
  });

  test("classifies an OLE compound-file (EncryptedPackage) container as encrypted", async () => {
    const oleHeader = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

    const result = await extractDocx(oleHeader, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("encrypted");
  });

  test("catches a declared-size zip bomb via the DECLARED size, without inflating it", async () => {
    // Build a normal small docx zip, then patch the uncompressed-size field
    // in both the local file header and the central directory record for
    // word/document.xml to a forged ~40MB value. The actual compressed
    // bytes on disk stay tiny — this simulates a zip that lies about its
    // inflated size, which fflate's filter must catch from the header
    // alone, before ever calling inflate.
    const realBody = wrapDocument(`<w:p><w:r><w:t>${"tiny ".repeat(20)}</w:t></w:r></w:p>`);
    const bytes = buildDocxZip({ "word/document.xml": realBody });

    const forgedSize = 40 * 1024 * 1024; // 40MB declared
    const patched = forgeUncompressedSize(bytes, "word/document.xml", forgedSize);

    expect(patched.length).toBeLessThan(200 * 1024); // physically tiny file
    const start = Date.now();
    const result = await extractDocx(patched, DEFAULT_EXTRACT_LIMITS);
    const elapsedMs = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("too_large");
    expect(elapsedMs).toBeLessThan(2000); // returns fast, no 40MB allocation
  });
});

describe("readOoxmlParts with a predicate `wanted`", () => {
  test("selects entries by predicate instead of exact name (pptx-style unknown-N part names)", async () => {
    const bytes = buildDocxZip({
      "ppt/slides/slide1.xml": "<p>one</p>",
      "ppt/slides/slide2.xml": "<p>two</p>",
      "ppt/slideLayouts/slideLayout1.xml": "<p>not wanted</p>",
    });

    const result = readOoxmlParts(bytes, DEFAULT_EXTRACT_LIMITS, (name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.parts).sort()).toEqual([
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
    ]);
  });

  test("still supports the exact-name array form (docx's existing behavior, unchanged)", async () => {
    const bytes = buildDocxZip({ "word/document.xml": wrapDocument("<w:p/>") });

    const result = readOoxmlParts(bytes, DEFAULT_EXTRACT_LIMITS, ["word/document.xml"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.parts)).toEqual(["word/document.xml"]);
  });
});
