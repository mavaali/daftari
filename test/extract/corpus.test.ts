// test/extract/corpus.test.ts
// U10: consolidated, data-driven evaluation corpus across docx/pptx/pdf.
//
// This does NOT re-test the per-format edge cases already covered by
// office-docx.test.ts / office-pptx.test.ts / pdf.test.ts (dangling rels,
// zip-bomb header forging, standardFontDataUrl resilience, etc.) — it
// reuses those files' fixture builders (exported for this purpose) to
// assemble a single table asserting the two properties R31 cares about:
//   1. 100% decision-sentence recall on "happy" fixtures.
//   2. Exact failure-`reason` classification on "negative" fixtures.
// It also measures per-type text_chars/source_bytes ratios over the happy
// fixtures and writes them to test/fixtures/extract/ratios.json — a
// committed artifact U17 (enrollment cost-preview) reads later to estimate
// extracted-text volume from a file's byte size before enrolling it.

import fs from "node:fs";
import { beforeAll, describe, expect, test } from "vitest";
import { extractDocx, extractPptx } from "../../src/extract/office.js";
import { extractPdf } from "../../src/extract/pdf.js";
import {
  DEFAULT_EXTRACT_LIMITS,
  type ExtractLimits,
  type ExtractReason,
} from "../../src/extract/types.js";
import {
  buildDeck,
  buildDocxZip,
  buildPdf,
  forgeUncompressedSize,
  type PageSpec,
  textOp,
  wrapDocument,
  wrapFootnotes,
} from "./fixtures.js";

const RATIOS_PATH = new URL("../fixtures/extract/ratios.json", import.meta.url);

type CorpusType = "docx" | "pptx" | "pdf";

interface HappyCase {
  type: CorpusType;
  label: string;
  classification: "happy";
  bytes: Uint8Array;
  /** Substrings that MUST survive extraction verbatim — the decision-sentence recall bar. */
  decisionSentences: string[];
  limits?: ExtractLimits;
  /** pptx only */
  includeSpeakerNotes?: boolean;
}

interface NegativeCase {
  type: CorpusType;
  label: string;
  classification: "negative";
  bytes: Uint8Array;
  reason: ExtractReason;
  limits?: ExtractLimits;
  includeSpeakerNotes?: boolean;
}

type CorpusCase = HappyCase | NegativeCase;

// ---------------------------------------------------------------------------
// Fixtures — built via the existing per-format test files' exported builders.
// ---------------------------------------------------------------------------

const OLE_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
const TRUNCATED = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

// --- docx fixtures ---

const docxHappyCharter = buildDocxZip({
  "word/document.xml": wrapDocument(`
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project Charter</w:t></w:r></w:p>
    <w:p><w:r><w:t>We will proceed with plan A and ship by end of Q3.</w:t></w:r></w:p>
    <w:p><w:r><w:t>The board approved the budget increase on 2026-02-01.</w:t></w:r></w:p>
  `),
});

const docxHappyFootnote = buildDocxZip({
  "word/document.xml": wrapDocument(`
    <w:p><w:r><w:t>See details</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>
  `),
  "word/footnotes.xml": wrapFootnotes(
    `<w:footnote w:id="1"><w:p><w:r><w:t>Approved by finance on 2026-01-01.</w:t></w:r></w:p></w:footnote>`,
  ),
});

const docxEmpty = buildDocxZip({ "word/document.xml": wrapDocument(`<w:sectPr/>`) });

const docxTooLarge = (() => {
  const body = wrapDocument(`<w:p><w:r><w:t>${"tiny ".repeat(20)}</w:t></w:r></w:p>`);
  const bytes = buildDocxZip({ "word/document.xml": body });
  return forgeUncompressedSize(bytes, "word/document.xml", 40 * 1024 * 1024);
})();

// --- pptx fixtures ---

const pptxHappyDeck = buildDeck({ slideOrder: [1, 2, 3] });

const pptxEmpty = buildDeck({ slideOrder: [], withNotes: false, withTableAndGroup: false });

const pptxTooLarge = (() => {
  const bytes = buildDeck({ slideOrder: [1], withNotes: false, withTableAndGroup: false });
  return forgeUncompressedSize(bytes, "ppt/slides/slide1.xml", 40 * 1024 * 1024);
})();

// --- pdf fixtures ---

const pdfHappyThreePage = buildPdf([
  {
    contentOps: textOp("F1", 24, 10, 100, "Decision: ship the Q3 release on schedule."),
    fonts: { F1: "Helvetica" },
  },
  {
    contentOps: textOp("F1", 24, 10, 100, "The committee approved the merger on 2026-03-01."),
    fonts: { F1: "Helvetica" },
  },
  {
    contentOps: textOp("F1", 24, 10, 100, "Final budget signed off by finance."),
    fonts: { F1: "Helvetica" },
  },
]);

