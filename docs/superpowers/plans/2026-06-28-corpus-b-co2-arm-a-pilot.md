# Corpus (B) CO2 — Arm A resolver + #67–76 pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Arm A (stream-recency) and Arm C (daftari) resolvers and the pilot runner, then run the cheap falsifier on the 14 post-cutoff (`governingNum ∈ [67,76]`) stale-trap instances.

**Architecture:** Reuse CO1 modules. Each stale-trap instance's revert diff (`action=compare`, `compare["*"]`) yields, deterministically, the stale (deleted) and governing (added) passage text. Arm A returns the stale text at the bad-edit snapshot and the governing text at the revert snapshot (the fair-foil control). Arm C resolves the cited item via `resolveCurrent` and confirms the governing passage via the inline `consensus N` marker within the diff window (non-circular, no full-content fetch). A pilot runner classifies each arm {governing | stale | abstain | unscorable} and emits metrics. Fixture-backed; no network in tests.

**Tech Stack:** TypeScript, vitest, Node `fetch` (script only), the CO1 modules (`consensus-parse`, `consensus-resolve`, `consensus-instances`, `consensus-qa`).

**Spec:** `docs/superpowers/specs/2026-06-28-corpus-b-co2-arm-a-pilot-design.md`

**Out of scope (follow-ons, gated on the pilot):** full 37-instance run; Arm B (LLM-synth) + its blind judge; pre-cutoff perturbation; CB4 acquired-edge arm; Arm A/B mint-rate on no-mint (CO2 measures only Arm C's abstention on the 5 box-derived dead-ends — the clean, deterministic no-mint property; Arm A/B minting comes with Arm B).

---

## File Structure

- Create `integrations/consensus-bench/src/consensus-content.ts` — `DiffSource` interface + `loadDiffsFromFile` fixture reader; `RevertDiff` type.
- Create `integrations/consensus-bench/src/consensus-passage.ts` — `parsePassage(diffHtml)` → `{ staleText, governingText, scorable, reason }`; `markerPresent(diffHtml, num)`.
- Create `integrations/consensus-bench/src/consensus-arm-a.ts` — `armA(passage, snapshot)`.
- Create `integrations/consensus-bench/src/consensus-arm-c.ts` — `armC(items, instance, passage, diffHtml)`.
- Create `integrations/consensus-bench/src/consensus-pilot.ts` — `runPilot(...)` → per-instance rows + metrics.
- Create `integrations/consensus-bench/scripts/pull-instance-diffs.mjs` — one-shot pull of the 14 instances' diffs → `__fixtures__/trump-instance-diffs.json`.
- Fixtures: `__fixtures__/co2-diff-single.json` (one real captured diff, for parser/arm tests), plus the pull output above.

No classes; functions + types; no throwing from pure functions.

---

## Task 1: Diff source (interface + fixture reader)

**Files:**
- Create: `integrations/consensus-bench/src/consensus-content.ts`
- Create: `integrations/consensus-bench/src/__fixtures__/co2-diff-single.json`
- Test: `integrations/consensus-bench/src/consensus-content.test.ts`

- [ ] **Step 1: Capture one real diff as a fixture**

Run (captures the #70 instance: revert 1358996228 undid bad edit 1358989658):

```bash
curl -s -A "daftari-research mihir.wagle@gmail.com" \
  "https://en.wikipedia.org/w/api.php?action=compare&fromrev=1358989658&torev=1358996228&format=json&prop=diff" \
  | jq '{revid:1358996228, parentid:1358989658, citedNum:70, governingNum:70, diffHtml:.compare["*"]}' \
  | jq -s '.' > integrations/consensus-bench/src/__fixtures__/co2-diff-single.json
```

Expected: a 1-element JSON array with a non-empty `diffHtml` containing `diff-addedline` and `consensus 70`.

- [ ] **Step 2: Write the failing test**

```typescript
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDiffsFromFile } from "./consensus-content.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url));

describe("loadDiffsFromFile", () => {
  test("loads revert diffs keyed with the fields the pilot needs", () => {
    const diffs = loadDiffsFromFile(FIXTURE);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ revid: 1358996228, parentid: 1358989658, citedNum: 70, governingNum: 70 });
    expect(diffs[0].diffHtml).toContain("diff-addedline");
    expect(diffs[0].diffHtml).toContain("consensus 70");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-content.test.ts`
Expected: FAIL — `loadDiffsFromFile` not defined.

- [ ] **Step 4: Write minimal implementation**

```typescript
// consensus-content — the diff layer for CO2. A RevertDiff pairs a CO1 revert
// instance with the Wikipedia compare HTML (compare["*"]) between the bad edit
// (parentid) and the revert (revid). DiffSource is the seam that lets tests
// inject fixtures while the one-shot pull script supplies real diffs.
import { readFileSync } from "node:fs";

export interface RevertDiff {
  revid: number;
  parentid: number;
  citedNum: number;
  governingNum: number;
  diffHtml: string;
}

export interface DiffSource {
  diffs(): RevertDiff[];
}

export function loadDiffsFromFile(path: string): RevertDiff[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => ({
    revid: Number(d.revid),
    parentid: Number(d.parentid),
    citedNum: Number(d.citedNum),
    governingNum: Number(d.governingNum),
    diffHtml: String(d.diffHtml ?? ""),
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-content.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add integrations/consensus-bench/src/consensus-content.ts integrations/consensus-bench/src/consensus-content.test.ts integrations/consensus-bench/src/__fixtures__/co2-diff-single.json
git commit -m "feat(consensus-bench): CO2 diff source + real single-diff fixture"
```

---

## Task 2: Passage parser (diff → stale/governing text + scorability)

**Files:**
- Create: `integrations/consensus-bench/src/consensus-passage.ts`
- Test: `integrations/consensus-bench/src/consensus-passage.test.ts`

The compare HTML has one `diff-deletedline` td (stale) and one `diff-addedline`
td (governing) for a clean single-hunk replacement. Scorable iff exactly one of
each. Multi-hunk, add-only, or remove-only → unscorable with a reason. Text is
normalized: strip HTML comments and tags, decode `&lt;`/`&gt;`/`&amp;`/`&quot;`,
collapse whitespace.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDiffsFromFile } from "./consensus-content.js";
import { parsePassage, markerPresent } from "./consensus-passage.js";

const REAL = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url)),
)[0];

