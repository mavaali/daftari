# E2: EDGAR Chain-Discovery Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic, zero-LLM EDGAR chain-discovery pipeline that auto-finds prolific amenders, reconstructs their amendment chains by preamble linkage, scores each chain's labelability, and emits a ranked candidate set plus the natural-unrecoverable-rate distribution.

**Architecture:** Seven small units in `integrations/contract-bench/src/` (mirroring E1's pure-core/thin-IO split), composed by a `discover-edgar.mjs` runner: `efts-search` (full-text query, injectable transport) → `cik-tally` → `preamble` (linkage extractor) → `reconstruct` (group→order→base) → `score` (reuses E1's `buildChainDocs`+`parseCitations`) → `select` (filter+rank+distribution). Tests are hermetic (recorded EFTS JSON fixture + the committed NGS HTML fixtures + injected fake transports); live EFTS/curl only in the runner.

**Tech Stack:** TypeScript (NodeNext, strict), vitest, Node built-ins (`child_process`, `fs/promises`, `URLSearchParams`). Zero new runtime deps. curl for the live SEC/EFTS fetch.

**Spec:** `docs/superpowers/specs/2026-06-26-e2-edgar-discovery-design.md`.

**Conventions (CLAUDE.md):** No classes — functions and types. Fallible IO returns a `Result`-style discriminated union (`{ok:true,...}|{ok:false,error}`), never throws across the boundary. Tests mirror `src/`. `"type":"module"`/NodeNext → import siblings as `./x.js`. Build: `cd integrations/contract-bench && npx tsc`. Test: `npx vitest run`. Single file: `npx vitest run src/<name>.test.ts`.

**Reused E1 signatures (verified — do NOT reimplement):**
- `Seed {chainId, unitType, docs: SeedDoc[]}`, `SeedDoc {id, order, role, cik, accession, filename}`, `buildChainDocs(seed, opts): Promise<{ok:true,docs:ChainDoc[]}|{ok:false,error}>` — `src/chain-docs.ts`.
- `FilingRef {cik, accession, filename}`, `FetchOpts {cacheDir, userAgent, transport?, throttleMs?}`, `Transport = (url, ua) => Promise<string>` — `src/edgar-fetch.ts`.
- `parseCitations(text): Citation[]`, `Citation {clause, op, recoverable}` — `src/citation-parse.ts`.
- `htmlToText(html): string` — `src/html-to-text.ts`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/efts-search.ts` | `EftsHit` type, `parseEftsResponse` (pure), `searchFullText` (network, paginated, injectable transport) |
| `src/cik-tally.ts` | `tallyCiks` — rank CIKs by amendment-exhibit frequency (pure) |
| `src/preamble.ts` | `Preamble` type, `parsePreamble` — extract ordinal + base date + agreement type (pure) |
| `src/reconstruct.ts` | `DiscDoc` type, `reconstructChains` — group→order→base → `Seed[]` (pure) |
| `src/score.ts` | `ChainScore`/`UnitType`, `scoreChain` — reuse `buildChainDocs`+`parseCitations` → labelability metrics |
| `src/select.ts` | `Selection`/`Distribution`, `rankCandidates` — filter+rank+distribution (pure) |
| `discover-edgar.mjs` | runner: query→tally→per-CIK reconstruct→score→rank→write manifest+seeds+pairs+report |
| `src/__fixtures__/efts/credit-amendments.json` | recorded real EFTS response (trimmed to ~5 hits) |
| their `*.test.ts` | one per unit |

---

## Task 1: Scaffold — recorded EFTS fixture

**Files:** Create `integrations/contract-bench/src/__fixtures__/efts/credit-amendments.json`

- [ ] **Step 1: Capture a real EFTS response** (the per-CIK NGS query — known accessions to assert on):

```bash
cd integrations/contract-bench
mkdir -p src/__fixtures__/efts
UA="Daftari Research (mihir.wagle@gmail.com)"
curl -sS --fail --max-time 40 -A "$UA" \
  'https://efts.sec.gov/LATEST/search-index?q=%22Amendment+to+Credit+Agreement%22&ciks=0001084991' \
  -o /tmp/efts-raw.json
```

- [ ] **Step 2: Trim to a compact fixture** preserving structure. Keep `.hits.total` and the FIRST 5 entries of `.hits.hits`, dropping the rest (the fixture only needs realistic shape, not 100 hits):

```bash
jq '{hits: {total: .hits.total, hits: (.hits.hits[0:5])}}' /tmp/efts-raw.json > src/__fixtures__/efts/credit-amendments.json
```
Verify the fixture has 5 hits each with `._id` (format `<accession>:<filename>`) and `._source.ciks`/`.root_forms`/`.file_date`:
```bash
jq '.hits.hits | length, (.[0] | {_id, ciks: ._source.ciks, form: ._source.root_forms, date: ._source.file_date})' src/__fixtures__/efts/credit-amendments.json
```

- [ ] **Step 3: Commit**
```bash
git add src/__fixtures__/efts/credit-amendments.json
git commit -m "test(contract-bench): E2 recorded EFTS response fixture"
```

---

## Task 2: `efts-search.ts` — parse + paginated search

**Files:** Create `src/efts-search.ts`, `src/efts-search.test.ts`

- [ ] **Step 1: Write the failing test** (parse the fixture; pagination via a fake transport — no network):

```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { parseEftsResponse, searchFullText } from "./efts-search.js";

