// src/extract/office.ts
// OOXML (Office Open XML) zip-container text extraction. U7 implements the
// .docx (WordprocessingML) driver; U8 extends this file with a .pptx
// (DrawingML) driver reusing the shared primitives below.
//
// Shared primitives (reusable across docx/pptx):
//   - OLE-magic detection for IRM/password-protected containers (-> encrypted)
//   - a declared-size-capped zip opener built on fflate's unzipSync filter
//     (zip-bomb defense: caps are enforced on the DECLARED originalSize
//     BEFORE any bytes are inflated)
//   - a linear, non-DTD, non-entity-expanding XML tokenizer + tree builder
//   - a single-pass XML entity decoder (named + numeric only)
//
// Docx-specific driver (WordprocessingML): walks word/document.xml (plus
// word/footnotes.xml / word/endnotes.xml) preserving the element set from
// design spec §3.1, and normalizes per §3.2.
//
// Security note: the tokenizer below is a hand-rolled linear scan over
// element boundaries. It never processes DOCTYPE/ENTITY declarations and
// never re-scans decoded entity output for further entities — there is no
// external-entity or entity-expansion surface here, unlike a general-purpose
// DTD-aware XML parser.

import { unzipSync } from "fflate";
import type { Result } from "../frontmatter/types.js";
import type {
  ExtractError,
  ExtractLimits,
  ExtractRequest,
  ExtractWorkerResponse,
} from "./types.js";

// tsx's ESM resolve hook (dev/test only — see worker.ts's matching comment)
// doesn't reliably remap a ".js" specifier to its sibling ".ts" source for a
// *value* import resolved from inside a worker_threads realm, even though
// the same remapping works fine on the main thread. `Result`/`ExtractError`
// etc. above are type-only imports, erased at compile time, so they never
// hit this at runtime — but `ok`/`err`/`normalize` are real values this
// module calls, so resolve them via an exact-extension URL (matching this
// file's own extension) instead of a plain specifier.
const officeModuleSuffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const { ok, err } = (await import(
  new URL(`../frontmatter/types${officeModuleSuffix}`, import.meta.url).href
)) as typeof import("../frontmatter/types.js");
const { normalize } = (await import(
  new URL(`./normalize${officeModuleSuffix}`, import.meta.url).href
)) as typeof import("./normalize.js");

// ---------------------------------------------------------------------------
// Shared: OLE compound-file detection
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * IRM/password-protected Office files are wrapped in an OLE2 compound file
 * container (an `EncryptedPackage` stream), not a plain zip. We only need
 * the magic-number check to classify this as `encrypted` — parsing the OLE
 * structure itself is out of scope (spec §3.3).
 */
