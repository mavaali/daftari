# Distill receipt join + persistence + model-aware edge voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make a distill run reproducible and correctly attributed: (a) the persisted receipt joins to its artifacts by `runId`, (b) the receipt is written to disk operator-side, and (d) two different models voting on the same edge in one sitting count as independent re-derivations instead of colliding as a replay.

**Architecture:** Three independent seams. (a) `buildReceipt` stops minting its own `randomUUID()` and takes the CLI's staging `runId` (the same `makeRunId()` value stamped into artifact bodies) — the join. (b) A small append-only store writes each receipt to `.daftari/distill-receipts.jsonl` (gitignored, operator-only, never MCP-exposed — R10). (d) `ObserveEdgeInput`/the edge record gain an optional `model`, folded into the replay-guard dedup key (`${by}\n${axis}\n${model}`), and the consolidation birth loop passes its run model — so same-observer/same-axis votes by *different* models no longer collide.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, biome. Source: `src/distill/cost.ts`, `src/distill/cli.ts`, new `src/distill/receipt-store.ts`, `src/curation/edges.ts`, `src/consolidate/birth.ts`. Tests mirror source.

**Spec:** daftari GH #423 (I2 in `docs/2026-08-17-derived-content-lifecycle-gap-report.md`). Bead `mavaali-beads-43a.2`. Base: `origin/main` @ `b675c84`.

---

## Scope decisions (locked with Mihir 2026-08-17)

- **DO (a) runId join, (b) receipt persistence, (d) model-aware dedup.**
- **SKIP proposal (c)** — "add model id to the artifact / `compiled_with` frontmatter extension." The 6mf reader-provenance epic (already merged) stamps `reader_model` + `reader_served_model` frontmatter, a reader fingerprint, and append-only `reader_lineage` on every distilled artifact. A `compiled_with` field would duplicate `reader_model`. Nothing in this plan touches frontmatter/types.ts.
- **DD1 — persistence location:** `.daftari/distill-receipts.jsonl`, append-only JSONL, gitignored. It is operator-local telemetry (provider/ZDR/cost facts, R10) — **no MCP tool or CLI read path** reads it back. It mirrors the existing `.daftari/*.jsonl` append logs (`edges.jsonl`, `consumes.jsonl`).
- **DD2 — the join key is the artifact `runId`** (`makeRunId()` format `distill-<iso>-<hex>`, already stamped into each artifact body at `propose.ts:312`), NOT a fresh UUID. After (a), `receipt.runId === ids.runId` on the artifacts, so a receipt on disk joins to its claims.
- **DD3 — model dedup is backward-compatible.** Existing `edges.jsonl` records have no `model`; `rec.model ?? ""` reproduces the current `${by}\n${axis}` semantics (empty model segment). `votedPairs` is rebuilt from records each collapse pass, so every record in a pass uses the same key shape — no cross-format collision. Records without a model keep today's behavior exactly.
- **DD4 — model is orthogonal to axis.** The birth loop keeps `axis: "prompt"` (blind re-read); the new `model` field only records *which model* cast the vote so cross-run different-model votes don't collide. We do NOT repurpose the `"model"` axis.

---

## File Structure

- `src/distill/cost.ts` — `BuildReceiptOpts` gains `runId`; `buildReceipt` uses it instead of `randomUUID()` (drop the now-unused import if unused).
- `src/distill/receipt-store.ts` (new) — `distillReceiptsPath(vaultRoot)` + `appendDistillReceipt(vaultRoot, receipt)`. One responsibility: persist a receipt.
- `src/distill/cli.ts` — pass the staging `runId` into `buildReceipt`; after building, `await appendDistillReceipt(...)`.
- `.gitignore` — ignore `**/.daftari/distill-receipts.jsonl`.
- `src/curation/edges.ts` — `ObserveEdgeInput` + `RawEdgeRecord` gain `model?: string`; `observeEdge` serializes it; both dedup-key sites (`:370` seed, `:399` vote) fold in `rec.model`.
- `src/consolidate/birth.ts` — the two `deps.observe({...})` calls pass `model: opts.model`.
- Tests mirror each.

---

## Task 1: (a) Thread the staging runId into `buildReceipt`

