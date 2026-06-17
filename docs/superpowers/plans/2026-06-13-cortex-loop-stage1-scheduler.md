# Cortex Loop Stage 1 — Scheduler Skeleton + `daftari consolidate` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Component C scheduler skeleton and a `daftari consolidate` CLI command that computes the two work-queues (edge due-queue + unprocessed-doc birth queue) at session start and **prints them** — no Component A, no writes, no LLM calls.

**Architecture:** A new `src/consolidate/` subsystem, mirroring the `src/eval/` and `src/backfill/` command structure (a `runConsolidate(argv)` dispatcher wired into `cli.ts`). It reads the shipped edge store (`listEdges`, live aged strength) and git history (a new `changedSince` helper), computes three clocks (event / decay / backstop) as pure functions, ranks the result into a four-slice priority queue under a compute budget, and persists `last_consolidation_commit` + birth-processed-doc hashes to `.daftari/consolidate-state.json`. Stage 1 is read-only: it emits the queues; Stage 2 adds the pass that acts on them.

**Tech Stack:** TypeScript, Node.js, `better-sqlite3` (via shipped edge store), `vitest`, `Result<T, Error>` (no throws from handlers), git CLI via `src/utils/git.ts`.

**Spec:** `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md` (§3 Component C, §4.0 birth mode, §12 Stage 1).

---

## What already exists (do not rebuild)

- `src/curation/edges.ts` — `listEdges(vaultRoot, filter, now): Promise<Result<DerivesFromEdge[]>>` returns collapsed edges with **live aged strength** (`strength`, `kSurvived`, `lastRederived`, `status`). Constants `EDGE_HALF_LIFE_DAYS=90`, `EDGE_TRIGGER_STRENGTH=0.5`, `agedStrength()`.
- `src/curation/vault-docs.ts` — `loadDocuments(vaultRoot): Promise<Result<LoadedDoc[]>>`; **`LoadedDoc` fields are `path` (vault-relative), `content`, `frontmatter`** — the doc-key field is `path`, NOT `relPath`. (`src/curation/vault-docs.ts:14-18`.)
- `src/utils/git.ts` — `log()`, `commit()`, `isGitRepo()`, `git()` (private runner). **No `changedSince` yet — Task 2 adds it.**
- `src/cli.ts` `run()` — the dispatch site; `parseFlag(argv, "vault")` reads `--vault`.
- `src/eval/index.ts` — the **template** for a CLI subcommand: `flag()`/`intFlag()` parsers, `HELP` string, exit codes (0 ok / 2 config / 3 runtime), `runEval` never throws.

## File structure (new)

- `src/consolidate/constants.ts` — provisional, exported scheduler constants (calibration targets, §10 of spec).
- `src/consolidate/state.ts` — `.daftari/consolidate-state.json` read/write.
- `src/consolidate/clocks.ts` — the three clocks as pure functions over injected edges/docs.
- `src/consolidate/priority.ts` — four-slice ranking + drain-under-ceiling (pure).
- `src/consolidate/index.ts` — `runConsolidate(argv)` CLI dispatcher + output formatting.
- `src/utils/git.ts` — **modify**: add `changedSince`.
- Tests mirror under `test/consolidate/` + `test/utils/git-changed-since.test.ts`.

---

### Task 1: Scheduler constants module

**Files:**
- Create: `src/consolidate/constants.ts`
- Test: `test/consolidate/constants.test.ts`

All values are **provisional placeholders** (calibration is spec §10, TBD from shadow data). Single-sourced + exported like `edges.ts`/`shadow.ts` so calibration has one place to tune.

- [ ] **Step 1: Write the failing test**

