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

// Snapshot of the whole hooks surface, captured before each test. Restoring all
// three fields in afterEach keeps a per-test override (parseFn / idleMs / statFn)
// from leaking into a later test — the statFn seam in particular is reassigned
// by several tests and must be reset to its real default.
let hooksSnapshot: {
  statFn: typeof docCacheTestHooks.statFn;
  parseFn: typeof docCacheTestHooks.parseFn;
  idleMs: number;
};

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
  // Capture the full default hooks surface so afterEach can restore every field.
  hooksSnapshot = {
    statFn: docCacheTestHooks.statFn,
    parseFn: docCacheTestHooks.parseFn,
    idleMs: docCacheTestHooks.idleMs,
  };
  // Route parsing through the hook so tests can count parse calls.
  docCacheTestHooks.parseFn = parseDocument;
  docCacheTestHooks.idleMs = 60_000;
});
afterEach(() => {
  resetDocumentCache();
  // Restore all three fields — including statFn — so no override leaks forward.
  docCacheTestHooks.statFn = hooksSnapshot.statFn;
  docCacheTestHooks.parseFn = hooksSnapshot.parseFn;
  docCacheTestHooks.idleMs = hooksSnapshot.idleMs;
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

  it("re-parses only the file whose mtime changed", async () => {
    writeDoc("a.md", DOC("A"));
    writeDoc("b.md", DOC("B"));
    await loadDocuments(vault);
    const spy = vi.fn(parseDocument);
    docCacheTestHooks.parseFn = spy;
    // Bump only a.md's mtime by injecting a newer fingerprint for it.
    const base = docCacheTestHooks.statFn;
    docCacheTestHooks.statFn = async (p) => {
      const fp = await base(p);
      return p.endsWith("/a.md") ? { ...fp, mtimeMs: fp.mtimeMs + 1000 } : fp;
    };
    const r = await loadDocuments(vault);
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // only a.md
  });

  it("invalidates on a size change within the same mtime tick", async () => {
    writeDoc("a.md", DOC("A"));
    await loadDocuments(vault);
    const spy = vi.fn(parseDocument);
    docCacheTestHooks.parseFn = spy;
    const base = docCacheTestHooks.statFn;
    docCacheTestHooks.statFn = async (p) => {
      const fp = await base(p);
      return { ...fp, size: fp.size + 1 }; // same mtime, different length
    };
    await loadDocuments(vault);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reflects a newly added file without re-parsing untouched ones", async () => {
    writeDoc("a.md", DOC("A"));
    await loadDocuments(vault);
    const spy = vi.fn(parseDocument);
    docCacheTestHooks.parseFn = spy;
    writeDoc("c.md", DOC("C"));
    const r = await loadDocuments(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((d) => d.path)).toEqual(["a.md", "c.md"]);
    expect(spy).toHaveBeenCalledTimes(1); // only c.md
  });

  it("drops a deleted file from the result and the cache", async () => {
    writeDoc("a.md", DOC("A"));
    writeDoc("b.md", DOC("B"));
    await loadDocuments(vault);
    rmSync(join(vault, "b.md"));
    const r = await loadDocuments(vault);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((d) => d.path)).toEqual(["a.md"]);
  });

  it("skips a malformed file and retries it on the next call once fixed", async () => {
    writeDoc("good.md", DOC("Good"));
    writeDoc("bad.md", "---\n: not: valid: yaml\n---\n"); // parse fails
    const r1 = await loadDocuments(vault);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.map((d) => d.path)).toEqual(["good.md"]);
    // Fix bad.md; it must appear on the next call (was never cached).
    writeDoc("bad.md", DOC("Bad"));
    const r2 = await loadDocuments(vault);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.map((d) => d.path)).toEqual(["bad.md", "good.md"]);
  });

  it("collapses concurrent calls into one fingerprint+parse pass", async () => {
    writeDoc("a.md", DOC("A"));
    writeDoc("b.md", DOC("B"));
    let statCalls = 0;
    const base = docCacheTestHooks.statFn;
    docCacheTestHooks.statFn = async (p) => {
      statCalls++;
      return base(p);
    };
    const [r1, r2] = await Promise.all([loadDocuments(vault), loadDocuments(vault)]);
    expect(r1.ok && r2.ok).toBe(true);
    // Two files, ONE fingerprint pass shared by both callers => 2 stat calls, not 4.
    expect(statCalls).toBe(2);
  });

  it("drops the whole cache after the idle window, forcing a cold rebuild", async () => {
    vi.useFakeTimers();
    try {
      docCacheTestHooks.idleMs = 1000;
      writeDoc("a.md", DOC("A"));
      await loadDocuments(vault); // arms a 1000ms idle timer (faked)
      vi.advanceTimersByTime(1001); // fire it -> caches.delete(vault)
      const spy = vi.fn(parseDocument);
      docCacheTestHooks.parseFn = spy;
      await loadDocuments(vault); // cache dropped => cold rebuild
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an orphaned cache's idle timer does not evict a newer live cache", async () => {
    vi.useFakeTimers();
    try {
      docCacheTestHooks.idleMs = 1000;
      writeDoc("a.md", DOC("A"));
      await loadDocuments(vault); // cache C1, timer T1 armed at t=1000

      // Hold the next refresh in-flight past T1 by gating statFn.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const baseStat = docCacheTestHooks.statFn;
      docCacheTestHooks.statFn = async (p) => {
        await gate;
        return baseStat(p);
      };
      const call2 = loadDocuments(vault); // C1.inflight set, awaiting gate

      vi.advanceTimersByTime(1001); // T1 fires -> deletes C1 from map (mid-inflight)
      release();
      await call2; // C1 finishes, arms T2 on the now-orphaned C1 (at now+1000)
      docCacheTestHooks.statFn = baseStat;

      // Give C2 a far-future idle window so ITS own timer can't confound the
      // assertion: only the orphaned T2 must be in range of the advance below.
      docCacheTestHooks.idleMs = 1_000_000;
      await loadDocuments(vault); // creates fresh C2, warms it, arms T3 at now+1e6
      const spy = vi.fn(parseDocument);
      docCacheTestHooks.parseFn = spy;
      vi.advanceTimersByTime(1001); // fires ONLY the orphaned T2 — must NOT delete C2
      await loadDocuments(vault); // if C2 survived: 0 reparse; if evicted: cold rebuild
      expect(spy).toHaveBeenCalledTimes(0); // C2 preserved
    } finally {
      vi.useRealTimers();
    }
  });
});