const raw = JSON.parse(readFileSync(new URL("./__fixtures__/efts/credit-amendments.json", import.meta.url), "utf8"));

describe("parseEftsResponse", () => {
  test("maps EFTS hits to normalized {cik, accession, filename, formType, fileDate}", () => {
    const hits = parseEftsResponse(raw);
    expect(hits.length).toBe(5);
    expect(hits[0]).toMatchObject({ cik: expect.stringMatching(/^\d{10}$/), accession: expect.stringMatching(/^\d{10}-\d\d-\d{6}$/), filename: expect.stringMatching(/\.htm$/) });
  });
  test("splits the _id into accession:filename and reads the first cik", () => {
    // _id is "<accession>:<filename>"; _source.ciks[0] is the filer.
    const hits = parseEftsResponse({ hits: { hits: [{ _id: "0001084991-23-000124:exhibit101firstamendmentto.htm", _source: { ciks: ["0001084991"], root_forms: ["8-K"], file_date: "2023-11-15" } }] } });
    expect(hits[0]).toEqual({ cik: "0001084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm", formType: "8-K", fileDate: "2023-11-15" });
  });
  test("skips malformed hits (no _id, no cik)", () => {
    expect(parseEftsResponse({ hits: { hits: [{ _id: "noColon" }, { _source: { ciks: ["1"] } }] } })).toEqual([]);
    expect(parseEftsResponse({})).toEqual([]);
  });
});

