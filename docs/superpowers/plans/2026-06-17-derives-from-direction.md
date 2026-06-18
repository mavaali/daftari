# derives_from Direction (foundational-ordering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make birth-mode `derives_from` edge direction reliable by replacing the `derives`/`depends` token with a temp-0 foundational-ordering judgment, loading neighbor content, and representing genuinely-symmetric pairs as direction-unconfirmed edges that don't propagate triggers.

**Architecture:** Direction becomes a *derived* edge property (per-observation `premiseVote` collapsed into a `directionVerdict`, like `status`/`strength` today), elicited with a foundational-ordering prompt at temperature 0. Symmetric pairs are stored as canonical-sorted edges with `directionVerdict="symmetric"` that the event/decay clocks skip. A real-prose + symmetric-emission validation experiment gates the whole build.

**Tech Stack:** TypeScript/Node, vitest, better-sqlite3, the existing `src/curation/edges.ts` (append-only JSONL + materialized SQLite) and `src/consolidate/` loop subsystem.

**Spec:** `docs/superpowers/specs/2026-06-17-derives-from-direction-design.md`

---

## File Structure

- `scripts/pools/v2/direction-realprose-experiment.mjs` — **new**, the §4 validation gate (Task 0).
- `src/eval/llm.ts` — **modify**, add `temperature?` to `CompleteOpts`, forward to `messages.create`.
- `src/consolidate/derivation-prompt.ts` — **new**, shared foundational-ordering elicitation + `{related, premise}` verdict + parser.
- `src/curation/edges.ts` — **modify**, `premiseVote` on `ObserveEdgeInput`/`RawEdgeRecord`, accumulate in `EdgeState`, `directionVerdict` on `DerivesFromEdge`, collapse rule in `deriveEdge`.
- `src/storage/index-db.ts` — **modify**, `direction_verdict` column + `SCHEMA_VERSION` bump + drop-list entry; `DerivesFromEdgeRow`.
- `src/consolidate/clocks.ts` — **modify**, `eventDue` + `decayBackstopDue` skip `directionVerdict==="symmetric"`.
- `src/consolidate/birth.ts` — **modify**, new `loadNeighborContent` dep, content loading + truncation, foundational elicitation at temp 0, write `premiseVote`, symmetric→pending edge + tension; replace `parseBirthVerdict`/`VALID_VERDICTS`.
- `src/consolidate/decorrelation.ts` — **modify**, reuse `derivation-prompt.ts` (F3).
- Consolidate CLI cost path (locate in Task 8) — **modify**, reflect neighbor-content input tokens.

Tests mirror `src/` under `test/` (project convention).

---

## Task 0: Validation GATE — real-prose direction + symmetric emission (kill conditions)

**This task gates everything below. If a kill condition fires, STOP and report — do not implement.**

**Files:**
- Create: `scripts/pools/v2/direction-realprose-experiment.mjs`
- Create (output): `scripts/pools/v2/direction-realprose.results.json`, append a "Real-prose direction validation" section to `docs/superpowers/drafts/2026-06-16-stage2-decorrelation-verdict.md`

- [ ] **Step 1: Assemble ~25–30 real-prose directional pairs + ~10 genuinely-symmetric pairs.** Source directional pairs from `experiments/exp1-info-vs-priors/draft_novel.json` (`from_claim` = conclusion, `to_premise_true` = premise) and a handful from Daftari's own docs. Hand-write ~10 genuinely-mutual pairs (each claim conditions the other — e.g. supply/demand price equilibrium, predator/prey population coupling). Store as `scripts/pools/v2/direction-realprose-pairs.json` with `{id, premise, conclusion}` (directional) and `{id, a, b, mutual:true}` (symmetric).

- [ ] **Step 2: Adapt `direction-experiment.mjs` into `direction-realprose-experiment.mjs`.** Reuse the both-orders + foundational-prompt machinery. **Pin `temperature: 0`** (already the case). Add a symmetric block: present each mutual pair, score whether the model returns `symmetric`.

- [ ] **Step 3: Run it.**
Run: `node scripts/pools/v2/direction-realprose-experiment.mjs`
Expected: a table of accuracy / order-consistency / DOC1-bias for the directional pairs, and a symmetric-emission rate for the mutual pairs.

