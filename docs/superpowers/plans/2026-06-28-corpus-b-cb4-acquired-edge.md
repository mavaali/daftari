# Corpus (B) CB4 — Acquired-edge arm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run daftari's actual derivation classifier (vendored verbatim) and a supersession-minting foil over raw stream pairs, to measure daftari-way acquisition recall (+ the oracle→acquired gap) vs the foil's fabrication rate.

**Architecture:** Reuse the Arm B `LlmClient` seam. A vendored copy of daftari's `DERIVATION_SYSTEM`/`derivationUserBody` (with a `readFileSync` byte-match drift-guard against `src/consolidate/derivation-prompt.ts`) is the daftari-way acquirer — it structurally cannot mint a supersession. A bespoke foil prompt forces a directional supersession verdict. Pairs come from the 33 CO2 stale-traps (true) and cross-item governing passages deduped on `governingNum` (control). All LLM behind the stub seam; the paid run is a deleted throwaway.

**Tech Stack:** TypeScript, vitest, OpenRouter (`OPENROUTER_API_KEY`, `anthropic/claude-haiku-4.5`), CO2 modules (`consensus-content`, `consensus-passage`), Arm B `consensus-llm`.

**Spec:** `docs/superpowers/specs/2026-06-28-corpus-b-cb4-acquired-edge-design.md`
**Vendor source:** `src/consolidate/derivation-prompt.ts` @ commit `7adfd42`.

**Out of scope:** full cortex pipeline on a built vault; full supersession-graph reconstruction; pre-cutoff perturbation; fuller Arm C localization.

---

## File Structure

- Create `integrations/consensus-bench/src/consensus-cb4-derivation.ts` — vendored `DERIVATION_SYSTEM`, `derivationUserBody`, `parseCb4Derivation`, `acquireDerivation`.
- Create `integrations/consensus-bench/src/consensus-cb4-foil.ts` — `buildFoilPrompt`, `parseFoil`, `classifyFoilTrue`, `classifyFoilControl`, `acquireFoil`.
- Create `integrations/consensus-bench/src/consensus-cb4-pairs.ts` — `truePairs`, `controlPairs`.
- Tests mirror each. Plus `consensus-cb4-derivation.driftguard.test.ts`.
- Throwaway paid runner `src/_cb4-run.test.ts` (run once, deleted, not committed).
- Committed output: `docs/superpowers/results/2026-06-28-corpus-b-cb4.md`.

No classes; functions + types. No network in the suite.

---

## Task 1: Vendored derivation acquirer + drift-guard

**Files:**
- Create: `integrations/consensus-bench/src/consensus-cb4-derivation.ts`
- Test: `integrations/consensus-bench/src/consensus-cb4-derivation.test.ts`
- Test: `integrations/consensus-bench/src/consensus-cb4-derivation.driftguard.test.ts`

- [ ] **Step 1: Write the drift-guard test** (proves the vendored prompt is daftari's actual one)

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DERIVATION_SYSTEM, derivationUserBody } from "./consensus-cb4-derivation.js";

// The real cortex prompt lives outside the bench's rootDir, so we cannot IMPORT
// it (tsc), but we can READ it as a file at test time to assert our vendored copy
// has not drifted. If daftari edits the prompt, these phrase checks fail -> resync.
const SRC = readFileSync(
  fileURLToPath(new URL("../../../src/consolidate/derivation-prompt.ts", import.meta.url)),
  "utf8",
);

describe("derivation prompt drift-guard", () => {
  const SYS_PHRASES = [
    "You assess whether one document's central claim is a load-bearing derivation of",
    "Be conservative: when the",
  ];
  const BODY_PHRASES = [
    "is there a load-bearing dependency between these two central claims",
    'Answer "A" ',
    "answer \"symmetric\".",
  ];

  test("vendored DERIVATION_SYSTEM matches the phrases in the real src", () => {
    for (const p of SYS_PHRASES) {
      expect(SRC).toContain(p);
      expect(DERIVATION_SYSTEM).toContain(p);
    }
  });

  test("vendored derivationUserBody matches the phrases in the real src", () => {
    const body = derivationUserBody("a", "AC", "b", "BC");
    for (const p of BODY_PHRASES) {
      expect(SRC).toContain(p);
      expect(body).toContain(p);
    }
    expect(body).toContain("DOC A (path: a)");
    expect(body).toContain("AC");
  });
});
```

- [ ] **Step 2: Write the parser/acquirer test**

```typescript
import { describe, expect, test } from "vitest";
import { parseCb4Derivation, acquireDerivation } from "./consensus-cb4-derivation.js";
import type { LlmClient } from "./consensus-llm.js";

