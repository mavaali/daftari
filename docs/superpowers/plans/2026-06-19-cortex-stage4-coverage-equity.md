# Cortex Loop Stage 4 — Coverage/Equity Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only coverage/equity monitor to `vault_lint` that surfaces the cortex loop's four budget-drift ratchets (strength-distribution drift, backstop-overdue, action-mix cheap-link creep, direction-resolution).

**Architecture:** One new pure module `src/curation/coverage.ts` computes a `CoverageEquitySummary` from injected `docs` + `edges` + journal rows (no I/O of its own). `runLint` reads the inputs and calls it, adding `coverageEquity` to `LintReport`. The `vault_lint` tool passes it through. B is a **monitor, never a target** — a guard test forbids any `src/consolidate/` module from importing it.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), vitest, `Result<T,E>` returns (no throws from handlers), functions-and-types (no classes).

**Spec:** `docs/superpowers/specs/2026-06-19-cortex-stage4-coverage-equity-design.md`

---

## Conventions (read once)

- Imports use the `.js` suffix (NodeNext): `import { listEdges } from "./edges.js"`.
- `Result<T>`: `import { ok, err, type Result } from "../frontmatter/types.js"` (shape: `{ok:true,value} | {ok:false,error}`).
- Tests live in `test/curation/coverage.test.ts`, mirror `src/`. Vitest: `import { describe, it, expect } from "vitest"`.
- Run a single test file: `npx vitest run test/curation/coverage.test.ts`.
- Full build/lint gate before PR: `npm run build && npm test`.
- **Branch:** do all work on `feat/cortex-loop-stage4` (created in Task 0). Commit-bearing — run the session in **ask-permissions** (the `uatu` hook blocks commits in don't-ask mode).
- The pure function takes data in; it never reads disk. Only `runLint` (Task 7) reads.

### Reference types (already in the codebase — do not redefine)

```ts
// src/curation/edges.ts
interface DerivesFromEdge {
  fromPath: string; toPath: string; strength: number; kSurvived: number;
  firstObserved: string; lastRederived: string;
  status: "candidate" | "trigger-bearing" | "revoked";
  directionVerdict: "directed" | "symmetric";
  observations: number; contestedAt: string | null; contestReason: string | null;
}
const EDGE_K_CAP = 5; const EDGE_HALF_LIFE_DAYS = 90; const EDGE_TRIGGER_STRENGTH = 0.5;
async function listEdges(vaultRoot, filter?, now?): Promise<Result<DerivesFromEdge[]>>;

// src/curation/vault-docs.ts
interface LoadedDoc { path: string; frontmatter: Frontmatter; content: string; /* + validation */ }

// src/consolidate/clocks.ts
function decayBackstopDue(edges: DerivesFromEdge[], now: Date): DueEdge[]; // DueEdge.reason: "backstop"|"decay"|"event"; skips revoked + symmetric

// src/curation/tension-blast.ts
function buildReverseSourceMap(docs: LoadedDoc[]): Map<string, Set<string>>;
function buildReverseLinkMap(docs: LoadedDoc[]): Map<string, Set<string>>;
function computeBlast({ seeds, reverseSource, reverseLink }): { downstream: string[]; /* ... */ };

// src/curation/shadow.ts
interface ShadowActionRecord { action: string; decision?: "admitted"|"gated"; at: string; /* ... */ }
async function listShadowActions(vaultRoot): Promise<Result<ShadowActionRecord[]>>;

// src/curation/staged-actions.ts
const STAGED_ACTION_TYPES = [...] // promote/deprecate/supersede/merge/confidence-up
interface StagedAction { actionType: string; /* ... */ }
async function listStagedActions(vaultRoot, status?): Promise<Result<StagedAction[]>>;

// src/consolidate/constants.ts
const CONSOLIDATE_MAX_INTERVAL_DAYS = 90;
```

---

## Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
cd /Users/mihirwagle/projects/daftari
git checkout main && git pull --ff-only
git checkout -b feat/cortex-loop-stage4
```

- [ ] **Step 2: Confirm clean baseline**

Run: `npm run build && npx vitest run test/curation/lint.test.ts`
Expected: build clean, lint tests pass. (Ignore the pre-existing untracked `scripts/pools/**`, `tests/**` experimental files — leave them alone.)

---

## Task 1: Module scaffold + stats helper + empty-vault zeros

**Files:**
- Create: `src/curation/coverage.ts`
- Test: `test/curation/coverage.test.ts`

- [ ] **Step 1: Write the failing test (empty inputs → all zeros)**

```ts
// test/curation/coverage.test.ts
import { describe, it, expect } from "vitest";
import { coverageEquitySummary } from "../../src/curation/coverage.js";

const NOW = new Date("2026-06-19T00:00:00Z");

describe("coverageEquitySummary", () => {
  it("returns all-zero summary for an empty vault", () => {
    const r = coverageEquitySummary({ docs: [], edges: [], shadowRecords: [], stagedActions: [], now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;
    expect(s.strengthDrift.core.count).toBe(0);
    expect(s.strengthDrift.periphery.count).toBe(0);
    expect(s.strengthDrift.coreMinusPeripheryMedian).toBe(0);
    expect(s.strengthDrift.belowTriggerCount).toBe(0);
    expect(s.backstopOverdue.count).toBe(0);
    expect(s.actionMix.total).toBe(0);
    expect(s.actionMix.cheapLinkFraction).toBe(0);
    expect(s.directionResolution.directed).toBe(0);
    expect(s.directionResolution.symmetric).toBe(0);
    expect(s.directionResolution.unresolvedFraction).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/coverage.test.ts`
Expected: FAIL — cannot find module `coverage.js` / `coverageEquitySummary` is not a function.

- [ ] **Step 3: Write the module scaffold + stats helper**

```ts
// src/curation/coverage.ts
// Stage 4 — coverage/equity instrumentation (spec §6.2). PURE: callers inject
// docs/edges/journal rows; this module reads no disk. B is a MONITOR, NEVER a
// TARGET — nothing in src/consolidate/ may import this (guard test in coverage.test).
import { posix } from "node:path";
import { ok, type Result } from "../frontmatter/types.js";
import type { LoadedDoc } from "./vault-docs.js";
import { type DerivesFromEdge, EDGE_TRIGGER_STRENGTH } from "./edges.js";
import { buildReverseSourceMap, buildReverseLinkMap, computeBlast } from "./tension-blast.js";
import { decayBackstopDue } from "../consolidate/clocks.js";
import { CONSOLIDATE_MAX_INTERVAL_DAYS } from "../consolidate/constants.js";
import type { ShadowActionRecord } from "./shadow.js";
import type { StagedAction } from "./staged-actions.js";

// Same canon() the consolidate modules use (path-aliasing bug class): an alias
// like `x/../x/a.md` must resolve to the loader's canonical relPath key.
function canon(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "");
}

export interface StrengthGroupStats {
  count: number; mean: number; median: number; p10: number; p90: number; variance: number;
}

export interface CoverageEquitySummary {
  generatedAt: string;
  strengthDrift: {
    core: StrengthGroupStats;        // blast > 0
    periphery: StrengthGroupStats;   // blast == 0
    coreMinusPeripheryMedian: number;
    belowTriggerCount: number;       // aged strength < EDGE_TRIGGER_STRENGTH (0.5)
  };
  backstopOverdue: {
    count: number;
    stalest: Array<{ fromPath: string; toPath: string; daysOverdue: number }>;
  };
  actionMix: {
    counts: Record<string, number>;
    cheapLinkFraction: number;       // edge-observe / total
    total: number;
  };
  directionResolution: {
    directed: number; symmetric: number;
    unresolvedFraction: number;      // symmetric / non-revoked
  };
}

export interface CoverageInput {
  docs: LoadedDoc[];
  edges: DerivesFromEdge[];
  shadowRecords: ShadowActionRecord[];
  stagedActions: StagedAction[];
  now: Date;
}

// --- pure stats over a number[] -------------------------------------------
const EMPTY_STATS: StrengthGroupStats = {
  count: 0, mean: 0, median: 0, p10: 0, p90: 0, variance: 0,
};

// Nearest-rank percentile on the sorted array; p in [0,1]. Deterministic and
// dependency-free (we don't need interpolation precision for a monitor).
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(p * (sortedAsc.length - 1))));
  return sortedAsc[idx] as number;
}

function stats(values: number[]): StrengthGroupStats {
  if (values.length === 0) return { ...EMPTY_STATS };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n; // population variance
  return {
    count: n,
    mean,
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
    variance,
  };
}

export function coverageEquitySummary(input: CoverageInput): Result<CoverageEquitySummary, Error> {
  const { now } = input;
  return ok({
    generatedAt: now.toISOString(),
    strengthDrift: {
      core: { ...EMPTY_STATS },
      periphery: { ...EMPTY_STATS },
      coreMinusPeripheryMedian: 0,
      belowTriggerCount: 0,
    },
    backstopOverdue: { count: 0, stalest: [] },
    actionMix: { counts: {}, cheapLinkFraction: 0, total: 0 },
    directionResolution: { directed: 0, symmetric: 0, unresolvedFraction: 0 },
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/coverage.ts test/curation/coverage.test.ts
git commit -m "feat(coverage): Stage 4 module scaffold + empty-vault zeros"
```

---

## Task 2: Strength-distribution drift (blast==0 split)

**Files:**
- Modify: `src/curation/coverage.ts`
- Test: `test/curation/coverage.test.ts`

Helper to build edge fixtures and a tiny doc set. The blast is the **link-graph
downstream reach** of the edge endpoints over the reverse maps built from `docs` —
identical to the envelope (`admit.ts:193-195`) minus its `+1` footprint. An edge whose
endpoints have zero downstream reach is periphery; reach > 0 is core.

- [ ] **Step 1: Write the failing tests**

```ts
// add to test/curation/coverage.test.ts
import type { DerivesFromEdge } from "../../src/curation/edges.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";

function edge(p: Partial<DerivesFromEdge> & { fromPath: string; toPath: string }): DerivesFromEdge {
  return {
    strength: 1, kSurvived: 1, firstObserved: "2026-01-01T00:00:00Z",
    lastRederived: "2026-06-19T00:00:00Z", status: "trigger-bearing",
    directionVerdict: "directed", observations: 1, contestedAt: null, contestReason: null,
    ...p,
  };
}
// A doc with a wikilink body so the reverse maps have downstream structure.
function doc(path: string, body = ""): LoadedDoc {
  // Minimal LoadedDoc — only path + content are read by the reverse-map builders.
  return { path, content: body, frontmatter: {} as any } as LoadedDoc;
}

// SHARED fixture doc set (also used by Task 6's alias test — keep them in sync,
// per the plan-reviewer's drift caution). CRITICAL: computeBlast EXCLUDES the
// seed endpoints from `downstream`. The monitor's blast drops the envelope's `+1`
// footprint, so an edge is "core" (downstream.length > 0) ONLY if some doc that is
// NOT one of its two endpoints links to / sources an endpoint. Hence `consumer.md`:
// it links [[hub]] and is not an endpoint of the core edge, so hub.md's downstream
// is non-empty. A 2-node fixture (only the endpoints) is ALWAYS periphery.
function blastDocs(): LoadedDoc[] {
  return [
    doc("consumer.md", "see [[hub]]"), // non-seed doc downstream of hub.md
    doc("hub.md"),
    doc("dependent.md"),
    doc("lonely.md"),
    doc("orphan.md"),
  ];
}

describe("strength-distribution drift", () => {
  it("splits edges into core (blast>0) and periphery (blast==0)", () => {
    const docs = blastDocs();
    const edges = [
      // seeds {hub.md, dependent.md}; consumer.md (non-seed) links hub → downstream≥1 → CORE
      edge({ fromPath: "hub.md", toPath: "dependent.md", strength: 4 }),
      // lonely.md / orphan.md have no inbound links → downstream 0 → PERIPHERY
      edge({ fromPath: "lonely.md", toPath: "orphan.md", strength: 1 }),
    ];
    const r = coverageEquitySummary({ docs, edges, shadowRecords: [], stagedActions: [], now: NOW });
    expect(r.ok && r.value.strengthDrift.core.count).toBe(1);
    expect(r.ok && r.value.strengthDrift.periphery.count).toBe(1);
    expect(r.ok && r.value.strengthDrift.coreMinusPeripheryMedian).toBeCloseTo(3, 5);
    // cheap mis-bucketing regression guard: every live edge lands in exactly one group
    expect(r.ok && r.value.strengthDrift.core.count + r.value.strengthDrift.periphery.count).toBe(2);
  });

  it("excludes revoked edges from the distribution", () => {
    const docs = [doc("a.md"), doc("b.md")];
    const edges = [edge({ fromPath: "a.md", toPath: "b.md", strength: 0, status: "revoked" })];
    const r = coverageEquitySummary({ docs, edges, shadowRecords: [], stagedActions: [], now: NOW });
    expect(r.ok && r.value.strengthDrift.core.count).toBe(0);
    expect(r.ok && r.value.strengthDrift.periphery.count).toBe(0);
  });

  it("counts edges decayed below EDGE_TRIGGER_STRENGTH", () => {
    const docs = [doc("a.md"), doc("b.md"), doc("c.md"), doc("d.md")];
    const edges = [
      edge({ fromPath: "a.md", toPath: "b.md", strength: 0.3 }), // below 0.5
      edge({ fromPath: "c.md", toPath: "d.md", strength: 0.9 }), // above
    ];
    const r = coverageEquitySummary({ docs, edges, shadowRecords: [], stagedActions: [], now: NOW });
    expect(r.ok && r.value.strengthDrift.belowTriggerCount).toBe(1);
  });
});
```

> **Why the fixture has a third doc (read before changing it):** `computeBlast`
> seeds the two endpoints and **excludes them from `downstream`**
> (`tension-blast.ts:144-176`). The monitor uses `downstream.length` directly (no
> `+1`), so an edge is core ONLY when a doc *other than its two endpoints* links to /
> sources an endpoint. That is exactly what `consumer.md` provides. Do NOT try to fix
> a red test here by changing the `[[hub]]` link form — `resolveLink("hub", …)`
> already resolves to `hub.md` fine; the requirement is a NON-SEED downstream doc.
> Tune the fixture (keep a non-endpoint linker), never the assertion.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/coverage.test.ts -t "strength-distribution"`
Expected: FAIL — counts are 0 (scaffold returns empty stats).

- [ ] **Step 3: Implement the strength-drift block**

Replace the `strengthDrift` literal in `coverageEquitySummary` with computed values:

```ts
// inside coverageEquitySummary, before the return:
const reverseSource = buildReverseSourceMap(input.docs);
const reverseLink = buildReverseLinkMap(input.docs);

const live = input.edges.filter((e) => e.status !== "revoked");
const coreStrengths: number[] = [];
const periStrengths: number[] = [];
let belowTriggerCount = 0;
for (const e of live) {
  const blast = computeBlast({
    seeds: [canon(e.fromPath), canon(e.toPath)],
    reverseSource,
    reverseLink,
  }).downstream.length;
  (blast > 0 ? coreStrengths : periStrengths).push(e.strength);
  if (e.strength < EDGE_TRIGGER_STRENGTH) belowTriggerCount += 1;
}
const core = stats(coreStrengths);
const periphery = stats(periStrengths);
const strengthDrift = {
  core,
  periphery,
  coreMinusPeripheryMedian: core.median - periphery.median,
  belowTriggerCount,
};
```

Then use `strengthDrift` in the returned object (replace the inline literal).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/coverage.test.ts`
Expected: PASS (all, including Task 1's empty test). If the blast-split test fails on counts, fix the **fixture** per the verify note, not the implementation.

- [ ] **Step 5: Commit**

```bash
git add src/curation/coverage.ts test/curation/coverage.test.ts
git commit -m "feat(coverage): strength-distribution drift with blast==0 core/periphery split"
```

---

## Task 3: Backstop-overdue (standing)

**Files:**
- Modify: `src/curation/coverage.ts`
- Test: `test/curation/coverage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("backstop-overdue", () => {
  it("counts edges past the 90-day max interval; boundary is inclusive", () => {
    const docs = [doc("a.md"), doc("b.md"), doc("c.md"), doc("d.md")];
    const at89 = new Date(NOW.getTime() - 89 * 86_400_000).toISOString();
    const at90 = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const edges = [
      edge({ fromPath: "a.md", toPath: "b.md", lastRederived: at90 }), // overdue
      edge({ fromPath: "c.md", toPath: "d.md", lastRederived: at89 }), // not overdue
    ];
    const r = coverageEquitySummary({ docs, edges, shadowRecords: [], stagedActions: [], now: NOW });
    expect(r.ok && r.value.backstopOverdue.count).toBe(1);
    expect(r.ok && r.value.backstopOverdue.stalest[0]?.fromPath).toBe("a.md");
    expect(r.ok && r.value.backstopOverdue.stalest[0]?.daysOverdue).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/coverage.test.ts -t "backstop-overdue"`
Expected: FAIL — count 0.

- [ ] **Step 3: Implement backstop-overdue from decayBackstopDue**

```ts
const overdue = decayBackstopDue(input.edges, now).filter((d) => d.reason === "backstop");
const daysSince = (iso: string) =>
  Math.max(0, (now.getTime() - new Date(iso).getTime()) / 86_400_000);
// daysOverdue = days past the max interval. We need lastRederived per overdue
// edge; look it up from the source edges by (from,to).
const lastByKey = new Map(input.edges.map((e) => [`${e.fromPath}\n${e.toPath}`, e.lastRederived]));
const overdueDetailed = overdue
  .map((d) => {
    const last = lastByKey.get(`${d.fromPath}\n${d.toPath}`) ?? now.toISOString();
    return {
      fromPath: d.fromPath,
      toPath: d.toPath,
      daysOverdue: Math.max(0, daysSince(last) - CONSOLIDATE_MAX_INTERVAL_DAYS),
    };
  })
  .sort((a, b) => b.daysOverdue - a.daysOverdue);
const backstopOverdue = {
  count: overdueDetailed.length,
  stalest: overdueDetailed.slice(0, 5),
};
```

Use `backstopOverdue` in the return (replace the inline literal).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/coverage.ts test/curation/coverage.test.ts
git commit -m "feat(coverage): standing backstop-overdue metric"
```

---

## Task 4: Action-mix drift (cheap-link fraction)

**Files:**
- Modify: `src/curation/coverage.ts`
- Test: `test/curation/coverage.test.ts`

Denominator (pinned in spec §5.3): count **edge-op rows** (`action` ∈
{`edge-observe`, `edge-contest`}) **plus** staged-action rows. **Exclude** the shadow
journal's doc-write calibration rows (their `action` is a doc tool like `write`, with
no `decision`). Cheap-link fraction = `edge-observe / total`.

- [ ] **Step 1: Write the failing tests**

```ts
import type { ShadowActionRecord } from "../../src/curation/shadow.js";
import type { StagedAction } from "../../src/curation/staged-actions.js";

function shadowRow(action: string, decision?: "admitted" | "gated"): ShadowActionRecord {
  return {
    at: "2026-06-19T00:00:00Z", tool: "t", action, target_path: "x.md", agent: "a",
    i_base: 0, blast: 1, impact: 0, budget: 1, spent_before: 0, would_gate: false,
    commit_message: "m", ...(decision ? { decision } : {}),
  } as ShadowActionRecord;
}
function staged(actionType: string): StagedAction {
  return { id: "1", actionType, targetPath: "x.md", proposedBy: "a", proposedAt: "",
    expiresAt: "", status: "pending", rationale: "", proposedDiff: null,
    ratifiedAt: null, ratifiedBy: null, ratificationReason: null, decidedByPrincipal: null };
}

describe("action-mix drift", () => {
  it("computes cheap-link fraction over edge-op + staged rows", () => {
    const shadowRecords = [
      shadowRow("edge-observe", "admitted"),
      shadowRow("edge-observe", "admitted"),
      shadowRow("edge-contest", "admitted"),
    ];
    const stagedActions = [staged("merge")]; // total = 4, edge-observe = 2
    const r = coverageEquitySummary({ docs: [], edges: [], shadowRecords, stagedActions, now: NOW });
    expect(r.ok && r.value.actionMix.total).toBe(4);
    expect(r.ok && r.value.actionMix.cheapLinkFraction).toBeCloseTo(0.5, 5);
    expect(r.ok && r.value.actionMix.counts["edge-observe"]).toBe(2);
    expect(r.ok && r.value.actionMix.counts["merge"]).toBe(1);
  });

  it("excludes doc-write calibration rows from the denominator", () => {
    const shadowRecords = [
      shadowRow("edge-observe", "admitted"),
      shadowRow("write"),   // doc-write calibration row: no decision, non-edge action
      shadowRow("append"),  // ditto
    ];
    const r = coverageEquitySummary({ docs: [], edges: [], shadowRecords, stagedActions: [], now: NOW });
    expect(r.ok && r.value.actionMix.total).toBe(1);            // only the edge-observe
    expect(r.ok && r.value.actionMix.cheapLinkFraction).toBe(1);
    expect(r.ok && r.value.actionMix.counts["write"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/coverage.test.ts -t "action-mix"`
Expected: FAIL — total 0.

- [ ] **Step 3: Implement action-mix**

```ts
const EDGE_OP_ACTIONS = new Set(["edge-observe", "edge-contest"]);
const counts: Record<string, number> = {};
for (const rec of input.shadowRecords) {
  if (!EDGE_OP_ACTIONS.has(rec.action)) continue; // exclude doc-write calibration rows
  counts[rec.action] = (counts[rec.action] ?? 0) + 1;
}
for (const sa of input.stagedActions) {
  counts[sa.actionType] = (counts[sa.actionType] ?? 0) + 1;
}
const total = Object.values(counts).reduce((s, n) => s + n, 0);
const cheapLink = counts["edge-observe"] ?? 0;
const actionMix = {
  counts,
  total,
  cheapLinkFraction: total > 0 ? cheapLink / total : 0,
};
```

Use `actionMix` in the return.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/coverage.ts test/curation/coverage.test.ts
git commit -m "feat(coverage): action-mix drift (cheap-link fraction, doc-write rows excluded)"
```

---

## Task 5: Direction-resolution coverage

**Files:**
- Modify: `src/curation/coverage.ts`
- Test: `test/curation/coverage.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("direction-resolution", () => {
  it("reports directed vs symmetric over non-revoked edges", () => {
    const edges = [
      edge({ fromPath: "a.md", toPath: "b.md", directionVerdict: "directed" }),
      edge({ fromPath: "c.md", toPath: "d.md", directionVerdict: "symmetric" }),
      edge({ fromPath: "e.md", toPath: "f.md", directionVerdict: "symmetric", status: "revoked" }), // excluded
    ];
    const r = coverageEquitySummary({ docs: [], edges, shadowRecords: [], stagedActions: [], now: NOW });
    expect(r.ok && r.value.directionResolution.directed).toBe(1);
    expect(r.ok && r.value.directionResolution.symmetric).toBe(1);
    expect(r.ok && r.value.directionResolution.unresolvedFraction).toBeCloseTo(0.5, 5);
  });

  it("all-symmetric vault → unresolvedFraction 1, backstop-overdue 0", () => {
    const oldISO = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    const edges = [
      edge({ fromPath: "a.md", toPath: "b.md", directionVerdict: "symmetric", lastRederived: oldISO }),
    ];
    const r = coverageEquitySummary({ docs: [], edges, shadowRecords: [], stagedActions: [], now: NOW });
    expect(r.ok && r.value.directionResolution.unresolvedFraction).toBe(1);
    expect(r.ok && r.value.backstopOverdue.count).toBe(0); // symmetric never becomes due
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/coverage.test.ts -t "direction-resolution"`
Expected: FAIL.

- [ ] **Step 3: Implement direction-resolution**

```ts
const nonRevoked = input.edges.filter((e) => e.status !== "revoked");
const directed = nonRevoked.filter((e) => e.directionVerdict === "directed").length;
const symmetric = nonRevoked.filter((e) => e.directionVerdict === "symmetric").length;
const directionResolution = {
  directed,
  symmetric,
  unresolvedFraction: nonRevoked.length > 0 ? symmetric / nonRevoked.length : 0,
};
```

Use `directionResolution` in the return.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/coverage.ts test/curation/coverage.test.ts
git commit -m "feat(coverage): direction-resolution (directed vs symmetric)"
```

---

## Task 6: Path-alias canonicalization + monitor-never-target guard

**Files:**
- Modify: `test/curation/coverage.test.ts` (tests only)

- [ ] **Step 1: Write the alias + guard tests**

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("path-alias canonicalization", () => {
  it("canonicalizes aliased edge paths so blast isn't mis-bucketed", () => {
    // Reuse the shared blastDocs() set — consumer.md makes the PLAIN hub.md edge core.
    const docs = blastDocs();
    // Aliased form of hub.md — must canon() to "hub.md" (the reverse-map key).
    const edges = [edge({ fromPath: "sub/../hub.md", toPath: "dependent.md", strength: 2 })];
    const r = coverageEquitySummary({ docs, edges, shadowRecords: [], stagedActions: [], now: NOW });
    // With canon(): seeds {hub.md, dependent.md}, consumer.md downstream → CORE.
    // Without canon(): seed "sub/../hub.md" is not a reverse-map key → downstream 0
    // → periphery. So core.count===1 proves canon() routed the alias correctly.
    expect(r.ok && r.value.strengthDrift.core.count).toBe(1);
    expect(r.ok && r.value.strengthDrift.periphery.count).toBe(0);
  });
});

describe("monitor-never-target invariant", () => {
  it("no src/consolidate/ module imports the coverage monitor", () => {
    const dir = join(process.cwd(), "src", "consolidate");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      if (/from\s+["'][^"']*curation\/coverage(\.js)?["']/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
```

> **Fixture note:** this test reuses `blastDocs()` from Task 2 (the shared set keeps
> the two fixtures from drifting). The plain `hub.md` form is core there; here the
> *aliased* `sub/../hub.md` form must reach the same bucket. The discriminating power
> is real: without canon() the alias seed isn't a reverse-map key, so downstream is
> empty and the edge would fall to periphery — core.count===1 is only reachable if
> canon() worked.

- [ ] **Step 2: Run to verify the guard passes and alias behaves**

Run: `npx vitest run test/curation/coverage.test.ts`
Expected: guard PASSES (no consolidate import exists yet); alias test PASSES because Task 2 already canon()s the seeds. If the alias test FAILS, the canon() call is missing on a lookup path — fix `coverage.ts` to canon() consistently, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/curation/coverage.test.ts
git commit -m "test(coverage): path-alias canonicalization + monitor-never-target guard"
```

---

## Task 7: Wire into runLint + LintReport

**Files:**
- Modify: `src/curation/lint.ts` (`LintReport` interface ~:124; `runLint` body ~:278-288)
- Test: `test/curation/lint.test.ts`

- [ ] **Step 1: Write a failing integration test**

Add to `test/curation/lint.test.ts` a case that seeds at least one edge in a temp
vault, runs `runLint`, and asserts `report.value.coverageEquity` exists with the
expected shape. Reuse the temp-vault + edge-seeding helpers already in
`test/curation/edges.test.ts` (`makeTempVault`, `observeEdge`) — read those helpers
first and mirror them.

```ts
// sketch — adapt to the file's existing helpers/imports
it("runLint includes a coverageEquity summary", async () => {
  const vault = await makeTempVault();
  // seed one directed edge (see edges.test.ts seedAndVote pattern)
  // ...
  const r = await runLint(vault);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.coverageEquity).toBeDefined();
  expect(r.value.coverageEquity.directionResolution).toBeDefined();
  await cleanupVault(vault);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/lint.test.ts -t "coverageEquity"`
Expected: FAIL — `coverageEquity` undefined / type error.

- [ ] **Step 3: Add the field to LintReport and wire runLint**

In `src/curation/lint.ts`:

```ts
// imports (top of file)
import { coverageEquitySummary, type CoverageEquitySummary } from "./coverage.js";
import { listEdges } from "./edges.js";
import { listShadowActions } from "./shadow.js";
import { listStagedActions } from "./staged-actions.js";

// LintReport interface — add beside shadowActions:
  coverageEquity: CoverageEquitySummary;

// in runLint, after the existing `shadowActions` block (~:279), before the return:
  const edgesRes = await listEdges(vaultRoot, {}, now);
  if (!edgesRes.ok) return edgesRes;
  const shadowRecordsRes = await listShadowActions(vaultRoot);
  if (!shadowRecordsRes.ok) return shadowRecordsRes;
  const stagedRes = await listStagedActions(vaultRoot);
  if (!stagedRes.ok) return stagedRes;
  const coverageEquityRes = coverageEquitySummary({
    docs, edges: edgesRes.value, shadowRecords: shadowRecordsRes.value,
    stagedActions: stagedRes.value, now,
  });
  if (!coverageEquityRes.ok) return coverageEquityRes;

// add to the returned ok({...}):
    coverageEquity: coverageEquityRes.value,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/lint.test.ts`
Expected: PASS (new + existing lint tests).

- [ ] **Step 5: Commit**

```bash
git add src/curation/lint.ts test/curation/lint.test.ts
git commit -m "feat(lint): wire coverageEquity summary into runLint + LintReport"
```

---

## Task 8: Surface in the vault_lint tool

**Files:**
- Modify: `src/tools/curation.ts` (`VaultLintResult` ~:258; both `ok({...})` returns ~:309 and ~:320)
- Test: `test/tools/curation.test.ts` (if present) OR extend `test/curation/lint.test.ts`

- [ ] **Step 1: Write the failing test**

Check for an existing tool-level test: `rg -l "vaultLint" test/`. If a tool test
exists, add a case asserting the returned `VaultLintResult.coverageEquity` is present.
Otherwise add the assertion to the integration test from Task 7 by calling `vaultLint`
directly.

```ts
const r = await vaultLint(vault);
expect(r.ok && r.value.coverageEquity).toBeDefined();
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run <the test file> -t "coverageEquity"`
Expected: FAIL — field absent on `VaultLintResult`.

- [ ] **Step 3: Add to VaultLintResult + both returns**

```ts
// src/tools/curation.ts — import the type
import type { CoverageEquitySummary } from "../curation/coverage.js";

// VaultLintResult interface — add:
  coverageEquity: CoverageEquitySummary;

// BOTH ok({...}) returns in vaultLint (filtered + unfiltered) — add:
    coverageEquity: report.value.coverageEquity,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run <the test file>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/curation.ts test/**
git commit -m "feat(tool): surface coverageEquity in vault_lint output"
```

---

## Task 9: Full gate + CHANGELOG + adversarial review

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Full build + test gate**

Run: `npm run build && npm test`
Expected: build clean, all tests pass. (CI Node-20 has a known onnxruntime/MiniLM
flake — if a search/embedding test is the only red, re-run `--failed`; do not assume a
regression.)

- [ ] **Step 2: Update CHANGELOG**

Add an entry under the unreleased/next section noting: "Stage 4 — coverage/equity
instrumentation: `vault_lint` now reports strength-distribution drift (blast==0
core/periphery split), standing backstop-overdue, action-mix cheap-link fraction, and
direction-resolution. Read-only monitor (never a target)."

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Stage 4 coverage/equity instrumentation"
```

- [ ] **Step 4: Two adversarial general-purpose reviewers**

Per spec §9: dispatch **two general-purpose** reviewers (NOT squad agents — broken
tool bindings). Tell each: read-only, no `git checkout`. Verify every claim against
source (in the Stage-3 run a hook injected fabricated audit findings into reviewer
output). Focus: (a) is the blast split consistent with the envelope; (b) does any
metric leak into A's inputs / calibration (the monitor-never-target invariant);
(c) population correctness (revoked/symmetric handling) per metric; (d) the
percentile/variance math. Fix real findings; explain disagreements.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/cortex-loop-stage4
gh pr create --title "Cortex loop Stage 4 — B coverage/equity instrumentation" --body "<summary + spec link + test evidence>"
```

Release (version bump across the four sites, tag, GitHub Release) follows per
`reference_daftari_release_ritual` AFTER merge. **npm publish is Mihir's MFA step — do
not attempt it from a session.** The CLAUDE.md charter amendment is **Stage 5**, not
here.

---

## Done criteria

- `vault_lint` (tool + `runLint`) returns a `coverageEquity` summary with all four
  metrics.
- `coverage.ts` is pure (no disk I/O) and not imported by any `src/consolidate/`
  module (guard test green).
- `npm run build && npm test` green.
- Two adversarial reviews addressed; PR open to `main`.