- [ ] **Step 4: Check kill conditions.**
  - Directional accuracy ≥ 85% AND DOC1-bias ∈ [40%, 60%] → PASS.
  - Symmetric emission: the prompt returns `symmetric` on a **majority** of the genuinely-mutual pairs → PASS.
  - If EITHER fails: STOP. Write the result, and surface to the human — the §3.3 pending path or the elicitation prompt needs rework before implementation.

- [ ] **Step 5: Commit the gate result.**
```bash
git add scripts/pools/v2/direction-realprose-experiment.mjs scripts/pools/v2/direction-realprose-pairs.json scripts/pools/v2/direction-realprose.results.json docs/superpowers/drafts/2026-06-16-stage2-decorrelation-verdict.md
git commit -m "test(consolidate): real-prose direction + symmetric-emission validation gate"
```

---

## Task 1: `CompleteOpts.temperature` passthrough

**Files:**
- Modify: `src/eval/llm.ts:10` (`CompleteOpts`), `:65` and `:124` (`messages.create` calls)
- Test: `test/eval/llm.test.ts`

- [ ] **Step 1: Write the failing test.** Assert that when `temperature` is set on the opts, the SDK `create` mock receives it; when unset, no `temperature` key is sent (preserves provider default).
```ts
it("forwards temperature when set, omits when unset", async () => {
  const create = vi.fn(async () => ({ content: [{ type: "text", text: "ok", citations: null }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" }));
  const client = makeClientWith(create); // helper that injects the mock Anthropic
  await client.complete({ model: "m", system: "s", user: "u", temperature: 0 });
  expect(create.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  await client.complete({ model: "m", system: "s", user: "u" });
  expect(create.mock.calls[1][0].temperature).toBeUndefined();
});
```

- [ ] **Step 2: Run it — expect FAIL** (`temperature` not on `CompleteOpts`).
Run: `npx vitest run test/eval/llm.test.ts -t temperature`

- [ ] **Step 3: Implement.** Add `temperature?: number;` to `CompleteOpts`. In both `client.messages.create({...})` calls, conditionally include `...(opts.temperature !== undefined ? { temperature: opts.temperature } : {})`.

- [ ] **Step 4: Run — expect PASS.** Also run the full `llm.test.ts` to confirm no regression.

- [ ] **Step 5: Commit.**
```bash
git add src/eval/llm.ts test/eval/llm.test.ts
git commit -m "feat(eval): optional temperature passthrough on CompleteOpts"
```

---

## Task 2: Shared `derivation-prompt.ts` — foundational-ordering elicitation

**Files:**
- Create: `src/consolidate/derivation-prompt.ts`
- Test: `test/consolidate/derivation-prompt.test.ts`

Verdict shape:
```ts
export type PremiseSide = "A" | "B" | "symmetric";
export interface DerivationVerdict { related: boolean; premise: PremiseSide | null; reason: string; }
export const DERIVATION_VERDICT_SCHEMA = { /* JSON schema: related:boolean, premise:enum, reason:string */ } as const;
export const DERIVATION_SYSTEM = "You assess whether one document's central claim is a load-bearing derivation of another's, and if so which is the foundational premise. ...";
export function derivationUserBody(aPath: string, aContent: string, bPath: string, bContent: string): string { /* foundational-ordering question, no [template:] tags, no derives/depends token */ }
export function parseDerivationVerdict(raw: unknown): Result<DerivationVerdict, Error>; // replaces birth's parseBirthVerdict
```

- [ ] **Step 1: Write failing tests** for `parseDerivationVerdict`: accepts `{related:true,premise:"A",reason}`; accepts `related:false` (→ premise ignored); rejects bad `premise`; rejects missing `related`. And a test that `derivationUserBody` contains neither `derive` nor `[template:` and asks for the "premise/foundational" framing.

