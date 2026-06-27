# E1: EDGAR Acquisition + htmlToText — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a SEC-EDGAR puller and a zero-dep `htmlToText` converter that turn a hand-seeded amendment chain into `ChainDoc[]` ready for the existing CB1 `assemble()` pipeline, proven end-to-end on the NGS TCB Amended & Restated Credit Agreement chain.

**Architecture:** Three pure/IO-split units in `integrations/contract-bench/src/` mirroring the existing `assemble`(pure)/`writeAssembly`(IO) pattern: `html-to-text.ts` (pure string→string, the load-bearing converter), `edgar-fetch.ts` (pure `filingUrl` + IO `fetchFiling` with disk cache + injectable transport), `chain-docs.ts` (`buildChainDocs` glue). A `pull-edgar.mjs` runner drives the real pull. Tests are hermetic (committed fixtures + injected fake transport); the live curl path runs only via the runner.

**Tech Stack:** TypeScript (NodeNext, strict), vitest, Node built-ins (`child_process`, `fs/promises`). Zero new runtime deps. curl (shell-out) for the SEC fetch.

**Spec:** `docs/superpowers/specs/2026-06-26-e1-edgar-acquisition-design.md` (gate-zero already PASSED — chain + oracle term `"Commitment"` verified live).

**Conventions (from CLAUDE.md):** No classes — functions and types. Fallible IO returns a `Result`-style discriminated union, never throws across the boundary. Tests mirror `src/`. Build: `cd integrations/contract-bench && npx tsc`. Test: `cd integrations/contract-bench && npx vitest run`. Run a single test file: `npx vitest run src/html-to-text.test.ts`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/html-to-text.ts` | `decodeEntities`, `stripStructure`, `htmlToText` — EDGAR HTML → parseCitations-ready text |
| `src/html-to-text.test.ts` | entity/tag/whitespace units + the **oracle** test against the amd-1 fixture |
| `src/edgar-fetch.ts` | `FilingRef`, `filingUrl` (pure), `fetchFiling` (IO: cache + curl, injectable transport) |
| `src/edgar-fetch.test.ts` | `filingUrl` shape + `fetchFiling` cache logic via fake transport (no network) |
| `src/chain-docs.ts` | `Seed`/`SeedDoc` types, `buildChainDocs` (fetch → htmlToText → `ChainDoc[]`) |
| `src/chain-docs.test.ts` | `buildChainDocs` over a seed with a fake transport → ordered `ChainDoc[]` |
| `src/__fixtures__/ngs/amd1.htm` | committed real First-Amendment HTML (oracle fixture, ~70KB) |
| `src/__fixtures__/ngs/amd2.htm` | committed real Second-Amendment HTML (mixed-ops fixture, ~37KB) |
| `seeds/ngs.json` | resolved chain (base A&R + amd-1..4) |
| `pull-edgar.mjs` | runner — `node pull-edgar.mjs seeds/ngs.json` → cache + `ChainDoc[]` summary |
| `.gitignore` (root) | add `.edgar-cache/` |

> **Note on the A&R base fixture:** the 1.72MB base doc is **not** committed as a fixture (E1 tests don't need it; the runner pulls it live for E3). This keeps the committed fixtures small.

---

## Task 1: Scaffold — fixtures, seed, gitignore

**Files:**
- Create: `integrations/contract-bench/src/__fixtures__/ngs/amd1.htm`, `amd2.htm`
- Create: `integrations/contract-bench/seeds/ngs.json`
- Modify: `.gitignore` (repo root)

- [ ] **Step 1: Fetch the two oracle fixtures via the proven curl path**

```bash
cd integrations/contract-bench
mkdir -p src/__fixtures__/ngs
UA="Daftari Research (mihir.wagle@gmail.com)"
B="https://www.sec.gov/Archives/edgar/data/1084991"
curl -sS --fail --max-time 40 -A "$UA" "$B/000108499123000124/exhibit101firstamendmentto.htm" -o src/__fixtures__/ngs/amd1.htm
sleep 0.3
curl -sS --fail --max-time 40 -A "$UA" "$B/000108499124000066/exhibit101_secondamendme.htm" -o src/__fixtures__/ngs/amd2.htm
```
Verify: `wc -c src/__fixtures__/ngs/*.htm` → amd1 ≈ 69757, amd2 ≈ 37428. Confirm `grep -c '&#8220;' src/__fixtures__/ngs/amd1.htm` → 17.

- [ ] **Step 2: Write the seed** `integrations/contract-bench/seeds/ngs.json`

```json
{
  "chainId": "ngs-tcb-ar-credit-agreement",
  "unitType": "mixed",
  "docs": [
    { "id": "ngs-ar-base", "order": 0, "role": "master-ar",  "cik": "1084991", "accession": "0001084991-23-000019", "filename": "exhibit101tcbamendedandres.htm" },
    { "id": "ngs-amd-1",   "order": 1, "role": "amendment-1", "cik": "1084991", "accession": "0001084991-23-000124", "filename": "exhibit101firstamendmentto.htm" },
    { "id": "ngs-amd-2",   "order": 2, "role": "amendment-2", "cik": "1084991", "accession": "0001084991-24-000066", "filename": "exhibit101_secondamendme.htm" },
    { "id": "ngs-amd-3",   "order": 3, "role": "amendment-3", "cik": "1084991", "accession": "0001084991-24-000080", "filename": "exhibit101thirdamendment.htm" },
    { "id": "ngs-amd-4",   "order": 4, "role": "amendment-4", "cik": "1084991", "accession": "0001084991-25-000044", "filename": "exhibit101_fourthxamendm.htm" }
  ]
}
```

- [ ] **Step 3: Ignore the cache dir** — append to the repo-root `.gitignore`:

```
.edgar-cache/
```

- [ ] **Step 4: Commit**

```bash
git add integrations/contract-bench/src/__fixtures__/ngs/ integrations/contract-bench/seeds/ngs.json .gitignore
git commit -m "test(contract-bench): E1 NGS fixtures + resolved seed + cache gitignore"
```

---

## Task 2: `decodeEntities`

**Files:**
- Create: `integrations/contract-bench/src/html-to-text.ts`
- Test: `integrations/contract-bench/src/html-to-text.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { decodeEntities } from "./html-to-text.js";

describe("decodeEntities", () => {
  test("decodes named entities", () => {
    expect(decodeEntities("AT&amp;T &lt;x&gt; &quot;q&quot; a&nbsp;b &sect;5")).toBe('AT&T <x> "q" a b §5');
  });
  test("decodes decimal numeric entities incl. the curly quotes parseCitations needs", () => {
    expect(decodeEntities("&#8220;Commitment&#8221; means&#58; &#8217;")).toBe("“Commitment” means: ’");
  });
  test("decodes hex numeric entities", () => {
    expect(decodeEntities("a&#x2014;b")).toBe("a—b");
  });
  test("maps cp1252 high-range smart punctuation", () => {
    expect(decodeEntities("&#147;x&#148; y&#146;s &#150;")).toBe("“x” y’s –");
  });
  test("leaves an unknown named entity intact", () => {
    expect(decodeEntities("&bogus; &amp;")).toBe("&bogus; &");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/html-to-text.test.ts`
Expected: FAIL — `decodeEntities` is not exported / not defined.

- [ ] **Step 3: Write minimal implementation** (top of `html-to-text.ts`)

```ts
// html-to-text — convert EDGAR exhibit HTML into text that the CB1
// parseCitations contract can read: decode entities (curly quotes arrive as
// numeric entities like &#8220;), unwrap inline tags WITHOUT inserting
// whitespace (so a tag-split quoted term stays one token), and collapse
// structure to spaces WITHOUT minting spurious sentence boundaries.

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  sect: "§", para: "¶", middot: "·",
  mdash: "—", ndash: "–", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  reg: "®", copy: "©", trade: "™", deg: "°",
};

// Windows-1252 mappings for the 0x80–0x9F range that legacy filings emit as
// raw numeric entities (&#147; etc.). Only the punctuation that occurs in
// contract prose is mapped; anything else falls through to fromCodePoint.
const CP1252: Record<number, string> = {
  145: "‘", 146: "’", 147: "“", 148: "”",
  150: "–", 151: "—", 133: "…", 149: "•",
};

function numericEntity(body: string): string | null {
  const code = body[1] === "x" || body[1] === "X"
    ? parseInt(body.slice(2), 16)
    : parseInt(body.slice(1), 10);
  if (!Number.isFinite(code)) return null;
  if (code in CP1252) return CP1252[code];
  try {
    return String.fromCodePoint(code);
  } catch {
    return null;
  }
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body[0] === "#") return numericEntity(body) ?? m;
    return NAMED[body] ?? m; // unknown named entity left intact
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/html-to-text.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/contract-bench/src/html-to-text.ts integrations/contract-bench/src/html-to-text.test.ts
git commit -m "feat(contract-bench): decodeEntities — named + numeric + cp1252 for EDGAR"
```

---

## Task 3: `stripStructure` (tag handling)

**Files:**
- Modify: `integrations/contract-bench/src/html-to-text.ts`
- Test: `integrations/contract-bench/src/html-to-text.test.ts`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```ts
import { stripStructure } from "./html-to-text.js";

describe("stripStructure", () => {
  test("removes inline tags with NO inserted whitespace (keeps a tag-split token whole)", () => {
    expect(stripStructure("&#8220;<b>Commit</b>ment&#8221;")).toBe("&#8220;Commitment&#8221;");
    expect(stripStructure("5.<u>1</u>")).toBe("5.1");
  });
  test("turns block tags into a single space boundary", () => {
    expect(stripStructure("<p>A.</p><p>B.</p>").trim()).toBe("A.  B.");
  });
  test("drops comments, script, and style content", () => {
    expect(stripStructure("a<!--x-->b<script>z()</script>c<style>p{}</style>d")).toBe("abcd");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/html-to-text.test.ts`
Expected: FAIL — `stripStructure` not defined.

- [ ] **Step 3: Write the implementation** (append to `html-to-text.ts`)

```ts
// Inline tags carry no structural meaning — remove them with no spacing so a
// quoted term split across <b>/<u>/<font> stays a single token. Everything
// else is treated as a block boundary (one space).
const INLINE = new Set([
  "b", "i", "u", "em", "strong", "font", "span", "a", "sup", "sub",
  "small", "big", "tt", "strike", "s", "ins", "del", "mark", "abbr",
]);

export function stripStructure(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "");
  // Named element tags: inline -> "", block -> " ".
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_m, name: string) =>
    INLINE.has(name.toLowerCase()) ? "" : " ");
  // Any residual stray tags (malformed) -> space, never silently merge tokens.
  s = s.replace(/<[^>]+>/g, " ");
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/html-to-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/contract-bench/src/html-to-text.ts integrations/contract-bench/src/html-to-text.test.ts
git commit -m "feat(contract-bench): stripStructure — inline-no-space, block-to-space tag handling"
```

---

## Task 4: `htmlToText` + the parseCitations oracle

**Files:**
- Modify: `integrations/contract-bench/src/html-to-text.ts`
- Test: `integrations/contract-bench/src/html-to-text.test.ts`

- [ ] **Step 1: Write the failing tests** (append). The oracle is the load-bearing assertion: real amd-1 HTML must survive the converter into a form where `parseCitations` recovers the verified `"Commitment"` restate.

```ts
import { readFileSync } from "node:fs";
import { htmlToText } from "./html-to-text.js";
import { parseCitations } from "./citation-parse.js";

const amd1 = readFileSync(new URL("./__fixtures__/ngs/amd1.htm", import.meta.url), "utf8");

describe("htmlToText", () => {
  test("strips tags then decodes (literal < from &lt; is not re-stripped)", () => {
    expect(htmlToText("<p>a &lt;b&gt; c</p>").trim()).toBe("a <b> c");
  });
  test("collapses all whitespace (incl. decoded nbsp) to single spaces", () => {
    expect(htmlToText("x\n\n  y&#160;&#160;z")).toBe("x y z");
  });
  test("does NOT mint a spurious sentence boundary inside a dotted clause number", () => {
    // "5.1" split by an inline tag must remain a non-boundary "5.1".
    const out = htmlToText("Section 5.<b>1</b> of the Agreement is amended.");
    expect(out).toContain("Section 5.1 of");
  });

  // --- ORACLE: real EDGAR HTML -> parseCitations recovers the verified term ---
  test("oracle: amd-1 yields the Commitment defined-term restate as recoverable", () => {
    const text = htmlToText(amd1);
    expect(text).toContain("“Commitment” means"); // curly quotes decoded
    const cites = parseCitations(text);
    const commitment = cites.find((c) => c.clause === "Commitment");
    expect(commitment).toBeDefined();
    expect(commitment).toMatchObject({ op: "restate", recoverable: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/html-to-text.test.ts`
Expected: FAIL — `htmlToText` not defined.

- [ ] **Step 3: Write the implementation** (append). Order is load-bearing: **strip tags first** (while real tags are `<...>` and `&lt;` is still encoded), **then** decode entities, **then** collapse whitespace.

```ts
export function htmlToText(html: string): string {
  const stripped = stripStructure(html);
  const decoded = decodeEntities(stripped);
  // Collapse every run of whitespace (incl. decoded U+00A0) to one space. We
  // never insert a period, so this cannot mint a sentence boundary; it only
  // guarantees at least one space between former block elements.
  return decoded.replace(/[\s ]+/g, " ").trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/html-to-text.test.ts`
Expected: PASS — including the oracle. **If the oracle fails**, htmlToText is wrong (or the fixture is not the verified amd-1); debug before proceeding — this is the gate the whole sub-project exists to pass.

- [ ] **Step 5: Commit**

```bash
git add integrations/contract-bench/src/html-to-text.ts integrations/contract-bench/src/html-to-text.test.ts
git commit -m "feat(contract-bench): htmlToText + parseCitations oracle on real NGS amd-1"
```

---

## Task 5: `filingUrl`

**Files:**
- Create: `integrations/contract-bench/src/edgar-fetch.ts`
- Test: `integrations/contract-bench/src/edgar-fetch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { filingUrl } from "./edgar-fetch.js";

describe("filingUrl", () => {
  test("strips dashes from the accession and builds the Archives path", () => {
    expect(filingUrl({ cik: "1084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" }))
      .toBe("https://www.sec.gov/Archives/edgar/data/1084991/000108499123000124/exhibit101firstamendmentto.htm");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/edgar-fetch.test.ts`
Expected: FAIL — `filingUrl` not defined.

- [ ] **Step 3: Write minimal implementation** (top of `edgar-fetch.ts`)

```ts
// edgar-fetch — resolve a filing reference to its SEC Archives URL (pure) and
// fetch it via curl with a compliant User-Agent + on-disk cache (IO). The
// transport is injectable so cache logic is testable without the network.

export interface FilingRef {
  cik: string;
  accession: string;
  filename: string;
}

export function filingUrl(ref: FilingRef): string {
  const acc = ref.accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${ref.cik}/${acc}/${ref.filename}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/edgar-fetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/contract-bench/src/edgar-fetch.ts integrations/contract-bench/src/edgar-fetch.test.ts
git commit -m "feat(contract-bench): filingUrl — SEC Archives URL builder"
```

---

## Task 6: `fetchFiling` (cache + injectable transport)

**Files:**
- Modify: `integrations/contract-bench/src/edgar-fetch.ts`
- Test: `integrations/contract-bench/src/edgar-fetch.test.ts`

- [ ] **Step 1: Write the failing tests** (append). Cache + error behavior is tested with a fake transport and a temp dir — **no network**.

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchFiling } from "./edgar-fetch.js";

const REF = { cik: "1084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" };

describe("fetchFiling", () => {
  test("fetches via transport, caches, and serves the second call from cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      let calls = 0;
      const transport = async () => { calls++; return "<p>hello</p>"; };
      const r1 = await fetchFiling(REF, { cacheDir, userAgent: "ua", transport });
      const r2 = await fetchFiling(REF, { cacheDir, userAgent: "ua", transport });
      expect(r1).toMatchObject({ ok: true, fromCache: false, html: "<p>hello</p>" });
      expect(r2).toMatchObject({ ok: true, fromCache: true, html: "<p>hello</p>" });
      expect(calls).toBe(1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("returns an error result (does not throw) when the transport fails", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const transport = async () => { throw new Error("HTTP 403"); };
      const r = await fetchFiling(REF, { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("403");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/edgar-fetch.test.ts`
Expected: FAIL — `fetchFiling` not defined.

- [ ] **Step 3: Write the implementation.** Put the five `import` lines at the **top** of `edgar-fetch.ts` (with the existing file header), and the rest of the code below `filingUrl`.

```ts
// --- these imports go at the TOP of edgar-fetch.ts ---
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// --- the rest goes below filingUrl ---
const execFileP = promisify(execFile);

export type FetchResult =
  | { ok: true; html: string; fromCache: boolean }
  | { ok: false; error: string };

// (url, userAgent) -> raw HTML. Throws on HTTP/transport failure.
export type Transport = (url: string, userAgent: string) => Promise<string>;

// Default transport: curl with --fail (non-2xx -> non-zero exit -> throw). This
// is the path proven to work against SEC fair-access (WebFetch is 403'd).
const curlTransport: Transport = async (url, userAgent) => {
  const { stdout } = await execFileP(
    "curl",
    ["-sS", "--fail", "--max-time", "40", "-A", userAgent, url],
    { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
  );
  return stdout;
};

export interface FetchOpts {
  cacheDir: string;
  userAgent: string;
  transport?: Transport;
  throttleMs?: number;
}

function cacheKey(ref: FilingRef): string {
  return `${ref.accession}-${ref.filename}`.replace(/[^\w.-]/g, "_");
}

export async function fetchFiling(ref: FilingRef, opts: FetchOpts): Promise<FetchResult> {
  const cachePath = join(opts.cacheDir, cacheKey(ref));
  if (existsSync(cachePath)) {
    return { ok: true, html: await readFile(cachePath, "utf8"), fromCache: true };
  }
  const transport = opts.transport ?? curlTransport;
  try {
    const html = await transport(filingUrl(ref), opts.userAgent);
    await mkdir(opts.cacheDir, { recursive: true });
    await writeFile(cachePath, html);
    if (opts.throttleMs) await new Promise((res) => setTimeout(res, opts.throttleMs));
    return { ok: true, html, fromCache: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/edgar-fetch.test.ts`
Expected: PASS (cache hit + error-result tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/contract-bench/src/edgar-fetch.ts integrations/contract-bench/src/edgar-fetch.test.ts
git commit -m "feat(contract-bench): fetchFiling — disk cache + injectable curl transport"
```

---

## Task 7: `buildChainDocs`

**Files:**
- Create: `integrations/contract-bench/src/chain-docs.ts`
- Test: `integrations/contract-bench/src/chain-docs.test.ts`

- [ ] **Step 1: Write the failing test** (fake transport keyed by filename; assert order + htmlToText applied + the `ChainDoc` shape `assemble` consumes).

```ts
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChainDocs, type Seed } from "./chain-docs.js";

const SEED: Seed = {
  chainId: "t", unitType: "mixed",
  docs: [
    { id: "amd-2", order: 2, role: "amendment-2", cik: "1", accession: "a-2", filename: "two.htm" },
    { id: "base", order: 0, role: "master-ar",  cik: "1", accession: "a-0", filename: "zero.htm" },
    { id: "amd-1", order: 1, role: "amendment-1", cik: "1", accession: "a-1", filename: "one.htm" },
  ],
};

describe("buildChainDocs", () => {
  test("fetches each doc, htmlToText's it, and returns ChainDocs sorted by order", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const bodies: Record<string, string> = {
        "zero.htm": "<p>base &#8220;X&#8221;</p>",
        "one.htm": "<p>one</p>",
        "two.htm": "<p>two</p>",
      };
      const transport = async (url: string) => {
        const file = url.split("/").pop() as string;
        return bodies[file];
      };
      const r = await buildChainDocs(SEED, { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.docs.map((d) => d.id)).toEqual(["base", "amd-1", "amd-2"]);
      expect(r.docs.map((d) => d.order)).toEqual([0, 1, 2]);
      expect(r.docs[0]).toMatchObject({ id: "base", order: 0, text: "base “X”" });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("propagates a fetch failure as an error result naming the doc", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const transport = async () => { throw new Error("HTTP 404"); };
      const r = await buildChainDocs(SEED, { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/base.*404/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/chain-docs.test.ts`
Expected: FAIL — `buildChainDocs` not defined.

- [ ] **Step 3: Write the implementation** `chain-docs.ts`

```ts
// chain-docs — turn a hand-authored chain seed into the ChainDoc[] that the
// CB1 assemble() pipeline consumes: fetch each filing (cached), convert its
// HTML to parseCitations-ready text, and order by the seed's `order`.

import type { ChainDoc } from "./clause-edge.js";
import { fetchFiling, type FetchOpts } from "./edgar-fetch.js";
import { htmlToText } from "./html-to-text.js";

export interface SeedDoc {
  id: string;
  order: number;
  role: string;
  cik: string;
  accession: string;
  filename: string;
}

export interface Seed {
  chainId: string;
  unitType: string;
  docs: SeedDoc[];
}

export type BuildResult =
  | { ok: true; docs: ChainDoc[] }
  | { ok: false; error: string };

export async function buildChainDocs(seed: Seed, opts: FetchOpts): Promise<BuildResult> {
  const sorted = [...seed.docs].sort((a, b) => a.order - b.order);
  const docs: ChainDoc[] = [];
  for (const d of sorted) {
    const r = await fetchFiling(d, opts);
    if (!r.ok) return { ok: false, error: `${d.id}: ${r.error}` };
    docs.push({ id: d.id, order: d.order, text: htmlToText(r.html) });
  }
  return { ok: true, docs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/chain-docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/contract-bench/src/chain-docs.ts integrations/contract-bench/src/chain-docs.test.ts
git commit -m "feat(contract-bench): buildChainDocs — seed -> ordered ChainDoc[] via fetch+htmlToText"
```

---

## Task 8: `pull-edgar.mjs` runner + live end-to-end pull (the done-criterion)

**Files:**
- Create: `integrations/contract-bench/pull-edgar.mjs`

- [ ] **Step 1: Write the runner**

```js
#!/usr/bin/env node
// Runner: pull a seed's chain from EDGAR (curl + cache) and print a ChainDoc
// summary. Imports the COMPILED build, so run `npx tsc` first.
// Usage: node pull-edgar.mjs seeds/ngs.json
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChainDocs } from "./dist/chain-docs.js";

const here = dirname(fileURLToPath(import.meta.url));
const seedArg = process.argv[2];
if (!seedArg) {
  console.error("usage: node pull-edgar.mjs <seed.json>");
  process.exit(1);
}
const ua = process.env.EDGAR_UA ?? "Daftari Research (mihir.wagle@gmail.com)";
const seed = JSON.parse(await readFile(resolve(seedArg), "utf8"));
const r = await buildChainDocs(seed, {
  cacheDir: join(here, ".edgar-cache"),
  userAgent: ua,
  throttleMs: 300,
});
if (!r.ok) {
  console.error("FAILED:", r.error);
  process.exit(1);
}
console.log(`chain ${seed.chainId} — ${r.docs.length} docs`);
for (const d of r.docs) console.log(`  ${d.order}\t${d.id}\t${d.text.length} chars`);
```

- [ ] **Step 2: Build, then run the live pull**

```bash
cd integrations/contract-bench
npx tsc
node pull-edgar.mjs seeds/ngs.json
```
Expected: prints `chain ngs-tcb-ar-credit-agreement — 5 docs` then 5 lines (orders 0–4), each with a non-trivial char count (base ≫ 100k chars; amendments smaller). A `.edgar-cache/` dir now holds 5 cached files. **Re-running prints the same summary with no network calls** (cache hit).

- [ ] **Step 3: Confirm the cache is git-ignored**

Run: `git status --porcelain integrations/contract-bench/.edgar-cache` → empty output (ignored).

- [ ] **Step 4: Commit the runner**

```bash
git add integrations/contract-bench/pull-edgar.mjs
git commit -m "feat(contract-bench): pull-edgar runner — live chain pull -> ChainDoc summary"
```

---

## Task 9: Full-suite green + tsc clean (regression gate)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole package**

Run: `cd integrations/contract-bench && npx tsc`
Expected: no output (clean). Note: `*.test.ts` are excluded by tsconfig; vitest type-checks them at run.

- [ ] **Step 2: Run the entire test suite**

Run: `cd integrations/contract-bench && npx vitest run`
Expected: all green — the prior 63 CB1 tests **plus** the new html-to-text / edgar-fetch / chain-docs tests. Confirm count increased and zero failures.

- [ ] **Step 3: Final verification note**

Confirm the E1 done-criterion holds: `node pull-edgar.mjs seeds/ngs.json` yields 5 `ChainDoc`s and `npx vitest run src/html-to-text.test.ts` (incl. the parseCitations oracle) is green. E1 output (`buildChainDocs` → `ChainDoc[]`) is exactly what E3's `assemble(rawDocs, opts)` consumes. No commit needed if Steps 1–2 are clean.

---

## What E1 deliberately does NOT do (guardrails for the implementer)

- **No `assemble()` call, no arms, no metrics** — that is E3. E1 stops at `ChainDoc[]`.
- **No chain discovery / no chains beyond the seed** — E2. The seed is hand-authored and final for E1.
- **No `ngs-amd-5`** — it is a second A&R restatement (chain-boundary decision deferred to E2/E3).
- **No answer normalization, no `unamended` bucket** — out of scope (E3 / deferred).
- **Do not commit `.edgar-cache/` or the 1.72MB base doc.** Only `amd1.htm`/`amd2.htm` are committed fixtures.
