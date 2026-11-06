// src/extract/pdf.ts
// U9: .pdf text-layer extraction via pdfjs-dist (legacy Node build). Reads
// the text layer only — no OCR, no rendering. Provider-neutral: no
// Graph/Microsoft imports belong here.
//
// pdfjs-dist is a real published npm package (unlike office.ts's local
// sibling modules), so it's imported with a normal static specifier — the
// tsx-in-worker sibling-import gotcha (see worker.ts/office.ts) only applies
// to *this project's own* .ts sibling modules resolved from inside a
// worker_threads realm, not to node_modules packages, which resolve the
// same way regardless of who's asking.
import { fileURLToPath } from "node:url";
import { getDocument, PasswordException, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ExtractLimits, ExtractRequest, ExtractWorkerResponse } from "./types.js";

// pdfjs-dist calls Promise.withResolvers, which only exists on Node 22+. This
// package supports Node 20 (engines: >=20.9.0, CI matrix includes 20), where it
// is absent — getDocument() would throw a TypeError. Install the standard
// polyfill, guarded, before any pdfjs call.
interface WithResolversResult<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}
const promiseCtor = Promise as unknown as {
  withResolvers?: <T>() => WithResolversResult<T>;
};
if (typeof promiseCtor.withResolvers !== "function") {
  promiseCtor.withResolvers = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// tsx's ESM resolve hook doesn't reliably remap a ".js" specifier to its
// sibling ".ts" source for a *value* import resolved from inside a worker
// thread (see worker.ts's matching comment) — but `normalize` here is a real
// value this module calls at runtime, so resolve it via an exact-extension
// URL (matching this file's own extension) instead of a plain specifier.
const pdfModuleSuffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const { normalize } = (await import(
  new URL(`./normalize${pdfModuleSuffix}`, import.meta.url).href
)) as typeof import("./normalize.js");

/**
 * Resolves the standard-fonts directory pdfjs-dist ships, as a plain
 * filesystem path with a trailing slash. This deliberately is NOT a
 * `file://` URL string: pdfjs-dist's Node code path (NodeBinaryDataFactory)
 * concatenates `standardFontDataUrl + filename` as a plain string and hands
 * that straight to `fs.promises.readFile`, which only recognizes `file:`
 * URLs when given an actual `URL` object — a "file://…" *string* is instead
 * treated as a literal (bogus) path and fails with ENOENT. `import.meta
 * .resolve` + `fileURLToPath` gets us the real disk path pdfjs-dist expects.
 */
function resolveStandardFontDataUrl(): string {
  const pkgUrl = import.meta.resolve("pdfjs-dist/package.json");
  const dir = new URL(".", pkgUrl);
  return fileURLToPath(new URL("standard_fonts/", dir));
}

// Deliberately lazy and memoized, NOT resolved at module top level: worker.ts
// imports this module unconditionally (alongside office.ts) before building
// its dispatch table, so a throw here at import time would take down docx
// and pptx extraction too, not just pdf — e.g. a packaging layout that
// strips pdfjs-dist's standard_fonts/ directory, or a stricter
// pnpm/bundler install. Resolving lazily on first extractPdf() call, and
// caching the outcome (including a resolution failure, so we don't retry
// pointlessly on every request), confines that failure to pdf extraction
// alone — and even then, degrades rather than fails outright: see
// getStandardFontDataUrl's caller.
const NOT_YET_RESOLVED = Symbol("standard-font-data-url-not-yet-resolved");
let standardFontDataUrlCache: string | undefined | typeof NOT_YET_RESOLVED = NOT_YET_RESOLVED;

function getStandardFontDataUrl(): string | undefined {
  if (standardFontDataUrlCache === NOT_YET_RESOLVED) {
    try {
      standardFontDataUrlCache = resolveStandardFontDataUrl();
    } catch {
      standardFontDataUrlCache = undefined;
    }
  }
  return standardFontDataUrlCache;
}

/**
 * Test-only seam: forces the memoized standard-fonts resolution to a given
 * value (pass `undefined` to simulate an environment where it couldn't be
 * resolved, without actually breaking node_modules). Never called from
 * production code — only from test/extract/pdf.test.ts, to prove
 * extractPdf degrades gracefully rather than failing when this lookup comes
 * up empty.
 */
export function __setStandardFontDataUrlCacheForTests(value: string | undefined): void {
  standardFontDataUrlCache = value;
}

interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return typeof item === "object" && item !== null && "str" in item && "hasEOL" in item;
}