describe("searchFullText", () => {
  test("paginates via the transport until an empty page, accumulating hits", async () => {
    let calls = 0;
    const page = (n: number) => JSON.stringify({ hits: { hits: Array.from({ length: n }, (_, i) => ({ _id: `000000000${calls}-00-00000${i}:f${i}.htm`, _source: { ciks: ["0000000001"], root_forms: ["8-K"], file_date: "2023-01-01" } })) } });
    const transport = async () => { const body = calls === 0 ? page(2) : page(0); calls++; return body; };
    const r = await searchFullText("Amendment to Credit Agreement", { userAgent: "ua", transport, maxHits: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits.length).toBe(2);
    expect(calls).toBe(2); // page 0 (2 hits) then page 1 (empty) -> stop
  });
  test("returns an error result (no throw) when the transport fails", async () => {
    const transport = async () => { throw new Error("HTTP 429"); };
    const r = await searchFullText("x", { userAgent: "ua", transport });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("429");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/efts-search.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/efts-search.ts`:

```ts
// efts-search — query EDGAR full-text search (efts.sec.gov) and normalize hits.
// Endpoint verified live: https://efts.sec.gov/LATEST/search-index?q=<phrase>&forms=<f>&ciks=<10-digit>&from=<n>
// Each hit: _id = "<accession>:<filename>", _source.{ciks[], root_forms[], file_date}.
// Result window caps at 10000; ~100 hits/page. Parsing is pure; the network call
// uses an injectable curl transport (same pattern as edgar-fetch).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface EftsHit {
  cik: string;
  accession: string;
  filename: string;
  formType: string;
  fileDate: string;
}

interface RawEfts { hits?: { hits?: Array<{ _id?: string; _source?: { ciks?: string[]; root_forms?: string[]; file_date?: string } }> } }

export function parseEftsResponse(json: unknown): EftsHit[] {
  const hits = (json as RawEfts).hits?.hits ?? [];
  const out: EftsHit[] = [];
  for (const h of hits) {
    const id = h._id ?? "";
    const colon = id.indexOf(":");
    if (colon < 0) continue;
    const cik = h._source?.ciks?.[0];
    const filename = id.slice(colon + 1);
    if (!cik || !filename) continue;
    out.push({
      cik,
      accession: id.slice(0, colon),
      filename,
      formType: h._source?.root_forms?.[0] ?? "",
      fileDate: h._source?.file_date ?? "",
    });
  }
  return out;
}

export type Transport = (url: string, userAgent: string) => Promise<string>;

const curlTransport: Transport = async (url, userAgent) => {
  const { stdout } = await execFileP("curl", ["-sS", "--fail", "--max-time", "40", "-A", userAgent, url], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout;
};

const EFTS = "https://efts.sec.gov/LATEST/search-index";
const WINDOW_CAP = 10000;

export interface SearchOpts {
  userAgent: string;
  forms?: string;
  ciks?: string;
  maxHits?: number;
  transport?: Transport;
  throttleMs?: number;
}

export async function searchFullText(query: string, opts: SearchOpts): Promise<{ ok: true; hits: EftsHit[] } | { ok: false; error: string }> {
  const transport = opts.transport ?? curlTransport;
  const max = Math.min(opts.maxHits ?? 1000, WINDOW_CAP);
  const url = (from: number) => {
    const p = new URLSearchParams({ q: `"${query}"`, from: String(from) });
    if (opts.forms) p.set("forms", opts.forms);
    if (opts.ciks) p.set("ciks", opts.ciks);
    return `${EFTS}?${p.toString()}`;
  };
  const all: EftsHit[] = [];
  try {
    let from = 0;
    while (all.length < max) {
      const page = parseEftsResponse(JSON.parse(await transport(url(from), opts.userAgent)));
      if (page.length === 0) break;
      all.push(...page);
      from += page.length; // robust to EFTS's actual page size
      if (opts.throttleMs) await new Promise((r) => setTimeout(r, opts.throttleMs));
    }
    return { ok: true, hits: all.slice(0, max) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**
```bash
git add src/efts-search.ts src/efts-search.test.ts
git commit -m "feat(contract-bench): efts-search — parse + paginated EDGAR full-text search"
```

---

## Task 3: `cik-tally.ts`

**Files:** Create `src/cik-tally.ts`, `src/cik-tally.test.ts`

- [ ] **Step 1: Failing test:**
```ts
import { describe, expect, test } from "vitest";
import { tallyCiks } from "./cik-tally.js";
import type { EftsHit } from "./efts-search.js";

const hit = (cik: string): EftsHit => ({ cik, accession: "a", filename: "f", formType: "8-K", fileDate: "2023-01-01" });

describe("tallyCiks", () => {
  test("ranks CIKs by frequency, descending, with a deterministic CIK tiebreak", () => {
    const hits = [hit("A"), hit("B"), hit("A"), hit("C"), hit("B"), hit("A")];
    expect(tallyCiks(hits)).toEqual([{ cik: "A", count: 3 }, { cik: "B", count: 2 }, { cik: "C", count: 1 }]);
  });
});
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:**
```ts
// cik-tally — rank CIKs by how many amendment exhibits they filed (the
// auto-discovery worklist: prolific amenders surface to the top).
import type { EftsHit } from "./efts-search.js";

export interface CikCount { cik: string; count: number; }

export function tallyCiks(hits: EftsHit[]): CikCount[] {
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.cik, (counts.get(h.cik) ?? 0) + 1);
  return [...counts.entries()]
    .map(([cik, count]) => ({ cik, count }))
    .sort((a, b) => b.count - a.count || a.cik.localeCompare(b.cik));
}
```
- [ ] **Step 4: Run** → PASS. **Step 5: Commit**
```bash
git add src/cik-tally.ts src/cik-tally.test.ts
git commit -m "feat(contract-bench): cik-tally — rank CIKs by amendment frequency"
```

---

## Task 4: `preamble.ts` — the linkage extractor (dominant risk)

**Files:** Create `src/preamble.ts`, `src/preamble.test.ts`

**CRITICAL real-data facts (verified live on NGS amd-1; do NOT fall into the trap):**
- The amendment's preamble head reads: `…FIRST AMENDMENT TO AMENDED AND RESTATED CREDIT AGREEMENT This FIRST AMENDMENT … is dated effective as of November 14, 2023 … to that certain Amended and Restated Credit Agreement dated as of February 28, 2023…`
- The amendment's OWN date uses **`dated effective as of November 14, 2023`** — which `/dated as of/` deliberately does NOT match (the word `effective` breaks it).
- The BASE date uses **`dated as of February 28, 2023`**, appearing LATER (in the recitals). So slice a generous head (~2500 chars) so the base date is in range, and match `/dated as of …/` (NOT `dated effective as of`). This naturally skips the amendment's own date.
- The agreement type here is **"Amended and Restated Credit Agreement"** (not bare "Credit Agreement").

- [ ] **Step 1: DISCOVER then write the test.** First print the real head to confirm the strings, then pin the test:
```bash
cd integrations/contract-bench && npx tsc
node -e 'import("./dist/html-to-text.js").then(m=>{const fs=require("node:fs");console.log(JSON.stringify(m.htmlToText(fs.readFileSync("src/__fixtures__/ngs/amd1.htm","utf8")).slice(0,2500)))})'
```
Confirm you see `FIRST AMENDMENT`, `dated effective as of November 14, 2023` (amendment's own — must NOT be picked), and `dated as of February 28, 2023` (base — must be picked). Then write `src/preamble.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { htmlToText } from "./html-to-text.js";
import { parsePreamble } from "./preamble.js";

const amd1 = htmlToText(readFileSync(new URL("./__fixtures__/ngs/amd1.htm", import.meta.url), "utf8"));

describe("parsePreamble", () => {
  test("extracts ordinal, BASE date (not the amendment's own effective date), and agreement type from real NGS amd-1", () => {
    const p = parsePreamble(amd1);
    expect(p).not.toBeNull();
    expect(p?.ordinal).toBe(1);
    expect(p?.baseDate).toBe("February 28, 2023"); // NOT "November 14, 2023" (the amendment's own date)
    expect(p?.agreementType.toLowerCase()).toContain("credit agreement");
  });
  test("does NOT match the amendment's own 'dated effective as of' date", () => {
    expect(parsePreamble(amd1)?.baseDate).not.toBe("November 14, 2023");
  });
  test("returns null when there is no <Ordinal> Amendment", () => {
    expect(parsePreamble("This Credit Agreement dated as of January 1, 2020 by and among …")).toBeNull();
  });
  test("returns null when no base 'dated as of' date is present", () => {
    expect(parsePreamble("FIRST AMENDMENT TO CREDIT AGREEMENT. No date here.")).toBeNull();
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/preamble.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/preamble.ts`. Adjust the agreement-type capture if the discovery output shows a different shape, but keep the baseDate rule (match `dated as of`, never `dated effective as of`):
```ts
// preamble — extract the linkage signal from an amendment's opening: its ordinal
// (First/Second/…), the BASE agreement's date ("dated as of <date>"), and the
// agreement type. The base date is what links an amendment to its master and
// separates two same-type chains for one filer. NOTE: an amendment's OWN date
// is often phrased "dated effective as of <date>" — we match "dated as of"
// (no "effective"), which skips the amendment's own date and lands on the base's.
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

export interface Preamble {
  ordinal: number;
  ordinalWord: string;
  baseDate: string;
  agreementType: string;
}

export function parsePreamble(text: string): Preamble | null {
  const head = text.slice(0, 2500);
  const ordM = head.match(/\b(First|Second|Third|Fourth|Fifth|Sixth|Seventh|Eighth|Ninth|Tenth)\s+Amendment\b/i);
  if (!ordM) return null;
  const ordinalWord = ordM[1];
  const ordinal = ORDINALS[ordinalWord.toLowerCase()];
  // "dated as of <Month D, YYYY>" — but NOT "dated effective as of" (the
  // amendment's own date). The negative lookbehind-free guard: require "dated"
  // immediately followed by " as of".
  const dateM = head.match(/dated as of\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
  if (!dateM) return null;
  const baseDate = dateM[1];
  const typeM = head.match(/Amendment\s+to\s+(?:the\s+)?(?:that\s+certain\s+)?([A-Za-z][A-Za-z ]*?Agreement)\b/i);
  const agreementType = (typeM ? typeM[1] : "Agreement").replace(/\s+/g, " ").trim();
  return { ordinal, ordinalWord, baseDate, agreementType };
}
```
**If the discovery output reveals the regexes don't match reality (e.g. agreement type captured wrong), adjust to match the REAL text and report what you changed — do not force the test.** If `parsePreamble(amd1)` cannot yield `baseDate === "February 28, 2023"`, STOP and report (it means the base date isn't in the first 2500 chars or uses a different phrasing — a real finding).

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**
```bash
git add src/preamble.ts src/preamble.test.ts
git commit -m "feat(contract-bench): parsePreamble — ordinal + base-date linkage extractor"
```

---

## Task 5: `reconstruct.ts` — group → order → base

**Files:** Create `src/reconstruct.ts`, `src/reconstruct.test.ts`

- [ ] **Step 1: Failing test** (synthetic two-chain CIK — controlled preambles; tests grouping by base date, ordering, base identification, and the amendments-only fallback):
```ts
import { describe, expect, test } from "vitest";
import { reconstructChains, type DiscDoc } from "./reconstruct.js";

const doc = (accession: string, filename: string, text: string): DiscDoc => ({ ref: { cik: "1", accession, filename }, text });

describe("reconstructChains", () => {
  test("splits two same-type chains by base date, orders by ordinal, identifies the filed base", () => {
    const docs: DiscDoc[] = [
      doc("a-0", "base2020.htm", "This Credit Agreement dated as of January 1, 2020 by and among X and Y. Section 1.1 …"),
      doc("a-1", "amd1.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT. This First Amendment to that certain Credit Agreement dated as of January 1, 2020 …"),
      doc("a-2", "amd2.htm", "SECOND AMENDMENT TO CREDIT AGREEMENT. This Second Amendment to that certain Credit Agreement dated as of January 1, 2020 …"),
      doc("b-0", "base2022.htm", "This Credit Agreement dated as of June 1, 2022 by and among X and Z. Section 1.1 …"),
      doc("b-1", "amdB1.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT. This First Amendment to that certain Credit Agreement dated as of June 1, 2022 …"),
    ];
    const chains = reconstructChains("1", docs);
    expect(chains.length).toBe(2);
    const c2020 = chains.find((c) => c.chainId.includes("january-1-2020"))!;
    expect(c2020.docs.map((d) => [d.order, d.role, d.filename])).toEqual([
      [0, "master", "base2020.htm"], [1, "amendment-1", "amd1.htm"], [2, "amendment-2", "amd2.htm"],
    ]);
    const c2022 = chains.find((c) => c.chainId.includes("june-1-2022"))!;
    expect(c2022.docs.map((d) => d.role)).toEqual(["master", "amendment-1"]);
  });

  test("falls back to earliest amendment as base when no separate base filing is present", () => {
    const docs: DiscDoc[] = [
      doc("x-2", "amd2.htm", "SECOND AMENDMENT TO CREDIT AGREEMENT dated as of March 3, 2021 …"),
      doc("x-1", "amd1.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT dated as of March 3, 2021 …"),
    ];
    const [chain] = reconstructChains("1", docs);
    // No base filing -> earliest amendment becomes order 0 (resolveChain treats ordered[0] as master).
    expect(chain.docs.map((d) => [d.order, d.role])).toEqual([[0, "amendment-1"], [1, "amendment-2"]]);
  });

  test("sets unitType to the placeholder 'unknown' (score.ts produces the authoritative value)", () => {
    const [chain] = reconstructChains("1", [doc("x-1", "a.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT dated as of March 3, 2021 …")]);
    expect(chain.unitType).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/reconstruct.ts`:
```ts
// reconstruct — group a CIK's amendment exhibits into chains by their preamble
// (agreementType, baseDate) signature, order by ordinal, and identify the base
// filing (else fall back to the earliest amendment as master). Emits E1-format
// Seeds. unitType is a placeholder here ("unknown"); score.ts produces the
// authoritative value. SeedDoc.role follows E1's convention:
// base -> "master", ordinal N -> "amendment-N".
import type { Seed, SeedDoc } from "./chain-docs.js";
import type { FilingRef } from "./edgar-fetch.js";
import { parsePreamble, type Preamble } from "./preamble.js";

export interface DiscDoc {
  ref: FilingRef;
  text: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function seedDoc(ref: FilingRef, order: number, role: string): SeedDoc {
  return { id: role, order, role, cik: ref.cik, accession: ref.accession, filename: ref.filename };
}

export function reconstructChains(cik: string, docs: DiscDoc[]): Seed[] {
  const amendments: { doc: DiscDoc; pre: Preamble }[] = [];
  const others: DiscDoc[] = [];
  for (const d of docs) {
    const pre = parsePreamble(d.text);
    if (pre) amendments.push({ doc: d, pre });
    else others.push(d);
  }
  const groups = new Map<string, { doc: DiscDoc; pre: Preamble }[]>();
  for (const a of amendments) {
    const key = `${a.pre.agreementType.toLowerCase()}|${a.pre.baseDate}`;
    const g = groups.get(key);
    if (g) g.push(a); else groups.set(key, [a]);
  }
  const seeds: Seed[] = [];
  for (const [key, group] of groups) {
    const baseDate = key.split("|")[1];
    const agreementType = group[0].pre.agreementType;
    group.sort((x, y) => x.pre.ordinal - y.pre.ordinal);
    const base = others.find((o) =>
      o.text.includes(baseDate) && new RegExp(esc(agreementType), "i").test(o.text.slice(0, 3000)),
    );
    const seedDocs: SeedDoc[] = [];
    let order = 0;
    if (base) seedDocs.push(seedDoc(base.ref, order++, "master"));
    for (const a of group) seedDocs.push(seedDoc(a.doc.ref, order++, `amendment-${a.pre.ordinal}`));
    seeds.push({
      chainId: `${cik}-${slug(agreementType)}-${slug(baseDate)}`,
      unitType: "unknown",
      docs: seedDocs,
    });
  }
  return seeds;
}
```
Note the amendments-only fallback: with no `base`, `order` starts at 0 on the first amendment, so `amendment-1` gets order 0. The role stays `amendment-1` (honest about what the doc is) while `order:0` makes `resolveChain` treat it as the master baseline — matching the test.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**
```bash
git add src/reconstruct.ts src/reconstruct.test.ts
git commit -m "feat(contract-bench): reconstructChains — preamble grouping -> ordered Seeds"
```

---

## Task 6: `score.ts` — labelability scoring (reuses E1)

**Files:** Create `src/score.ts`, `src/score.test.ts`

- [ ] **Step 1: Failing test** (inject a fake transport via `FetchOpts.transport`; small HTML bodies with known ops → assert unitType + rate). The fake transport is keyed by filename in the URL:
```ts
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreChain } from "./score.js";
import type { Seed } from "./chain-docs.js";

const seed = (docs: { order: number; role: string; filename: string }[]): Seed => ({
  chainId: "t", unitType: "unknown",
  docs: docs.map((d) => ({ id: d.role, order: d.order, role: d.role, cik: "1", accession: "a", filename: d.filename })),
});

describe("scoreChain", () => {
  test("scores a mixed chain: counts ops across amendments, classifies unit type, computes unrecoverable rate", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const bodies: Record<string, string> = {
        "base.htm": "<p>Master agreement.</p>",
        // amendment with one Section restate (recoverable) + one defined-term restate (recoverable) + one partial (unrecoverable)
        "a1.htm": `<p>Section 5.1 of the Agreement is hereby amended and restated in its entirety as follows: "x". The terms set forth in Section 1.1 are hereby amended and restated in their respective entireties to read in full as follows: &#8220;Margin&#8221; means 2%. Section 9.9 of the Agreement is hereby amended by inserting a comma.</p>`,
      };
      const transport = async (url: string) => bodies[url.split("/").pop() as string];
      const r = await scoreChain(seed([{ order: 0, role: "master", filename: "base.htm" }, { order: 1, role: "amendment-1", filename: "a1.htm" }]), { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.score.length).toBe(2);
      expect(r.score.unitType).toBe("mixed");           // Section clause + defined term both present
      expect(r.score.totalOps).toBe(3);
      expect(r.score.unrecoverableOps).toBe(1);          // the "amended by" partial
      expect(r.score.unrecoverableRate).toBeCloseTo(1 / 3, 5);
      expect(r.score.cik).toBe("1");
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  });

  test("propagates a build failure as an error result", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const transport = async () => { throw new Error("HTTP 404"); };
      const r = await scoreChain(seed([{ order: 0, role: "master", filename: "b.htm" }]), { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(false);
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  });
});
```
**Before relying on the exact `totalOps`/`unrecoverableOps` numbers, run the test once** — `parseCitations` behavior on the crafted body is the source of truth. If the counts differ, adjust the ASSERTIONS to the real `parseCitations` output (the unit under test is `scoreChain`'s aggregation, not `parseCitations`), and note what the real counts were.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/score.ts`:
```ts
// score — labelability metrics for a candidate chain. Reuses E1's buildChainDocs
// (fetch+htmlToText) and parseCitations: counts amendment ops, classifies the
// unit type (Section / defined-term / mixed) and the unrecoverable rate (the
// >20% hand-resolution kill-metric). Master (order 0) is not an amendment.
import { buildChainDocs, type Seed } from "./chain-docs.js";
import type { FetchOpts } from "./edgar-fetch.js";
import { parseCitations } from "./citation-parse.js";

export type UnitType = "section" | "defined-term" | "mixed" | "unknown";

export interface ChainScore {
  chainId: string;
  cik: string;
  length: number;
  unitType: UnitType;
  totalOps: number;
  unrecoverableOps: number;
  unrecoverableRate: number;
}

const NUMERIC_CLAUSE = /^\d+(\.\d+)*/;

export async function scoreChain(seed: Seed, opts: FetchOpts): Promise<{ ok: true; score: ChainScore } | { ok: false; error: string }> {
  const built = await buildChainDocs(seed, opts);
  if (!built.ok) return { ok: false, error: built.error };
  let total = 0, unrec = 0, section = 0, term = 0;
  for (const d of built.docs) {
    if (d.order === 0) continue; // the master is not an amendment
    for (const c of parseCitations(d.text)) {
      total++;
      if (!c.recoverable) unrec++;
      if (NUMERIC_CLAUSE.test(c.clause)) section++; else term++;
    }
  }
  const unitType: UnitType = section && term ? "mixed" : section ? "section" : term ? "defined-term" : "unknown";
  return { ok: true, score: {
    chainId: seed.chainId,
    cik: seed.docs[0]?.cik ?? "",
    length: built.docs.length,
    unitType,
    totalOps: total,
    unrecoverableOps: unrec,
    unrecoverableRate: total ? unrec / total : 0,
  } };
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**
```bash
git add src/score.ts src/score.test.ts
git commit -m "feat(contract-bench): scoreChain — unit-type + unrecoverable-rate via E1 reuse"
```

---

## Task 7: `select.ts` — filter + rank + distribution

**Files:** Create `src/select.ts`, `src/select.test.ts`

- [ ] **Step 1: Failing test:**
```ts
import { describe, expect, test } from "vitest";
import { rankCandidates } from "./select.js";
import type { ChainScore } from "./score.js";

const s = (chainId: string, length: number, rate: number, unitType: ChainScore["unitType"] = "mixed"): ChainScore =>
  ({ chainId, cik: "1", length, unitType, totalOps: 10, unrecoverableOps: Math.round(rate * 10), unrecoverableRate: rate });

describe("rankCandidates", () => {
  test("selects length>=minLength AND rate<=maxUnrecoverable, sorted by rate ascending", () => {
    const scores = [s("hi", 4, 0.5), s("clean", 4, 0.05), s("short", 2, 0.0), s("ok", 3, 0.15)];
    const { selected } = rankCandidates(scores, { minLength: 3, maxUnrecoverable: 0.2 });
    expect(selected.map((x) => x.chainId)).toEqual(["clean", "ok"]); // "hi" rate too high, "short" too short
  });
  test("the distribution counts ALL scores regardless of selection", () => {
    const scores = [s("a", 4, 0.05), s("b", 2, 0.95, "section"), s("c", 5, 0.15, "defined-term")];
    const { distribution } = rankCandidates(scores, { minLength: 3, maxUnrecoverable: 0.2 });
    expect(distribution.total).toBe(3);
    expect(distribution.unitTypeCounts).toEqual({ mixed: 1, section: 1, "defined-term": 1 });
    expect(distribution.rateBuckets["0.0-0.1"]).toBe(1);
    expect(distribution.rateBuckets["0.1-0.2"]).toBe(1);
    expect(distribution.rateBuckets["0.9-1.0"]).toBe(1);
  });
});
```
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** `src/select.ts`:
```ts
// select — filter scored chains to the labelable, well-formed ones and rank them;
// always report the full distribution (the natural unrecoverable-rate histogram
// is the labelability finding, independent of the selection cutoff). Both gates
// are tunable; maxUnrecoverable defaults to a deliberately generous 0.20.
import type { ChainScore } from "./score.js";

export interface SelectOpts { minLength: number; maxUnrecoverable: number; }

export interface Distribution {
  total: number;
  unitTypeCounts: Record<string, number>;
  rateBuckets: Record<string, number>;
}

export interface Selection { selected: ChainScore[]; distribution: Distribution; }

function bucket(rate: number): string {
  const lo = Math.min(9, Math.floor(rate * 10));
  return `${(lo / 10).toFixed(1)}-${((lo + 1) / 10).toFixed(1)}`;
}

export function rankCandidates(scores: ChainScore[], opts: SelectOpts): Selection {
  const selected = scores
    .filter((s) => s.length >= opts.minLength && s.unrecoverableRate <= opts.maxUnrecoverable)
    .sort((a, b) => a.unrecoverableRate - b.unrecoverableRate || b.length - a.length || a.chainId.localeCompare(b.chainId));
  const unitTypeCounts: Record<string, number> = {};
  const rateBuckets: Record<string, number> = {};
  for (const s of scores) {
    unitTypeCounts[s.unitType] = (unitTypeCounts[s.unitType] ?? 0) + 1;
    const b = bucket(s.unrecoverableRate);
    rateBuckets[b] = (rateBuckets[b] ?? 0) + 1;
  }
  return { selected, distribution: { total: scores.length, unitTypeCounts, rateBuckets } };
}
```
- [ ] **Step 4: Run** → PASS. **Step 5: Commit**
```bash
git add src/select.ts src/select.test.ts
git commit -m "feat(contract-bench): rankCandidates — filter/rank + full unrecoverable-rate distribution"
```

---

## Task 8: `discover-edgar.mjs` runner + live run (done-criterion)

**Files:** Create `integrations/contract-bench/discover-edgar.mjs`

- [ ] **Step 1: Write the runner** (imports the COMPILED build; `npx tsc` first). It wires the pipeline and writes outputs under a gitignored `.discover-out/`:
```js
#!/usr/bin/env node
// Runner: discover EDGAR amendment chains for a broad query and emit a ranked
// candidate set + the unrecoverable-rate distribution. Imports the COMPILED
// build — run `npx tsc` first.
// Usage: node discover-edgar.mjs "Amendment to Credit Agreement" [topCiks] [maxUnrecoverable]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchFullText } from "./dist/efts-search.js";
import { tallyCiks } from "./dist/cik-tally.js";
import { reconstructChains } from "./dist/reconstruct.js";
import { scoreChain } from "./dist/score.js";
import { rankCandidates } from "./dist/select.js";
import { fetchFiling } from "./dist/edgar-fetch.js";
import { htmlToText } from "./dist/html-to-text.js";
import { parseCitations } from "./dist/citation-parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const query = process.argv[2];
if (!query) { console.error('usage: node discover-edgar.mjs "<query>" [topCiks] [maxUnrecoverable]'); process.exit(1); }
const topCiks = Number(process.argv[3] ?? 15);
const maxUnrecoverable = Number(process.argv[4] ?? 0.2);
const ua = process.env.EDGAR_UA ?? "Daftari Research (mihir.wagle@gmail.com)";
const cacheDir = join(here, ".edgar-cache");
const outDir = join(here, ".discover-out");
const fetchOpts = { cacheDir, userAgent: ua, throttleMs: 300 };

// 1. broad query -> tally CIKs
const broad = await searchFullText(query, { userAgent: ua, forms: "8-K", maxHits: 1000, throttleMs: 300 });
if (!broad.ok) { console.error("broad search FAILED:", broad.error); process.exit(1); }
const ciks = tallyCiks(broad.hits).slice(0, topCiks);
console.log(`tallied ${tallyCiks(broad.hits).length} CIKs from ${broad.hits.length} hits; taking top ${ciks.length}`);

// 2. per CIK: fetch amendment exhibits -> reconstruct -> score
const scores = [];
const seedsById = new Map();
for (const { cik } of ciks) {
  const per = await searchFullText(query, { userAgent: ua, ciks: cik.padStart(10, "0"), maxHits: 200, throttleMs: 300 });
  if (!per.ok) { console.error(`  ${cik}: search failed: ${per.error}`); continue; }
  // fetch each exhibit's text
  const discDocs = [];
  for (const h of per.hits) {
    const r = await fetchFiling({ cik, accession: h.accession, filename: h.filename }, fetchOpts);
    if (r.ok) discDocs.push({ ref: { cik, accession: h.accession, filename: h.filename }, text: htmlToText(r.html) });
  }
  for (const seed of reconstructChains(cik, discDocs)) {
    const sc = await scoreChain(seed, fetchOpts);
    if (sc.ok) { scores.push(sc.score); seedsById.set(seed.chainId, seed); }
  }
}

// 3. rank + write outputs
const { selected, distribution } = rankCandidates(scores, { minLength: 3, maxUnrecoverable });
await mkdir(join(outDir, "seeds"), { recursive: true });
await mkdir(join(outDir, "pairs"), { recursive: true });
const manifest = scores.map((s) => ({ ...s, selected: selected.some((x) => x.chainId === s.chainId) }));
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
await writeFile(join(outDir, "distribution.md"), renderDistribution(distribution, selected.length));
for (const s of selected) {
  const seed = seedsById.get(s.chainId);
  await writeFile(join(outDir, "seeds", `${s.chainId}.json`), JSON.stringify({ ...seed, unitType: s.unitType }, null, 2));
  // pairs dump: parseCitations annotations per amendment, from cache (no new network)
  const lines = [];
  for (const d of seed.docs) {
    if (d.order === 0) continue;
    const r = await fetchFiling({ cik: d.cik, accession: d.accession, filename: d.filename }, fetchOpts);
    if (r.ok) for (const c of parseCitations(htmlToText(r.html))) lines.push(`${d.role}\t${c.clause}\t${c.op}\t${c.recoverable}`);
  }
  await writeFile(join(outDir, "pairs", `${s.chainId}.md`), lines.join("\n") + "\n");
}
console.log(`\nscored ${scores.length} chains; selected ${selected.length} (rate<=${maxUnrecoverable}, length>=3)`);
console.log(`outputs in ${outDir}/ (manifest.json, distribution.md, seeds/, pairs/)`);
for (const s of selected) console.log(`  ${s.unrecoverableRate.toFixed(2)}\t${s.unitType}\tlen=${s.length}\t${s.chainId}`);

function renderDistribution(d, selectedCount) {
  const buckets = Object.keys(d.rateBuckets).sort();
  return [
    `# Unrecoverable-rate distribution (${d.total} chains scored, ${selectedCount} selected)`, "",
    "## Rate buckets", ...buckets.map((b) => `- ${b}: ${d.rateBuckets[b]}`), "",
    "## Unit types", ...Object.entries(d.unitTypeCounts).map(([k, v]) => `- ${k}: ${v}`), "",
  ].join("\n");
}
```

- [ ] **Step 2: Ignore the output dir** — append to the repo-root `.gitignore`:
```
.discover-out/
```

- [ ] **Step 3: Build + live run** (real EFTS + SEC network; expected, not a test):
```bash
cd integrations/contract-bench && npx tsc
node discover-edgar.mjs "Amendment to Credit Agreement" 15 0.2
```
Expected: tallies CIKs, then per-CIK reconstructs+scores chains, prints `scored N chains; selected M`, and writes `.discover-out/{manifest.json, distribution.md, seeds/, pairs/}`. This is network-heavy and throttled (~300ms/call) — it may take a few minutes. **Capture and report:** the number scored/selected, the distribution.md contents, and whether any NGS chain (CIK 1084991) surfaced as a candidate (the known-good anchor — it will only appear if NGS is in the top-`topCiks`; if not, separately run `node discover-edgar.mjs "Amendment to Credit Agreement" 15 0.2` is fine, NGS appearing is a bonus not a gate).

- [ ] **Step 4: Confirm outputs are git-ignored**
```bash
git status --porcelain integrations/contract-bench/.discover-out integrations/contract-bench/.edgar-cache
```
Expected: EMPTY (both ignored). If anything shows, STOP — do not commit pulled filings or outputs.

- [ ] **Step 5: Commit the runner only**
```bash
git add integrations/contract-bench/discover-edgar.mjs .gitignore
git commit -m "feat(contract-bench): discover-edgar runner — query -> ranked chains + distribution"
```

---

## Task 9: Spot-check gate + full-suite/tsc green (done-criterion)

**Files:** none (verification + a written spot-check note)

- [ ] **Step 1: Typecheck + full suite**
```bash
cd integrations/contract-bench && npx tsc && npx vitest run
```
Expected: tsc clean; all prior tests (83 from E1) PLUS the new E2 unit tests green. Report the new total.

- [ ] **Step 2: Human spot-check (the required gate).** Pick one SELECTED chain from `.discover-out/manifest.json` (prefer the NGS chain if present, else the lowest-rate selected chain). Open its `.discover-out/pairs/<chainId>.md` and, for ~3–5 annotated clauses, open the corresponding cached filing (`.edgar-cache/`) and confirm the parser's `clause → op → recoverable` matches the contract text (e.g. a `restate` row really is an "amended and restated in its entirety" of that clause). **Write the result** into `docs/superpowers/results/2026-06-26-e2-discovery-spotcheck.md`: the chain checked, the sample, agree/disagree per row, and the verdict (annotations trustworthy? null-preamble rate from distribution.md?). This is the labels-are-the-canary gate before E3 consumes any of these chains.

- [ ] **Step 3: Commit the spot-check result**
```bash
git add docs/superpowers/results/2026-06-26-e2-discovery-spotcheck.md
git commit -m "docs(results): E2 discovery spot-check — parser annotation accuracy on a real chain"
```

---

## What E2 deliberately does NOT do (guardrails)

- **No `assemble()`, no arms, no metrics** — E3. E2 stops at ranked candidates + seeds + the distribution + the spot-check.
- **No final N≥20 curation** — that's a human consuming E2's ranked output (E3-adjacent).
- **No LLM anywhere** — discovery is deterministic/auditable by design.
- **No agreement types beyond the credit-agreement query** — mechanism is general; widening the query is a future run, not new code.
- **Do not commit `.edgar-cache/` or `.discover-out/`** — both gitignored. Only the recorded EFTS fixture is committed.
