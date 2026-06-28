# Corpus (B) CO1 — Acquisition + Ground-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, fixture-backed layer that turns Wikipedia article revision history into labeled supersession instances and QA buckets for the consensus-bench — the durable data artifact Arm A and the run consume.

**Architecture:** Pure Node/TypeScript, no network in tests. A thin `RevisionSource` interface lets unit tests inject hand-authored synthetic revision fixtures; a separate one-shot script does the real Wikipedia API pull and writes a real fixture. A deterministic parser extracts **consensus-citing reverts** (`rv per consensus #N`) from edit summaries; each is joined to the consensus box (via the already-shipped `resolveCurrent`) to produce a labeled instance with editor-provided alignment (no LLM aligner). A QA builder assembles the four buckets (current-decision / stale-restatement-trap / live-tension / no-mint). A human-readable dump supports Mihir's spot-check.

**Tech Stack:** TypeScript, vitest, Node `fetch` (script only), the existing `integrations/consensus-bench/` modules (`consensus-parse`, `consensus-resolve`, `consensus-topics`).

**Spec:** `docs/superpowers/specs/2026-06-27-corpus-b-consensus-bench-design.md`

**Out of scope (CO2+):** Arm A recency *resolver*, passage-localization (mapping a topic to article prose), stale-value content extraction, Arm B/LLM, the metric runner. CO1 stops at labeled instances + QA buckets + dump.

---

## File Structure

- Create `integrations/consensus-bench/src/consensus-revisions.ts` — `RevisionRecord` type, `RevisionSource` interface, `loadRevisionsFromFile` fixture reader.
- Create `integrations/consensus-bench/src/consensus-reverts.ts` — `RevertInstance` type, `parseConsensusReverts(revisions)`.
- Create `integrations/consensus-bench/src/consensus-instances.ts` — `buildInstances(items, revisions)` (join citing reverts → resolved box terminal).
- Create `integrations/consensus-bench/src/consensus-dump.ts` — `formatInstanceDump(instances)`.
- Create `integrations/consensus-bench/src/consensus-qa.ts` — `QaItem` type, `buildQa(items, topics, instances)`.
- Create `integrations/consensus-bench/scripts/pull-trump-revisions.mjs` — one-shot real API pull → fixture JSON.
- Create fixtures: `__fixtures__/revisions-synthetic.json` (hand-authored, for tests); `__fixtures__/trump-revisions.json` is produced by the script in Task 6.
- Test files mirror each module: `*.test.ts`.

All new code follows the existing style: no classes, functions + types, no throwing from pure functions (return values/empty arrays).

---

## Task 1: Revision types + fixture-backed source

**Files:**
- Create: `integrations/consensus-bench/src/consensus-revisions.ts`
- Create: `integrations/consensus-bench/src/__fixtures__/revisions-synthetic.json`
- Test: `integrations/consensus-bench/src/consensus-revisions.test.ts`

- [ ] **Step 1: Write the synthetic fixture**

Create `__fixtures__/revisions-synthetic.json` — a small, hand-authored set of revisions modeling the real shapes (a consensus-citing revert, a plain edit, a near-miss "per the consensus we reached" with no number, an anchor-wikilink citation, a multi-cite revert):

```json
[
  { "revid": 1001, "parentid": 1000, "timestamp": "2025-09-01T10:00:00Z", "user": "EditorA", "comment": "ce: tweak wording of lead" },
  { "revid": 1002, "parentid": 1001, "timestamp": "2025-09-02T11:00:00Z", "user": "EditorB", "comment": "manual rv per consensus 70" },
  { "revid": 1003, "parentid": 1002, "timestamp": "2025-09-03T12:00:00Z", "user": "EditorC", "comment": "partial rv per [[Talk:Donald Trump/Current consensus#C71|consensus 71]]" },
  { "revid": 1004, "parentid": 1003, "timestamp": "2025-09-04T13:00:00Z", "user": "EditorD", "comment": "restored per the consensus we reached on talk" },
  { "revid": 1005, "parentid": 1004, "timestamp": "2025-09-05T14:00:00Z", "user": "EditorE", "comment": "rv per consensus 30 and consensus 39" },
  { "revid": 1006, "parentid": 1005, "timestamp": "2025-09-06T15:00:00Z", "user": "EditorF", "comment": "Undid revision 1005 — see consensus 999" }
]
```

