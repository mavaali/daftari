// test/extract/office-docx.test.ts
// U7: .docx (WordprocessingML) OOXML text-run walker. Fixtures are built
// programmatically as synthetic, hand-built OOXML zips (via fflate) so no
// binary fixtures need to be checked in.

import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { extractDocx } from "../../src/extract/office.js";
import { DEFAULT_EXTRACT_LIMITS } from "../../src/extract/types.js";

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const V_NS = 'xmlns:v="urn:schemas-microsoft-com:vml"';

function wrapDocument(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`;
}

function wrapFootnotes(footnotesXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}>${footnotesXml}</w:footnotes>`;
}

function buildDocxZip(parts: Record<string, string>): Uint8Array {
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypesXml),
  };
  for (const [name, content] of Object.entries(parts)) {
    files[name] = strToU8(content);
  }
  return zipSync(files);
}

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

/**
 * Locates the local file header and central directory record for `entryName`
 * inside a zip produced by fflate's zipSync, and overwrites the
 * "uncompressed size" field (a 4-byte LE integer) in both places with
 * `forgedSize`, leaving the actual compressed bytes untouched.
 */
function forgeUncompressedSize(
  zipBytes: Uint8Array,
  entryName: string,
  forgedSize: number,
): Uint8Array {
  const out = new Uint8Array(zipBytes); // copy, don't mutate the caller's buffer
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const nameBytes = strToU8(entryName);

  const LOCAL_SIG = 0x04034b50;
  const CENTRAL_SIG = 0x02014b50;

  const matchesNameAt = (nameOffset: number): boolean => {
    if (nameOffset + nameBytes.length > out.length) return false;
    for (let i = 0; i < nameBytes.length; i += 1) {
      if (out[nameOffset + i] !== nameBytes[i]) return false;
    }
    return true;
  };

  let patchedLocal = false;
  let patchedCentral = false;
  for (let i = 0; i + 4 <= out.length; i += 1) {
    const sig = view.getUint32(i, true);
    if (sig === LOCAL_SIG && !patchedLocal) {
      const nameLen = view.getUint16(i + 26, true);
      if (matchesNameAt(i + 30) && strFromBytes(out, i + 30, nameLen) === entryName) {
        view.setUint32(i + 22, forgedSize, true); // uncompressed size
        patchedLocal = true;
      }
    } else if (sig === CENTRAL_SIG && !patchedCentral) {
      const nameLen = view.getUint16(i + 28, true);
      if (matchesNameAt(i + 46) && strFromBytes(out, i + 46, nameLen) === entryName) {
        view.setUint32(i + 24, forgedSize, true); // uncompressed size
        patchedCentral = true;
      }
    }
    if (patchedLocal && patchedCentral) break;
  }

  if (!patchedLocal || !patchedCentral) {
    throw new Error(`forgeUncompressedSize: could not locate zip headers for ${entryName}`);
  }
  return out;
}

function strFromBytes(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("utf-8").decode(bytes.subarray(offset, offset + length));
}
