import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  docCacheTestHooks,
  loadDocuments,
  resetDocumentCache,
} from "../../src/curation/vault-docs.js";
import { parseDocument } from "../../src/frontmatter/parser.js";

let vault: string;

function writeDoc(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf-8");
}

const DOC = (title: string) =>
  `---\ntitle: ${title}\nupdated: 2026-01-01\nstatus: canonical\nconfidence: high\ncollection: notes\ndomain: accumulation\n---\nbody of ${title}\n`;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-doccache-"));
  resetDocumentCache();
  // Route parsing through the hook so tests can count parse calls.
  docCacheTestHooks.parseFn = parseDocument;
  docCacheTestHooks.idleMs = 60_000;
});
afterEach(() => {
  resetDocumentCache();
  docCacheTestHooks.parseFn = parseDocument;
  docCacheTestHooks.idleMs = 60_000;
  vi.restoreAllMocks();
  rmSync(vault, { recursive: true, force: true });
});

describe("loadDocuments cache", () => {
  it("cold call returns all docs, sorted by path", async () => {
    writeDoc("b.md", DOC("B"));
    writeDoc("a.md", DOC("A"));
    const r = await loadDocuments(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((d) => d.path)).toEqual(["a.md", "b.md"]);
    expect(r.value[0]?.frontmatter.title).toBe("A");
  });

  it("warm call with no changes re-parses nothing", async () => {
    writeDoc("a.md", DOC("A"));
    writeDoc("b.md", DOC("B"));
    await loadDocuments(vault); // cold: parses both
    const spy = vi.fn(parseDocument);
    docCacheTestHooks.parseFn = spy;
    const r = await loadDocuments(vault);
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
    if (r.ok) expect(r.value.map((d) => d.path)).toEqual(["a.md", "b.md"]);
  });
});