const pdfImageOnly = buildPdf([{ contentOps: "0 0 1 rg 0 0 200 200 re f" }]);

const pdfNotAPdf = new TextEncoder().encode("this is not a PDF, just plain text bytes");

const PDF_TOO_LARGE_LIMITS: ExtractLimits = { ...DEFAULT_EXTRACT_LIMITS, maxPdfPages: 500 };
const pdfTooLargePages: PageSpec[] = Array.from({ length: 501 }, () => ({}));
const pdfTooLarge = buildPdf(pdfTooLargePages);

// ---------------------------------------------------------------------------
// The corpus table
// ---------------------------------------------------------------------------

const CORPUS: CorpusCase[] = [
  // docx
  {
    type: "docx",
    label: "docx: project charter with a clear decision sentence",
    classification: "happy",
    bytes: docxHappyCharter,
    decisionSentences: [
      "We will proceed with plan A and ship by end of Q3.",
      "The board approved the budget increase on 2026-02-01.",
    ],
  },
  {
    type: "docx",
    label: "docx: footnote carries the decision (finance approval)",
    classification: "happy",
    bytes: docxHappyFootnote,
    decisionSentences: ["Approved by finance on 2026-01-01."],
  },
  {
    type: "docx",
    label: "docx: OLE compound-file container",
    classification: "negative",
    bytes: OLE_HEADER,
    reason: "encrypted",
  },
  {
    type: "docx",
    label: "docx: truncated / non-zip bytes",
    classification: "negative",
    bytes: TRUNCATED,
    reason: "malformed",
  },
  {
    type: "docx",
    label: "docx: valid but no extractable text",
    classification: "negative",
    bytes: docxEmpty,
    reason: "empty",
  },
  {
    type: "docx",
    label: "docx: forged declared-size zip bomb",
    classification: "negative",
    bytes: docxTooLarge,
    reason: "too_large",
  },
  // pptx
  {
    type: "pptx",
    label: "pptx: 3-slide deck with notes and a decision on slide 2",
    classification: "happy",
    bytes: pptxHappyDeck,
    decisionSentences: ["Slide 2 body text"],
    includeSpeakerNotes: true,
  },
  {
    type: "pptx",
    label: "pptx: OLE compound-file container",
    classification: "negative",
    bytes: OLE_HEADER,
    reason: "encrypted",
  },
  {
    type: "pptx",
    label: "pptx: truncated / non-zip bytes",
    classification: "negative",
    bytes: TRUNCATED,
    reason: "malformed",
  },
  {
    type: "pptx",
    label: "pptx: valid deck with zero slides",
    classification: "negative",
    bytes: pptxEmpty,
    reason: "empty",
  },
  {
    type: "pptx",
    label: "pptx: forged declared-size zip bomb on a slide part",
    classification: "negative",
    bytes: pptxTooLarge,
    reason: "too_large",
  },
  // pdf
  {
    type: "pdf",
    label: "pdf: 3-page text-layer deck with decision sentences",
    classification: "happy",
    bytes: pdfHappyThreePage,
    decisionSentences: [
      "Decision: ship the Q3 release on schedule.",
      "The committee approved the merger on 2026-03-01.",
      "Final budget signed off by finance.",
    ],
  },
  {
    type: "pdf",
    label: "pdf: password-protected",
    classification: "negative",
    bytes: new Uint8Array(
      fs.readFileSync(new URL("./fixtures/pdf-encrypted.pdf", import.meta.url)),
    ),
    reason: "encrypted",
  },
  {
    type: "pdf",
    label: "pdf: not a PDF at all",
    classification: "negative",
    bytes: pdfNotAPdf,
    reason: "malformed",
  },
  {
    type: "pdf",
    label: "pdf: image-only, no text layer",
    classification: "negative",
    bytes: pdfImageOnly,
    reason: "empty",
  },
  {
    type: "pdf",
    label: "pdf: over the page cap",
    classification: "negative",
    bytes: pdfTooLarge,
    reason: "too_large",
    limits: PDF_TOO_LARGE_LIMITS,
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runExtract(c: CorpusCase) {
  const limits = c.limits ?? DEFAULT_EXTRACT_LIMITS;
  const notes = c.includeSpeakerNotes ?? true;
  // Each corpus case's fixture bytes may be run through its extractor more
  // than once (once in the main pass/fail loop below, again while measuring
  // ratios) — pdfjs-dist detaches/transfers the underlying ArrayBuffer of
  // whatever Uint8Array it's given, so a fixture reused as-is fails its
  // second call with "Cannot transfer object of unsupported type." A fresh
  // copy per call sidesteps that without touching extractPdf itself.
  const bytes = new Uint8Array(c.bytes);
  switch (c.type) {
    case "docx":
      return extractDocx(bytes, limits);
    case "pptx":
      return extractPptx(bytes, limits, notes);
    case "pdf":
      return extractPdf(bytes, limits);
  }
}

describe("extraction evaluation corpus (R31)", () => {
  for (const c of CORPUS) {
    test(c.label, async () => {
      const result = await runExtract(c);
      if (c.classification === "happy") {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        for (const sentence of c.decisionSentences) {
          expect(result.value.text).toContain(sentence);
        }
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.reason).toBe(c.reason);
      }
    });
  }

  test(`corpus covers all three types with at least one happy and one negative case`, () => {
    for (const type of ["docx", "pptx", "pdf"] as const) {
      const happy = CORPUS.filter((c) => c.type === type && c.classification === "happy");
      const negative = CORPUS.filter((c) => c.type === type && c.classification === "negative");
      expect(happy.length).toBeGreaterThan(0);
      expect(negative.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Ratio measurement — text_chars / source_bytes over the happy fixtures,
// written to test/fixtures/extract/ratios.json for U17 to read.
// ---------------------------------------------------------------------------

describe("text_chars / source_bytes ratios (seeds U17's cost-preview estimate)", () => {
  let ratios: Record<CorpusType, number>;

  beforeAll(async () => {
    const perType: Record<CorpusType, number[]> = { docx: [], pptx: [], pdf: [] };

    for (const c of CORPUS) {
      if (c.classification !== "happy") continue;
      const result = await runExtract(c);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const ratio = result.value.text.length / c.bytes.byteLength;
      perType[c.type].push(ratio);
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    ratios = {
      docx: mean(perType.docx),
      pptx: mean(perType.pptx),
      pdf: mean(perType.pdf),
    };

    fs.writeFileSync(RATIOS_PATH, `${JSON.stringify(ratios, null, 2)}\n`);
  });

  test("docx/pptx ratio is > 0 and < 1 (zip-compressed source, plain-text output)", () => {
    expect(ratios.docx).toBeGreaterThan(0);
    expect(ratios.docx).toBeLessThan(1);
    expect(ratios.pptx).toBeGreaterThan(0);
    expect(ratios.pptx).toBeLessThan(1);
  });

  test("pdf ratio is > 0 (object/xref overhead means it may exceed 1 for small fixtures)", () => {
    expect(ratios.pdf).toBeGreaterThan(0);
    expect(ratios.pdf).toBeLessThan(50); // loose sanity bound, not a precision target
  });

  test("ratios.json on disk matches what was measured this run", () => {
    const onDisk = JSON.parse(fs.readFileSync(RATIOS_PATH, "utf-8"));
    expect(onDisk).toEqual(ratios);
  });
});

// ---------------------------------------------------------------------------
// Legacy PDF conversion loses speaker notes — recorded evidence for keeping
// Graph's `?format=pdf` conversion OUT of the primary Word/PowerPoint path
// (design override #1). Demonstrated at the extraction level: the same
// slide content, once through extractPptx (notes preserved) and once
// through extractPdf against a PDF rendering of the same slides that
// (as real PDF slide-export always does) carries no speaker-notes layer.
// ---------------------------------------------------------------------------

describe("legacy PDF conversion loses speaker notes (evidence for design override #1)", () => {
  const SPEAKER_NOTE = "Speaker note for slide 1";
  const SLIDE_BODY = "Slide 1 body text";

  test("extractPptx WITH speaker notes preserves the note", async () => {
    const bytes = buildDeck({ slideOrder: [1], withTableAndGroup: false });
    const result = await extractPptx(bytes, DEFAULT_EXTRACT_LIMITS, true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain(SLIDE_BODY);
    expect(result.value.text).toContain(SPEAKER_NOTE);
  });

  test("extractPdf against the SAME slide, rendered to PDF without a notes layer, loses the note", async () => {
    // A PDF slide export renders only the visible slide body into the page
    // content stream — speaker notes are presenter-only and have no
    // standard PDF representation, so a PDF built from "the same slide"
    // necessarily contains the body text and nothing resembling the note.
    const bytes = buildPdf([
      { contentOps: textOp("F1", 24, 10, 100, SLIDE_BODY), fonts: { F1: "Helvetica" } },
    ]);
    const result = await extractPdf(bytes, DEFAULT_EXTRACT_LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain(SLIDE_BODY);
    expect(result.value.text).not.toContain(SPEAKER_NOTE);
  });
});