const stub = (reply: string): LlmClient => ({ complete: async () => reply });

describe("parseCb4Derivation", () => {
  test("parses related+premise+reason from a JSON object (with code fences)", () => {
    const v = parseCb4Derivation('```json\n{"related":true,"premise":"A","reason":"x"}\n```');
    expect(v).toEqual({ related: true, premise: "A", reason: "x" });
  });
  test("related:false discards premise", () => {
    expect(parseCb4Derivation('{"related":false,"premise":"A","reason":"none"}'))
      .toEqual({ related: false, premise: null, reason: "none" });
  });
  test("invalid shape -> null (unparseable)", () => {
    expect(parseCb4Derivation("not json")).toBeNull();
    expect(parseCb4Derivation('{"related":"yes"}')).toBeNull();
  });
});

describe("acquireDerivation", () => {
  test("returns the parsed verdict from the model", async () => {
    const v = await acquireDerivation(stub('{"related":true,"premise":"B","reason":"r"}'), "GOV", "STALE");
    expect(v?.related).toBe(true);
    expect(v?.premise).toBe("B");
  });
});
```

- [ ] **Step 3: Run both tests → FAIL** (`npx vitest run integrations/consensus-bench/src/consensus-cb4-derivation*.ts`)

- [ ] **Step 4: Write the implementation** (vendor verbatim from src @ 7adfd42)

```typescript
// consensus-cb4-derivation — daftari's ACTUAL cortex derivation classifier, vendored
// verbatim from src/consolidate/derivation-prompt.ts (commit 7adfd42). The bench
// cannot import across rootDir, so we copy + guard against drift (see the
// driftguard test). This acquirer structurally CANNOT mint a supersession — it
// reports {related, premise} only; the keystone in code.
import type { LlmClient } from "./consensus-llm.js";

export type PremiseSide = "A" | "B" | "symmetric";
export interface DerivationVerdict {
  related: boolean;
  premise: PremiseSide | null;
  reason: string;
}

// --- VERBATIM from src/consolidate/derivation-prompt.ts (keep in sync; drift-guarded) ---
export const DERIVATION_SYSTEM =
  "You assess whether one document's central claim is a load-bearing derivation of " +
  "another's, and if so which is the foundational premise. A load-bearing dependency " +
  "means one claim rests on the other as a premise it could not stand without — not a " +
  "passing reference, a citation, or mere co-occurrence. Be conservative: when the " +
  "dependency is shallow or ambiguous, judge that there is none.";

export function derivationUserBody(aPath: string, aContent: string, bPath: string, bContent: string): string {
  return (
    `DOC A (path: ${aPath}):\n${aContent}\n\n` +
    `DOC B (path: ${bPath}):\n${bContent}\n\n` +
    "First: is there a load-bearing dependency between these two central claims — does " +
    "one rest on the other as a foundational premise (not a passing mention, a citation, " +
    "or mere co-occurrence)? If there is no such dependency, set related to false.\n\n" +
    "If there is a dependency: which of DOC A or DOC B is the load-bearing premise — the " +
    'one that would have to be established first for the other to make sense? Answer "A" ' +
    'or "B". If each claim conditions the other so that neither could be established first, ' +
    'answer "symmetric".\n\nReturn JSON.'
  );
}
// --- end verbatim ---

const PREMISE_SIDES: ReadonlySet<string> = new Set(["A", "B", "symmetric"]);

export function parseCb4Derivation(raw: string): DerivationVerdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj: any;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (typeof obj.related !== "boolean") return null;
  if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) return null;
  if (obj.related === false) return { related: false, premise: null, reason: obj.reason };
  if (typeof obj.premise !== "string" || !PREMISE_SIDES.has(obj.premise)) return null;
  return { related: true, premise: obj.premise as PremiseSide, reason: obj.reason };
}