**Files:**
- Modify: `src/distill/cost.ts` — `BuildReceiptOpts` (~line 109), `buildReceipt` (~line 238, the `runId: randomUUID()` at ~252)
- Test: `test/distill/cost.test.ts`

- [ ] **Step 1: Write/adjust the failing test**

Read `test/distill/cost.test.ts` and find the existing `buildReceipt` test(s) that assert on `runId` (the Explore noted a test checks `runId` is a UUID-ish string). Add a test asserting the receipt carries the CALLER'S runId:

```typescript
it("uses the caller's staging runId so the receipt joins to its artifacts", () => {
  const receipt = buildReceipt({
    outcome: /* reuse the fixture outcome the other tests build */,
    config: /* reuse fixture config */,
    provider: "anthropic",
    zdr: false,
    runId: "distill-2026-08-17T00-00-00-000Z-abc123",
  });
  expect(receipt.runId).toBe("distill-2026-08-17T00-00-00-000Z-abc123");
});
```
If an existing test asserts `runId` is a random UUID, UPDATE it to pass a `runId` and assert equality (the random-UUID behavior is being removed by spec). Copy the `outcome`/`config` fixtures from a neighboring test in the file — do not invent new fixture shapes.

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run test/distill/cost.test.ts -t "staging runId"`
Expected: FAIL — `buildReceipt` rejects the `runId` opt / returns a random value.

- [ ] **Step 3: Implement**

In `BuildReceiptOpts` add:
```typescript
  /**
   * The run's staging id — the SAME makeRunId() value stamped into each
   * artifact body's provenance block (propose.ts). Persisted on the receipt so
   * a receipt on disk joins to the claims it produced (#423). Not a fresh UUID.
   */
  runId: string;
```
In `buildReceipt`, replace `runId: randomUUID(),` with `runId: opts.runId,` (destructure `runId` from `opts` alongside the others). If `randomUUID` is now unused in the file, remove its import (`import { randomUUID } from "node:crypto"`). Run a grep to confirm no other use before removing.

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run test/distill/cost.test.ts` — all pass. `npx tsc --noEmit` — this will flag the `buildReceipt` call site in `cli.ts` as missing `runId` (that is expected and fixed in Task 2; note it and proceed).

- [ ] **Step 5: Commit**

```bash
git add src/distill/cost.ts test/distill/cost.test.ts
git commit -m "feat(#423): buildReceipt takes the staging runId (joinable receipt)"
```
(tsc may still flag the cli.ts call site — Task 2 fixes it. If your commit hook runs tsc and blocks, do Task 2's cli.ts wiring first, then commit both. Report if so.)

---

## Task 2: (b) Persist the receipt operator-side + wire the CLI

**Files:**
- Create: `src/distill/receipt-store.ts`
- Modify: `src/distill/cli.ts` (the `--propose` receipt block, ~lines 595-621), `.gitignore`
- Test: `test/distill/receipt-store.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/distill/receipt-store.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { appendDistillReceipt, distillReceiptsPath } from "../../src/distill/receipt-store.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";
import type { DistillReceipt } from "../../src/distill/cost.js";

function receipt(runId: string): DistillReceipt {
  return {
    runId, model: "claude-haiku-4-5", provider: "openrouter", zdr: false,
    llmCalls: 3, claimsProduced: 5, truncated: false, approxCostUSD: 0.004,
    completedAt: "2026-08-17T00:00:00.000Z",
  };
}

describe("appendDistillReceipt", () => {
  let vault: string;
  beforeEach(() => { vault = makeTempVault(); });
  afterEach(() => cleanupVault(vault));

  it("appends one JSON line per receipt, joinable by runId", async () => {
    const r1 = await appendDistillReceipt(vault, receipt("distill-A"));
    const r2 = await appendDistillReceipt(vault, receipt("distill-B"));
    expect(r1.ok && r2.ok).toBe(true);
    const lines = readFileSync(distillReceiptsPath(vault), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).runId).toBe("distill-A");
    expect(JSON.parse(lines[1]!).runId).toBe("distill-B");
  });
});
```
Confirm `DistillReceipt`'s exact field set against `src/distill/cost.ts` and adjust the `receipt()` literal to match (include `sourceId` only if required — it is optional). Confirm `makeTempVault`/`cleanupVault` exist in `test/helpers/temp-vault.ts`.

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run test/distill/receipt-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/distill/receipt-store.ts`, mirroring the `.daftari/` append pattern used by `observeEdge` (`edges.ts` — `mkdirSync(join(vaultRoot, ".daftari"), { recursive: true })` then append):

```typescript
// Operator-side persistence for distill receipts (#423). Append-only JSONL at
// .daftari/distill-receipts.jsonl, keyed by the artifact runId so a run's
// provider/ZDR/cost facts join to the claims it produced. Machine-local and
// gitignored — these are operator telemetry (R10), NEVER exposed through an MCP
// tool or CLI read path.
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { DistillReceipt } from "./cost.js";
import { err, ok, type Result } from "../frontmatter/types.js";

export function distillReceiptsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "distill-receipts.jsonl");
}

