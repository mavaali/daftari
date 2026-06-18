# Design — reliable `derives_from` direction (foundational-ordering elicitation)

**Date:** 2026-06-17. **Status:** design, pending spec review + real-prose validation gate.
**Supersedes** the "direction is a loop-design blocker" framing in
`docs/superpowers/drafts/2026-06-16-stage2-decorrelation-verdict.md` — the blocker was
falsified (see that doc's "Direction-elicitation experiment" section).

## 1. Problem

The cortex loop's core primitive is a **directed** `derives_from` edge: trigger propagation
flows premise→dependent (change a premise ⇒ its dependents become due for re-derivation). Birth
mode (`src/consolidate/birth.ts:218`) currently sets that direction from the LLM's
**`derives`/`depends` token**:

```js
const [from, to] = parsed.value.verdict === "derives" ? [docPath, neighbor] : [neighbor, docPath];
```

Two measured findings make this unsafe:

1. **The derives/depends token is a broken interface for direction.** In the Stage-2
   decorrelation runs, `reverse` emitted "depends" on 18/18 derives pairs; gemini emitted
   "derives" on essentially every directional pair. This *looked* like "direction is unreliable
   across models." It is not — see finding 3.
2. **Birth judges with no content for the neighbor** (`userBody(axis, doc.content, docPath, "",
   neighbor)` — empty DOC B). Under that path-only condition, derivation detection collapses to
   **0/18**; the model cannot judge a derivation it cannot read.
3. **Direction IS reliably recoverable with the right prompt.** A direction-elicitation
   experiment (30 known-direction pairs × both orders × 3 methods × 3 models, temp 0) showed a
   **foundational-ordering** prompt ("which claim is the load-bearing premise / must be
   established first?") recovers direction at **~100% accuracy, ~100% order-consistency, ~50%
   position-bias (unbiased)** on *all three* models, including the gemini that looked
   direction-blind under the token. The token method trailed (90–100%). The capability was
   always there; the token was the problem.

## 2. Goals / non-goals

**Goals:** birth (and the revision panel) establish edge direction reliably and without
position/token bias; derivation existence is judged with adequate information; genuinely
mutual/symmetric pairs are not forced into a fabricated direction.

**What we keep vs drop on accumulation (reconciled after spec review):** the store *already*
accrues **existence/strength** over independent re-derivations (entrenchment-resistance,
freshness) — that is unchanged. What we drop is **direction-de-biasing-by-accumulation**: the
earlier design assumed systematic per-vote *direction* bias that votes must average out, and the
experiment showed no such bias under foundational-ordering. So **direction is a deterministic,
per-observation judgment (temp 0, §3.1), not a panel-accrued property.** The only special path
is genuine symmetry (§3.3). Existence accrues; direction does not.

**Non-goals (explicit YAGNI):**
- **No de-biasing accumulation for direction**, per above. Direction does not get its own k-vote
  trust budget.
- **No cross-session "opposite premises ⇒ contested" backstop.** (Cut on review: the revision
  panel votes `survives`/`fails` on a *fixed-direction* edge and never re-elicits a premise, so
  this would be a new mechanism, not reuse — and temp-0 determinism removes the variance it
  guarded against.)
- **No structural-signal direction engine** (timestamps/citations). Not needed for directed
  pairs. (A future tie-breaker for hard symmetric cases; not in scope.)
- **No multi-model direction panel.** A single temp-0 foundational-ordering call on the loop's
  default model suffices.

## 3. Design

### 3.1 Foundational-ordering elicitation (replaces the token)

A shared module `src/consolidate/derivation-prompt.ts` exposes the **birth-mode**
detect+direct elicitation, replacing `birth.ts`'s private `SYSTEM_BASE`/`userBody` copy and the
duplicate in `decorrelation.ts` (the report reuses it so it measures exactly what birth runs —
closing F3). **Scope note (review I5):** the **revision** panel (`revision.ts`) uses a
*different* verdict space (`survives`/`fails` on an already-directed edge) and is NOT unified
here — it may share only doc-formatting/`SYSTEM_BASE` text, not the verdict schema. Revision
does not re-elicit direction.

The birth judgment returns:

```
{ related: boolean,            // is there a load-bearing derivation at all? (the reliable signal)
  premise: "A" | "B" | "symmetric" | null,  // which doc is the load-bearing premise
  reason: string }
```

- **`related`** — the undirected question the models are near-perfect at (detection + promiscuity
  rejection). `related=false` ⇒ no edge (the `neither` case).
- **`premise`** — foundational-ordering: "Which of DOC A / DOC B is the load-bearing premise —
  the one that would have to be established first for the other to make sense?" `symmetric` when
  each depends on the other; `null` only on parse failure ⇒ skip the neighbor + record in the
  birth trace (the existing `parseBirthVerdict` reject-and-continue path, `birth.ts:101-119`).
- Edge mapping (matches the store convention — `clocks.ts:56` "an edge from→to means `from`
  depends on `to`"): `from = the non-premise doc (dependent)`, `to = the premise doc`. For
  `premise === "symmetric"` see §3.3.
- **Temperature 0 (review I1).** Direction is a factual judgment, not a creative one; the
  experiment's accuracy/unbiasedness was measured at temp 0, and determinism is *desirable* here
  — we do not want a stored edge's direction to flip on sampling noise. Birth's direction call
  pins `temperature: 0` via a new optional field on **`CompleteOpts`** (not `CompleteJsonOpts` —
  review IMPORTANT-2), consumed in `complete` and forwarded by `completeJson`'s internal spread
  (`src/eval/llm.ts:94`); `llm.ts` currently sends no temperature ⇒ provider default 1.0.
  Existence/strength votes elsewhere keep their varied/independent sampling; only the direction
  elicitation is pinned.
- **New parser, not reused (MINOR-3):** the `{related, premise}` verdict space replaces birth's
  current `VALID_VERDICTS`/`parseBirthVerdict` (`birth.ts:99-119`); the plan writes a new parser
  that *mirrors the reject-and-continue pattern*, it does not call the old one.

The prompt is presentation-order-agnostic by construction (asks for a content role, not "does A
derive from B"); validated at ~50% position-bias.

### 3.2 Load neighbor content

Birth must pass the neighbor's content as DOC B, not the empty string. The caller already holds
the docs map; load the neighbor's content, **truncated to `MAX_DOC_CHARS` (1500)** to bound cost
(the `birth.ts:189-195` comment warns ~20× per-doc cost — truncation + the existing compute
budget bound it). Update the `--model` cost-USD estimate to reflect the larger inputs.

> **AMENDMENT (option c, 2026-06-17).** The real-prose validation gate (verdict doc,
> "Real-prose direction validation") passed on clear-direction pairs but confirmed that
> genuinely-ambiguous production pairs receive a confident direction that *flips with
> presentation order* rather than `symmetric`. So §3.1's birth elicitation runs in **both
> orders** per neighbor and reconciles: agreement ⇒ trusted directed edge; order-disagreement
> ⇒ routed to the §3.3 pending path (same as explicit `symmetric`), with a tension titled
> "direction-pending (contested)". Self-contained in birth; the data model below is unchanged.

### 3.3 Symmetric tail — a pending *directed* edge (review C3)

The store has no representation for "a derivation that is not a directed edge"
(`observeEdge` requires `from ≠ to` and writes a directed record; `contestEdge` needs a
pre-existing edge). So `symmetric` must still produce a directed edge — but one whose direction
is **not trusted**:
- `premise === "symmetric"` (with `related=true`) ⇒ write the edge with a **canonical sorted**
  `(from, to)` (deterministic, so re-observation lands on the same edge, not a flipped twin) and
  `directionVerdict = "symmetric"`. The undirected relationship is thus preserved in the graph
  (`search_related`/traversal still see it); only its *direction* is marked unconfirmed.
- Open a `direction-pending` tension via `vault_tension_log` so a human can adjudicate or split
  the docs. Tension is advisory (CLAUDE.md), authored under the loop principal
  `agent:curation-loop` (review M2).
- **Trigger propagation skips direction-unconfirmed edges** — see §3.4 for the concrete
  `clocks.ts` change this requires (it is NOT free today).

### 3.4 Data model — direction is *derived*, like strength (review C2/C1)

The edge store lives in `src/curation/edges.ts` (durable append-only observe/contest JSONL;
the SQLite row in `src/storage/index-db.ts` is *materialized* by `collapse()`/`deriveEdge()`);
the consolidate-side write wrapper is `src/consolidate/edge-write.ts`. `status` is already a
*derived* field (`deriveEdge`, `src/curation/edges.ts:319`). Direction follows the same pattern,
not an "additive column":

- **Each observe record carries the observation's premise vote**: extend `ObserveEdgeInput`
  (`src/curation/edges.ts:108`) and `RawEdgeRecord` (`:159`) with `premiseVote: "from" | "to" |
  "symmetric"` (which endpoint this observation judged the premise). Birth writes it from §3.1.
- **`deriveEdge` collapses the votes into a `directionVerdict`** field on `DerivesFromEdge`
  (`:94`) + a `derives_from_edges` column on `DerivesFromEdgeRow`/DDL
  (`src/storage/index-db.ts:819`).
- **Collapse reconciliation rule (review IMPORTANT-3 — was under-specified):** group an edge's
  `premiseVote`s by **content-hash epoch** (votes recorded before either endpoint was edited are
  stale — this reuses the existing edit-invalidation notion). Among current-epoch votes:
  *unanimous* orientation ⇒ `directionVerdict = "directed"` (with that orientation); *any genuine
  split, or an explicit `symmetric` vote* ⇒ `"symmetric"`. Because direction is temp-0
  deterministic (§3.1), unanimity is the normal case; a split signals genuine symmetry (or a
  post-edit direction change, which *should* re-open the question). A symmetric edge becomes
  directed only through this collapse on future agreeing votes — there is no separate
  "promote symmetric→directed" path and no flipped-twin edge (MINOR: canonical sort guarantees
  re-observations land on the same key).
- **SQLite materialization (review IMPORTANT-1 — not just a DDL line):** `derives_from_edges` is
  `CREATE TABLE IF NOT EXISTS` and is **excluded from the schema-bump drop list**
  (`src/storage/index-db.ts:363-366`), so a new column will *not* appear on existing vaults
  unless the plan (a) bumps `SCHEMA_VERSION` (currently `"5"`, `:50`) and (b) adds
  `DROP TABLE IF EXISTS derives_from_edges` to the migration block. The `.daftari/index.db` is
  ephemeral (rebuilt from JSONL), so this is a rebuild, not a data migration — but it must be
  carried explicitly or the column silently never materializes.
- **Trigger-propagation change (review C1 — the real work, not additive):** `eventDue` and
  `decayBackstopDue` (`src/consolidate/clocks.ts:36,76`) today skip only `status === "revoked"`.
  They must additionally **skip `directionVerdict === "symmetric"`** edges so direction-unconfirmed
  edges don't propagate. A small but explicit change to the propagation filters; not free.
- Envelope/RBAC: a symmetric/pending edge is below trigger-bearing trust ⇒ stages/surfaces,
  never auto-acts (the loop is `ratify:false`).

## 4. Validation plan + kill conditions

**GATE (must pass before implementation is trusted in shadow):**
- **Real-prose direction validation, at the production temperature (review I1).** Run the
  foundational-ordering experiment **at temp 0** (the pinned production setting, §3.1) on ~25–30
  *real-prose* derivation pairs (Daftari's own docs + exp1 real-prose pairs in
  `experiments/exp1-info-vs-priors/draft_novel.json`), each shown in both orders. **Kill
  condition:** accuracy on clear-direction real pairs < 85%, or position-bias outside 40–60%.
- **Symmetric emission, explicitly validated (review I2 — the §3.3 path has the least evidence).**
  The 30-pair experiment never tested whether the model *correctly emits* `symmetric` — every
  pair was clear-direction and `symmetric` was scored as wrong. Add ~8–10 hand-built
  **genuinely-mutual** pairs (each claim conditions the other) and a few clear-direction
  controls. **Kill condition:** if the prompt does not return `symmetric` on a majority of the
  genuinely-mutual pairs (i.e. it fabricates a direction where none exists), the §3.3 pending
  path is unsafe — either improve the prompt's symmetric sensitivity or fall back to "low-margin
  ⇒ pending" on a confidence signal.
- **Detection-with-content.** Confirm loading neighbor content restores detection (full-content
  18/18 vs path-only 0/18 on v2 — re-confirm on the birth path).

**Ongoing (shadow):** once the loop seeds real edges, compare path-only vs content-loaded
verdicts (the knob `birth.ts:189-195` already names) and track direction-contested rate.

## 5. Testing

TDD against `test/consolidate/birth*.test.ts` and the revision panel tests. Unit-test the
foundational-ordering parse + the premise→edge-direction mapping (incl. the symmetric →
no-edge + pending path) with a scripted LLM. The decorrelation report harness is reused to
measure the foundational prompt's accuracy on the v2 + real-prose fixtures.

## 5b. Open implementation action-items surfaced by review

- **M1 — locate the cost estimate.** §3.2's content-loading raises input tokens ~20×; find and
  update the `--model` cost-USD preview (in the consolidate CLI cost path, not yet located) so it
  reflects neighbor content. A planning step, not a defect.
- **M3 — parse-failure path.** `premise === null` ⇒ skip the neighbor and record in the birth
  trace (mirror `parseBirthVerdict`'s existing reject-and-continue), never write an edge.
- **`CompleteJsonOpts.temperature`** passthrough must be added in `src/eval/llm.ts` (currently
  no temperature is sent ⇒ provider default 1.0) for the §3.1 temp-0 pin.

## 6. Out of scope / deferred

Structural direction signals; multi-model direction; the full accrue-and-verify de-biasing
architecture; any change to the `derives`/`depends` *fixture* labels (the v2 fixture stays a
2-class promiscuity+detection set). Multi-action passes and live event-hooks remain v2 per the
parent spec.