// daftari-way acquisition: governing = DOC A, stale = DOC B. The prompt is
// presentation-order-agnostic by contract; premise is reported descriptively (a
// derivation foundation, NOT a supersession verdict).
export async function acquireDerivation(
  client: LlmClient,
  govText: string,
  staleText: string,
): Promise<DerivationVerdict | null> {
  const body = derivationUserBody("governing", govText, "stale", staleText);
  const raw = await client.complete({ model: "anthropic/claude-haiku-4.5", system: DERIVATION_SYSTEM, user: body });
  return parseCb4Derivation(raw);
}
```

- [ ] **Step 5: Run → PASS.** If a drift phrase is missing from src, STOP — daftari changed the prompt; re-vendor before continuing.

- [ ] **Step 6: Commit**

```bash
git add integrations/consensus-bench/src/consensus-cb4-derivation.ts integrations/consensus-bench/src/consensus-cb4-derivation.test.ts integrations/consensus-bench/src/consensus-cb4-derivation.driftguard.test.ts
git commit -m "feat(consensus-bench): CB4 daftari-way acquirer (vendored derivation prompt + drift guard)"
```

---

## Task 2: Minting foil

**Files:**
- Create: `integrations/consensus-bench/src/consensus-cb4-foil.ts`
- Test: `integrations/consensus-bench/src/consensus-cb4-foil.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from "vitest";
import { buildFoilPrompt, parseFoil, classifyFoilTrue, classifyFoilControl, acquireFoil } from "./consensus-cb4-foil.js";
import type { LlmClient } from "./consensus-llm.js";

const stub = (reply: string): LlmClient => ({ complete: async () => reply });

describe("buildFoilPrompt", () => {
  test("presents A and B and forces a directional supersession verdict", () => {
    const p = buildFoilPrompt("TA", "TB");
    expect(p).toContain("TA");
    expect(p).toContain("TB");
    expect(p).toContain("A_SUPERSEDES_B");
    expect(p).toContain("B_SUPERSEDES_A");
    expect(p).toContain("NEITHER");
  });
});

describe("parseFoil", () => {
  test("parses the three verdicts (tolerant)", () => {
    expect(parseFoil("A_SUPERSEDES_B")).toBe("a_supersedes_b");
    expect(parseFoil("answer: b_supersedes_a")).toBe("b_supersedes_a");
    expect(parseFoil("NEITHER")).toBe("neither");
    expect(parseFoil("unclear")).toBe("neither");
  });
});

describe("classifyFoilTrue (governingSide tells which slot is governing/current)", () => {
  test("verdict naming governing as superseder => correct (both slots)", () => {
    expect(classifyFoilTrue("a_supersedes_b", "A")).toBe("correct");
    expect(classifyFoilTrue("b_supersedes_a", "B")).toBe("correct");
  });
  test("verdict naming stale as superseder => wrong-direction (fabrication)", () => {
    expect(classifyFoilTrue("b_supersedes_a", "A")).toBe("wrong-direction");
    expect(classifyFoilTrue("a_supersedes_b", "B")).toBe("wrong-direction");
  });
  test("neither => neither", () => {
    expect(classifyFoilTrue("neither", "A")).toBe("neither");
  });
});

describe("classifyFoilControl (no relation exists)", () => {
  test("any supersession assertion => fabricate; neither => correct", () => {
    expect(classifyFoilControl("a_supersedes_b")).toBe("fabricate");
    expect(classifyFoilControl("b_supersedes_a")).toBe("fabricate");
    expect(classifyFoilControl("neither")).toBe("correct");
  });
});