const MULTI = `
<tr><td class="diff-deletedline"><div>old one</div></td><td class="diff-addedline"><div>new one</div></td></tr>
<tr><td class="diff-deletedline"><div>old two</div></td><td class="diff-addedline"><div>new two</div></td></tr>`;

const ADD_ONLY = `<tr><td class="diff-addedline"><div>brand new line</div></td></tr>`;

describe("parsePassage", () => {
  test("extracts governing (added) and stale (deleted) text from a single-hunk diff", () => {
    const p = parsePassage(REAL.diffHtml);
    expect(p.scorable).toBe(true);
    expect(p.governingText).toContain("47th president of the United States");
    expect(p.governingText).not.toContain("<!--"); // comments stripped
    expect(p.governingText).not.toContain("<div"); // tags stripped
    expect(p.staleText.length).toBeGreaterThan(0);
    expect(p.staleText).not.toBe(p.governingText);
  });

  test("flags a multi-hunk diff unscorable", () => {
    const p = parsePassage(MULTI);
    expect(p.scorable).toBe(false);
    expect(p.reason).toContain("multi-hunk");
  });

  test("flags an add-only diff unscorable", () => {
    const p = parsePassage(ADD_ONLY);
    expect(p.scorable).toBe(false);
    expect(p.reason).toContain("add-only");
  });
});

