// test/extract/fixtures.ts
// Shared, programmatically-built fixture constructors for docx/pptx/pdf
// extraction tests. Factored out of office-docx.test.ts / office-pptx.test.ts
// / pdf.test.ts (U7/U8/U9) so the U10 evaluation corpus (corpus.test.ts) can
// reuse them without duplicating OOXML/PDF construction — and so none of it
// needs `export` from a *.test.ts file (disallowed by the repo's lint rule
// lint/suspicious/noExportsInTest). The per-format test files import their
// builders from here; behavior is unchanged, only the builders' location.

import { strToU8, zipSync } from "fflate";

// ---------------------------------------------------------------------------
// docx (WordprocessingML)
// ---------------------------------------------------------------------------

export const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export const V_NS = 'xmlns:v="urn:schemas-microsoft-com:vml"';

export function wrapDocument(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`;
}

export function wrapFootnotes(footnotesXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W_NS}>${footnotesXml}</w:footnotes>`;
}

export function buildDocxZip(parts: Record<string, string>): Uint8Array {
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

/**
 * Locates the local file header and central directory record for `entryName`
 * inside a zip produced by fflate's zipSync, and overwrites the
 * "uncompressed size" field (a 4-byte LE integer) in both places with
 * `forgedSize`, leaving the actual compressed bytes untouched.
 */
export function forgeUncompressedSize(
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

export function strFromBytes(bytes: Uint8Array, offset: number, length: number): string {
  return new TextDecoder("utf-8").decode(bytes.subarray(offset, offset + length));
}

// ---------------------------------------------------------------------------
// pptx (DrawingML / PresentationML)
// ---------------------------------------------------------------------------

export const P_NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
export const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
export const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';

export const SLIDE_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
export const NOTES_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

export function contentTypesXml(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
}

export function wrapPresentation(sldIdLstXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${P_NS}><p:sldIdLst>${sldIdLstXml}</p:sldIdLst></p:presentation>`;
}

export function wrapRelationships(
  rels: Array<{ id: string; type: string; target: string }>,
): string {
  const body = rels
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>${body}</Relationships>`;
}

export function wrapSlide(spTreeBodyXml: string, opts: { hidden?: boolean } = {}): string {
  const showAttr = opts.hidden ? ' show="0"' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${P_NS} ${A_NS}${showAttr}><p:cSld><p:spTree>${spTreeBodyXml}</p:spTree></p:cSld></p:sld>`;
}

export function wrapNotesSlide(spTreeBodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${P_NS} ${A_NS}><p:cSld><p:spTree>${spTreeBodyXml}</p:spTree></p:cSld></p:notes>`;
}

export function textShape(text: string, extraParagraphs: string[] = []): string {
  const paras = [text, ...extraParagraphs]
    .map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`)
    .join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
}

export function groupedTextShape(text: string): string {
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${textShape(text)}</p:grpSp>`;
}

export function tableGraphicFrame(rows: string[][]): string {
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

export function buildPptxZip(parts: Record<string, string>): Uint8Array {
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
export function buildDeck(opts: {
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

// ---------------------------------------------------------------------------
// pdf (minimal synthetic object/xref graph)
// ---------------------------------------------------------------------------

export interface PageSpec {
  /** Content-stream operators (already valid PDF syntax), or omitted for a
   * page with no /Contents at all (used for the "over the page cap" fixture
   * — no content stream is ever needed to make `doc.numPages` see a page). */
  contentOps?: string;
  /** Font resource name -> PDF base-14 font name (e.g. "F1" -> "Helvetica"). */
  fonts?: Record<string, string>;
}

export function buildPdf(pages: PageSpec[]): Uint8Array {
  const objs: string[] = []; // index 0 unused; objs[n] is object n's body
  objs[0] = "";

  const pageObjNums: number[] = [];
  const contentObjNums: number[] = [];
  const fontObjNums = new Map<string, number>(); // base-14 font name -> obj num

  let nextObjNum = 3; // 1: catalog, 2: pages tree
  for (const spec of pages) {
    pageObjNums.push(nextObjNum);
    nextObjNum += 1;
    if (spec.contentOps !== undefined) {
      contentObjNums.push(nextObjNum);
      nextObjNum += 1;
    } else {
      contentObjNums.push(-1);
    }
  }
  for (const spec of pages) {
    for (const fontName of Object.values(spec.fonts ?? {})) {
      if (!fontObjNums.has(fontName)) {
        fontObjNums.set(fontName, nextObjNum);
        nextObjNum += 1;
      }
    }
  }
  const maxObjNum = nextObjNum - 1;

  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;

  pages.forEach((spec, i) => {
    const pageObjNum = pageObjNums[i];
    const contentObjNum = contentObjNums[i];
    const fontEntries = Object.entries(spec.fonts ?? {})
      .map(([resName, fontName]) => `/${resName} ${fontObjNums.get(fontName)} 0 R`)
      .join(" ");
    const resources = `<< /Font << ${fontEntries} >> >>`;
    const contentsEntry = contentObjNum === -1 ? "" : ` /Contents ${contentObjNum} 0 R`;
    // Wide enough that a full line of test text never exceeds the page's
    // visible bounds — pdfjs's text-content extraction clips a text run
    // once it runs past the MediaBox width, so a too-narrow page here would
    // silently truncate the fixture's own text, not exercise pdf.ts at all.
    objs[pageObjNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 300] /Resources ${resources}${contentsEntry} >>`;
    if (contentObjNum !== -1) {
      const stream = spec.contentOps ?? "";
      objs[contentObjNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    }
  });

  for (const [fontName, objNum] of fontObjNums) {
    objs[objNum] = `<< /Type /Font /Subtype /Type1 /BaseFont /${fontName} >>`;
  }

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let n = 1; n <= maxObjNum; n += 1) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${maxObjNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObjNum; n += 1) {
    out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxObjNum + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(out);
}

/** A single Tj text-showing operation at a fixed position, one line. */
export function textOp(font: string, size: number, x: number, y: number, text: string): string {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  return `BT /${font} ${size} Tf ${x} ${y} Td (${escaped}) Tj ET`;
}
