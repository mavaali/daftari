# Fable review — multi-hop retrieval epic (`mavaali-beads-off`)

**Date:** 2026-08-17
**Reviewer:** Fable (adversarial plan review — no code shipped, this attacks the epic's reasoning before any child is claimed)
**Source verified at:** `bc9d3d3` (v3.7.0; HEAD adds only two dependency bumps on top — `881fc70`, `70c6e72` — no source changes)
**Epic under review:** `mavaali-beads-off` — thesis: *span recall is the measured bottleneck, not synthesis*, and the unused deterministic graph operators can close the multi-document recall gap. Children `.1`–`.5` per the epic packet.

**One line:** GO-WITH-CHANGES — the bottleneck diagnosis holds, but the epic ignores the second causally-confirmed lever (distractor suppression), its core bet's kill condition is currently unrunnable on any existing corpus, and the priority order is inverted: the cheap quantity knobs must run first as the honest baseline the structural bet has to beat.

---

## What was re-verified for this review [DATA]

- Ranking core unchanged since the June benchmarks. Only three commits touched `src/search/` after 2026-06-22; the one substantive one (`097ad3b`, federation slice 2) adds a `vault` field to hits and refactors `relatedSearch` seed extraction — the score formula, fusion weights, `VEC_KNN_K = 64` (`src/search/hybrid.ts:126`), and the coverage pass are untouched. **The June numbers are not stale with respect to the ranker.** The staleness caveat in the grounding finding is real but points at the corpus, not the code (see finding 4).
- The 2026-06-21 recall doc's resolution records **two** confirmed levers, not one: the oracle arm (27.8% → 1.3% hallucination on the recall-miss subset when the true span is supplied) **and a clean-distractor placebo**: adding the co-ranked stale distractors back to an otherwise-correct context re-induced hallucination 0% → 28% (disambiguation) / 0% → 19% (recall-miss). The doc's own decision line: *"the retrieval-recall feature should do BOTH — raise span recall AND foreground against stale distractors."*
- The coverage kill (2026-06-22) decomposes into three failure causes: (1) the window structurally can't reach the relevant days (ceiling 0.52 even uncapped); (2) added-day precision 5.7% at `m=5` — ~4.7 distractors per 0.3 relevant docs added; (3) plain relevance beats date-proximity in 32% of questions.
- `derives_from` candidate edges are **born from each doc's top-K embedding neighbors** (`src/consolidate/birth.ts`), zero-strength until re-derivation earns trust. `topicEgoGraph` BFS (`src/canon/topic.ts`) traverses **all non-revoked edges regardless of strength** — zero-strength embedding-neighbor candidates are topic links.
- Neither eval surface can currently run `.1`'s kill condition: the RB journal corpus has labeled `relevantDays` but **zero derives_from/tension edges** (raw journal, consolidation loop never run on it); the native-vault harness (`integrations/recall-bench/gen-native-vault.mjs`) is one-fact-per-file with no edges and no multi-hop labels.

---

## Findings, severity-ranked

### 1. The epic contradicts its own grounding evidence: every child widens, none suppresses (CRITICAL)

All five children add documents to the candidate set. The placebo arm proved stale distractors are *causally* hallucinogenic (0% → 28%), and the coverage experiment measured what widening costs: at `m=5`, ~16 distractors per relevant doc added. A child can win its recall gate and still make the product worse — recall up, hallucination up. The 2026-06-21 doc already made this call: raise span recall **and** foreground against stale distractors, together. The epic dropped the second half.

**Required change:** add a distractor-suppression child (supersession-aware demotion / `superseded_by` foregrounding, the SP-A mechanism the placebo rehabilitated) as a P1 peer of `.1`, and make **every** child's kill condition score hallucination (or at minimum distractor load), not recall alone. This also answers probe 5: the 32% disambiguation slice is not out of scope — the placebo shows it is largely distractor-caused, and the oracle floor is ~1.3%, so suppression covers it. No synthesis-side child is needed.

### 2. `.1`'s kill condition is unrunnable today — no corpus has both edges and labels (CRITICAL)

"Edge-expansion recall vs rank-extension recall at equal add budget" requires a corpus with (a) a labeled relevant set and (b) a real edge graph. RB has (a) and not (b); the native fixtures have neither for multi-hop. Building `.1`'s retrieval integration before this surface exists means the kill condition gets evaluated on whatever corpus is convenient at the time — unfalsifiable in practice. This is half of why the epic needs a blocking `.0` (finding 9 is the other half).

### 3. `.1`'s mechanism is weaker than "different in kind" — the edge graph is substantially a projection of the embedding space retrieval already searches (HIGH)

Candidate `derives_from` edges are seeded from top-K **embedding neighbors**, and the BFS traverses them at zero strength. One hop from the top hits along embedding-neighbor edges largely re-explores vector neighborhoods of the seeds — the same space whose ranking already failed to surface the span (recall-miss cases retrieved 37 docs and still missed it). What genuinely differs from the coverage failure: edges encode **doc-to-doc** similarity rather than query-to-doc similarity, and they are temporally unconstrained — so edge expansion escapes coverage failure #1 (the window that can't reach a scattered span). Tension edges are the more differentiated signal (born from contradiction, not similarity) but are sparse. [HYPOTHESIS] Edge expansion's recall gain over rank-extension is small on embedding-born edges; the aligned signal, if any, lives in tension edges and *earned* (trigger-bearing) derivation edges. **Kill condition for this hypothesis:** the $0 reachability arm below shows edge-ceiling recall materially above the rank-extension curve at matched budget.

**Required change:** `.1` starts with a **$0 edge-reachability ceiling arm** — for each labeled question, the fraction of missed relevant docs within one hop of the top-10 seeds, computed as pure graph arithmetic before any retrieval integration. This is the exact analog of the structural-ceiling computation (0.52) that killed coverage before a dollar was spent. Run it three ways: all edges, trigger-bearing-only, tensions-only. If the ceiling doesn't clear the rank-extension curve at matched budget, `.1` dies for $0.

### 4. The staleness worry aims at the wrong target: the numbers aren't stale, they're corpus-narrow (HIGH)

Since the ranker is unchanged (see verification), re-running the bench at 3.7.0 will almost certainly reproduce the June numbers — that re-run is cheap insurance (the harness is committed), not the real issue. The real fragility: every number the epic rests on comes from **one corpus** — a tag-less, edge-less journal where 71% of multi-day spans are exactly 7-day weeks. The epic generalizes "span recall is THE bottleneck" from a corpus that structurally cannot exercise the mechanisms (edges, tags) its core bet depends on. The `.0` child must therefore do more than re-confirm: it must **produce the edge-bearing labeled corpus** `.1` will be judged on (run the consolidation loop over the RB vault to birth edges, or generate a native vault with a labeled multi-hop relevant set — the 2026-06-22 doc already flagged this exact gap for coverage's tag half).

### 5. Priority order is inverted: the cheap quantity knobs are the baseline, so they run first (HIGH)

Rank-extension dominates coverage at every budget and keeps climbing (0.292 at +5 → 0.531 at +50). `.3` is a config-level sweep of a single constant (`VEC_KNN_K = 64`, best-chunk-per-doc collapse — plausibly saturating on a 180-file journal with long dailies). Together, `.2a` + `.3` define the **quantity frontier**: recall *and* hallucination as a function of budget, for retrieving-more. That frontier is the honest bar `.1` must beat — running it last (P3) means the epic spends its structural bet before knowing whether a one-line constant change closes most of the gap. Note the same evidence bounds the quantity play: "not a top-N artifact" (37 docs retrieved, span still missed) and the 0.531 plateau say widen-only won't finish the job — which is exactly why it's the *baseline*, not the answer, and why it must be measured first, with hallucination scored (per finding 1, +50 docs means +dozens of distractors; the placebo predicts that hurts).

### 6. `.2` is mis-specified: half of it is already decided, the other half is `.1` in disguise (MEDIUM)

Option (a) — retire the date-window pass and rank-extend — does not depend on `.1` at all: the kill already tripped on 2026-06-22 and rank-extension dominated at every budget. Unblock it from `.1` and run it with the `.3` sweep. Scope the retirement correctly: the kill condemned the **date-window half on journals** only; the discriminating-tag half was untestable on RB and stays pending the native corpus from `.0`. Option (b) — edge-guided widening — is the `.1` bet restated; keeping it in `.2` double-runs the same hypothesis under two child IDs. Delete `.2b`.

### 7. `.4` is negative-value without a hard staleness gate (MEDIUM)

Surfacing a compiled artifact via `consumes` edges when its sources have since changed is the placebo experiment run in production: a confidently-wrong, high-authority distractor injected at rank time. Daftari already computes exactly the guard needed. `.4` survives at P3 only with: surface the artifact only if it passes the staleness check, has no open tensions, and is not superseded — and its kill condition scores **hallucination**, not recall. Without the gate, kill it.

### 8. `.5` answers the wrong question — reranking is a precision lever aimed at a recall bottleneck (MEDIUM)

The agent is already the reranker by explicit design (`src/search/hybrid.ts:87-114`; `rerank_candidates` returns a pool plus instructions, and the server never calls a model). A server-side reranker (i) breaks that invariant and (ii) permutes the retrieved set — but the 68% failure mode is the relevant doc **not being in the set**. Reranking cannot recall what was never retrieved. If reranking has a role in this epic it is as suppression (demote stale distractors within the pool), which belongs to the new suppression child as agent-side foregrounding discipline. Drop `.5` from the epic, or reframe the POV to "why server-side reranking is the wrong lever" and close it.

### 9. No shared frozen baseline — cross-child comparison is currently meaningless (MEDIUM, cheap to fix)

Each child names a recall/hallucination hypothesis against no common snapshot. Required `.0` (blocking, P0): freeze the RB corpus snapshot + pinned 3.7.0 commit; one baseline `recall-runner` run recording recall **and** hallucination per budget; extend the harness to score distractor load; produce the edge-bearing labeled corpus (finding 4). Every child's kill condition scores against this snapshot. The harness is committed and reproducible — this is days, not weeks.

---

## Verdict on the epic

| Child | Verdict |
|---|---|
| **`.0` (new)** | **Add, blocking.** Frozen baseline + hallucination scoring + edge-bearing labeled corpus. Nothing else lands first. |
| **`.1`** | **Keep as the core bet, gated.** $0 reachability-ceiling arm first (three edge subsets); build the retrieval integration only if the ceiling clears the quantity frontier at matched budget. Prior is weaker than the epic assumes (finding 3) — this is a bet worth pricing, not a bet worth pre-committing to. |
| **`.2`** | **Split.** `.2a` unblocked from `.1`, runs with `.3` as the quantity-frontier baseline; retirement scoped to the date-window half. `.2b` deleted (duplicate of `.1`). |
| **`.3`** | **Promote to run first** (with `.2a`). It is the honest baseline, not a P3 afterthought. |
| **new: suppression** | **Add at P1**, peer of `.1`. Supersession-aware demotion / foregrounding. Causally confirmed by the placebo; the epic is incoherent with its own evidence without it. |
| **`.4`** | Keep at P3 **only** with the staleness/tension/superseded gate and a hallucination-scored kill condition; otherwise kill. |
| **`.5`** | Drop, or reframe the POV as "reranking is a precision lever, not a recall lever" and close it. |

**Correct order:** `.0` → (`.2a` + `.3` quantity frontier) + suppression child → `.1` $0 ceiling → `.1` build (only if ceiling clears) → `.4`.

**GO-WITH-CHANGES** — the span-recall diagnosis is sound and freshly re-verifiable, but as scoped the epic would spend its most expensive child first, against no runnable kill condition, while ignoring the second lever its own experiments proved causal.

---

## Addendum — reconciliation against the Linear beads (2026-08-17, post-review)

The review above was written from the packet's summary of the children; the actual beads (Linear `MAV-155` epic; children `MAV-154` = `.1`, `MAV-156` = `.2`, `MAV-159` = `.3`, `MAV-157` = `.5`, `MAV-158` = `.4`) were read afterward. The packet summary was faithful — **no verdict changes**. Deltas worth recording:

- **`MAV-156` (.2) is better than the packet suggested:** its acceptance criteria already specify the three-arm A/B (coverage-off+rank-extend vs coverage-on vs edge-guided), so the rank-extend arm is not in fact blocked by `.1` in the bead itself — only the edge-guided arm is, and that arm still needs the edge-bearing corpus from `.0`. Finding 6's split stands; the bead is already halfway there.
- **`MAV-158` (.4) already names the staleness guard** ("guard against stale-artifact false positives via staleness signal") — finding 7 should be read as *sharpening* that guard (hard gate: staleness-pass ∧ no open tensions ∧ not superseded) and as changing the scoreboard: the bead measures recall/precision delta; the placebo evidence says the metric that decides `.4` must be hallucination.
- **The epic body already says** "rerun recall bench as the shared eval harness for every child" — so finding 9's `.0` is partially anticipated, but the bead-level gap remains: no frozen snapshot, no hallucination/distractor scoring in the harness, and no edge-bearing labeled corpus, which is what actually makes the kill conditions comparable and `.1`'s runnable.
- **Confirmed missing in the beads, as the review claims:** no `.0` baseline child, and no distractor-suppression child — the epic's children are all recall-widening.
- Bookkeeping: the five children are not linked as sub-issues or blockers of `MAV-155` in Linear (no parent/relations set), so the `.2b`-depends-on-`.1` ordering exists only in prose.