export async function appendDistillReceipt(
  vaultRoot: string,
  receipt: DistillReceipt,
): Promise<Result<void, Error>> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(distillReceiptsPath(vaultRoot), `${JSON.stringify(receipt)}\n`);
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot persist distill receipt: ${reason}`));
  }
}
```
Confirm the `Result`/`ok`/`err` import path matches how other modules import them (grep `from "../frontmatter/types.js"` usages, e.g. in `edges.ts`).

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run test/distill/receipt-store.test.ts` — pass.

- [ ] **Step 5: Wire the CLI + gitignore**

In `src/distill/cli.ts` `--propose` block: the `buildReceipt({...})` call currently omits `runId` — add `runId,` (the `runId` variable from `makeRunId()` at ~line 553). Immediately after `const receipt = buildReceipt({...})`, persist it:
```typescript
    const persisted = await appendDistillReceipt(vaultRoot, receipt);
    if (!persisted.ok) {
      process.stderr.write(`warning: could not persist distill receipt: ${persisted.error.message}\n`);
    }
```
(Best-effort — a persistence failure warns but does not fail the run; the proposal already landed.) Import `appendDistillReceipt` from `./receipt-store.js`.

Add to `.gitignore` (near the other `.daftari/*.jsonl` ignores):
```
**/.daftari/distill-receipts.jsonl
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit` (clean — the Task 1 cli.ts gap is now closed). Run: `npx vitest run test/distill/`.

- [ ] **Step 7: Commit**

```bash
git add src/distill/receipt-store.ts src/distill/cli.ts test/distill/receipt-store.test.ts .gitignore
git commit -m "feat(#423): persist distill receipts to .daftari/distill-receipts.jsonl (operator-side, R10)"
```

---

## Task 3: (d) Add `model` to the edge observation record

**Files:**
- Modify: `src/curation/edges.ts` — `ObserveEdgeInput` (~135), `RawEdgeRecord` (~202), `observeEdge` serialization (~527-536)
- Test: `test/curation/edges.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/curation/edges.test.ts` a test that observes an edge WITH a model and asserts it is serialized into `.daftari/edges.jsonl`:

```typescript
it("serializes the observing model into the edge record", async () => {
  const res = await observeEdge(vault, {
    fromPath: "a.md", toPath: "b.md", observedBy: BY, blind: true,
    axis: "prompt", model: "claude-opus-4-6", at: T1,
  });
  expect(res.ok).toBe(true);
  const raw = readFileSync(join(vault, ".daftari", "edges.jsonl"), "utf8").trim().split("\n");
  const rec = JSON.parse(raw[raw.length - 1]!);
  expect(rec.model).toBe("claude-opus-4-6");
});
```
Reuse the file's existing imports/helpers (`observeEdge`, `BY`, `T1`, `readFileSync`, `join`, `vault` setup). If `readFileSync`/`join` aren't imported in the test file, add them.

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run test/curation/edges.test.ts -t "serializes the observing model"`
Expected: FAIL — `model` rejected by the input type / absent from the record.

- [ ] **Step 3: Implement**

