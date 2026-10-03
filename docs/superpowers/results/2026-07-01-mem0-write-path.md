# M3 — Mem0's real write path on corpus-B: 33 supersession traps + 6 genuine tensions

**Date:** 2026-07-01. **Item:** M3, `docs/paper/2026-07-01-moderator-review-correction-plan.md`.
**System:** `mem0ai` (PyPI) **v2.0.11**, open-source `Memory` class, `memory.add()`.
**LLM:** `openai/gpt-4o` via OpenRouter, temperature 0. **Embedder:** `fastembed`
(`BAAI/bge-small-en-v1.5`, local ONNX, no API key). **Vector store:** `qdrant`,
`path=":memory:"` (embedded, zero-infra). Single run. **[DATA]**

**Verdict:** mem0's actual `Memory.add()` write path (v2.0.11) is **not** the
ADD/UPDATE/DELETE/NOOP tool-call loop the mem0 paper (2504.19413) describes.
Empirically, across all 78 ingests in this run, **every recorded history event
was `ADD`** — zero `UPDATE`, zero `DELETE` **[DATA]**. Reading the installed
package source confirms why: `_add_to_vector_store()`'s default (`infer=True`)
path is a purely additive extraction-and-hash-dedup pipeline; `_update_memory`
and `_delete_memory` exist as methods but are called only from the *explicit*
`update()`/`delete()`/`delete_all()` API, never from `add()` **[DATA,
`mem0/memory/main.py` in the installed package, lines 831-1150 (sync
`_add_to_vector_store`) vs 1804/1821/1860 (explicit `update`/`delete`/
`delete_all`)]**. So on this version, the keystone question the paper asks
("does a real consolidator overwrite, or keep both, or drop the correction?")
has a third answer neither foil nor daftari anticipated: **it frequently does
none of the three — it silently fails to register the correction at all**,
because its LLM extraction step judges the corrected passage as containing
nothing new relative to what's already stored. On the **33 traps**, the
corrected (governing) ingest added **zero** new memories in **26/33 (79%)**
**[DATA]**. On the **6 tensions**, both editor-certified positions survived as
separate memories in **5/6** **[DATA]** — mem0 never merged or overwrote one
tension position with the other in this run, so the masquerade the keystone
forbids did not occur here, but not because mem0 detected a tension: its
extraction step simply treated the two positions as two unrelated facts about
different things, the same additive default that causes the 79% silent-drop
rate on traps. The paper's "harsher than any deployed architecture" framing
(M3's premise) does not hold for this system/version: the measured failure
mode is coverage, not fabrication.

## Setup

**Corpus:** the paper's corpus-B 39 Wikipedia items, extracted read-only from
the committed consensus-bench fixtures (no reconstruction — see Provenance
below): 33 supersession traps (`staleText`/`governingText` pairs, single-hunk
clean diffs) and 6 editor-certified "no consensus" genuine tensions
(`positionA`/`positionB`, distilled from linked RfCs, second-rater-gated 6/6 in
CB6). **[DATA]**

**Protocol per item — traps:** fresh `Memory` instance (fresh in-process
qdrant collection **and** fresh `user_id`, so items cannot contaminate each
other via mem0's cross-message extraction context). Ingest `staleText`, then
`governingText`, via `memory.add(text, user_id=...)` — chronological order, as
a memory would see the edit stream. Inspect `memory.get_all(filters={"user_id":...})`
for survivors, and `memory.history(memory_id)` for every survivor.

**Protocol per item — tensions:** same fresh-instance discipline. Ingest
`positionA` (status quo), then `positionB` (the contested alternative), in RfC
citation order. Inspect the same way.

**Route/key:** `OPENROUTER_API_KEY` is present in the environment;
`OPENAI_API_KEY` is not. mem0's `OpenAILLM` auto-detects `OPENROUTER_API_KEY`
and routes through `https://openrouter.ai/api/v1` when present (no custom
client plumbing needed — verified by reading `mem0/llms/openai.py` in the
installed package before running). The embedder does **not** get this
auto-routing (OpenRouter has no generic embeddings passthrough), and
`OPENAI_API_KEY` was absent, so `fastembed` (local, zero-key) was substituted
for the embedder only — the LLM write-decision path, which is what this
experiment measures, is unaffected by that substitution. **[DATA]**

**Cost/scale:** 39 items x 2 ingests = 78 `memory.add()` calls, zero errors,
~118s cumulative per-item wall time (LLM + local embedding). Exact per-call
token spend was not separately metered by this harness; at `gpt-4o` list
pricing and the corpus's typical ~150-300 word passages, cost is consistent
with the CB6-scale (~$2-5) budget guard set for this task. **[DATA/estimate]**

## Results — traps (33 stale-then-governing pairs)

| Metric | Count | Share |
|---|---|---|
| Governing ingest added **zero** new memories (correction dropped by the extraction step) | **26 / 33** | 79% |
| Stale ingest added zero new memories | 8 / 33 | 24% |
| Both ingests added zero (fully inert pair — nothing ever entered the store) | 3 / 33 | 9% |
| History events across all surviving memories, this item set | **100% `ADD`, 0% `UPDATE`, 0% `DELETE`** | — |

**`n_survivors` distribution (memories left in the store per item, after both
ingests):** 0 survivors: 3 items; 1: 13 items; 2: 1 item; 3: 6 items; 4: 7
items; 5: 1 item; 6: 2 items. **[DATA]** The store frequently holds *several*
memories per item because mem0 decomposes a single Wikipedia passage into
multiple atomic extracted facts (e.g. one 4-sentence passage yielded 4
separate memories) rather than storing the passage verbatim — this is a
property of mem0's extraction step, not of this harness.

**Hand-verified clause-level reading (spot-checked against the corpus fixture's
`staleText`/`governingText` diff, not just the raw ADD/UPDATE counts above):**
the automated substring/token-run classifier in
`scripts/consolidator-writepath/analyze-results.py` sorted the 33 traps into:

| Verdict | Count | What it means |
|---|---|---|
| BOTH_PRESENT — stale clause never removed, governing clause also present as a separate extracted fact | 11 | The trap's specific changed clause and its replacement both persist as separate memories (mem0 decomposed the passage; neither the original clause nor the corrected one displaced the other) |
| NEITHER_CLAUSE_DETECTED — extraction paraphrased past the token-run detector | 9 | Hand-checked: 4 of these 9 are wikitext/citation-markup-only diffs (link brackets, verb tense) with no substantive fact change — a known corpus property, not a mem0 failure; 2 (trap-06/07) are real corrections that DID land cleanly (verified by hand below) but were missed by the automated detector's clause-level matching; 3 (trap-15/18/22) are substantive edits the extraction paraphrased enough that the detector could not confirm either way — unresolved without further manual reading |
| GOVERNING_ONLY — the detector's loose token-run matched only the corrected clause | 6 | Hand-checked: 3 (trap-08/19/29) are genuine content additions where the "supersession" is really an insertion/expansion, not a value flip; 3 (trap-04/27/31) are false positives from trivial-formatting diffs matching loosely on both sides — **not real evidence of a landed correction** |
| STALE_ONLY — the correction was silently dropped; only the stale clause survives | 4 | The cleanest, most direct hits: trap-01, trap-10, trap-14, trap-21. In every one, `gov_ingest_events` = `NONE` — the governing ingest extracted nothing new at all. Example below. |
| STORE_EMPTY | 3 | trap-02, trap-09, trap-30 — all three are frequently-repeated generic intro/summary sentences (e.g. the article's opening description) that mem0's extractor apparently judged not worth storing on either ingest |

**Worked example (trap-01, the cleanest hit):** `staleText` and `governingText`
are identical except for one clause: *"...persecution of transgender
people..."* (stale) vs *"...restriction of transgender rights..."* (governing)
inside an otherwise-unchanged 4-sentence passage. mem0 decomposed the stale
ingest into 4 separate memories, one of which stores the stale
"persecution of transgender people" framing. The governing ingest — 95%
identical text with only that one clause changed — returned
`{"results": []}`: the LLM's extraction step judged it contained nothing new.
**The correction never entered the store.** `get_all()` after both ingests
still shows only the 4 stale-derived memories; `history()` on every one of
them shows a single `ADD` event, nothing else. **[DATA, full JSON in
`scripts/consolidator-writepath/mem0-writepath-results.json`, `trap-01`]**

## Results — tensions (6 editor-certified "no consensus" pairs)

| Metric | Count |
|---|---|
| Both positions kept as separate surviving memories (no merge, no overwrite) | **5 / 6** |
| Store empty after both ingests (neither position extracted) | 1 / 6 (tension-01) |
| One position overwrote/absorbed the other (the keystone-violating masquerade) | **0 / 6** |

**Worked example (tension-02, COVID-19 response wording):** ingesting
`positionA` ("Trump reacted slowly...minimized the threat...promoted false
information about unproven treatments") produced one `ADD`; ingesting
`positionB` ("the United States recorded more confirmed cases than any other
country...largest economic stimulus in U.S. history") produced a second,
independent `ADD`. `get_all()` after both shows both memories, verbatim in
substance, neither referencing or superseding the other. `history()` on both
is a single `ADD` each. **[DATA]**

**tension-01** (2016 election popular-vote phrasing) is the one exception:
both `add()` calls returned `{"results": []}` — the extraction step treated
both dense, citation-style sentences as not worth storing standalone. This is
a **coverage gap** (nothing was captured, for either side), not a masquerade
(nothing was captured in a way that erased the other side either). **[DATA]**

**Reading:** on the 5 scorable tensions, mem0's default write path did not
manufacture the keystone violation (a tension collapsed into a single
asserted value) — but this is best read as an artifact of its *additive*
default (nothing gets removed by `add()` at all, ever, on this version) rather
than evidence that mem0 "detects" a tension the way daftari's contradiction
detector does. An architecture that never overwrites *anything* cannot
masquerade a tension as a supersession, but it also cannot correct a stale
fact — CB6's forced-foil framing (an LLM required to pick a direction) and
this measured mem0 behavior (an LLM extraction step that just doesn't flag
small deltas as new) are two different failure modes, and the paper should
not conflate them.

## Honest precision and caveats

- **[DATA] Single run, one model, one mem0 version.** `openai/gpt-4o` via
  OpenRouter, temperature 0, mem0ai 2.0.11 (2026-03 vintage per PyPI; current
  as of this run). mem0 is under active development — an earlier or later
  version, or a different LLM behind mem0's extraction step, could show
  materially different ADD/UPDATE/DELETE/NOOP behavior. This run should be
  read as "what mem0 v2.0.11 + gpt-4o did on 2026-07-01," not as a permanent
  characterization of "what Mem0 does."
- **[DATA] The mem0 paper's (2504.19413) documented ADD/UPDATE/DELETE/NOOP
  architecture does not match the installed v2.0.11 package's default
  `add()` behavior.** The docstring in `mem0/memory/main.py` still says
  *"an LLM is used to extract key facts from 'messages' and decide whether to
  add, update, or delete related memories"* — that description is now stale
  relative to the code beneath it. `_update_memory`/`_delete_memory` are real,
  reachable methods, just not reachable from `add()`'s default batch pipeline.
  This is worth stating plainly in the paper rather than assuming the
  documented architecture is what ships.
- **[HYPOTHESIS] The 79% silent-drop rate is likely inflated by this
  corpus's specific shape** (long, mostly-static passages with a one-clause
  edit), which is an adversarial case for any extraction-based memory:
  the delta is small relative to the unchanged context, so an LLM asked "is
  there new information here" can reasonably say no even when a downstream
  reader would consider the edit meaningful. **Kill condition:** if a corpus
  of shorter, more atomic single-fact edits (e.g. isolated "X is now Y"
  sentences rather than one clause inside a long paragraph) shows a
  materially lower silent-drop rate under the same harness, this hypothesis
  is confirmed and the 79% number should not be read as mem0's general-purpose
  correction-miss rate — only as its rate on paragraph-embedded clause edits.
- **[DATA] The automated clause-level classifier
  (`analyze-results.py`) is a heuristic, not ground truth**, and was
  hand-spot-checked, not exhaustively verified. Every number in the "Governing
  ingest added zero new memories" table above comes directly from mem0's own
  `add()` return payload (an unambiguous operation-level count, not a text
  match) and is fully trustworthy; the "Hand-verified clause-level reading"
  table is a best-effort classification with 9/33 items flagged explicitly as
  ambiguous or partially wrong on inspection (see the GOVERNING_ONLY row) —
  read it as directional, not exact.
- **[DATA] Zero runtime errors** across all 78 ingests + 39 `get_all` calls +
  history calls on every survivor (0 items in the `errors` list in the raw
  results JSON).
- **[DATA] mem0's extraction is lossy relative to the source text in a way
  distinct from summarization quality**: on the smoke-test preceding this run
  (not part of the 39-item corpus, discarded), mem0 fabricated a specific date
  ("as of July 2, 2026") into an extracted fact that was never in the input
  text. This wasn't measured systematically on the corpus-B run (no ground
  truth for injected-detail hallucination was scored), but it is a visible
  failure mode worth a follow-up experiment if mem0's write path is examined
  further — flagged here rather than silently dropped.
- **What this run does NOT show:** it does not show that mem0 is "worse" or
  "better" than the paper's prompted foils in any single-number sense — the
  foils were scored on fabrication/masquerade rate under a forced-verdict
  task; mem0's default `add()` was never asked to render a verdict at all, so
  it cannot fabricate a direction it was never asked to assert. The correct
  comparison is architectural: daftari and the forced foil both make an
  explicit claim about which value is current; mem0's default write path
  (on this version) makes no such claim and, on this corpus, more often than
  not makes no update at all. M3's premise — that real consolidators have "an
  implicit no-op" that make the forced-foil condition harsher than deployed
  reality — is *partially* supported (mem0 does not manufacture direction
  here) but for a different reason than a designed NOOP output: it is a
  side-effect of an additive-only pipeline failing to detect the delta, not a
  deliberate abstention.

## Provenance

- Corpus extraction: `scripts/consolidator-writepath/extract-corpus-b.mjs`
  (read-only; pulls the 33 scorable trap pairs via the same
  `truePairs(loadDiffsFromFile(...))` call CO2/CB4 use, from the committed
  `integrations/consensus-bench/src/__fixtures__/trump-instance-diffs.json`;
  the 6 tension pairs are transcribed from
  `integrations/consensus-bench/src/consensus-cb6-tension.ts`'s `tensionPairs`
  export into `scripts/consolidator-writepath/cb6-tension-pairs.json`).
  Verified count: 33 traps + 6 tensions = 39, matching the paper.
- Extracted fixture: `scripts/consolidator-writepath/corpus-b-39.json`.
- Harness: `scripts/consolidator-writepath/run-mem0-writepath.py` (single-file,
  `uv run`-executable via inline PEP 723 metadata; `MEM0_WRITEPATH_MOCK=1`
  runs the same ingest/inspect loop on 2 items with a monkeypatched LLM
  response, zero spend, for mechanics verification — this was run first and
  its output discarded before the real run).
- Raw results: `scripts/consolidator-writepath/mem0-writepath-results.json`.
- Hand-verification analysis: `scripts/consolidator-writepath/analyze-results.py`
  and its output `scripts/consolidator-writepath/mem0-writepath-analysis.json`.

## For the paper

This converts §5's "(we did not run Graphiti)" gap into a real run, but the
finding is not the one M3 anticipated. Recommended framing: replace "real
consolidators' write paths have an implicit no-op, so the forced condition may
be harsher than any deployed architecture" with something closer to *"one
real OSS consolidator's default write path (Mem0 v2.0.11), run on the same 39
items, neither fabricated a directional supersession on the 6 tensions nor
reliably registered the 33 corrections — its LLM extraction step silently
dropped 26/33 corrections rather than overwriting or preserving both values.
This is a third failure mode outside the foil/daftari axis: silent
non-registration, not fabrication."* This does not weaken the keystone claim
(no mint occurred here either) but it does mean the "harsher than deployed
reality" framing needs to be replaced with something more specific: deployed
reality, on this measurement, is worse at recall than the forced foil, not
better-abstaining than it.