```ts
// test/consolidate/constants.test.ts
import { describe, expect, it } from "vitest";
import {
  CONSOLIDATE_MIN_INTERVAL_DAYS,
  CONSOLIDATE_MAX_INTERVAL_DAYS,
  CONSOLIDATE_PATH_STRENGTH_FLOOR,
  CONSOLIDATE_SLICE_FRACTIONS,
  CONSOLIDATE_DEFAULT_BUDGET,
  reviewIntervalDays,
} from "../../src/consolidate/constants.js";

describe("consolidate constants", () => {
  it("slice fractions sum to 1", () => {
    const { backstop, main, periphery, birth } = CONSOLIDATE_SLICE_FRACTIONS;
    expect(backstop + main + periphery + birth).toBeCloseTo(1, 10);
  });

  it("interval grows with strength and caps at MAX", () => {
    expect(reviewIntervalDays(0)).toBe(CONSOLIDATE_MIN_INTERVAL_DAYS);
    expect(reviewIntervalDays(1)).toBeGreaterThan(reviewIntervalDays(0));
    // The cap is load-bearing: the decay clock checks `age >= MAX_INTERVAL`
    // (backstop) BEFORE `age >= reviewIntervalDays`, which is only sound if the
    // interval never exceeds MAX. 2^7=128 > 90 → strength 7 is the first that
    // saturates; pin it.
    expect(reviewIntervalDays(7)).toBe(CONSOLIDATE_MAX_INTERVAL_DAYS);
    expect(reviewIntervalDays(99)).toBe(CONSOLIDATE_MAX_INTERVAL_DAYS);
  });

  it("path-strength floor is in (0,1)", () => {
    expect(CONSOLIDATE_PATH_STRENGTH_FLOOR).toBeGreaterThan(0);
    expect(CONSOLIDATE_PATH_STRENGTH_FLOOR).toBeLessThan(1);
  });

  it("default budget is a positive integer", () => {
    expect(Number.isInteger(CONSOLIDATE_DEFAULT_BUDGET)).toBe(true);
    expect(CONSOLIDATE_DEFAULT_BUDGET).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consolidate/constants.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/consolidate/constants.ts
// Provisional scheduler constants. EVERY value here is a calibration target
// (spec §10 — calibrate from shadow data); the loop runs on these placeholders
// until Stage 5. Single-sourced + exported so calibration has one home, mirroring
// EDGE_* / SHADOW_* in the curation layer.

// Review interval f(aged strength): MIN · 2^strength, hard-capped by MAX (the
// max-interval backstop — nothing rests longer than this without re-derivation).
export const CONSOLIDATE_MIN_INTERVAL_DAYS = 1;
export const CONSOLIDATE_MAX_INTERVAL_DAYS = 90; // aligns with EDGE_HALF_LIFE_DAYS

export function reviewIntervalDays(strength: number): number {
  const grown = CONSOLIDATE_MIN_INTERVAL_DAYS * 2 ** Math.max(0, strength);
  return Math.min(grown, CONSOLIDATE_MAX_INTERVAL_DAYS);
}

// Event-blast attenuation: a forward path's reach = ∏(edge strengths); it stops
// where the product drops below this floor (spec §3.1, C-Q2).
export const CONSOLIDATE_PATH_STRENGTH_FLOOR = 0.1;

// Compute-budget partition (spec §3.3). Fractions of the per-session budget.
// backstop is GUARANTEED; periphery is blast-blind fairness; birth is one-time
// cold-start population. Provisional — tuned against B coverage metrics (§6.2).
export const CONSOLIDATE_SLICE_FRACTIONS = {
  backstop: 0.25,
  main: 0.45,
  periphery: 0.15,
  birth: 0.15,
} as const;

// Stage 1 has no LLM calls, so "budget" = max queue items emitted per session.
// With Component A (Stage 2) this becomes the re-derivation-call cap.
export const CONSOLIDATE_DEFAULT_BUDGET = 50;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consolidate/constants.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/consolidate/constants.ts test/consolidate/constants.test.ts
git commit -m "feat(consolidate): provisional scheduler constants (§3 Stage 1)"
```

---

### Task 2: `changedSince` git helper

**Files:**
- Modify: `src/utils/git.ts` (add `changedSince` next to `log`)
- Test: `test/utils/git-changed-since.test.ts`

The event clock needs "which vault docs changed since `last_consolidation_commit`." `git diff --name-only <commit>..HEAD`. Returns vault-relative `.md` paths.

- [ ] **Step 1: Write the failing test**

```ts
// test/utils/git-changed-since.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedSince, commit } from "../../src/utils/git.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "daftari-cs-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("changedSince", () => {
  it("lists .md files changed between a commit and HEAD", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    const first = await commit(dir, ["."], "first", "agent:test");
    expect(first.ok).toBe(true);
    const baseline = (await import("../../src/utils/git.js")).log;
    const commits = await baseline(dir, { limit: 1 });
    const sha = commits.ok ? commits.value[0].hash : "";

    writeFileSync(join(dir, "b.md"), "# b\n");
    await commit(dir, ["."], "second", "agent:test");

    const res = await changedSince(dir, sha);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(["b.md"]);
  });

  it("returns an error for an unknown commit", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    await commit(dir, ["."], "first", "agent:test");
    const res = await changedSince(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/utils/git-changed-since.test.ts`
Expected: FAIL — `changedSince` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `src/utils/git.ts`, after `log`)

```ts
// Vault-relative .md paths changed between `sinceCommit` and HEAD. Used by the
// consolidate event clock (spec §3.1). A bad/unknown commit is an error, not [].
export async function changedSince(
  vaultRoot: string,
  sinceCommit: string,
): Promise<Result<string[], Error>> {
  if (!(await isGitRepo(vaultRoot))) return err(new Error("not a git repository"));
  const result = await git(vaultRoot, ["diff", "--name-only", `${sinceCommit}..HEAD`]);
  if (!result.ok) return result;
  const paths = result.value
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.endsWith(".md"));
  return ok(paths);
}
```