`ObserveEdgeInput` — add:
```typescript
  /**
   * The model that cast this observation (#423). Recorded so two different
   * models voting on the same (observer, axis) in one sitting count as
   * independent re-derivations rather than colliding as a replay. Optional:
   * omitted records keep the pre-#423 dedup behavior exactly.
   */
  model?: string;
```
`RawEdgeRecord` — add `model?: string;`.
`observeEdge` record literal — add `...(input.model ? { model: input.model.trim() } : {}),` (place it beside the existing `axis`/`note` spreads). Do not add validation beyond the existing pattern.

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run test/curation/edges.test.ts` — all pass (existing tests must stay green; `model` is optional so records without it are unchanged). `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/curation/edges.ts test/curation/edges.test.ts
git commit -m "feat(#423): record the observing model on edge observations"
```

---

## Task 4: (d) Fold `model` into the replay-guard dedup key

**Files:**
- Modify: `src/curation/edges.ts` — the seed pair (~370) and the vote pair (~399)
- Test: `test/curation/edges.test.ts`

- [ ] **Step 1: Write the failing test**

Append a test proving different-model votes in one sitting count independently, same-model collides:

```typescript
it("counts two DIFFERENT models on the same (observer, axis) as independent votes in one sitting", async () => {
  // seed (non-blind establishes the edge)
  await observeEdge(vault, { fromPath: "a.md", toPath: "b.md", observedBy: BY, blind: false, at: T0 });
  // two blind votes, same observer + axis, SAME sitting (T1), DIFFERENT models
  await observeEdge(vault, { fromPath: "a.md", toPath: "b.md", observedBy: BY, blind: true, axis: "prompt", model: "model-X", at: T1 });
  await observeEdge(vault, { fromPath: "a.md", toPath: "b.md", observedBy: BY, blind: true, axis: "prompt", model: "model-Y", at: T1 });
  const edge = await getEdge(vault, "a.md", "b.md", new Date(T1));
  expect(edge.value?.kSurvived).toBe(2); // both counted — different models are independent

  // a THIRD vote, same observer/axis/sitting, REPEATING model-X → replay, no advance
  await observeEdge(vault, { fromPath: "a.md", toPath: "b.md", observedBy: BY, blind: true, axis: "prompt", model: "model-X", at: T1 });
  const edge2 = await getEdge(vault, "a.md", "b.md", new Date(T1));
  expect(edge2.value?.kSurvived).toBe(2); // unchanged — model-X already voted this sitting
}, 60_000);
```
Match `getEdge`, `BY`, `T0`, `T1`, `EDGE_K_CAP` conventions to the file. If the seed itself registers a pair (per the `:364-371` seed-pair logic), confirm the seed here is non-blind (so it does not register a blind vote pair) — the test above uses `blind: false` for the seed, matching the file's `seedAndVote` helper intent. Adjust `T0` vs `T1` so the gap is < `EDGE_REPLAY_GAP_DAYS` (same sitting) — use the file's existing same-sitting timestamps.

- [ ] **Step 2: Run, verify FAIL**

Run: `npx vitest run test/curation/edges.test.ts -t "independent votes in one sitting"`
Expected: FAIL — `kSurvived` is 1 (both model-X and model-Y hash to `${BY}\nprompt`, so model-Y is treated as a replay).

- [ ] **Step 3: Implement**

At the seed-pair site (~370), change:
```typescript
          ? [`${rec.by}\n${rec.axis}`]
```
to:
```typescript
          ? [`${rec.by}\n${rec.axis}\n${rec.model ?? ""}`]
```
At the vote-pair site (~399), change:
```typescript
      const pair = `${rec.by}\n${rec.axis}`;
```
to:
```typescript
      const pair = `${rec.by}\n${rec.axis}\n${rec.model ?? ""}`;