describe("acquireFoil", () => {
  test("returns the parsed verdict", async () => {
    expect(await acquireFoil(stub("A_SUPERSEDES_B"), "x", "y")).toBe("a_supersedes_b");
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Write the implementation**

```typescript
// consensus-cb4-foil — the verdict daftari refuses: a forced directional
// supersession claim. Exists to be contrasted (it fabricates), not adopted.
import type { LlmClient } from "./consensus-llm.js";

export type FoilVerdict = "a_supersedes_b" | "b_supersedes_a" | "neither";

export function buildFoilPrompt(textA: string, textB: string): string {
  return [
    "Two versions of a passage from a collaboratively edited article:",
    "",
    `A: ${textA}`,
    `B: ${textB}`,
    "",
    "Does one supersede the other as the current consensus? Reply with exactly",
    "'A_SUPERSEDES_B', 'B_SUPERSEDES_A', or 'NEITHER'.",
  ].join("\n");
}

export function parseFoil(resp: string): FoilVerdict {
  if (/a_supersedes_b/i.test(resp)) return "a_supersedes_b";
  if (/b_supersedes_a/i.test(resp)) return "b_supersedes_a";
  return "neither";
}

// True pairs: governingSide is the slot ("A"|"B") holding the governing (current)
// text. Correct = the verdict names that slot as the superseder.
export function classifyFoilTrue(v: FoilVerdict, governingSide: "A" | "B"): "correct" | "wrong-direction" | "neither" {
  if (v === "neither") return "neither";
  const superseder = v === "a_supersedes_b" ? "A" : "B";
  return superseder === governingSide ? "correct" : "wrong-direction";
}

// Control pairs: no relation exists, so any supersession assertion is a fabrication.
export function classifyFoilControl(v: FoilVerdict): "correct" | "fabricate" {
  return v === "neither" ? "correct" : "fabricate";
}

export async function acquireFoil(client: LlmClient, textA: string, textB: string): Promise<FoilVerdict> {
  const raw = await client.complete({ model: "anthropic/claude-haiku-4.5", user: buildFoilPrompt(textA, textB) });
  return parseFoil(raw);
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**

```bash
git add integrations/consensus-bench/src/consensus-cb4-foil.ts integrations/consensus-bench/src/consensus-cb4-foil.test.ts
git commit -m "feat(consensus-bench): CB4 minting foil (forced supersession verdict + classify)"
```

---

## Task 3: Pairs builder (true + control, item-deduped)

**Files:**
- Create: `integrations/consensus-bench/src/consensus-cb4-pairs.ts`
- Test: `integrations/consensus-bench/src/consensus-cb4-pairs.test.ts`

`controlPairs` MUST pair governing passages from **distinct `governingNum`** (only
18 distinct exist; index pairing would pair same-item passages — see spec).

- [ ] **Step 1: Write the failing test**

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDiffsFromFile } from "./consensus-content.js";
import { truePairs, controlPairs } from "./consensus-cb4-pairs.js";

const DIFFS = loadDiffsFromFile(
  fileURLToPath(new URL("./__fixtures__/trump-instance-diffs.json", import.meta.url)),
);

describe("truePairs", () => {
  const tp = truePairs(DIFFS);
  test("one per scorable instance with gov/stale text + governingNum", () => {
    expect(tp.length).toBe(33);
    for (const p of tp) {
      expect(p.govText.length).toBeGreaterThan(0);
      expect(p.staleText.length).toBeGreaterThan(0);
      expect(typeof p.governingNum).toBe("number");
    }
  });
});

describe("controlPairs", () => {
  const cp = controlPairs(DIFFS);
  test("every control pairs two DIFFERENT consensus items (truly unrelated)", () => {
    expect(cp.length).toBeGreaterThanOrEqual(10);
    for (const p of cp) {
      expect(p.numA).not.toBe(p.numB); // item-level dedup is load-bearing
      expect(p.textA.length).toBeGreaterThan(0);
      expect(p.textB.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Write the implementation**

```typescript
// consensus-cb4-pairs — build the CB4 datasets from CO2 diffs. True pairs are the
// scorable stale-traps (a real supersession: governing supersedes stale). Control
// pairs join governing passages from DISTINCT consensus items (no relation) —
// deduped on governingNum because only ~18 distinct items exist across 37
// instances (index pairing would pair same-item passages).
import type { RevertDiff } from "./consensus-content.js";
import { parsePassage } from "./consensus-passage.js";

export interface TruePair {
  revid: number;
  governingNum: number;
  govText: string;
  staleText: string;
}

export interface ControlPair {
  numA: number;
  numB: number;
  textA: string;
  textB: string;
}

export function truePairs(diffs: RevertDiff[]): TruePair[] {
  const out: TruePair[] = [];
  for (const d of diffs) {
    const p = parsePassage(d.diffHtml);
    if (!p.scorable) continue;
    out.push({ revid: d.revid, governingNum: d.governingNum, govText: p.governingText, staleText: p.staleText });
  }
  return out;
}

export function controlPairs(diffs: RevertDiff[]): ControlPair[] {
  // One governing passage per distinct governingNum (first scorable instance).
  const byNum = new Map<number, string>();
  for (const d of diffs) {
    if (byNum.has(d.governingNum)) continue;
    const p = parsePassage(d.diffHtml);
    if (p.scorable) byNum.set(d.governingNum, p.governingText);
  }
  const items = [...byNum.entries()].sort((a, b) => a[0] - b[0]); // [num, text]
  const out: ControlPair[] = [];
  for (let i = 0; i + 1 < items.length; i++) {
    out.push({ numA: items[i][0], numB: items[i + 1][0], textA: items[i][1], textB: items[i + 1][1] });
  }
  return out; // all numA != numB by construction (distinct items, adjacent)
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Full suite + tsc**

Run: `npx vitest run integrations/consensus-bench && (cd integrations/consensus-bench && npx tsc --noEmit)`
Expected: all green, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add integrations/consensus-bench/src/consensus-cb4-pairs.ts integrations/consensus-bench/src/consensus-cb4-pairs.test.ts
git commit -m "feat(consensus-bench): CB4 pairs builder (true + item-deduped control)"
```

---

## Task 4: The paid run + results

**Files:**
- Throwaway: `src/_cb4-run.test.ts` (run once, deleted, not committed)
- Create: `docs/superpowers/results/2026-06-28-corpus-b-cb4.md`

- [ ] **Step 1: Write the throwaway runner**

Imports `openRouterClient(process.env.OPENROUTER_API_KEY)`, builds `truePairs` +
`controlPairs`, and:
- **daftari-way:** for each true pair, `acquireDerivation(client, govText, staleText)`;
  count `related===true` (recall), `related===false` (miss), `null` (unparseable).
  For each control pair, `acquireDerivation(client, textA, textB)`; count
  `related===true` (false-positive). Record premise distribution descriptively.
  Supersessions minted = 0 (structural; assert acquireDerivation has no supersede path).
- **foil:** for each true pair, governing is slot A (govText passed as textA),
  `classifyFoilTrue(await acquireFoil(client, govText, staleText), "A")` →
  {correct | wrong-direction | neither}. For each control pair,
  `classifyFoilControl(await acquireFoil(client, textA, textB))` → {correct | fabricate}.
- Compute the **oracle→acquired gap = 16 − (daftari-way recall count)**.
- `writeFileSync` the metrics table + per-row to scratch (NOT console.log).

- [ ] **Step 2: CHECKPOINT — confirm the paid run with Mihir**

~33 true + ~17 control pairs × 2 acquirers ≈ ~100 Haiku calls, temp 0, well under
$1. Surface go/no-go before running.

- [ ] **Step 3: Run the paid run**

Run: `npx vitest run integrations/consensus-bench/src/_cb4-run.test.ts`
Inspect: daftari-way recall/false-pos, foil correct/wrong-direction/neither + control
fabricate-rate, the oracle→acquired gap.

- [ ] **Step 4: Write the results note + commit**

Write `docs/superpowers/results/2026-06-28-corpus-b-cb4.md`: the metrics table,
the oracle→acquired gap, and a straight reading — frame low daftari-way recall as
the predicted confirmation-of-design (derivation ≠ tension), foil fabrication F as
a lower bound (conservative model). Delete the throwaway runner.

```bash
git add docs/superpowers/results/2026-06-28-corpus-b-cb4.md
git commit -m "docs(results): corpus B CB4 — acquired-edge (daftari-way recall + gap) vs minting foil fabrication"
```

---

## Definition of Done

- `consensus-cb4-derivation` (+ drift-guard), `consensus-cb4-foil`,
  `consensus-cb4-pairs` implemented + unit-tested; full `integrations/consensus-bench`
  suite green, tsc clean.
- Drift-guard confirms the vendored prompt == daftari's actual `src` prompt.
- Paid run executed (after checkpoint); metrics table + oracle→acquired gap recorded.
- Results note stated straight (predicted-low-recall framing; foil F lower-bound).
- No network/LLM in the committed suite (runner is a deleted throwaway).

**Next (separate):** full cortex pipeline on a built vault; full supersession-graph
reconstruction; pre-cutoff perturbation; fuller Arm C localization.