(Confirm `err`/`ok`/`Result`/`git`/`isGitRepo` are already imported/defined in the file — they are; `git` is the private runner used by `log`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/utils/git-changed-since.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/git.ts test/utils/git-changed-since.test.ts
git commit -m "feat(git): changedSince helper for the consolidate event clock"
```

---

### Task 3: `consolidate-state.json` store

**Files:**
- Create: `src/consolidate/state.ts`
- Test: `test/consolidate/state.test.ts`

Tracks `lastConsolidationCommit` and `birthProcessed` (a map of canonical doc path → content hash, so an *edited* doc re-births — spec §4.0). Git-ignored, ephemeral, rebuildable (absent ⇒ first session).

- [ ] **Step 1: Write the failing test**

```ts
// test/consolidate/state.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docContentHash, readConsolidateState, writeConsolidateState } from "../../src/consolidate/state.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "daftari-state-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("consolidate state", () => {
  it("returns an empty default when absent", () => {
    const s = readConsolidateState(dir);
    expect(s.lastConsolidationCommit).toBeNull();
    expect(s.birthProcessed).toEqual({});
  });

  it("round-trips", () => {
    writeConsolidateState(dir, { lastConsolidationCommit: "abc", birthProcessed: { "a.md": "h1" } });
    const s = readConsolidateState(dir);
    expect(s.lastConsolidationCommit).toBe("abc");
    expect(s.birthProcessed["a.md"]).toBe("h1");
  });

  it("treats a corrupt file as the empty default (rebuildable)", () => {
    writeConsolidateState(dir, { lastConsolidationCommit: "abc", birthProcessed: {} });
    rmSync(join(dir, ".daftari", "consolidate-state.json"));
    expect(readConsolidateState(dir).lastConsolidationCommit).toBeNull();
  });

  it("content hash is stable and content-sensitive", () => {
    expect(docContentHash("x")).toBe(docContentHash("x"));
    expect(docContentHash("x")).not.toBe(docContentHash("y"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consolidate/state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/consolidate/state.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ConsolidateState {
  lastConsolidationCommit: string | null;
  // canonical vault-relative doc path → content hash at last birth-processing.
  birthProcessed: Record<string, string>;
}

const EMPTY: ConsolidateState = { lastConsolidationCommit: null, birthProcessed: {} };

export function consolidateStatePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "consolidate-state.json");
}

export function docContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// Absent OR corrupt ⇒ the empty default. The state is ephemeral and rebuildable
// (an empty lastCommit just means the next session uses HEAD as its baseline).
export function readConsolidateState(vaultRoot: string): ConsolidateState {
  const p = consolidateStatePath(vaultRoot);
  if (!existsSync(p)) return { ...EMPTY, birthProcessed: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ConsolidateState>;
    return {
      lastConsolidationCommit: raw.lastConsolidationCommit ?? null,
      birthProcessed: raw.birthProcessed ?? {},
    };
  } catch {
    return { ...EMPTY, birthProcessed: {} };
  }
}

export function writeConsolidateState(vaultRoot: string, state: ConsolidateState): void {
  const p = consolidateStatePath(vaultRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consolidate/state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

Add the repo-root `.gitignore` line in THIS commit (it's a standalone edit):

```
**/.daftari/consolidate-state.json
```

```bash
git add src/consolidate/state.ts test/consolidate/state.test.ts .gitignore
git commit -m "feat(consolidate): consolidate-state.json store (last-commit + birth-processed)"
```

> **NOTE for the implementer:** the `VAULT_GITIGNORE` block lives in `src/cli.ts`,
> which Task 6 already modifies — add `.daftari/consolidate-state.json` to that
> block THERE (Task 6), so the `cli.ts` edit lands in one commit. The repo-root
> `.gitignore` line above goes here in Task 3 (it's not coupled to `cli.ts`).

---

### Task 4: The three clocks (pure functions)

**Files:**
- Create: `src/consolidate/clocks.ts`
- Test: `test/consolidate/clocks.test.ts`

Three pure functions over **injected** edges/docs (no I/O — the I/O wrapper is Task 6). Each returns due items with a `reason` tag.

- **decay/backstop clock** — over `DerivesFromEdge[]`: an edge is *backstop-overdue* if `daysSince(lastRederived) ≥ MAX_INTERVAL`; else *decay-due* if `daysSince(lastRederived) ≥ reviewIntervalDays(strength)`.
- **event clock** — forward walk over the `derives_from` graph from changed docs. An edge means `fromPath` derives from `toPath`; so when a premise `toPath` changes, its dependents (`fromPath`) are due. Propagate transitively, multiplying path strength, stopping below `PATH_STRENGTH_FLOOR`.
- **birth queue** — docs whose canonical path is absent from `birthProcessed`, OR whose content hash differs (edited ⇒ re-birth).

- [ ] **Step 1: Write the failing test**

```ts
// test/consolidate/clocks.test.ts
import { describe, expect, it } from "vitest";
import { birthQueue, decayBackstopDue, eventDue } from "../../src/consolidate/clocks.js";
import { docContentHash } from "../../src/consolidate/state.js";
import type { DerivesFromEdge } from "../../src/curation/edges.js";

const NOW = new Date("2026-06-13T00:00:00Z");
function edge(from: string, to: string, strength: number, lastRederived: string): DerivesFromEdge {
  return { fromPath: from, toPath: to, strength, kSurvived: 1, firstObserved: lastRederived,
    lastRederived, status: "trigger-bearing", observations: 1, contestedAt: null, contestReason: null };
}

describe("decayBackstopDue", () => {
  it("flags an edge past its strength-scaled interval as decay-due", () => {
    const fresh = edge("a.md", "b.md", 0, "2026-06-12T00:00:00Z"); // 1 day, interval(0)=1 → due
    const due = decayBackstopDue([fresh], NOW);
    expect(due.map((d) => d.reason)).toContain("decay");
  });
  it("flags an edge past MAX_INTERVAL as backstop, even if strong", () => {
    const old = edge("a.md", "b.md", 5, "2026-01-01T00:00:00Z"); // ~163 days > 90
    const due = decayBackstopDue([old], NOW);
    expect(due.find((d) => d.fromPath === "a.md")?.reason).toBe("backstop");
  });
  it("does not flag a strong, recently-reviewed edge", () => {
    const ok = edge("a.md", "b.md", 5, "2026-06-12T00:00:00Z");
    expect(decayBackstopDue([ok], NOW)).toEqual([]);
  });
});

describe("eventDue", () => {
  it("marks dependents of a changed premise due, attenuating by path strength", () => {
    // c derives_from b derives_from a; a changed. strengths high enough to propagate.
    const edges = [edge("b.md", "a.md", 5, "2026-06-12T00:00:00Z"),
                   edge("c.md", "b.md", 5, "2026-06-12T00:00:00Z")];
    const due = eventDue(["a.md"], edges);
    expect(due.map((d) => d.fromPath).sort()).toEqual(["b.md", "c.md"]);
  });
  it("stops propagation where the strength product drops below the floor", () => {
    // weak edges: strength 0 → aged product collapses below floor immediately
    const edges = [edge("b.md", "a.md", 0.05, "2026-06-12T00:00:00Z")];
    expect(eventDue(["a.md"], edges)).toEqual([]);
  });
});

describe("birthQueue", () => {
  it("includes unprocessed docs and edited (hash-changed) docs", () => {
    const docs = [{ relPath: "a.md", content: "A" }, { relPath: "b.md", content: "B" }];
    const q = birthQueue(docs, { "a.md": "stale-hash" });
    expect(q.sort()).toEqual(["a.md", "b.md"]); // a: hash differs, b: absent
  });
  it("excludes a doc whose hash matches", () => {
    const docs = [{ relPath: "a.md", content: "A" }];
    expect(birthQueue(docs, { "a.md": docContentHash("A") })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consolidate/clocks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/consolidate/clocks.ts
import type { DerivesFromEdge } from "../curation/edges.js";
import { CONSOLIDATE_MAX_INTERVAL_DAYS, CONSOLIDATE_PATH_STRENGTH_FLOOR, reviewIntervalDays } from "./constants.js";
import { docContentHash } from "./state.js";

export type DueReason = "backstop" | "decay" | "event";
export interface DueEdge { fromPath: string; toPath: string; strength: number; reason: DueReason; }

const MS_PER_DAY = 86_400_000;
function daysBetween(thenISO: string, now: Date): number {
  return (now.getTime() - new Date(thenISO).getTime()) / MS_PER_DAY;
}

// Decay + backstop clocks. Backstop dominates (it is the guarantee).
export function decayBackstopDue(edges: DerivesFromEdge[], now: Date): DueEdge[] {
  const out: DueEdge[] = [];
  for (const e of edges) {
    if (e.status === "revoked") continue;
    const age = daysBetween(e.lastRederived, now);
    if (age >= CONSOLIDATE_MAX_INTERVAL_DAYS) {
      out.push({ fromPath: e.fromPath, toPath: e.toPath, strength: e.strength, reason: "backstop" });
    } else if (age >= reviewIntervalDays(e.strength)) {
      out.push({ fromPath: e.fromPath, toPath: e.toPath, strength: e.strength, reason: "decay" });
    }
  }
  return out;
}

// Event clock: forward walk from changed premises over derives_from edges. An
// edge (from → to) means `from` depends on `to`; a changed `to` makes `from`
// due. Reach attenuates by ∏(edge strength), stopping below the floor. The
// visited set is the cycle guard.
export function eventDue(changedPaths: string[], edges: DerivesFromEdge[]): DueEdge[] {
  // index: premise path → edges that derive from it
  const byPremise = new Map<string, DerivesFromEdge[]>();
  for (const e of edges) {
    if (e.status === "revoked") continue;
    const list = byPremise.get(e.toPath) ?? [];
    list.push(e);
    byPremise.set(e.toPath, list);
  }
  const due = new Map<string, DueEdge>();
  const visited = new Set<string>(changedPaths);
  // queue of (premise path, accumulated path strength)
  let frontier: Array<{ path: string; product: number }> = changedPaths.map((p) => ({ path: p, product: 1 }));
  while (frontier.length > 0) {
    const next: Array<{ path: string; product: number }> = [];
    for (const { path, product } of frontier) {
      for (const e of byPremise.get(path) ?? []) {
        const carried = product * Math.max(e.strength, 0);
        if (carried < CONSOLIDATE_PATH_STRENGTH_FLOOR) continue; // signal faded
        if (!due.has(e.fromPath)) {
          due.set(e.fromPath, { fromPath: e.fromPath, toPath: e.toPath, strength: e.strength, reason: "event" });
        }
        if (!visited.has(e.fromPath)) {
          visited.add(e.fromPath);
          next.push({ path: e.fromPath, product: carried });
        }
      }
    }
    frontier = next;
  }
  return [...due.values()];
}

// Birth queue: docs never processed, or whose content changed since.
export function birthQueue(
  docs: Array<{ relPath: string; content: string }>,
  birthProcessed: Record<string, string>,
): string[] {
  return docs
    .filter((d) => birthProcessed[d.relPath] !== docContentHash(d.content))
    .map((d) => d.relPath);
}
```

> **Implementer note on the floor test:** `eventDue` multiplies the *current
> aged* `strength` field already returned by `listEdges`. The second event test
> uses `strength: 0.05` so `1 × 0.05 < 0.1` → no propagation. Keep the
> attenuation on the edge's live `strength`, not `kSurvived`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consolidate/clocks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consolidate/clocks.ts test/consolidate/clocks.test.ts
git commit -m "feat(consolidate): event/decay/backstop clocks + birth queue (§3.1, §4.0)"
```

---

### Task 5: Four-slice priority + drain-under-ceiling

**Files:**
- Create: `src/consolidate/priority.ts`
- Test: `test/consolidate/priority.test.ts`

Partition the budget into slices (spec §3.3): **backstop** (guaranteed), **main** (event+decay, ranked `fragility × blast`), **periphery** (reserved, ranked pure staleness, blast-blind), **birth** (reserved, FIFO). Stage 1 has no per-doc blast yet, so `blast` defaults to 1 (fragility-only ranking) — wired to real blast in Stage 2; the ranking shape is what Stage 1 locks. Dedup: an edge that is both event- and backstop-due ranks in the higher tier (backstop > event > decay).

- [ ] **Step 1: Write the failing test**

```ts
// test/consolidate/priority.test.ts
import { describe, expect, it } from "vitest";
import type { DueEdge } from "../../src/consolidate/clocks.js";
import { prioritize } from "../../src/consolidate/priority.js";

function due(from: string, reason: DueEdge["reason"], strength = 1): DueEdge {
  return { fromPath: from, toPath: "p.md", strength, reason };
}

describe("prioritize", () => {
  it("dedups an edge due for multiple reasons into the strongest tier", () => {
    const out = prioritize({
      edgeDue: [due("a.md", "event"), due("a.md", "backstop")],
      birth: [], budget: 10, ages: {},
    });
    const a = out.queue.filter((q) => q.kind === "edge" && q.fromPath === "a.md");
    expect(a).toHaveLength(1);
    expect(a[0].slice).toBe("backstop");
  });

  it("reserves a periphery slice so a low-fragility stale edge still appears under load", () => {
    const main = Array.from({ length: 20 }, (_, i) => due(`m${i}.md`, "decay", 0.1)); // many high-fragility
    const peripheral = due("p1.md", "decay", 4.9); // low fragility, but oldest
    const out = prioritize({
      edgeDue: [...main, peripheral], birth: [], budget: 6,
      ages: { "p1.md": 1000 }, // very stale → wins the periphery slice
    });
    expect(out.queue.some((q) => q.kind === "edge" && q.fromPath === "p1.md" && q.slice === "periphery")).toBe(true);
  });

  it("reserves a birth slice and respects the total ceiling", () => {
    const out = prioritize({
      edgeDue: Array.from({ length: 20 }, (_, i) => due(`e${i}.md`, "decay")),
      birth: ["b1.md", "b2.md", "b3.md"], budget: 8, ages: {},
    });
    expect(out.queue.length).toBeLessThanOrEqual(8);
    expect(out.queue.some((q) => q.kind === "birth")).toBe(true);
    expect(out.backstopOverdueRemaining).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consolidate/priority.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/consolidate/priority.ts
import type { DueEdge } from "./clocks.js";
import { CONSOLIDATE_SLICE_FRACTIONS, CONSOLIDATE_MAX_INTERVAL_DAYS } from "./constants.js";
import { EDGE_K_CAP } from "../curation/edges.js";

export type Slice = "backstop" | "main" | "periphery" | "birth";
export type QueueItem =
  | { kind: "edge"; fromPath: string; toPath: string; reason: DueEdge["reason"]; slice: Slice }
  | { kind: "birth"; path: string; slice: "birth" };

export interface PrioritizeInput {
  edgeDue: DueEdge[];
  birth: string[];
  budget: number;
  // fromPath → days since last re-derivation (for periphery staleness ranking).
  ages: Record<string, number>;
}
export interface PrioritizeOutput {
  queue: QueueItem[];
  backstopOverdueRemaining: number;
}

const REASON_RANK: Record<DueEdge["reason"], number> = { backstop: 3, event: 2, decay: 1 };

export function prioritize(input: PrioritizeInput): PrioritizeOutput {
  const { birth, budget, ages } = input;

  // Dedup by fromPath, keeping the strongest reason (backstop > event > decay).
  const best = new Map<string, DueEdge>();
  for (const d of input.edgeDue) {
    const prev = best.get(d.fromPath);
    if (!prev || REASON_RANK[d.reason] > REASON_RANK[prev.reason]) best.set(d.fromPath, d);
  }
  const all = [...best.values()];

  const backstop = all.filter((d) => d.reason === "backstop");
  const nonBackstop = all.filter((d) => d.reason !== "backstop");

  // Slice budgets. A reserved slice with a nonzero fraction must yield at least
  // ONE slot whenever the budget is positive — otherwise the periphery fairness
  // floor silently rounds to zero below budget 7 (floor(6·0.15)=0), which would
  // break the spec §3.3 guarantee that the periphery gets nonzero compute EVERY
  // session, not just at the backstop. So: ⌊budget·f⌋, but never zero when f>0.
  const slot = (f: number) => (budget * f > 0 ? Math.max(1, Math.floor(budget * f)) : 0);
  const cap = { backstop: slot(CONSOLIDATE_SLICE_FRACTIONS.backstop),
    main: slot(CONSOLIDATE_SLICE_FRACTIONS.main),
    periphery: slot(CONSOLIDATE_SLICE_FRACTIONS.periphery),
    birth: slot(CONSOLIDATE_SLICE_FRACTIONS.birth) };

  const queue: QueueItem[] = [];
  const taken = new Set<string>();

  // 1. Backstop — guaranteed. Oldest first.
  const backstopSorted = [...backstop].sort((a, b) => (ages[b.fromPath] ?? 0) - (ages[a.fromPath] ?? 0));
  // Backstop is GUARANTEED: it serves the ENTIRE backstop set (cap.backstop is a
  // floor it may exceed — it borrows from everything, nothing borrows from it).
  // `backstopOverdueRemaining` is therefore nonzero ONLY under total-budget
  // starvation (budget < #backstop-overdue), where the shared queue ceiling cuts
  // the push loop short. That extreme is exactly what the exit-code-4 cron alert
  // (spec §9) is meant to flag — not a per-slice overflow.
  const backstopServed = backstopSorted.slice(0, Math.min(backstop.length, Math.max(cap.backstop, backstop.length)));
  for (const d of backstopServed) {
    if (queue.length >= budget) break;
    queue.push({ kind: "edge", fromPath: d.fromPath, toPath: d.toPath, reason: d.reason, slice: "backstop" });
    taken.add(d.fromPath);
  }
  const backstopOverdueRemaining = backstop.length - backstopServed.filter((d) => taken.has(d.fromPath)).length;

  // 3. Periphery — reserved, blast-blind, pure staleness (oldest first). Taken
  //    BEFORE main so a busy main slice can't swallow the fairness floor.
  const peripheryPool = nonBackstop
    .filter((d) => !taken.has(d.fromPath))
    .sort((a, b) => (ages[b.fromPath] ?? 0) - (ages[a.fromPath] ?? 0));
  for (const d of peripheryPool.slice(0, cap.periphery)) {
    if (queue.length >= budget) break;
    queue.push({ kind: "edge", fromPath: d.fromPath, toPath: d.toPath, reason: d.reason, slice: "periphery" });
    taken.add(d.fromPath);
  }

  // 2. Main — event+decay ranked fragility × blast (blast=1 in Stage 1).
  const fragility = (strength: number) => 1 - Math.min(strength, EDGE_K_CAP) / EDGE_K_CAP;
  const mainPool = nonBackstop
    .filter((d) => !taken.has(d.fromPath))
    .sort((a, b) => REASON_RANK[b.reason] - REASON_RANK[a.reason] || fragility(b.strength) - fragility(a.strength));
  for (const d of mainPool.slice(0, cap.main)) {
    if (queue.length >= budget) break;
    queue.push({ kind: "edge", fromPath: d.fromPath, toPath: d.toPath, reason: d.reason, slice: "main" });
    taken.add(d.fromPath);
  }

  // 4. Birth — reserved, FIFO.
  for (const path of birth.slice(0, cap.birth)) {
    if (queue.length >= budget) break;
    queue.push({ kind: "birth", path, slice: "birth" });
  }

  return { queue, backstopOverdueRemaining };
}
```

> **Implementer note:** periphery is intentionally served *before* main so the
> fairness floor can't be starved by a flood of high-fragility main items (spec
> §3.3 — the periphery slice is the *full* fix, not a mitigation). The slice
> caps `slot()` use floor; leftover budget naturally flows to later slices via
> the shared `queue.length >= budget` ceiling. Verify the periphery test passes
> *because* of the pre-main ordering, not by accident.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/consolidate/priority.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/consolidate/priority.ts test/consolidate/priority.test.ts
git commit -m "feat(consolidate): four-slice priority + drain-under-ceiling (§3.3)"
```

---

### Task 6: `runConsolidate` CLI wiring + output

**Files:**
- Create: `src/consolidate/index.ts`
- Modify: `src/cli.ts` (dispatch `consolidate`; add to `USAGE`)
- Test: `test/consolidate/index.test.ts`

Glue: resolve `--vault`, load edges (`listEdges`) + docs (`loadDocuments`), compute `changedSince(lastCommit)` (nil ⇒ skip event clock, baseline = HEAD), run the three clocks, prioritize, print a report, persist new `lastConsolidationCommit` (current HEAD) — but **leave `birthProcessed` unchanged** (Stage 1 doesn't process births; Stage 2 records them). Exit codes: 0 ok / 2 config / 3 runtime; non-zero (4) if `backstopOverdueRemaining > 0` so a cron wrapper can alert.

- [ ] **Step 1: Write the failing test** (integration over a tmp fixture vault)

```ts
// test/consolidate/index.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConsolidate } from "../../src/consolidate/index.js";
import { commit } from "../../src/utils/git.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-consol-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("runConsolidate", () => {
  it("on a fresh vault, lists every doc in the birth queue and exits 0", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    writeFileSync(join(dir, "b.md"), "# b\n");
    await commit(dir, ["."], "init", "agent:test");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });

    const code = await runConsolidate(["--vault", dir]);
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("birth");
    expect(text).toContain("a.md");
    expect(text).toContain("b.md");
  });

  it("exits 2 when no vault resolves", async () => {
    const code = await runConsolidate(["--vault", join(dir, "does-not-exist")]);
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/consolidate/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/consolidate/index.ts
// `daftari consolidate` — Component C scheduler skeleton (Stage 1). Computes the
// edge due-queue + birth queue at session start and PRINTS them. No Component A,
// no writes, no LLM. Spec: docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listEdges } from "../curation/edges.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { changedSince, isGitRepo, log as gitLog } from "../utils/git.js";
import { birthQueue, decayBackstopDue, eventDue, type DueEdge } from "./clocks.js";
import { CONSOLIDATE_DEFAULT_BUDGET } from "./constants.js";
import { prioritize } from "./priority.js";
import { readConsolidateState, writeConsolidateState } from "./state.js";

const HELP = `daftari consolidate — cortex loop scheduler (Stage 1: emits the queues, acts on nothing).

Usage:
  daftari consolidate [--vault <path>] [--budget <n>]

Exit codes:
  0 — ran; queues emitted
  2 — config error (no vault, bad flags)
  3 — runtime error (git/index I/O)
  4 — ran, but backstop-overdue work was left unserved (cron-alertable)
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export async function runConsolidate(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(HELP); return 0; }
  try {
    const vaultRoot = resolve(flag(argv, "vault") ?? process.cwd());
    if (!existsSync(vaultRoot)) { process.stderr.write(`consolidate: no vault at ${vaultRoot}\n`); return 2; }
    const budget = Number(flag(argv, "budget") ?? CONSOLIDATE_DEFAULT_BUDGET);
    if (!Number.isFinite(budget) || budget <= 0) { process.stderr.write("consolidate: --budget must be > 0\n"); return 2; }

    const now = new Date();
    const state = readConsolidateState(vaultRoot);

    const edgesRes = await listEdges(vaultRoot, {}, now);
    if (!edgesRes.ok) { process.stderr.write(`consolidate: ${edgesRes.error.message}\n`); return 3; }
    const edges = edgesRes.value;

    const docsRes = await loadDocuments(vaultRoot);
    if (!docsRes.ok) { process.stderr.write(`consolidate: ${docsRes.error.message}\n`); return 3; }
    // LoadedDoc's vault-relative key is `path`, not `relPath` (vault-docs.ts:14).
    const docs = docsRes.value.map((d) => ({ relPath: d.path, content: d.content }));

    // Event clock — only if we have a baseline commit AND a git repo.
    let eventEdges: DueEdge[] = [];
    if (state.lastConsolidationCommit && (await isGitRepo(vaultRoot))) {
      const changed = await changedSince(vaultRoot, state.lastConsolidationCommit);
      if (changed.ok) eventEdges = eventDue(changed.value, edges);
      // A present-but-invalid baseline (e.g. a rebased-away commit) is non-fatal
      // — we skip the event clock (spec §7) — but surface it so the degrade isn't
      // invisible (a silently-broken baseline would mask all event-driven work).
      else process.stderr.write(`consolidate: stale baseline ${state.lastConsolidationCommit} — skipping event clock\n`);
    }
    const decayEdges = decayBackstopDue(edges, now);
    const birth = birthQueue(docs, state.birthProcessed);

    // ages for periphery/backstop staleness ranking.
    const MS_PER_DAY = 86_400_000;
    const ages: Record<string, number> = {};
    for (const e of edges) ages[e.fromPath] = (now.getTime() - new Date(e.lastRederived).getTime()) / MS_PER_DAY;

    const { queue, backstopOverdueRemaining } = prioritize({
      edgeDue: [...eventEdges, ...decayEdges], birth, budget, ages,
    });

    // Report.
    const edgeItems = queue.filter((q) => q.kind === "edge");
    const birthItems = queue.filter((q) => q.kind === "birth");
    let report = `consolidate @ ${vaultRoot}\n`;
    report += `  edges: ${edges.length} | docs: ${docs.length} | budget: ${budget}\n`;
    report += `  due edges (${edgeItems.length}):\n`;
    for (const q of edgeItems) if (q.kind === "edge")
      report += `    [${q.slice}/${q.reason}] ${q.fromPath} ← ${q.toPath}\n`;
    report += `  birth queue (${birthItems.length}):\n`;
    for (const q of birthItems) if (q.kind === "birth") report += `    [birth] ${q.path}\n`;
    report += `  backstop-overdue remaining: ${backstopOverdueRemaining}\n`;
    process.stdout.write(report);

    // Persist the new baseline (current HEAD). birthProcessed is unchanged in
    // Stage 1 (no births are actually processed; Stage 2 records them).
    if (await isGitRepo(vaultRoot)) {
      const head = await gitLog(vaultRoot, { limit: 1 });
      if (head.ok && head.value[0]) {
        writeConsolidateState(vaultRoot, { ...state, lastConsolidationCommit: head.value[0].hash });
      }
    }

    return backstopOverdueRemaining > 0 ? 4 : 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}
```

- [ ] **Step 4: Wire into `src/cli.ts`**

In `run()`, after the `backfill` block:

```ts
if (argv[0] === "consolidate") {
  const { runConsolidate } = await import("./consolidate/index.js");
  process.exitCode = await runConsolidate(argv.slice(1));
  return;
}
```

Add to `USAGE`:

```
  daftari consolidate [options]       Cortex loop scheduler — emit due/birth queues (Stage 1)
```

And add `.daftari/consolidate-state.json` to the `VAULT_GITIGNORE` template
string in `src/cli.ts` (the ephemeral-state list, alongside `edges.jsonl` /
`shadow-actions.jsonl`) — folded here so the `cli.ts` change is one commit.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/consolidate/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/consolidate/index.ts src/cli.ts test/consolidate/index.test.ts
git commit -m "feat(consolidate): daftari consolidate command — emit due+birth queues (Stage 1)"
```

---

### Task 7: End-to-end verification on a seeded fixture

**Files:**
- Test: `test/consolidate/e2e-fixture.test.ts`

The Stage-1 acceptance gate (spec §12): on a fixture vault with **hand-seeded edges** (via `vault_edge_observe`'s store) and a known git history, the emitted queues match a hand-computed expectation.

- [ ] **Step 1: Write the failing test**

Seeding uses the confirmed store producer `observeEdge(vaultRoot, input)`
(`src/curation/edges.ts:344`), `input: { fromPath, toPath, observedBy, blind,
axis?, note?, at? }`. The edge `derived ← premise` needs **k=1** (seed + one
qualifying vote) to be trigger-bearing and clear the `eventDue` path-strength
floor (0.1). The seed registers its own `(observer, axis)` pair, so the second
observe MUST use a *distinct* pair (different `observedBy` or `axis`) to count in
one sitting (the `EDGE_REPLAY_GAP_DAYS=1` guard only blocks a *repeated* pair).
`at` is computed **relative to real now** (the e2e command uses a live clock, not
an injected one) so the edge stays fresh — strength ≈ 1 — on any run date, and is
NOT itself decay-due (interval(1) = 2 days > the ~1-minute age), which isolates
the event-clock assertion.

```ts
// test/consolidate/e2e-fixture.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConsolidate } from "../../src/consolidate/index.js";
import { docContentHash } from "../../src/consolidate/state.js";
import { writeConsolidateState } from "../../src/consolidate/state.js";
import { observeEdge } from "../../src/curation/edges.js";
import { commit, log as gitLog } from "../../src/utils/git.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "daftari-e2e-")); mkdirSync(join(dir, ".daftari"), { recursive: true }); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("consolidate e2e", () => {
  it("event clock marks the dependent of a changed premise due", async () => {
    const derivedBody = "# derived\n";
    writeFileSync(join(dir, "premise.md"), "# premise\n");
    writeFileSync(join(dir, "derived.md"), derivedBody);
    const first = await commit(dir, ["."], "init", "agent:test");
    expect(first.ok).toBe(true);
    const firstSha = (await gitLog(dir, { limit: 1 })).ok
      ? (await gitLog(dir, { limit: 1 })).value[0].hash : "";

    // Seed a trigger-bearing edge: derived derives_from premise. `at` ~1 min ago
    // (fresh on any run date), distinct (observer, axis) pairs so the vote counts.
    const at = new Date(Date.now() - 60_000).toISOString();
    const seed = await observeEdge(dir, { fromPath: "derived.md", toPath: "premise.md",
      observedBy: "model-a", blind: true, axis: "model", at });
    expect(seed.ok).toBe(true);
    const vote = await observeEdge(dir, { fromPath: "derived.md", toPath: "premise.md",
      observedBy: "model-b", blind: true, axis: "prompt", at });
    expect(vote.ok).toBe(true);

    // Baseline = the FIRST commit; pre-mark derived.md as birth-processed so its
    // appearance in the queue can ONLY come from the event clock, not birth.
    writeConsolidateState(dir, {
      lastConsolidationCommit: firstSha,
      birthProcessed: { "derived.md": docContentHash(derivedBody) },
    });

    // Change the premise and commit → changedSince(firstSha) = [premise.md].
    writeFileSync(join(dir, "premise.md"), "# premise v2\n");
    await commit(dir, ["."], "edit premise", "agent:test");

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => { out.push(String(s)); return true; });
    const code = await runConsolidate(["--vault", dir]);

    expect([0, 4]).toContain(code);
    const text = out.join("");
    // derived.md is due via the EVENT clock (it derives from the changed premise),
    // tagged [.../event], and is NOT in the birth queue (pre-marked processed).
    expect(text).toMatch(/\[(main|periphery|backstop)\/event\] derived\.md/);
  });
});
```

- [ ] **Step 2: Run to verify it fails, then passes.**

Run: `npx vitest run test/consolidate/e2e-fixture.test.ts`
Expected: PASS once Tasks 1–6 are complete. If `derived.md` appears under
`[birth]` instead of `[.../event]`, the baseline/birthProcessed wiring is wrong —
fix it, don't relax the assertion.

- [ ] **Step 4: Full suite + lint + typecheck**

Run: `npm test && npm run lint && npm run build`
Expected: all green (the existing ~980-test suite + the new consolidate tests).

> **CI note:** the embedding/search tests flake on one Node matrix job when the
> MiniLM model fails to load — re-run `--failed` before assuming a regression
> (see memory `ci-embedding-model-flake`). The consolidate tests do not touch
> embeddings, so a consolidate-test failure is real.

- [ ] **Step 5: Commit**

```bash
git add test/consolidate/e2e-fixture.test.ts
git commit -m "test(consolidate): e2e fixture — event clock marks dependents due (Stage 1 gate)"
```

---

## NOT in scope (Stage 1)

- **Component A** (birth/revision passes, votes, `do()`s) — Stage 2. Stage 1 only
  *identifies* work; it never acts.
- **Real per-doc blast** in the main-tier ranking — defaults to 1 in Stage 1
  (`fragility × 1`); wired to `computeBlast` over the `derives_from` graph in
  Stage 2. The ranking *shape* is what Stage 1 locks.
- **Recording `birthProcessed`** — Stage 1 leaves it untouched (it processes no
  births). Stage 2's birth pass records hashes.
- **Shadow mode / writes / envelope** — Stages 2–3.
- **Calibrating any constant** — all `CONSOLIDATE_*` are provisional placeholders.

## What already exists (sub-problem → reuse)

| Sub-problem | Reuse |
|---|---|
| Read edges with aged strength | `listEdges` (`src/curation/edges.ts`) |
| Load vault docs | `loadDocuments` (`src/curation/vault-docs.ts`) |
| Changed-files-since-commit | new `changedSince` (Task 2) over `git diff --name-only` |
| HEAD sha | `log(vaultRoot, {limit:1})` (`src/utils/git.ts`) |
| CLI subcommand pattern | `src/eval/index.ts` template; dispatch in `src/cli.ts` |
| Result/no-throw, no-classes | house style (CLAUDE.md) |

## Review notes (carry into execution)

- **Two adversarial general-purpose reviewers** before the PR, NOT the squad agents
  (their tool bindings are broken — memory `squad-agents-broken-tools`).
- **Canonicalize paths** if any new path-keyed comparison is added — the alias bug
  bit the edge store and merge (memory `canonicalize-path-keys`). Stage 1 keys off
  `relPath`/`fromPath` already canonical from the store; don't introduce raw
  caller paths.
- **Subagent git hygiene**: implementers `git add` specific files only; reviewers
  don't `git checkout` (shared HEAD) — memory `subagent-git-hygiene`.
- This is a feature branch off `main` (e.g. `mihir/consolidate-stage1`); the uatu
  commit-audit hook blocks commits in don't-ask mode — switch to ask-permissions
  before commit-bearing work (memory `uatu-commit-hook`).