```
Update the nearby comment (the block at `:87-92` and/or the seed comment at `:358-363`) to note the dedup key now includes the model, so the "two different models voting in one sitting ARE independent" claim is now actually enforced by the key. Keep it to one or two lines.

- [ ] **Step 4: Run, verify PASS**

Run: `npx vitest run test/curation/edges.test.ts` — the new test passes AND every pre-existing edges test stays green (records without `model` use `?? ""`, identical key shape within a pass). `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/curation/edges.ts test/curation/edges.test.ts
git commit -m "feat(#423): fold model into the edge replay-guard dedup key"
```

---

## Task 5: (d) Birth loop passes its run model to observed edges

**Files:**
- Modify: `src/consolidate/birth.ts` — the two `deps.observe({...})` calls (~345, ~388)
- Test: `test/consolidate/` (extend an existing birth test if one asserts on observed edges; else verify via the edges surface)

- [ ] **Step 1: Write/extend the failing test**

Find the birth-loop test that exercises `observe` (search `test/consolidate/` for `observe`/`birthOne`/`derives_from`). If one asserts on the observed edge, extend it to assert the persisted edge record carries `model` equal to the run model passed in `opts.model`. If no such assertion point exists cleanly, add a focused test that runs `birthOne` with a stub `observe` dep capturing its input, and asserts the input includes `model: <opts.model>`. Mirror the existing birth test's dep-stubbing style exactly — do not invent a new harness. If the birth tests are heavy/integration-only and stubbing `observe` is impractical, report BLOCKED and I will decide whether to assert at the edges.jsonl layer instead.

- [ ] **Step 2: Run, verify FAIL**

Expected: FAIL — the observed edge input has no `model`.

- [ ] **Step 3: Implement**

In `src/consolidate/birth.ts`, both `deps.observe({...})` calls (the two blind re-read observations) add `model: opts.model,` to the observe input object (alongside `axis: "prompt"`). `opts.model` is already in scope (used for the LLM calls at `:266`/`:287`). Do not change the axis.

- [ ] **Step 4: Run, verify PASS**

Run: the birth test file, plus `npx vitest run test/curation/edges.test.ts test/consolidate/`. `npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/consolidate/birth.ts test/consolidate/
git commit -m "feat(#423): birth loop records its run model on observed edges"
```

---

## Task 6: Docs + full verification

**Files:**
- Modify: `CHANGELOG.md`; `docs/` (grep for a distill-receipt or `.daftari/` layout doc, and any consolidate voting/strength-model doc that describes the dedup key)

- [ ] **Step 1: CHANGELOG + docs**

Add a CHANGELOG entry under the current unreleased/top section (match the file's format):
```
- Distill receipts (#423): `buildReceipt` now carries the run's staging `runId` (the id stamped into artifact bodies) instead of a throwaway UUID, and each receipt is persisted to `.daftari/distill-receipts.jsonl` (operator-local, gitignored, never MCP-exposed) — so a run's provider/ZDR/cost facts join to the claims it produced. Consolidate voting: the replay-guard dedup key now includes the observing model, so two different models re-deriving the same edge in one sitting count as independent votes (previously collided as a replay).
```
Grep `docs/` for (i) any `.daftari/` file-layout list — add `distill-receipts.jsonl`; (ii) any consolidate/strength-model doc describing the `(observer, axis)` dedup key — note it now includes model. Do NOT edit the gap report or this plan. If no such docs exist, report it.

- [ ] **Step 2: Static verification**
```bash
npx tsc --noEmit
npx biome check src/ test/
```
If biome reports only auto-fixable formatting, run `npx biome check --write src/ test/` then re-check. Stop and report any non-auto-fixable lint error.

- [ ] **Step 3: Targeted tests**
```bash
npx vitest run test/distill/cost.test.ts test/distill/receipt-store.test.ts test/curation/edges.test.ts test/consolidate/
```
All green.

- [ ] **Step 4: Regression sweep**
```bash
npx vitest run test/distill/ test/curation/ test/consolidate/ test/tools/
```
Report tallies. Per the daftari worktree note, ignore only known separate-workspace `failed files` (integrations/**, packages/**) and load-sensitive spawn/e2e/lifecycle flakes — none of which this change touches. Any failure in distill/edges/consolidate is a real regression — investigate.

- [ ] **Step 5: Commit docs**
```bash
git add CHANGELOG.md docs/
git commit -m "docs(#423): changelog + .daftari layout / consolidate dedup notes"
```

---

## Acceptance trace (spec #423 → tasks)

- "A distill receipt on disk joins to its artifacts by runId" → Task 1 (runId is the artifact `makeRunId()` value) + Task 2 (persisted to `.daftari/distill-receipts.jsonl`); receipt-store test asserts join-by-runId.
- "A re-derivation by a different model is distinguishable from a same-sitting replay" → Task 3 (record the model) + Task 4 (fold into dedup key) + Task 5 (birth loop supplies the model); edges test asserts different-model = independent, same-model = replay.
- Proposal (c) intentionally dropped (subsumed by 6mf reader_model) — DD/scope decisions.

## Out of scope

- No frontmatter/types.ts change (no `compiled_with`). No MCP tool to read receipts (R10 operator-only). No change to the `"model"` axis semantics. #416 (unverifiable class, separate PR #449) and #419 (erase advisory, next bead) are not touched.