describe("markerPresent", () => {
  test("detects the inline consensus marker for the cited item", () => {
    expect(markerPresent(REAL.diffHtml, 70)).toBe(true);
    expect(markerPresent(REAL.diffHtml, 999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-passage.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-passage — turn a Wikipedia compare diff into the stale and governing
// passage text, and detect the inline consensus marker. Deterministic; the
// scorable gate keeps only clean single-hunk replacements (the spec's honest
// attrition).

const DELETED_RE = /<td[^>]*class="[^"]*diff-deletedline[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
const ADDED_RE = /<td[^>]*class="[^"]*diff-addedline[^"]*"[^>]*>([\s\S]*?)<\/td>/g;

export interface ParsedPassage {
  staleText: string;
  governingText: string;
  scorable: boolean;
  reason?: string;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Clean text for comparison: drop HTML comments and tags, decode entities,
// collapse whitespace. Comments are stripped twice (before and after decode) so
// an entity-encoded `&lt;!-- ... --&gt;` is removed too.
function cleanText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<[^>]*>/g, "");
  s = decode(s);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  return s.replace(/\s+/g, " ").trim();
}

export function parsePassage(diffHtml: string): ParsedPassage {
  const deleted = [...diffHtml.matchAll(DELETED_RE)].map((m) => m[1]);
  const added = [...diffHtml.matchAll(ADDED_RE)].map((m) => m[1]);
  if (deleted.length + added.length > 2 || deleted.length > 1 || added.length > 1) {
    return { staleText: "", governingText: "", scorable: false, reason: "multi-hunk" };
  }
  if (deleted.length === 0) return { staleText: "", governingText: "", scorable: false, reason: "add-only" };
  if (added.length === 0) return { staleText: "", governingText: "", scorable: false, reason: "remove-only" };
  return { staleText: cleanText(deleted[0]), governingText: cleanText(added[0]), scorable: true };
}

// The inline marker travels with a governed passage: "...president of the United
// States].<!-- DO NOT CHANGE preceding sentence ... [[Talk:...#C70|consensus 70]] -->".
// Match either "consensus N" or an anchor "#C N" anywhere in the (entity-encoded)
// diff window.
export function markerPresent(diffHtml: string, num: number): boolean {
  const re = new RegExp(`consensus\\s*#?\\s*${num}\\b|#C${num}\\b`, "i");
  return re.test(diffHtml);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-passage.test.ts`
Expected: PASS (4 tests). If `governingText` assertion misses, inspect the real fixture's `diff-addedline` content and adjust the `cleanText` entity list — do NOT loosen the single-hunk gate.

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-passage.ts integrations/consensus-bench/src/consensus-passage.test.ts
git commit -m "feat(consensus-bench): CO2 passage parser + consensus-marker detector"
```

---

## Task 3: Arm A (stream-recency)

**Files:**
- Create: `integrations/consensus-bench/src/consensus-arm-a.ts`
- Test: `integrations/consensus-bench/src/consensus-arm-a.test.ts`

Arm A is a memory that trusts the latest ingested edit. At the `before` snapshot
(bad edit latest) it returns the stale passage; at the `after` snapshot (revert
ingested) it returns the governing passage. The classifier compares an answer to
the two known texts.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "vitest";
import { armA, classifyAnswer } from "./consensus-arm-a.js";
import type { ParsedPassage } from "./consensus-passage.js";

const passage: ParsedPassage = { staleText: "stale value", governingText: "governing value", scorable: true };

describe("armA (stream-recency)", () => {
  test("returns the stale value at the bad-edit snapshot (fails)", () => {
    const a = armA(passage, "before");
    expect(a.answer).toBe("stale value");
    expect(classifyAnswer(a.answer, passage)).toBe("stale");
  });

  test("returns the governing value once the revert is ingested (fair-foil passes)", () => {
    const a = armA(passage, "after");
    expect(a.answer).toBe("governing value");
    expect(classifyAnswer(a.answer, passage)).toBe("governing");
  });
});

describe("classifyAnswer", () => {
  test("normalizes whitespace/case when matching", () => {
    expect(classifyAnswer("  Governing   VALUE ", passage)).toBe("governing");
  });
  test("returns 'other' for an unrelated answer", () => {
    expect(classifyAnswer("something else", passage)).toBe("other");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-arm-a.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-arm-a — the recency foil: a memory that trusts the latest ingested
// edit. Two snapshots per instance make the foil fair: it fails while the bad
// edit is latest ("before") and passes once it ingests the revert ("after").
import type { ParsedPassage } from "./consensus-passage.js";

export type Snapshot = "before" | "after";
export type Classification = "governing" | "stale" | "other";

export interface ArmAnswer {
  answer: string;
}

export function armA(passage: ParsedPassage, snapshot: Snapshot): ArmAnswer {
  return { answer: snapshot === "before" ? passage.staleText : passage.governingText };
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function classifyAnswer(answer: string, passage: ParsedPassage): Classification {
  const a = norm(answer);
  if (a === norm(passage.governingText)) return "governing";
  if (a === norm(passage.staleText)) return "stale";
  return "other";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-arm-a.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-arm-a.ts integrations/consensus-bench/src/consensus-arm-a.test.ts
git commit -m "feat(consensus-bench): CO2 Arm A stream-recency resolver + classifier"
```

---

## Task 4: Arm C (daftari)

**Files:**
- Create: `integrations/consensus-bench/src/consensus-arm-c.ts`
- Test: `integrations/consensus-bench/src/consensus-arm-c.test.ts`

Arm C resolves the cited item via `resolveCurrent` (oracle edge) and confirms the
governing passage with the inline `consensus N` marker (non-circular: the marker
is article-level evidence that #N governs this passage, not the revert's edit
summary). Returns governing on a clean, marker-confirmed, scorable instance;
**abstains** when the item is unresolved (dead-end / absent → the no-mint
property); **unscorable** when the passage isn't clean or the marker is absent.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { loadDiffsFromFile } from "./consensus-content.js";
import { parsePassage } from "./consensus-passage.js";
import { armC } from "./consensus-arm-c.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const REAL = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url)),
)[0];

describe("armC (daftari)", () => {
  test("returns governing on a resolved, marker-confirmed, scorable instance", () => {
    const passage = parsePassage(REAL.diffHtml);
    const c = armC(BOX, REAL, passage, REAL.diffHtml);
    expect(c.classification).toBe("governing");
    expect(c.answer).toBe(passage.governingText);
  });

  test("abstains when the cited item is unresolved (dead-end => no-mint)", () => {
    // Synthesize a dead-end instance: cite #4, which resolves to #15 (superseded,
    // no successor) => resolveCurrent unresolved => abstain.
    const passage = parsePassage(REAL.diffHtml);
    const deadEnd = { ...REAL, citedNum: 4, governingNum: 4 };
    const c = armC(BOX, deadEnd, passage, REAL.diffHtml);
    expect(c.classification).toBe("abstain");
  });

  test("unscorable when the marker for the cited item is absent", () => {
    const passage = parsePassage(REAL.diffHtml);
    // Cite an item that resolves but whose marker is not in this diff window.
    const noMarker = { ...REAL, citedNum: 30, governingNum: 30 };
    const c = armC(BOX, noMarker, passage, REAL.diffHtml);
    expect(c.classification).toBe("unscorable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-arm-c.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-arm-c — daftari's arm: resolve the cited item's supersession chain to
// the governing item (oracle edge), confirm the governed passage via the inline
// consensus marker, and foreground the governing text. Never mints: an unresolved
// item (dead-end / absent) abstains. The oracle edge makes a governing result
// near-tautological at the revert snapshot (accepted upper bound); the load-bearing
// signal is Arm A's failure and this abstention.
import type { ConsensusItem } from "./consensus-parse.js";
import { resolveCurrent } from "./consensus-resolve.js";
import { markerPresent, type ParsedPassage } from "./consensus-passage.js";
import type { RevertDiff } from "./consensus-content.js";

export type ArmCClassification = "governing" | "abstain" | "unscorable";

export interface ArmCResult {
  answer?: string;
  classification: ArmCClassification;
  reason?: string;
}

export function armC(
  items: ConsensusItem[],
  instance: Pick<RevertDiff, "citedNum">,
  passage: ParsedPassage,
  diffHtml: string,
): ArmCResult {
  const res = resolveCurrent(items, instance.citedNum);
  if (!res.resolved || res.item === undefined) {
    return { classification: "abstain", reason: "unresolved (dead-end/absent) — no-mint" };
  }
  if (!passage.scorable) return { classification: "unscorable", reason: passage.reason };
  // Non-circular localization: the governing item's marker must tag this passage.
  if (!markerPresent(diffHtml, res.item.num) && !markerPresent(diffHtml, instance.citedNum)) {
    return { classification: "unscorable", reason: "no inline consensus marker in diff window" };
  }
  return { answer: passage.governingText, classification: "governing" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-arm-c.test.ts`
Expected: PASS (3 tests). If the "no marker" test (#30) accidentally finds a `30` substring in the diff (e.g. a date), pick a different resolved item whose number does not appear in the fixture — inspect the diff and choose one.

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-arm-c.ts integrations/consensus-bench/src/consensus-arm-c.test.ts
git commit -m "feat(consensus-bench): CO2 Arm C daftari resolver (resolveCurrent + marker, abstain)"
```

---

## Task 5: Pilot runner + metrics

**Files:**
- Create: `integrations/consensus-bench/src/consensus-pilot.ts`
- Test: `integrations/consensus-bench/src/consensus-pilot.test.ts`

The runner pairs each CO1 instance with its diff, parses the passage, runs Arm A
(both snapshots) and Arm C, classifies, and aggregates the pilot metrics. No-mint
abstention is measured separately over the box-derived no-mint topics.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { loadDiffsFromFile } from "./consensus-content.js";
import { runPilot } from "./consensus-pilot.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const DIFFS = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/co2-diff-single.json", import.meta.url)),
);

describe("runPilot", () => {
  const result = runPilot(BOX, DIFFS);

  test("produces one row per diff with arm classifications", () => {
    expect(result.rows).toHaveLength(1);
    const r = result.rows[0];
    expect(r.armABefore).toBe("stale");      // recency fails at the bad edit
    expect(r.armAAfter).toBe("governing");   // fair foil: passes once corrected
    expect(r.armC).toBe("governing");        // daftari foregrounds governing
  });

  test("metrics summarize the kill gate", () => {
    const m = result.metrics;
    expect(m.scorable).toBe(1);
    expect(m.armAFailBefore).toBe(1);  // count classified 'stale' at before
    expect(m.armAPassAfter).toBe(1);
    expect(m.armCGoverning).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-pilot.test.ts`
Expected: FAIL — module not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-pilot — run Arm A (both snapshots) and Arm C over the stale-trap
// diffs, classify, and aggregate the pilot's kill-gate metrics.
import type { ConsensusItem } from "./consensus-parse.js";
import type { RevertDiff } from "./consensus-content.js";
import { parsePassage } from "./consensus-passage.js";
import { armA, classifyAnswer } from "./consensus-arm-a.js";
import { armC } from "./consensus-arm-c.js";

export interface PilotRow {
  revid: number;
  citedNum: number;
  scorable: boolean;
  reason?: string;
  armABefore?: string; // classification at the bad-edit snapshot
  armAAfter?: string;  // classification at the revert snapshot
  armC: string;        // Arm C classification
}

export interface PilotMetrics {
  total: number;
  scorable: number;
  armAFailBefore: number; // 'stale' at before (recency fails)
  armAPassAfter: number;  // 'governing' at after (fair foil)
  armCGoverning: number;
}

export interface PilotResult {
  rows: PilotRow[];
  metrics: PilotMetrics;
}

export function runPilot(items: ConsensusItem[], diffs: RevertDiff[]): PilotResult {
  const rows: PilotRow[] = diffs.map((d) => {
    const passage = parsePassage(d.diffHtml);
    const c = armC(items, d, passage, d.diffHtml);
    if (!passage.scorable) {
      return { revid: d.revid, citedNum: d.citedNum, scorable: false, reason: passage.reason, armC: c.classification };
    }
    return {
      revid: d.revid,
      citedNum: d.citedNum,
      scorable: true,
      armABefore: classifyAnswer(armA(passage, "before").answer, passage),
      armAAfter: classifyAnswer(armA(passage, "after").answer, passage),
      armC: c.classification,
    };
  });

  const scorable = rows.filter((r) => r.scorable);
  return {
    rows,
    metrics: {
      total: rows.length,
      scorable: scorable.length,
      armAFailBefore: scorable.filter((r) => r.armABefore === "stale").length,
      armAPassAfter: scorable.filter((r) => r.armAAfter === "governing").length,
      armCGoverning: scorable.filter((r) => r.armC === "governing").length,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-pilot.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full consensus-bench suite + tsc**

Run: `npx vitest run integrations/consensus-bench && (cd integrations/consensus-bench && npx tsc --noEmit)`
Expected: all green, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add integrations/consensus-bench/src/consensus-pilot.ts integrations/consensus-bench/src/consensus-pilot.test.ts
git commit -m "feat(consensus-bench): CO2 pilot runner + kill-gate metrics"
```

---

## Task 6: Real pull (14 instances) + run pilot + spot-check gate

**Files:**
- Create: `integrations/consensus-bench/scripts/pull-instance-diffs.mjs`
- Produces: `integrations/consensus-bench/src/__fixtures__/trump-instance-diffs.json` (committed)

- [ ] **Step 1: Write the pull script**

It reads the committed `trump-revisions.json` + box, rebuilds the instances with
CO1's `buildInstances`, filters to `governingNum ∈ [67,76]`, and for each fetches
the compare diff (parentid → revid). Use TS modules from the built output OR
duplicate the tiny filter inline; simplest is to import the source via a `.mjs`
that calls the API and writes `{revid,parentid,citedNum,governingNum,diffHtml}`.

```javascript
// pull-instance-diffs.mjs — one-shot: fetch the compare diff for each post-cutoff
// stale-trap instance and write the CO2 fixture. Run:
//   node integrations/consensus-bench/scripts/pull-instance-diffs.mjs
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://en.wikipedia.org/w/api.php";
const UA = "daftari-research mihir.wagle@gmail.com";

// Reuse the committed instance list: re-derive via the spot-check is overkill here;
// instead read the instances the test harness exposes. Simplest path: import the
// compiled helpers. If running from source, shell out to a tiny vitest inspector
// (see Step 2) to emit the instance list to JSON first, then read it here.
const instances = JSON.parse(readFileSync(new URL("./co2-instances.json", import.meta.url)));

async function diffOf(parentid, revid) {
  const params = new URLSearchParams({ action: "compare", fromrev: String(parentid), torev: String(revid), format: "json", prop: "diff" });
  const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
  const json = await res.json();
  return json.compare?.["*"] ?? "";
}

async function main() {
  const out = [];
  for (const i of instances) {
    out.push({ revid: i.revid, parentid: i.parentid, citedNum: i.citedNum, governingNum: i.governingNum, diffHtml: await diffOf(i.parentid, i.revid) });
  }
  writeFileSync(new URL("../src/__fixtures__/trump-instance-diffs.json", import.meta.url), JSON.stringify(out, null, 0));
  console.log(`wrote ${out.length} instance diffs`);
}
main();
```

- [ ] **Step 2: Emit the instance list (throwaway inspector)**

Add a temporary `src/_co2list.test.ts` that builds instances from the committed
fixtures, filters `governingNum ∈ [67,76]`, and `writeFileSync`s
`scripts/co2-instances.json` (`[{revid,parentid,citedNum,governingNum}]`). Use
`writeFileSync`, NOT `console.log` (vitest suppresses it). Run it, confirm 14
rows, then delete the inspector.

- [ ] **Step 3: Run the pull**

Run: `node integrations/consensus-bench/scripts/pull-instance-diffs.mjs`
Expected: `wrote 14 instance diffs`; `trump-instance-diffs.json` created.

- [ ] **Step 4: Run the pilot on real data (throwaway inspector)**

Add a temporary `src/_co2run.test.ts` that loads the box + `trump-instance-diffs.json`,
calls `runPilot`, and `writeFileSync`s the rows + metrics + per-row reasons to the
scratchpad. Inspect:
- `armAFailBefore` / `scorable` (the KILL gate — recency must fail on most scorable traps)
- `armAPassAfter` / `scorable` (foil fairness — must be high)
- `armCGoverning` / `scorable`
- unscorable count + reasons (attrition honesty)
Delete the inspector after.

- [ ] **Step 5: Spot-check gate (Mihir) — state the verdict**

Surface to Mihir against the spec's KILL / PROCEED / THIN gate:
- **KILL** if Arm A passes the traps at `before` (recency already governing).
- **THIN** if too few scorable (marker/diff attrition).
- **PROCEED** if Arm A fails before / passes after, Arm C governing, scorable N adequate.
Also run Arm C abstention over the 5 box-derived no-mint dead-ends (resolveCurrent
unresolved) and report it.

- [ ] **Step 6: Commit the fixture + script + results note**

```bash
git add integrations/consensus-bench/scripts/pull-instance-diffs.mjs integrations/consensus-bench/scripts/co2-instances.json integrations/consensus-bench/src/__fixtures__/trump-instance-diffs.json
git commit -m "chore(consensus-bench): CO2 real instance diffs + pull script"
```

Then write `docs/superpowers/results/2026-06-28-corpus-b-co2-pilot.md` with the
verdict and numbers, and commit.

---

## Definition of Done (CO2)

- Diff source, passage parser, Arm A, Arm C, pilot runner implemented + tested;
  full `integrations/consensus-bench` suite green, tsc clean.
- Real per-instance diff fixture pulled + committed for the 14 `governingNum ∈ [67,76]` instances.
- Pilot verdict (KILL / PROCEED / THIN) stated with numbers — Arm A fail@before,
  pass@after, Arm C governing, Arm C abstain on the 5 dead-ends, scorable count +
  unscorable reasons — not a hedge.
- Results note in `docs/superpowers/results/`, feeding [[project_corpus_b_consensus_bench]].

**Next (gated on PROCEED):** full 37-instance run, Arm B (LLM-synth + blind judge),
pre-cutoff perturbation, and the CB4 acquired-edge arm (the publishable contribution).
