// test/extract/pdf.test.ts
// U9: .pdf text-layer extraction via pdfjs-dist. Fixtures are built
// programmatically as tiny, synthetic, hand-written PDF object graphs (a
// PDF's object/xref structure is plain ASCII, so — like U7/U8's OOXML
// fixtures — no binary needs to be checked in for these). The one exception
// is `fixtures/pdf-encrypted.pdf`: producing a genuinely password-protected
// PDF requires real RC4/AES encryption math, impractical to hand-roll here,
// so that one small (~1KB) synthetic fixture is checked in instead.

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, test, vi } from "vitest";
import { extractText } from "../../src/extract/index.js";
import {
  __setStandardFontDataUrlCacheForTests,
  extractPdf,
  handlePdf,
} from "../../src/extract/pdf.js";
import { DEFAULT_EXTRACT_LIMITS, type ExtractLimits } from "../../src/extract/types.js";
import { canRunTsWorkers } from "../helpers/ts-worker-support.js";
import { buildPdf, type PageSpec, textOp } from "./fixtures.js";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url);

describe("extractPdf", () => {
  test("extracts a 3-page text-layer PDF, pages separated by a blank line, in order", async () => {
    const bytes = buildPdf([
      { contentOps: textOp("F1", 24, 10, 100, "Page One Alpha"), fonts: { F1: "Helvetica" } },
      { contentOps: textOp("F1", 24, 10, 100, "Page Two Bravo"), fonts: { F1: "Helvetica" } },
      { contentOps: textOp("F1", 24, 10, 100, "Page Three Charlie"), fonts: { F1: "Helvetica" } },
    ]);

    const result = await extractPdf(bytes, DEFAULT_EXTRACT_LIMITS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pages).toBe(3);
    const parts = result.value.text.split("\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("Page One Alpha");
    expect(parts[1]).toContain("Page Two Bravo");
    expect(parts[2]).toContain("Page Three Charlie");
    // Page order must be preserved, not just presence.
    const idxOne = result.value.text.indexOf("Alpha");
    const idxTwo = result.value.text.indexOf("Bravo");
    const idxThree = result.value.text.indexOf("Charlie");
    expect(idxOne).toBeLessThan(idxTwo);
    expect(idxTwo).toBeLessThan(idxThree);
  });

  test("recovers text from multiple base-14 fonts in the same document (standardFontDataUrl supplied)", async () => {
    const bytes = buildPdf([
      {
        contentOps: [
          textOp("F1", 18, 10, 150, "Helvetica decision heading"),
          textOp("F2", 14, 10, 100, "Times body ligature affine"),
        ].join(" "),
        fonts: { F1: "Helvetica", F2: "Times-Roman" },
      },
    ]);

    const result = await extractPdf(bytes, DEFAULT_EXTRACT_LIMITS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Helvetica decision heading");
    expect(result.value.text).toContain("Times body ligature affine");
  });

  test("classifies an image-only (no text layer) PDF as empty", async () => {
    // A content stream that paints a filled rectangle only — no text
    // operators at all, so getTextContent() yields zero items.
    const bytes = buildPdf([{ contentOps: "0 0 1 rg 0 0 200 200 re f" }]);

    const result = await extractPdf(bytes, DEFAULT_EXTRACT_LIMITS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("empty");
  });

  test("classifies a password-protected PDF as encrypted", async () => {
    const bytes = await readFile(new URL("pdf-encrypted.pdf", FIXTURES_DIR));

    const result = await extractPdf(new Uint8Array(bytes), DEFAULT_EXTRACT_LIMITS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("encrypted");
  });

  test("classifies malformed / not-a-PDF bytes as malformed", async () => {
    const bytes = new TextEncoder().encode("this is not a PDF, just plain text bytes");

    const result = await extractPdf(bytes, DEFAULT_EXTRACT_LIMITS);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("malformed");
  });

  test("classifies a PDF over the page cap as too_large, without extracting any page's content", async () => {
    const limits: ExtractLimits = { ...DEFAULT_EXTRACT_LIMITS, maxPdfPages: 500 };
    const pages: PageSpec[] = Array.from({ length: 501 }, () => ({})); // no /Contents at all
    const bytes = buildPdf(pages);

    // Prove ordering, not just the returned reason: patch
    // PDFDocumentProxy.prototype.getPage (shared across all instances,
    // pdfjs-dist exports no named class for it) via a throwaway small
    // document, then assert it's never invoked while extracting the
    // over-the-cap fixture. If the implementation ever extracted pages
    // before checking doc.numPages against the cap, this would fail.
    const probeBytes = buildPdf([{}]);
    const probeTask = getDocument({ data: probeBytes });
    const probeDoc = await probeTask.promise;
    const proto = Object.getPrototypeOf(probeDoc) as { getPage: unknown };
    await probeDoc.cleanup();
    await probeTask.destroy();
    const getPageSpy = vi.spyOn(
      proto as unknown as Record<string, (...args: unknown[]) => unknown>,
      "getPage",
    );

    try {
      const result = await extractPdf(bytes, limits);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe("too_large");
      expect(getPageSpy).not.toHaveBeenCalled();
    } finally {
      getPageSpy.mockRestore();
    }
  });

  test("handlePdf matches the worker dispatch Handler contract", async () => {
    const bytes = buildPdf([
      { contentOps: textOp("F1", 24, 10, 100, "Dispatch check"), fonts: { F1: "Helvetica" } },
    ]);

    const result = await handlePdf({ bytes, kind: "pdf", limits: DEFAULT_EXTRACT_LIMITS });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toContain("Dispatch check");
  });
});

describe("standardFontDataUrl resolution resilience (U9 follow-up)", () => {
  // Recomputes the real standard_fonts path the same way pdf.ts's
  // resolveStandardFontDataUrl() does, so tests here can restore the
  // module's memoized cache to its real value after simulating a failure.
  function realStandardFontDataUrl(): string {
    const pkgUrl = import.meta.resolve("pdfjs-dist/package.json");
    const dir = new URL(".", pkgUrl);
    return fileURLToPath(new URL("standard_fonts/", dir));
  }

  test("importing pdf.ts never throws, even before any font-dir resolution is attempted", async () => {
    // Resolution used to run at module top level, which meant a throw here
    // would take down worker.ts's unconditional import of pdf.ts (and thus
    // docx/pptx too, since they share the same dispatch-table bootstrap).
    // It's now lazy — this file's static top-level import already proves
    // the module loads without resolving anything; this dynamic re-import
    // makes that invariant an explicit, independent assertion.
    await expect(import("../../src/extract/pdf.js")).resolves.toBeDefined();
  });

  test("extractPdf degrades to extraction-without-fonts, rather than failing, when the standard-fonts dir can't be resolved", async () => {
    const bytes = buildPdf([
      {
        contentOps: textOp("F1", 24, 10, 100, "Degraded font path text"),
        fonts: { F1: "Helvetica" },
      },
    ]);

    __setStandardFontDataUrlCacheForTests(undefined);
    try {
      const result = await extractPdf(bytes, DEFAULT_EXTRACT_LIMITS);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.text).toContain("Degraded font path text");
    } finally {
      __setStandardFontDataUrlCacheForTests(realStandardFontDataUrl());
    }
  });
});

describe.skipIf(!canRunTsWorkers)(
  "extractText harness dispatching pdf through the real worker_threads path",
  () => {
    // Unlike the extractPdf() unit tests above (which call the driver
    // in-process), this goes through src/extract/index.ts's real Worker
    // spawn with no workerUrl override — i.e. worker.ts's actual dispatch
    // table and its sibling-import loading of pdf.ts, exactly the seam U7's
    // comment warns doesn't reliably remap .js -> .ts for a value import.
    test("extracts a real PDF's text through the worker_threads harness", async () => {
      const bytes = buildPdf([
        { contentOps: textOp("F1", 24, 10, 100, "Worker thread text"), fonts: { F1: "Helvetica" } },
      ]);

      const result = await extractText(bytes, "pdf", DEFAULT_EXTRACT_LIMITS);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.text).toContain("Worker thread text");
    });

    test("propagates encrypted classification through the worker_threads harness", async () => {
      const bytes = fs.readFileSync(new URL("pdf-encrypted.pdf", FIXTURES_DIR));

      const result = await extractText(new Uint8Array(bytes), "pdf", DEFAULT_EXTRACT_LIMITS);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.reason).toBe("encrypted");
    });
  },
);