- [ ] **Step 2: Run — expect FAIL** (module doesn't exist).
Run: `npx vitest run test/consolidate/derivation-prompt.test.ts`

- [ ] **Step 3: Implement** the module. The user body asks: *"Which of DOC A / DOC B is the load-bearing premise — the one that would have to be established first for the other to make sense? If each depends on the other, answer symmetric. If there is no load-bearing derivation either way, set related=false."* Return JSON per schema.

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit.**
```bash
git add src/consolidate/derivation-prompt.ts test/consolidate/derivation-prompt.test.ts
git commit -m "feat(consolidate): shared foundational-ordering derivation prompt + parser"
```

---

## Task 3: Edge store — `premiseVote` in, `directionVerdict` out (collapse rule)

**Files:**
- Modify: `src/curation/edges.ts` — `ObserveEdgeInput:108`, `RawEdgeRecord:159`, `EdgeState:212`, `DerivesFromEdge:94`, `collapse:245`, `deriveEdge:319`
- Test: `test/curation/edges.test.ts` (or the existing edge test file)

**Collapse rule (FIXED per review C1 — there is NO content-hash/epoch primitive on edge records).** Verified: `RawEdgeRecord` (`:159`) has no content hash or edit-epoch, and `collapse()` never reads doc content. So the rule is simply: **among all non-revoked premise votes on the canonical edge — unanimous non-symmetric orientation ⇒ `directionVerdict="directed"`; any disagreement, or any explicit `symmetric` vote ⇒ `"symmetric"`.** Stated semantic (intended, not a bug): because old votes never expire, a *legitimate post-edit direction flip* makes the edge `symmetric`/pending → a tension → human adjudication. A direction change is exactly the kind of thing the loop should surface, so this is acceptable v1 behavior; re-convergence-after-edit is explicitly out of scope (a future "expire votes older than the latest re-birth" refinement).

- [ ] **Step 1: Write failing tests** for the collapse rule (NO stale-epoch test — it's unimplementable):
  - two observes of canonical edge `(a,b)` both voting premise=`to` → `directionVerdict === "directed"`.
  - two observes voting opposite premises (`from` vs `to`) → `directionVerdict === "symmetric"`.
  - an explicit `premiseVote:"symmetric"` observe → `directionVerdict === "symmetric"`.
  - a single directed vote → `"directed"`.
```ts
it("collapses agreeing premise votes to directed", () => {
  const edge = deriveFromRecords([obs("a","b",{premiseVote:"to"}), obs("a","b",{premiseVote:"to"})]);
  expect(edge.directionVerdict).toBe("directed");
});
it("collapses split premise votes to symmetric", () => {
  const edge = deriveFromRecords([obs("a","b",{premiseVote:"to"}), obs("a","b",{premiseVote:"from"})]);
  expect(edge.directionVerdict).toBe("symmetric");
});
```

- [ ] **Step 2: Run — expect FAIL.**
Run: `npx vitest run test/curation/edges.test.ts -t direction`

- [ ] **Step 3: Implement.**
  - Add `premiseVote?: "from" | "to" | "symmetric"` to `ObserveEdgeInput` (`:108`) and `RawEdgeRecord` (`:159`) — optional, so legacy records (no vote) are simply not counted.
  - In `EdgeState` (`:212`), accumulate the set of seen non-revoked premise votes (e.g. a `Set<"from"|"to"|"symmetric">` or two counters).
  - In `deriveEdge` (`:319`), compute `directionVerdict: "directed" | "symmetric"` per the rule above; add `directionVerdict` to `DerivesFromEdge` (`:94`). Edges with zero votes (legacy) default to `"directed"` (preserves today's from/to as authoritative — no behavior change for pre-existing edges).

- [ ] **Step 4: Run — expect PASS** + full `edges.test.ts` green.

- [ ] **Step 5: Commit.**
```bash
git add src/curation/edges.ts test/curation/edges.test.ts
git commit -m "feat(edges): premiseVote observe field + derived directionVerdict (collapse rule)"
```

---

## Task 4: SQLite materialization — `direction_verdict` column + schema bump

**Files:**
- Modify: `src/storage/index-db.ts` — `DerivesFromEdgeRow:819`, `derives_from_edges` DDL (`:145`), `SCHEMA_VERSION` (`:50`), the **DROP block at `:367-376`** (NOT the comment at `:363-366` — review I4), and `upsertDerivesFromEdge` INSERT (`:832-855`)
- Modify: `src/curation/edges.ts:502-511` — `rebuildEdgesIndex`'s `DerivesFromEdge`→`DerivesFromEdgeRow` mapper must copy `directionVerdict` (review I3 — omitted, the column materializes NULL otherwise)
- Test: `test/storage/index-db.test.ts`

- [ ] **Step 1: Write failing test** — after reindex, the `derives_from_edges` row exposes `direction_verdict`, and an existing-vault open (old schema) triggers a rebuild that materializes the column.
```ts
it("materializes direction_verdict after schema bump", () => {
  const db = openFreshDb();
  // insert an edge with directionVerdict 'symmetric' via the materializer
  expect(readEdgeRow(db, "a", "b").direction_verdict).toBe("symmetric");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Add `direction_verdict TEXT` to the `derives_from_edges` DDL (`:145`); add the field to `DerivesFromEdgeRow` (`:819`); write it in `upsertDerivesFromEdge` (`:832-855`); copy it in `rebuildEdgesIndex`'s row-mapper (`src/curation/edges.ts:502-511`); read it in the edge select. **Bump `SCHEMA_VERSION` "5"→"6"** (`:50`) and add `DROP TABLE IF EXISTS derives_from_edges;` into the existing DROP exec block at `:367-376` (the table is `CREATE IF NOT EXISTS` and excluded from drops today, so the column won't appear otherwise). `.daftari/index.db` is ephemeral → rebuild, no data migration.

- [ ] **Step 4: Run — expect PASS** + `index-db.test.ts` green.

- [ ] **Step 5: Commit.**
```bash
git add src/storage/index-db.ts test/storage/index-db.test.ts
git commit -m "feat(storage): direction_verdict column + schema v6 bump/rebuild"
```

---

## Task 5: Trigger propagation skips symmetric edges

**Depends on Task 3** (`directionVerdict` must exist on `DerivesFromEdge` for this to typecheck). Does NOT need Task 4 — clocks read the in-memory `DerivesFromEdge` from `collapse()`/`deriveEdge()`, not the SQLite row.

**Files:**
- Modify: `src/consolidate/clocks.ts` — `decayBackstopDue` (revoked-skip at `:36`) and `eventDue` (revoked-skip at `:76`)
- Test: `test/consolidate/clocks.test.ts`

- [ ] **Step 1: Write failing test** — a `directionVerdict:"symmetric"` edge does NOT make its (canonical) dependent due via `eventDue`, while a `"directed"` edge does.
```ts
it("symmetric edges do not propagate event triggers", () => {
  const due = eventDue([symmetricEdge("a","b")], [changed("b")], ...);
  expect(due.map(d=>d.path)).not.toContain("a");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** In both clocks, add `if (e.directionVerdict === "symmetric") continue;` alongside the existing `if (e.status === "revoked") continue;`.

- [ ] **Step 4: Run — expect PASS** + `clocks.test.ts` green.

- [ ] **Step 5: Commit.**
```bash
git add src/consolidate/clocks.ts test/consolidate/clocks.test.ts
git commit -m "feat(consolidate): clocks skip direction-symmetric edges in propagation"
```

---

## Task 6: Birth mode — load content, foundational elicitation, symmetric→pending+tension

> **AMENDMENT (option c folded in, 2026-06-17 — gate re-curation chose this).** The real-prose
> gate passed on *clear-direction* pairs but confirmed that genuinely-ambiguous production pairs
> get a confident direction that **flips with presentation order** instead of returning `symmetric`
> (v1: ~71% order-consistency). So birth elicits direction in **BOTH orders** per neighbor and
> reconciles, routing order-disagreement to the same pending path as explicit symmetric. This is
> contained entirely in birth — the store/collapse/clocks/schema (Tasks 3/4/5) are unchanged
> (edges are keyed by ordered `(from,to)` at `edges.ts:205`; birth writes ONE reconciled vote:
> directed = premise on `to`, or canonical-sorted pending). Cost (Task 8) becomes **2 direction
> calls per neighbor**.
>
> **Reconciliation rule.** Per neighbor (after loading content): call the derivation prompt twice
> at temp 0 — order 1 `(A=doc, B=neighbor)`, order 2 `(A=neighbor, B=doc)`. Map each verdict to a
> *real-world* premise ∈ {`doc`, `neighbor`, `symmetric`, `null`}:
> - order 1: premise `A`→doc, `B`→neighbor, `symmetric`→symmetric, parse-fail/`related:false`→see below.
> - order 2: premise `A`→neighbor, `B`→doc, `symmetric`→symmetric.
>
> Then:
> - **either order `null` (parse fail)** → skip neighbor + birth-trace (M3), no observe.
> - **either order `related:false`** → no edge + trace (conservative: detection is the reliable
>   signal; require both orders to agree a derivation exists).
> - **either order `symmetric`** → pending edge (canonical-sorted, `premiseVote:"symmetric"`) +
>   `interpretive` tension, title `"direction-pending (mutual): …"`.
> - **both name the SAME real-world doc as premise** → directed edge, premise on `to`,
>   `premiseVote:"to"`.
> - **orders name DIFFERENT premises (order-contested)** → pending edge (canonical-sorted,
>   `premiseVote:"symmetric"`) + `interpretive` tension, title `"direction-pending (contested): …"`.
>
> Budget: each neighbor now costs 2 calls; check `llmCalls + 2 <= budgetRemaining` and increment
> `llmCalls` by the number of calls actually made (2, or fewer if the first errors).

**Files:**
- Modify: `src/consolidate/birth.ts` — `BirthDeps:21` (add `loadNeighborContent` + `recordTension`), the `userBody(...,"",neighbor)` call (`:199`), the direction mapping (`:219-220`), remove `parseBirthVerdict`/`VALID_VERDICTS` (`:99-119`) in favor of `derivation-prompt.ts`
- Modify: `src/consolidate/index.ts` — `runBirthLoop` (`:396`, called `:282`) constructs `BirthDeps` inline (`:424`) with **positional** args and imports no tension fn. Thread the two new deps through; wire `loadNeighborContent` to the **in-scope `docByPath` map (`:284`)** — content is already in process, NO disk read — and `recordTension` to `addTension(vaultRoot, …)` from `src/curation/tension.ts`.
- Test: `test/consolidate/birth.test.ts`

**Tension kind (FIXED per review C2):** `direction-pending` is NOT a loggable kind — `LOGGABLE_TENSION_KINDS` (`src/curation/tension.ts:34`) is `["temporal","factual","interpretive"]` and `addTension` rejects others. Use kind **`interpretive`** (a contested premise direction is an interpretive tension). Required fields: `title` (e.g. `"direction-pending: <docPath> ↔ <neighbor>"`), `sourceA/claimA` (doc path + its claim), `sourceB/claimB` (neighbor path + its claim), `loggedBy: opts.agent` (principal `agent:curation-loop` — review M5), `kind:"interpretive"`.

- [ ] **Step 1: Write failing tests** (scripted LLM via the shared schema):
  - neighbor content is loaded (truncated to `MAX_DOC_CHARS`) and passed as DOC B (assert the prompt the scripted LLM saw is non-empty for B).
  - **`temperature: 0` reaches the birth `completeJson` call** (assert via the LLM mock — closes the loop Task 1 only tested at the client level).
  - `premise:"A"` (doc is premise) → observe `from=neighbor,to=doc`, `premiseVote:"to"`. `premise:"B"` (neighbor is premise) → `from=doc,to=neighbor`, `premiseVote:"to"`.
  - `premise:"symmetric"` → observe **canonical-sorted** `(from,to)` + `premiseVote:"symmetric"` AND an `interpretive` tension recorded with `loggedBy=opts.agent`.
  - `related:false` → no observe, no tension.
  - load failure or `premise:null` → skip neighbor, record in birth trace, no observe.

- [ ] **Step 2: Run — expect FAIL.**
Run: `npx vitest run test/consolidate/birth.test.ts`

- [ ] **Step 3: Implement.**
  - `BirthDeps`: add `loadNeighborContent: (path:string)=>Promise<Result<string,Error>>` and `recordTension: (input)=>Promise<Result<unknown,Error>>`.
  - Per neighbor: `const nc = await deps.loadNeighborContent(neighbor)` (skip + trace on error); call `completeJson({ model, system: DERIVATION_SYSTEM, user: derivationUserBody(docPath, doc.content, neighbor, truncate(nc.value)), schema: DERIVATION_VERDICT_SCHEMA, temperature: 0 })`.
  - Map verdict→edge: `premise==="B"` → `[docPath, neighbor]`, premise on `to` ⇒ `premiseVote:"to"`; `premise==="A"` → `[neighbor, docPath]`, premise on `to` ⇒ `premiseVote:"to"`; `symmetric` → `[from,to]=[...].sort()` (canonical), `premiseVote:"symmetric"`, then `deps.recordTension(...)` with the `interpretive` payload above; `related:false` or `premise:null` → continue.
  - Delete `parseBirthVerdict`/`VALID_VERDICTS`; use `parseDerivationVerdict`.

- [ ] **Step 4: Run — expect PASS** + `birth.test.ts` green.

- [ ] **Step 5: Commit.**
```bash
git add src/consolidate/birth.ts test/consolidate/birth.test.ts src/consolidate/index.ts
git commit -m "feat(consolidate): birth loads neighbor content + foundational-ordering direction + symmetric pending"
```

---

## Task 7: Decorrelation report reuses the shared prompt (close F3)

**Files:**
- Modify: `src/consolidate/decorrelation.ts` — replace its private `SYSTEM_BASE`/`userBody`/verdict with `derivation-prompt.ts`
- Test: `test/consolidate/decorrelation.test.ts` (existing toy tests must stay green; adjust scripted-LLM verdicts to the `{related,premise}` shape)

**Scope note (review M2):** this is a real verdict-space rewrite, not a light touch. `decorrelation.ts` keys its `FixtureTruth`/`majorityVerdict`/accuracy math (`:291-352`) on the 3-class `derives/depends/neither` token. Mapping `{related, premise}`→fixture truth requires: `related:false`→`neither`; else map the premise side to `derives`/`depends` relative to the fixture edge's `from`/`to`. The toy tests need genuine rewriting.

- [ ] **Step 1: Update the toy/scripted tests** to the `{related,premise}` shape; assert the report still computes per-axis/majority/lift over the shared prompt + the new mapping.
- [ ] **Step 2: Run — expect FAIL** (decorrelation still on old prompt).
- [ ] **Step 3: Implement** the swap; map `{related,premise}` to the report's fixture truth space (`related:false`→neither; premise side→derives/depends relative to fixture from/to).
- [ ] **Step 4: Run — expect PASS** + `decorrelation.test.ts` green.
- [ ] **Step 5: Commit.**
```bash
git add src/consolidate/decorrelation.ts test/consolidate/decorrelation.test.ts
git commit -m "refactor(consolidate): decorrelation report uses shared derivation prompt (F3)"
```

---

## Task 8: Cost estimate reflects neighbor-content tokens

**Files:**
- Modify: the consolidate CLI cost-USD preview (locate: `rg -n "cost|USD|estimate|inputTokens" src/consolidate/index.ts`)
- Test: the CLI/cost test if one exists; else a focused unit test on the estimate function

- [ ] **Step 0 (grep-first, review M4):** `rg -n "cost|USD|estimate|inputTokens|pricePer" src/consolidate/index.ts`. If **no** cost-USD estimator exists, this task is a **no-op** — record that and skip (do not invent one). Only proceed if an estimate is actually computed from input tokens.
- [ ] **Step 1:** Locate the estimate; write/adjust a test asserting per-birth input-token estimate now includes (truncated) neighbor content.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — include `min(neighborLen, MAX_DOC_CHARS)` in the per-neighbor input estimate. **(option c)** the per-neighbor direction elicitation is now **2 calls** (both orders), each sending both docs' (truncated) content → roughly double the per-neighbor input-token estimate vs a single call.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.**
```bash
git add src/consolidate/index.ts test/consolidate/...
git commit -m "feat(consolidate): birth cost estimate includes neighbor content"
```

---

## Task 9: Symmetric-edge consumer audit (review — missing)

Symmetric edges must stay *visible* as an undirected relationship (search/traversal) while NOT being treated as a trusted directed edge. Task 5 covers the clocks; this audits the other consumers.

**Files:** read-only grep + targeted assertions.

- [ ] **Step 1:** `rg -n "DerivesFromEdge|derives_from_edges|directionVerdict" src` — enumerate consumers (the `vault_edges` tool, `search_related`, lint surfaces, any strength/PageRank-adjacent reader).
- [ ] **Step 2:** For each consumer that walks edges for a *directional* purpose (not just listing), confirm it either ignores `directionVerdict==="symmetric"` or handles it sanely. Add a focused test where a symmetric edge is present and assert the consumer's directional behavior is correct (e.g. `vault_edges` still lists it; no directional inference treats it as premise→dependent).
- [ ] **Step 3:** If a consumer mishandles it, fix + test. If all are fine, record "audit clean" in the commit message.
- [ ] **Step 4: Commit.**
```bash
git commit -m "test(consolidate): audit symmetric-edge consumers (listing vs directional)"
```

## Final verification

- [ ] Full suite green: `npm test`
- [ ] Build + lint: `npm run build` (tsc) and the project lint command.
- [ ] Re-run the decorrelation report on v2 with the new foundational prompt + content loading; confirm direction is now recovered (expect majority accuracy to jump vs the −15.69/−23pp token runs). Record in the verdict doc.
- [ ] Spawned task chip `task_9cc996ca` ("Make birth mode load neighbor content") is subsumed by Task 6 — dismiss it.