/** Joins one page's text-content items per design spec §3.2: runs within a
 * line are joined by a space; an item with `hasEOL` ends the line. */
function joinPageText(items: readonly unknown[]): string {
  const lines: string[] = [];
  let current: string[] = [];
  for (const item of items) {
    if (!isPdfTextItem(item)) continue; // TextMarkedContent: not a text run
    current.push(item.str);
    if (item.hasEOL) {
      lines.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) lines.push(current.join(" "));
  return lines.join("\n");
}

/** Extracts normalized text-layer content from a .pdf byte buffer per design
 * spec §3.2, via pdfjs-dist's legacy Node build. */
export async function extractPdf(
  bytes: Uint8Array,
  limits: ExtractLimits,
): Promise<ExtractWorkerResponse> {
  // If the standard-fonts dir can't be resolved (see getStandardFontDataUrl's
  // comment), degrade rather than fail: pdfjs still extracts text without
  // it, just with pdfjs's own non-fatal glyph-mapping warning for
  // non-embedded/non-standard fonts, logged at ERRORS verbosity below (which
  // won't surface it) — that's an acceptable quality trade against refusing
  // to extract at all.
  const loadingTask = getDocument({
    data: bytes,
    standardFontDataUrl: getStandardFontDataUrl(),
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });

  let doc: Awaited<typeof loadingTask.promise> | undefined;
  try {
    doc = await loadingTask.promise;

    // Checked BEFORE extracting any page's content — a page-count-over-cap
    // PDF must never trigger per-page parsing (spec: "assert it does NOT
    // extract all pages first").
    if (doc.numPages > limits.maxPdfPages) {
      return {
        ok: false,
        error: {
          reason: "too_large",
          message: `PDF has ${doc.numPages} pages, exceeding cap of ${limits.maxPdfPages}`,
        },
      };
    }

    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pageTexts.push(joinPageText(textContent.items));
      page.cleanup();
    }

    const rawText = pageTexts.join("\n\n");
    if (rawText.trim().length === 0) {
      return { ok: false, error: { reason: "empty" } };
    }

    let text: string;
    try {
      text = normalize(rawText);
    } catch (e) {
      return {
        ok: false,
        error: { reason: "malformed", message: e instanceof Error ? e.message : String(e) },
      };
    }
    if (text.trim().length === 0) {
      return { ok: false, error: { reason: "empty" } };
    }

    return { ok: true, value: { text, pages: doc.numPages } };
  } catch (e) {
    if (e instanceof PasswordException) {
      return { ok: false, error: { reason: "encrypted", message: e.message } };
    }
    // Any other pdfjs failure — InvalidPDFException (not a PDF at all),
    // UnknownErrorException, a corrupt xref/object stream, etc. — is
    // reported as malformed (spec: "pdfjs parse error / not a PDF").
    return {
      ok: false,
      error: { reason: "malformed", message: e instanceof Error ? e.message : String(e) },
    };
  } finally {
    // doc.destroy() is NOT a method in pdfjs-dist v6 — only loadingTask has
    // destroy(); doc itself only has cleanup(). Both are best-effort: a
    // failure during teardown must never mask (or replace) the real result
    // already computed above.
    if (doc) {
      try {
        await doc.cleanup();
      } catch {
        /* best-effort teardown */
      }
    }
    try {
      await loadingTask.destroy();
    } catch {
      /* best-effort teardown */
    }
  }
}

/** Worker dispatch entry point (matches the Handler shape in worker.ts). */
export async function handlePdf(request: ExtractRequest): Promise<ExtractWorkerResponse> {
  return extractPdf(request.bytes, request.limits);
}