- [ ] **Step 2: Write the failing test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadRevisionsFromFile } from "./consensus-revisions.js";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/revisions-synthetic.json", import.meta.url));

describe("loadRevisionsFromFile", () => {
  test("loads revisions with the expected fields", () => {
    const revs = loadRevisionsFromFile(FIXTURE);
    expect(revs).toHaveLength(6);
    expect(revs[0]).toMatchObject({ revid: 1001, parentid: 1000, user: "EditorA" });
    expect(revs[0].comment).toContain("tweak wording");
    expect(typeof revs[0].timestamp).toBe("string");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-revisions.test.ts`
Expected: FAIL — `loadRevisionsFromFile` is not defined.

- [ ] **Step 4: Write minimal implementation**

```typescript
// consensus-revisions — the messy-stream data layer for corpus (B). A
// RevisionRecord is one Wikipedia article revision (the fields we need from the
// API's prop=revisions). RevisionSource is the seam that lets tests inject
// hand-authored fixtures while the one-shot pull script supplies real data.
import { readFileSync } from "node:fs";

export interface RevisionRecord {
  revid: number;
  parentid: number;
  timestamp: string; // ISO 8601, as returned by the API
  user: string;
  comment: string; // the edit summary — the labeling signal
}

export interface RevisionSource {
  revisions(): RevisionRecord[];
}

export function loadRevisionsFromFile(path: string): RevisionRecord[] {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => ({
    revid: Number(r.revid),
    parentid: Number(r.parentid ?? 0),
    timestamp: String(r.timestamp ?? ""),
    user: String(r.user ?? ""),
    comment: String(r.comment ?? ""),
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-revisions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add integrations/consensus-bench/src/consensus-revisions.ts integrations/consensus-bench/src/consensus-revisions.test.ts integrations/consensus-bench/src/__fixtures__/revisions-synthetic.json
git commit -m "feat(consensus-bench): revision types + fixture-backed source (CO1)"
```

---

## Task 2: Consensus-citing-revert parser

**Files:**
- Create: `integrations/consensus-bench/src/consensus-reverts.ts`
- Test: `integrations/consensus-bench/src/consensus-reverts.test.ts`

The parser is deterministic: a revision is a consensus-citing revert iff its
comment contains a revert verb AND a consensus citation. It extracts EVERY cited
number (a revert can cite several). The near-miss ("per the consensus we
reached", no number) must NOT match. This is the load-bearing precision risk in
the spec — the tests pin it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "vitest";
import { parseConsensusReverts } from "./consensus-reverts.js";
import type { RevisionRecord } from "./consensus-revisions.js";

function rev(revid: number, comment: string): RevisionRecord {
  return { revid, parentid: revid - 1, timestamp: "2025-09-01T00:00:00Z", user: "U", comment };
}

describe("parseConsensusReverts", () => {
  test("matches 'rv per consensus N' and extracts the number", () => {
    const out = parseConsensusReverts([rev(2, "manual rv per consensus 70")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ revid: 2, citedNum: 70 });
  });

  test("matches an anchor-wikilink citation (#C71)", () => {
    const out = parseConsensusReverts([
      rev(3, "partial rv per [[Talk:Donald Trump/Current consensus#C71|consensus 71]]"),
    ]);
    expect(out.map((i) => i.citedNum)).toEqual([71]);
  });

  test("emits one instance per cited number on a multi-cite revert", () => {
    const out = parseConsensusReverts([rev(5, "rv per consensus 30 and consensus 39")]);
    expect(out.map((i) => i.citedNum).sort((a, b) => a - b)).toEqual([30, 39]);
  });

  test("does NOT match a revert with no numbered citation (the near-miss)", () => {
    const out = parseConsensusReverts([rev(4, "restored per the consensus we reached on talk")]);
    expect(out).toEqual([]);
  });

  test("does NOT match a plain edit that is not a revert", () => {
    const out = parseConsensusReverts([rev(1, "ce: tweak wording of lead")]);
    expect(out).toEqual([]);
  });

  test("dedupes a number cited twice in one comment", () => {
    const out = parseConsensusReverts([rev(7, "rv per consensus 70, consensus 70 again")]);
    expect(out.map((i) => i.citedNum)).toEqual([70]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-reverts.test.ts`
Expected: FAIL — `parseConsensusReverts` is not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-reverts — the deterministic labeling signal. A consensus-citing
// revert (a revert verb + a citation of a consensus item) tells us, with
// editor-provided alignment, that a recent edit asserted a NON-governing value
// on topic #N. This is the contamination-safe alignment the probe established;
// no LLM aligner.
import type { RevisionRecord } from "./consensus-revisions.js";

export interface RevertInstance {
  revid: number;
  parentid: number;
  timestamp: string;
  user: string;
  comment: string;
  citedNum: number;
}

const REVERT_RE = /\b(rv|rvt|revert(?:ed)?|undid|undo|restore[ds]?)\b/i;
// Either "consensus #N" / "consensus N" or an anchor wikilink "#C<N>".
const CITE_RE = /consensus\s*#?\s*(\d+)|#C(\d+)\b/gi;

export function parseConsensusReverts(revisions: RevisionRecord[]): RevertInstance[] {
  const out: RevertInstance[] = [];
  for (const r of revisions) {
    if (!REVERT_RE.test(r.comment)) continue;
    const nums = new Set<number>();
    for (const m of r.comment.matchAll(CITE_RE)) {
      nums.add(Number(m[1] ?? m[2]));
    }
    for (const citedNum of nums) {
      out.push({
        revid: r.revid,
        parentid: r.parentid,
        timestamp: r.timestamp,
        user: r.user,
        comment: r.comment,
        citedNum,
      });
    }
  }
  return out;
}
```

Note: `CITE_RE` has the `g` flag, so reuse via `matchAll` is fine, but `REVERT_RE` must NOT have `g` (stateful `.test`). Keep them separate as written.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-reverts.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-reverts.ts integrations/consensus-bench/src/consensus-reverts.test.ts
git commit -m "feat(consensus-bench): consensus-citing-revert parser (CO1)"
```

---

## Task 3: Build labeled instances (join to the box)

**Files:**
- Create: `integrations/consensus-bench/src/consensus-instances.ts`
- Test: `integrations/consensus-bench/src/consensus-instances.test.ts`

Each citing revert is joined to the consensus box: resolve the cited item via the
already-shipped `resolveCurrent` to its governing terminal. A citation of an item
that does not exist in the box (e.g. `consensus 999`) is surfaced as
`resolved:false` with `governingNum: undefined` — a labeling anomaly for the
dump, never silently dropped.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { buildInstances } from "./consensus-instances.js";
import { loadRevisionsFromFile } from "./consensus-revisions.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const REVS = loadRevisionsFromFile(
  fileURLToPath(new URL("./__fixtures__/revisions-synthetic.json", import.meta.url)),
);

describe("buildInstances", () => {
  test("joins a citing revert to the governing terminal via resolveCurrent", () => {
    const inst = buildInstances(BOX, REVS);
    // cited 70 is active terminal of 11->17->50->70; governing = 70.
    const i70 = inst.find((x) => x.citedNum === 70);
    expect(i70?.resolved).toBe(true);
    expect(i70?.governingNum).toBe(70);
  });

  test("surfaces a citation of a non-existent item as an anomaly, not a drop", () => {
    const inst = buildInstances(BOX, REVS);
    const i999 = inst.find((x) => x.citedNum === 999);
    expect(i999).toBeDefined();
    expect(i999?.resolved).toBe(false);
    expect(i999?.governingNum).toBeUndefined();
  });

  test("resolves a cited item that is already active to itself", () => {
    const inst = buildInstances(BOX, REVS);
    const i71 = inst.find((x) => x.citedNum === 71); // #71 active
    expect(i71?.governingNum).toBe(71);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-instances.test.ts`
Expected: FAIL — `buildInstances` is not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-instances — join the stream's citing reverts to the box's governing
// truth. The cited item is resolved through resolveCurrent so an editor who
// cited a since-superseded item still lands on the current terminal. A cited
// item absent from the box is kept as an unresolved anomaly for spot-check.
import type { ConsensusItem } from "./consensus-parse.js";
import { resolveCurrent } from "./consensus-resolve.js";
import { parseConsensusReverts, type RevertInstance } from "./consensus-reverts.js";
import type { RevisionRecord } from "./consensus-revisions.js";

export interface LabeledInstance extends RevertInstance {
  resolved: boolean;
  governingNum?: number; // the active terminal the cited item resolves to
  chain: number[];
}

export function buildInstances(items: ConsensusItem[], revisions: RevisionRecord[]): LabeledInstance[] {
  const known = new Set(items.map((i) => i.num));
  return parseConsensusReverts(revisions).map((r) => {
    if (!known.has(r.citedNum)) {
      return { ...r, resolved: false, governingNum: undefined, chain: [] };
    }
    const res = resolveCurrent(items, r.citedNum);
    return {
      ...r,
      resolved: res.resolved,
      governingNum: res.resolved ? res.item?.num : undefined,
      chain: res.chain,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-instances.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-instances.ts integrations/consensus-bench/src/consensus-instances.test.ts
git commit -m "feat(consensus-bench): build labeled instances joined to the box (CO1)"
```

---

## Task 4: Human-readable instance dump

**Files:**
- Create: `integrations/consensus-bench/src/consensus-dump.ts`
- Test: `integrations/consensus-bench/src/consensus-dump.test.ts`

A deterministic, line-oriented dump for Mihir's spot-check (the spec's labeling
discipline). One line per instance; anomalies clearly flagged.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "vitest";
import { formatInstanceDump } from "./consensus-dump.js";
import type { LabeledInstance } from "./consensus-instances.js";

const inst: LabeledInstance[] = [
  { revid: 1002, parentid: 1001, timestamp: "2025-09-02T11:00:00Z", user: "EditorB", comment: "manual rv per consensus 70", citedNum: 70, resolved: true, governingNum: 70, chain: [70] },
  { revid: 1006, parentid: 1005, timestamp: "2025-09-06T15:00:00Z", user: "EditorF", comment: "Undid revision 1005 — see consensus 999", citedNum: 999, resolved: false, governingNum: undefined, chain: [] },
];

describe("formatInstanceDump", () => {
  test("renders one line per instance with cited->governing", () => {
    const dump = formatInstanceDump(inst);
    const lines = dump.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("rev 1002");
    expect(lines[0]).toContain("#70 -> #70");
  });

  test("flags an unresolved anomaly", () => {
    const dump = formatInstanceDump(inst);
    expect(dump).toContain("ANOMALY");
    expect(dump).toContain("#999");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-dump.test.ts`
Expected: FAIL — `formatInstanceDump` is not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-dump — line-oriented spot-check output for the labeling discipline.
import type { LabeledInstance } from "./consensus-instances.js";

export function formatInstanceDump(instances: LabeledInstance[]): string {
  return instances
    .map((i) => {
      const target = i.resolved ? `#${i.citedNum} -> #${i.governingNum}` : `ANOMALY #${i.citedNum} (unresolved)`;
      return `rev ${i.revid} ${i.timestamp} @${i.user} | ${target} | ${i.comment}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-dump.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-dump.ts integrations/consensus-bench/src/consensus-dump.test.ts
git commit -m "feat(consensus-bench): human-readable instance dump (CO1)"
```

---

## Task 5: QA-bucket build

**Files:**
- Create: `integrations/consensus-bench/src/consensus-qa.ts`
- Test: `integrations/consensus-bench/src/consensus-qa.test.ts`

Assemble the buckets from the box topics + labeled instances. Per the spec
(reviewer sharpening): the **no-mint** bucket is **box-derived** (dead-end /
unresolved topics), NOT from the revert parser. `stale-restatement-trap` is the
resolved instances. `current-decision` is settled active single-item topics NOT
cited by any instance.

**Live-tension is NOT auto-populated in CO1 (evidence-driven correction).** The
spec called active "no consensus" box items the primary deterministic source for
the keystone bucket. Inspecting the real fixture refutes this: the active items
matching `/no consensus/i` (#48, #56, #65) are *settled* decisions that record
"no consensus on specific wording, **but** the status quo is {...}" — each HAS a
governing value, the opposite of a live tension. The box, by nature, holds only
*settled* items; a genuine live tension lives in the open stream (unresolved RfC
/ sustained edit-war with no consensus-citing stabilization), not the box. So
CO1 leaves `live-tension` empty and *guards against mis-tagging* settled
"no consensus" items as tensions. The keystone bucket is deferred to a later
best-effort stream pass (its own task/plan). The `QaBucket` type keeps the
`live-tension` member for that future work.

- [ ] **Step 1: Write the failing test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConsensus } from "./consensus-parse.js";
import { groupTopics } from "./consensus-topics.js";
import { buildInstances } from "./consensus-instances.js";
import { loadRevisionsFromFile } from "./consensus-revisions.js";
import { buildQa } from "./consensus-qa.js";

const BOX = parseConsensus(
  readFileSync(fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)), "utf8"),
);
const REVS = loadRevisionsFromFile(
  fileURLToPath(new URL("./__fixtures__/revisions-synthetic.json", import.meta.url)),
);

describe("buildQa", () => {
  const qa = buildQa(BOX, groupTopics(BOX), buildInstances(BOX, REVS));

  test("stale-restatement-trap: one QA per resolved instance, gold = governing terminal", () => {
    const trap = qa.filter((q) => q.bucket === "stale-restatement-trap");
    const t70 = trap.find((q) => q.governingNum === 70);
    expect(t70).toBeDefined();
    expect(t70?.staleCitedNum).toBe(70);
  });

  test("no-mint is box-derived: the dead-end {4,15} topic produces a no-mint QA, gold = not-present", () => {
    const noMint = qa.filter((q) => q.bucket === "no-mint");
    const deadEnd = noMint.find((q) => q.topicItems?.includes(4));
    expect(deadEnd).toBeDefined();
    expect(deadEnd?.gold).toBe("not-present");
  });

  test("CO1 does NOT auto-populate live-tension; settled 'no consensus' items are never mis-tagged", () => {
    // The box holds only settled items. #48/#56/#65 say "no consensus on wording
    // BUT the status quo is {...}" — settled decisions with a governing value, not
    // tensions. CO1 leaves the keystone bucket empty (deferred to a stream pass)
    // and must never tag these as live-tension.
    const tension = qa.filter((q) => q.bucket === "live-tension");
    expect(tension).toEqual([]);
    expect(qa.find((q) => q.topicItems?.includes(48) && q.bucket === "live-tension")).toBeUndefined();
  });

  test("current-decision: a settled active single-item topic not cited by any instance", () => {
    const baseline = qa.filter((q) => q.bucket === "current-decision");
    expect(baseline.length).toBeGreaterThan(0);
    for (const q of baseline) expect(typeof q.governingNum).toBe("number");
  });

  test("every QA has a bucket and a stable id", () => {
    expect(qa.length).toBeGreaterThan(0);
    const ids = qa.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run integrations/consensus-bench/src/consensus-qa.test.ts`
Expected: FAIL — `buildQa` is not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// consensus-qa — assemble the bench buckets from box topics + labeled instances.
// Bucket provenance:
//   stale-restatement-trap : resolved citing-revert instances (stream-derived)
//   no-mint                : unresolved topics — dead-end chains ({4,15}) AND lone
//                            superseded/canceled items with no successor (BOX-derived,
//                            not the parser); all are genuine no-current-value cases
//   current-decision       : settled active single-item topics not cited by any instance
//   live-tension           : NOT populated in CO1 — the box holds only settled items;
//                            the keystone bucket is deferred to a stream pass. The type
//                            keeps the member for that future work.
import type { ConsensusItem } from "./consensus-parse.js";
import type { Topic } from "./consensus-topics.js";
import type { LabeledInstance } from "./consensus-instances.js";

export type QaBucket = "current-decision" | "stale-restatement-trap" | "live-tension" | "no-mint";

export interface QaItem {
  id: string;
  bucket: QaBucket;
  governingNum?: number; // gold item for resolvable buckets
  gold?: "not-present" | "contested"; // gold for no-mint / live-tension
  staleCitedNum?: number; // the trap's cited item (stale-restatement-trap)
  topicItems?: number[]; // the component, for box-derived buckets
}

export function buildQa(items: ConsensusItem[], topics: Topic[], instances: LabeledInstance[]): QaItem[] {
  const qa: QaItem[] = [];

  // stale-restatement-trap — one per resolved instance.
  for (const inst of instances) {
    if (!inst.resolved || inst.governingNum === undefined) continue;
    qa.push({
      id: `trap:${inst.revid}:${inst.citedNum}`,
      bucket: "stale-restatement-trap",
      governingNum: inst.governingNum,
      staleCitedNum: inst.citedNum,
    });
  }

  // no-mint — box-derived: topics with no single active terminal (dead-ends).
  for (const t of topics) {
    if (!t.resolved && t.current.length === 0) {
      qa.push({ id: `nomint:${t.id}`, bucket: "no-mint", gold: "not-present", topicItems: t.items });
    }
  }

  // live-tension — intentionally NOT populated in CO1. The box holds only settled
  // items (including "no consensus on wording but status-quo is X", which HAS a
  // governing value). A genuine live tension lives in the open stream, not the box;
  // the keystone bucket is deferred to a later best-effort stream pass.

  // current-decision — settled active single-item topics not cited by any instance.
  const cited = new Set(instances.map((i) => i.governingNum).filter((n): n is number => n !== undefined));
  for (const t of topics) {
    if (t.resolved && t.items.length === 1) {
      const num = t.current[0];
      if (cited.has(num)) continue;
      qa.push({ id: `current:${num}`, bucket: "current-decision", governingNum: num });
    }
  }

  return qa;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run integrations/consensus-bench/src/consensus-qa.test.ts`
Expected: PASS (5 tests). The live-tension test asserts the bucket is EMPTY in CO1 (deferred to a later stream pass) and that settled "no consensus" items are never mis-tagged.

- [ ] **Step 5: Run the full consensus-bench suite + tsc**

Run: `npx vitest run integrations/consensus-bench && (cd integrations/consensus-bench && npx tsc --noEmit)`
Expected: all green, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add integrations/consensus-bench/src/consensus-qa.ts integrations/consensus-bench/src/consensus-qa.test.ts
git commit -m "feat(consensus-bench): QA-bucket build — 4 buckets, box/stream provenance (CO1)"
```

---

## Task 6: Real Wikipedia pull + spot-check

**Files:**
- Create: `integrations/consensus-bench/scripts/pull-trump-revisions.mjs`
- Produces: `integrations/consensus-bench/src/__fixtures__/trump-revisions.json` (committed) and a spot-check dump (scratch, not committed).

This is a one-shot network script (NOT part of the test suite). It pulls the
Donald Trump article revision history (edit summaries) via the Wikipedia API,
writes the real fixture, and prints the instance dump for Mihir's spot-check —
the labeling-precision gate from the spec (kill: >20% of citing reverts need
hand-resolution).

- [ ] **Step 1: Write the pull script**

```javascript
// pull-trump-revisions.mjs — one-shot: pull article revision summaries via the
// Wikipedia API (unthrottled, no auth; descriptive User-Agent) and write the
// real fixture. Run manually: `node integrations/consensus-bench/scripts/pull-trump-revisions.mjs`
import { writeFileSync } from "node:fs";

const API = "https://en.wikipedia.org/w/api.php";
const UA = "daftari-research mihir.wagle@gmail.com";
const TITLE = "Donald Trump";
const MAX = 5000; // cap; paginate via rvcontinue

async function main() {
  const out = [];
  let cont = undefined;
  while (out.length < MAX) {
    const params = new URLSearchParams({
      action: "query", format: "json", prop: "revisions", titles: TITLE,
      rvprop: "ids|timestamp|user|comment", rvlimit: "500", rvdir: "older",
    });
    if (cont) params.set("rvcontinue", cont);
    const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
    const json = await res.json();
    const pages = json.query?.pages ?? {};
    const page = Object.values(pages)[0];
    for (const r of page?.revisions ?? []) {
      out.push({ revid: r.revid, parentid: r.parentid, timestamp: r.timestamp, user: r.user ?? "", comment: r.comment ?? "" });
    }
    cont = json.continue?.rvcontinue;
    if (!cont) break;
  }
  const path = new URL("../src/__fixtures__/trump-revisions.json", import.meta.url);
  writeFileSync(path, JSON.stringify(out, null, 0));
  console.log(`wrote ${out.length} revisions`);
}
main();
```

- [ ] **Step 2: Run the pull**

Run: `node integrations/consensus-bench/scripts/pull-trump-revisions.mjs`
Expected: `wrote N revisions` (N up to 5000); `trump-revisions.json` created.

- [ ] **Step 3: Print the spot-check dump**

Add a tiny throwaway test (or a `--inspect` test like prior sessions used) that
loads the real fixture, runs `buildInstances` over the committed box, and writes
`formatInstanceDump` to a file. **Use `writeFileSync`, not `console.log`** —
vitest suppresses console output in this repo's config, so a console-based
inspector appears to produce nothing. Inspect: how many citing reverts? how many
ANOMALY lines (need hand-resolution)? Compute the anomaly fraction. Delete the
throwaway test after inspecting.

- [ ] **Step 4: Spot-check gate (Mihir)**

Surface to Mihir: the instance dump + the anomaly fraction. **Kill check:** if
>20% of citing reverts are anomalies / need hand-resolution, stop and revisit the
parser (the labelability claim weakens). Otherwise proceed. Report the count of
post-cutoff (#67–76-citing) instances — that is the pilot's usable N.

- [ ] **Step 5: Commit the real fixture**

```bash
git add integrations/consensus-bench/scripts/pull-trump-revisions.mjs integrations/consensus-bench/src/__fixtures__/trump-revisions.json
git commit -m "chore(consensus-bench): real Trump revision fixture + pull script (CO1)"
```

---

## Definition of Done (CO1)

- Revision source, revert parser, instance builder, dump, and QA builder all
  implemented + tested; full `integrations/consensus-bench` suite green, tsc clean.
- Real Trump revision fixture pulled + committed; instance dump produced.
- Anomaly fraction reported and under the 20% kill threshold (or surfaced if not).
- Post-cutoff usable N (instances citing #67–76 chains) reported — the input to
  the CO2 pilot.
- No network in the test suite; the real pull is an isolated script.
- Three buckets populated (current-decision, stale-restatement-trap, no-mint);
  live-tension intentionally empty with the mis-tag guard in place.

**Next (separate plans):**
- CO2 — Arm A recency resolver (passage-localization is its first question, now
  informed by the real instance data) + the pilot run on #67–76.
- Keystone (live-tension) source — a best-effort stream pass (open-RfC / sustained
  edit-war detection). Deferred because the box yields no valid tensions; **this
  corrects the spec's "active 'no consensus' box item is the primary deterministic
  source" claim**, which the real fixture refuted.