export function isOleCompoundFile(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_MAGIC.length) return false;
  for (let i = 0; i < OLE_MAGIC.length; i += 1) {
    if (bytes[i] !== OLE_MAGIC[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shared: declared-size-capped zip opener (zip-bomb defense)
// ---------------------------------------------------------------------------

export interface OoxmlParts {
  parts: Record<string, Uint8Array>;
  hasContentTypes: boolean;
}

/**
 * Opens a zip, decompressing ONLY the entries named in `wanted`, and only if
 * their DECLARED (pre-inflation) size fits within the per-entry and running
 * total caps. The size check happens inside fflate's `filter` callback,
 * which fires before that entry is inflated — an entry that fails the check
 * is skipped and never decompressed, so a small physical file that declares
 * a huge inflated size is caught without ever allocating for it.
 */
export function readOoxmlParts(
  bytes: Uint8Array,
  limits: ExtractLimits,
  wanted: readonly string[],
): Result<OoxmlParts, ExtractError> {
  let total = 0;
  let tooLarge = false;
  let hasContentTypes = false;

  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, {
      filter(info) {
        if (info.name === "[Content_Types].xml") {
          hasContentTypes = true;
          return false; // presence check only; content is never needed
        }
        if (!wanted.includes(info.name)) return false;
        if (info.originalSize > limits.maxInflatedBytesPerEntry) {
          tooLarge = true;
          return false;
        }
        total += info.originalSize;
        if (total > limits.maxInflatedBytesTotal) {
          tooLarge = true;
          return false;
        }
        return true;
      },
    });
  } catch (e) {
    return err({
      reason: "malformed",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (tooLarge) {
    return err({ reason: "too_large", message: "declared inflated size exceeds extraction caps" });
  }
  if (!hasContentTypes) {
    return err({ reason: "malformed", message: "missing [Content_Types].xml" });
  }
  return ok({ parts, hasContentTypes });
}

// ---------------------------------------------------------------------------
// Shared: XML entity decoding (single pass — no re-scan of decoded output)
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(?:([a-zA-Z]+)|#(\d+)|#[xX]([0-9a-fA-F]+));/g;

/**
 * Decodes only the standard named entities and numeric character references.
 * A single global-regex pass scans the ORIGINAL string once; replacement
 * text is never re-fed into the regex, so a crafted `&amp;lt;`-style payload
 * cannot cascade into `<` — this is a deliberate defense against
 * entity-expansion-style tricks, not just a decoding convenience.
 */
export function decodeXmlEntities(text: string): string {
  return text.replace(
    ENTITY_RE,
    (whole, named: string | undefined, dec: string | undefined, hex: string | undefined) => {
      if (named !== undefined) {
        return Object.hasOwn(NAMED_ENTITIES, named) ? NAMED_ENTITIES[named] : whole;
      }
      const codePoint =
        dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return whole;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Shared: linear XML tokenizer + minimal tree builder
// ---------------------------------------------------------------------------

function localName(rawName: string): string {
  const colon = rawName.indexOf(":");
  return colon === -1 ? rawName : rawName.slice(colon + 1);
}

type XmlTokenEvent =
  | { type: "text"; text: string }
  | { type: "open"; name: string; attrsRaw: string; selfClosing: boolean }
  | { type: "close"; name: string };

/**
 * A linear scan over element boundaries. Deliberately NOT a DTD/entity-
 * expanding parser: DOCTYPE/comment/CDATA/PI sections are skipped over
 * structurally (so a stray `>` inside them doesn't desync the scan) but
 * their contents are never interpreted — no entity declarations are ever
 * read or expanded.
 */
function* tokenizeXml(xml: string): Generator<XmlTokenEvent> {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      if (i < n) yield { type: "text", text: xml.slice(i) };
      return;
    }
    if (lt > i) yield { type: "text", text: xml.slice(i, lt) };

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const cdataText = xml.slice(lt + 9, end === -1 ? n : end);
      if (cdataText.length > 0) yield { type: "text", text: cdataText };
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE or similar declaration. Skip structurally with bracket
      // depth tracking so we don't desync on an internal subset — we never
      // interpret anything inside it (no ENTITY expansion, ever).
      let depth = 0;
      let j = lt + 1;
      for (; j < n; j += 1) {
        if (xml[j] === "<") depth += 1;
        else if (xml[j] === ">") {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      i = j + 1;
      continue;
    }

    // Ordinary tag: find the terminating '>' respecting quoted attr values.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j += 1;
    }
    const inner = xml.slice(lt + 1, j);
    i = j + 1;

    if (inner.startsWith("/")) {
      yield { type: "close", name: localName(inner.slice(1).trim()) };
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^[^\s]+/.exec(body);
    const rawName = nameMatch ? nameMatch[0] : body;
    const attrsRaw = body.slice(rawName.length);
    yield { type: "open", name: localName(rawName), attrsRaw, selfClosing };
  }
}

export interface XmlElement {
  name: string;
  attrsRaw: string;
  children: XmlNode[];
}
export interface XmlText {
  text: string;
}
export type XmlNode = XmlElement | XmlText;

export function isXmlElement(node: XmlNode): node is XmlElement {
  return "name" in node;
}

/** Parses XML into a minimal tree. Mismatched/unclosed tags are tolerated
 * (we pop the stack to the nearest matching ancestor) since we only need a
 * best-effort structural walk, not a validating parser. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#root", attrsRaw: "", children: [] };
  const stack: XmlElement[] = [root];

  for (const ev of tokenizeXml(xml)) {
    const top = stack[stack.length - 1];
    if (ev.type === "text") {
      const decoded = decodeXmlEntities(ev.text);
      if (decoded.length > 0) top.children.push({ text: decoded });
    } else if (ev.type === "open") {
      const el: XmlElement = { name: ev.name, attrsRaw: ev.attrsRaw, children: [] };
      top.children.push(el);
      if (!ev.selfClosing) stack.push(el);
    } else {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === ev.name) {
          stack.length = i;
          break;
        }
      }
    }
  }
  return root;
}

/** Reads an attribute by local name (prefix-agnostic: matches `w:id` or `id`). */
export function getAttr(el: XmlElement, localAttrName: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${localAttrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(el.attrsRaw);
  if (!m) return undefined;
  return decodeXmlEntities(m[1] ?? m[2] ?? "");
}

// ---------------------------------------------------------------------------
// Docx driver (WordprocessingML)
// ---------------------------------------------------------------------------

interface NoteRef {
  kind: "footnote" | "endnote";
  id: string;
}

/** Collects run-level (inline) text under a w:p (or any element containing
 * runs), applying the tracked-changes and text-box rules from spec §3.1. */
function collectRunText(el: XmlElement, refs: NoteRef[]): string {
  switch (el.name) {
    case "del":
      // Deleted content is dropped wholesale, including any nested runs.
      return "";
    case "t": {
      let out = "";
      for (const child of el.children) {
        if (!isXmlElement(child)) out += child.text;
      }
      return out;
    }
    case "tab":
      return "\t";
    case "br":
      return "\n";
    case "footnoteReference":
    case "endnoteReference": {
      const id = getAttr(el, "id");
      if (id !== undefined) {
        refs.push({ kind: el.name === "footnoteReference" ? "footnote" : "endnote", id });
      }
      return "";
    }
    case "txbxContent":
      return collectBlockLines(el, refs).join("\n");
    case "tbl":
      return collectTableLines(el, refs).join("\n");
    default: {
      let out = "";
      for (const child of el.children) {
        if (isXmlElement(child)) out += collectRunText(child, refs);
      }
      return out;
    }
  }
}

function collectTableLines(tbl: XmlElement, refs: NoteRef[]): string[] {
  const rows: string[] = [];
  for (const child of tbl.children) {
    if (!isXmlElement(child) || child.name !== "tr") continue;
    const cells: string[] = [];
    for (const cellNode of child.children) {
      if (!isXmlElement(cellNode) || cellNode.name !== "tc") continue;
      const cellLines = collectBlockLines(cellNode, refs);
      cells.push(cellLines.join(" ").replace(/\n+/g, " ").trim());
    }
    rows.push(cells.join(" | "));
  }
  return rows;
}

/** Walks a block-level container (document body, table cell, text box) and
 * returns one string per paragraph/table-row, in document order. */
function collectBlockLines(container: XmlElement, refs: NoteRef[]): string[] {
  const lines: string[] = [];
  for (const child of container.children) {
    if (!isXmlElement(child)) continue;
    if (child.name === "p") {
      lines.push(collectRunText(child, refs));
    } else if (child.name === "tbl") {
      lines.push(...collectTableLines(child, refs));
    } else {
      lines.push(...collectBlockLines(child, refs));
    }
  }
  return lines;
}

function indexNotesById(root: XmlElement, tagName: "footnote" | "endnote"): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (el: XmlElement): void => {
    for (const child of el.children) {
      if (!isXmlElement(child)) continue;
      if (child.name === tagName) {
        const id = getAttr(child, "id");
        if (id !== undefined) {
          const localRefs: NoteRef[] = [];
          const lines = collectBlockLines(child, localRefs);
          map.set(id, lines.join(" ").replace(/\n+/g, " ").trim());
        }
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return map;
}

function buildNotesLines(refs: NoteRef[], footnotesXml?: string, endnotesXml?: string): string[] {
  const footnoteMap = footnotesXml
    ? indexNotesById(parseXml(footnotesXml), "footnote")
    : new Map<string, string>();
  const endnoteMap = endnotesXml
    ? indexNotesById(parseXml(endnotesXml), "endnote")
    : new Map<string, string>();

  const lines: string[] = [];
  for (const ref of refs) {
    const map = ref.kind === "footnote" ? footnoteMap : endnoteMap;
    const text = map.get(ref.id);
    if (text && text.length > 0) lines.push(text);
  }
  return lines;
}

const DOCX_DOCUMENT = "word/document.xml";
const DOCX_FOOTNOTES = "word/footnotes.xml";
const DOCX_ENDNOTES = "word/endnotes.xml";

function decodeUtf8Lenient(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Extracts normalized text from a .docx byte buffer per design spec §3.1/§3.2. */
export async function extractDocx(
  bytes: Uint8Array,
  limits: ExtractLimits,
): Promise<ExtractWorkerResponse> {
  if (isOleCompoundFile(bytes)) {
    return {
      ok: false,
      error: {
        reason: "encrypted",
        message: "OLE compound-file container (IRM/password-protected)",
      },
    };
  }

  const partsResult = readOoxmlParts(bytes, limits, [DOCX_DOCUMENT, DOCX_FOOTNOTES, DOCX_ENDNOTES]);
  if (!partsResult.ok) return { ok: false, error: partsResult.error };

  const { parts } = partsResult.value;
  const documentBytes = parts[DOCX_DOCUMENT];
  if (!documentBytes) {
    return { ok: false, error: { reason: "malformed", message: `missing ${DOCX_DOCUMENT}` } };
  }

  const documentXml = decodeUtf8Lenient(documentBytes);
  const footnotesXml = parts[DOCX_FOOTNOTES] ? decodeUtf8Lenient(parts[DOCX_FOOTNOTES]) : undefined;
  const endnotesXml = parts[DOCX_ENDNOTES] ? decodeUtf8Lenient(parts[DOCX_ENDNOTES]) : undefined;

  const refs: NoteRef[] = [];
  const bodyLines = collectBlockLines(parseXml(documentXml), refs);
  const notesLines = buildNotesLines(refs, footnotesXml, endnotesXml);

  const allLines = [...bodyLines];
  if (notesLines.length > 0) {
    allLines.push("--- notes ---", ...notesLines);
  }

  const rawText = allLines.join("\n");
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

  return { ok: true, value: { text } };
}

/** Worker dispatch entry point (matches the Handler shape in worker.ts). */
export async function handleDocx(request: ExtractRequest): Promise<ExtractWorkerResponse> {
  return extractDocx(request.bytes, request.limits);
}
