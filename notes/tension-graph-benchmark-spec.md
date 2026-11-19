# Benchmark spec: the tension-graph advantage over data-olympus's supersede-chain

**Status:** design doc. Nothing runs. Nothing lands in the paper yet. This decides *what* to measure and *how* before any code.
**Branch:** `mihir/tension-graph-benchmark-spec` (no PR — push only).
**Relates to:** PR #168 (paper draft), and the data-olympus repo (`github.com/knaisoma/data-olympus`, Apache-2.0), inspected at commit-of-clone on 2026-07-03.

> **Build progress (2026-07-03).** Decision-free scaffold (§7 steps 1–3) built and verified; code in `benchmarks/tension-graph/`.
> - **§7.1 reproducibility gate — PASSED.** At pinned SHA `ccaffdb` (v0.2.0), `generate_artifacts` regenerates their committed `report.md`/`results.json` **bit-for-bit identical**. Their baseline is genuinely reproducible.
> - **§7.2 feud corpus generator** — `feud_corpus.py`: 10 co-active contradiction pairs (20 docs), all `status: active`, no supersession link. Disjointness suite `test_feud_disjoint.py` green (5/5); two real fairness leaks were caught by the integrity check and fixed (`repository` as monorepo's distinctive vocab; `tests` in the trophy label).
> - **§7.3 feud query stratum** — `feud_queries.py`: fifth stratum, gold = both sides. **Retrieval sanity: 10/10 feud queries return BOTH live docs via their `Index.search`, with no contradiction signal** — the structural ceiling, shown against their own harness.
> - **§7.5 agent adapter — BUILT, offline-proven.** Contract decided (structured `{answer, evidence_state, cited_docs}`). `agent.py` (Mock + OpenRouter LLMs, contract parse, agent loop with 3a's optional tool call), `substrate.py` (four cell configs), `feud_metrics.py` (deterministic {surface,pick,fabricate,miss} classifier + rates + recovery), `run_feud.py` (runner, `--live`). Full suite **18/18 green**; offline mock run proves the pipeline and the mechanism: lazy-3a collapses to no-tg (surface 0, all pick), 3b surfaces all (delta **+1.0**); diligent-3a closes the gap (delta 0) — showing the 3a↔3b delta is exactly "does a real agent consult the dedicated tool."
> - **Two gates remain before real numbers** (both require explicit go): (1) **billed live run** — swap MockLLM→OpenRouterLLM (`--live`), costs money over the query set; (2) **live-daftari fidelity** — the daftari cells currently reuse data-olympus's `Index` for ranking + take tensions from the manifest (information-faithful for the feud axis); the published run should drive real `vault_search` + `vault_tension_blast`. Neither changes the contract or metrics.

---

## 1. Strategic frame

We measure one axis: **when two live documents contradict and no adjudication exists (a "feud"), does the agent surface the contradiction instead of fabricating confidence?** data-olympus's benchmark cannot run this task, and the reason is structural, not an oversight: its entire model is a *total order*. A document's `status` is one of `{active, accepted, superseded}` (`benchmarks/governance_corpus.py:104–110`), supersession is a chain (old gets `superseded_by`, new gets `supersedes`), and its headline metric — `staleness_error(ranked, current_id, stale_id)` (`benchmarks/metrics.py:51–59`) — *requires a known `current_id`*. A feud has no `current_id`: neither document supersedes the other, both are live, and recency does not resolve it. There is no schema slot for "these two contradict, unresolved," and no metric that detects an agent picking one arbitrarily. daftari has exactly that slot: a `TensionEntry` records `{sourceA, claimA, sourceB, claimB, kind, status, resolution}` (`src/curation/tension.ts:40–62`) — two live sources in contradiction, resolvable to one of `{superseded, corrected, accepted, invalid}`.

**Kill condition, up front:** if a plain supersede-chain (daftari with the tension-graph disabled) answers the feud task as well as tension-logging does, the differentiator is dead and we publish that. The whole benchmark exists to falsify that one claim.

---

## 2. Corpus decision (the fork)

**Recommendation: hybrid (Option A base + a documented, regenerable tension-augmentation).** Concretely: take data-olympus's **governance corpus** (`benchmarks/governance_corpus.py`, not the base `corpus_gen.py`) as the substrate, and add a `_FEUD_TOPICS` generator that injects co-active contradiction pairs by a fixed rule.

Why the governance corpus specifically, and why hybrid:

- **It is genuinely reproducible.** Deterministic (`seed=0`), Apache-2.0, regenerable via `uv run python -m benchmarks.generate_artifacts` (`benchmarks/README.md:57–62`). We can run their harness against our augmentation today with modest work. This is not a closed benchmark — the "can we run it" prerequisite is satisfied.
- **It already has the right bones.** Each topic carries disjoint `trigger_vocab`/`intent_vocab` (`governance_corpus.py:29–90`), deterministic supersession pairs at a fixed fraction (`make_pair = (topic_idx + seed) % 6 == 0`, line 269), and four query strata (`trigger_covered`, `paraphrase_uncovered`, `supersession`, `negative` — `governance_queries.py:29–33`). Our feud category slots in as a fifth stratum built the same way.
- **Comparability is the point.** The paper's claim (PR #168) is that their benchmark measures a *strict subset*. To show a superset we must stand on their substrate, reuse their metric definitions verbatim where they apply, and add exactly one axis. Building a fresh corpus (Option B) forfeits the "same turf" argument and invites "you picked easy queries."
- **The augmentation must be documented and independently regenerable**, or the gaming accusation lands. The `_FEUD_TOPICS` table and its generation rule (below, §3) are checked in, deterministic, and disjoint-by-construction from the supersession topics — mirroring their own `covered/uncovered` disjointness guardrail (`governance_corpus.py:8–11, 239–241`).

Why not the alternatives:

- **Option A pure (reuse their corpus unchanged):** their corpus contains *no* feud cases — supersession is the only contradiction it models. Nothing to measure. Rejected.
- **Option B pure (from scratch):** cleaner attribution but not comparable to their numbers, and it hands reviewers the "cherry-picked queries" objection. Rejected as the base; retained as a fallback only if their governance generator proves too rigid to extend cleanly (low risk — it is plain Python with a topic table).

**Honesty guardrail carried over:** feud topics draw from a table disjoint from both the supersession topics and the distractor topics, so a feud query cannot accidentally be answerable by the supersede-chain. A test asserts the disjointness, exactly as their `governance_corpus` test asserts covered/uncovered disjointness.

---

## 3. Task and query design

**Core task.** Given a query and a corpus in one of three evidence states — `{clean, superseded, feuding}` — the agent must produce (a) an answer and (b) a **confidence signal about the underlying evidence state**. The confidence signal is what makes this more than retrieval: data-olympus's harness is retrieval-only (ranked ids + payload text, `benchmarks/run.py:86–134`); the feud task requires the agent to *say something about whether the evidence is settled*.

**The feud construction rule (the augmentation).** For each feud topic, generate two documents `FEUD-A-<topic>` and `FEUD-B-<topic>` such that:
- Both have `status: active` (neither superseded — this is the load-bearing property).
- They make opposing claims on the same topic (`claimA` contradicts `claimB`).
- They share trigger vocabulary so both are retrievable by the same query (unlike the supersession pairs, where the point is filtering one out).
- No `supersedes`/`superseded_by` link exists between them, and no shared date ordering implies one is newer. Recency is *not* a valid resolution function here — this is the exact property that breaks data-olympus's model.
- In the daftari arms only, a corresponding `TensionEntry` is pre-logged via `vault_tension_log` linking the two paths (see §7 — this is a real corpus-prep step, because tensions live in `.daftari/tensions.md`, not in the documents).

**Query strata** (extending their four with a fifth):

| Stratum | Corpus state | Gold / expected | Source |
|---|---|---|---|
| `trigger_covered` | clean | current_id retrieved | reuse `governance_queries.py` |
| `paraphrase_uncovered` | clean | current_id (hard; keyword methods lose) | reuse |
| `supersession` | superseded | current_id ranked, stale filtered | reuse — the accumulation-corpus spine |
| `negative` | none | abstain | reuse |
| **`feud`** *(new)* | feuding | **surface the contradiction** | new generator |

Feud query text mirrors the supersession template: `"What is the current governing rule for <feud-topic>?"` — deliberately phrased as if a single answer exists, to test whether the agent invents one. N feud queries (recommend N ≥ 20 for a stable rate; one per feud topic, ~15–20 topics feasible from a hand-built table).

**Metrics on the feud stratum:**

- **Correctness under feud** — score each answer `{surface, pick, fabricate}`:
  - `surface` (correct): the answer states both positions and flags them as unresolved / contested. Full credit.
  - `pick` (fail): the answer commits to one side with no contradiction signal. Partial penalty.
  - `fabricate` (worst): the answer states a *synthesized* position not supported by either doc, or asserts one side with confident justification. Full penalty.
  - Scoring: `surface = +1`, `pick = 0`, `fabricate = −1` (or map to a 3-class rate table; see §5).
- **Fabrication rate under feud** = fraction of feud queries scored `fabricate`. The dedicated failure-mode metric.
- **Precision under supersede** (sanity/regression) — run the reused `supersession` stratum on all three cells. Adding tension-logging must **not** degrade the accumulation-corpus win data-olympus reports (`staleness = 0.000`). If daftari-with-tension-graph regresses staleness on supersession queries, that is a bug we surface, not hide.
- **Recovery on resolution** — after `vault_tension_resolve(id, kind: "superseded"|"corrected")` collapses the feud to one side, re-run the same feud query. Correct behavior: the answer switches to the resolved side and stops surfacing the contradiction. This tests whether the primitive is *queryable*, not merely *recordable* — the sharpest test, because a supersede-chain can also record a resolution; the question is whether the agent's answer tracks it live.

---

## 4. Comparison methodology

Three cells:

| Cell | Substrate | Feud representable? | Expected on feud | Expected on supersession |
|---|---|---|---|---|
| **data-olympus** | their `Index.search(status="active")` over the same corpus | No — both docs return as `active`, ranked by FTS, no contradiction signal | `pick` or `fabricate` | `staleness 0.000` (their published win) |
| **daftari − tension-graph** | daftari search + supersede-chain, tension tools *withheld* | No — same structural gap as data-olympus | `pick` or `fabricate` | should match data-olympus |
| **daftari + tension-graph** | daftari search + tension-graph reachable (two variants, below) | Yes — feud is a first-class queryable object | **`surface`** | equal to the middle cell (no regression) |

Cell 3 runs as **two variants**, because the single biggest inspection surprise is that **tensions do not surface in `vault_search`** — the tension-graph is reachable only via the dedicated tools (`src/search/hybrid.ts`, `src/storage/index-db.ts` — no tensions table; confirmed no search integration). That gap is itself a measurable variable, not a blocker:

- **3a — dedicated-tools:** tensions reachable only via `vault_tension_blast`/`clusters`, *not* mandated in the prompt. Tests whether a naive agent — one that just searches — ever discovers the feud on its own.
- **3b — surfaced-in-search:** the harness adapter post-joins search results against `.daftari/tensions.md` by path and injects a `[contested: A vs B]` marker inline, simulating a search-integrated substrate *without shipping a real `vault_search` feature* (~a dozen lines in the adapter; no `index-db` schema change).

**The delta between 3a and 3b is the measured value of surfacing tensions in search.** If 3a already wins, search-integration is polish — ship it later on evidence. If 3a collapses (agent never calls the tool) but 3b wins, the run has *proven* the retrieval surface is necessary, and specifies its shape, before any product code is written. This is why the surface is a benchmark variable, not a prerequisite: building it first would pre-commit the answer and destroy the signal.

- **The accumulation spine (fair comparison):** cells 1 and 2 should track each other on the reused strata. If **daftari − tension-graph loses to data-olympus** on those strata, that is a legitimate, publishable finding — it matches their `staleness = 0.000` result and calibrates our position honestly (per the no-monetization-lens, adversarial-honesty stance). Publish it.
- **The differentiator (unfair-by-design):** cell 3 must win *uniquely* on the feud stratum. The win is not "cell 3 has an extra tool."

**Anti-gaming protocol (load-bearing — read this twice).** A naive design where cell 3 is simply *told* "call `vault_tension_blast` first" would measure tool-availability, not substrate power — a reviewer would call it engineered. To keep the win attributable to the substrate:

- **Identical agent protocol and tool budget across all cells and both cell-3 variants.** Every cell gets the same system prompt, the same "answer the query using the tools available; flag if the evidence is unsettled" instruction, and the same number of tool calls. The *only* difference is what the substrate exposes (dedicated tools for 3a; an inline marker for 3b).
- The tension-graph advantage must come from the substrate *having a queryable object to return* — cell 3 can discover the feud because the tension-graph exists and returns it; cells 1 and 2 cannot, because their substrate has nowhere to store "unresolved contradiction." That is a substrate-representation difference, not a prompt difference — and it holds whether tensions arrive via a tool (3a) or inline (3b), because data-olympus can produce neither.
- **Note on 3b and the gaming optics:** surfacing tensions inline looks *more* natural than a special-tool call, not less — it removes the "you gave one arm a magic tool" smell. The categorical claim survives either way: the point is the substrate *can* carry the `contested` annotation and data-olympus's schema (`status ∈ {active, accepted, superseded}`) cannot.
- **Stretch (optional, strongest form):** give cells 1 and 2 a hypothetical "list any contradictions touching these docs" tool that their substrate simply cannot populate (returns empty because `status` has no `contested` value). Makes the structural inability explicit rather than implied. Flag as a §9 decision — more convincing but more build.

---

## 5. Metrics table (concrete)

Reused **verbatim** from data-olympus (`benchmarks/metrics.py`) on the accumulation strata:

| Metric | Formula (their code) | Applies to |
|---|---|---|
| `recall@k` | `|top_k ∩ gold| / |gold|` (`metrics.py:15–19`) | all strata |
| `precision_signal` | `min(1, gold_tokens / payload_tokens)` (`metrics.py:22–31`) | all strata |
| `staleness_error` | `1 if pos_stale ≤ pos_current else 0` (`metrics.py:51–59`) | supersession only |
| `governance_miss_rate` | frac. queries with no gold in top-k (`metrics.py:62–73`) | all strata |
| `false_positive_rate` | frac. negatives returning anything (`metrics.py:76–83`) | negative only |
| `mean_tokens` | `tokenizer.count(payload)` (`run.py:99`) | all strata |

New metrics (feud stratum only):

| Metric | Formula | Notes |
|---|---|---|
| `feud_surface_rate` | `#{answers == surface} / #feud_queries` | headline win metric; higher better |
| `feud_pick_rate` | `#{answers == pick} / #feud_queries` | the silent-arbitrary-choice failure |
| `feud_fabrication_rate` | `#{answers == fabricate} / #feud_queries` | headline failure metric; lower better |
| `recovery_rate` | `#{post-resolve answer == resolved side ∧ no contradiction flag} / #resolved_feuds` | tests queryability of resolution |

**Answer classification.** `{surface, pick, fabricate}` is not derivable from a ranked id list — it requires reading the agent's natural-language answer. Two options, decide in §9: (a) a rubric-scored **LLM judge** (blind, cross-family — reuse the `OPENROUTER_API_KEY` second-rater pattern already in the repo), or (b) a **structured-output contract** where the agent must emit `{answer, evidence_state ∈ {settled, contested, unknown}, cited_docs[]}` and we score `evidence_state` deterministically against the corpus's ground-truth state. Option (b) is cleaner and cheaper and removes judge variance; recommend (b) as primary, (a) as a validation cross-check on a sample.

Results table shape (one row per cell × stratum, matching their `report.md` layout in `run.py:300–411`; cell 3 emits two rows, `daftari+tg (3a)` and `daftari+tg (3b)`, so the 3a→3b delta is a first-class row in the report):

```
| Cell | Stratum | Recall@k | Staleness | Miss | Surface | Pick | Fabricate | Mean Tokens | N |
```

The **3b − 3a delta on `feud_surface_rate`** is the reported "value of surfacing tensions in search" number that governs whether the real `vault_search` feature earns its place (§9).

---

## 6. Kill condition (hardened)

**Falsification:** if `feud_surface_rate(daftari + tension-graph) − feud_surface_rate(daftari − tension-graph)` is not a measurable, material margin (and correspondingly `feud_fabrication_rate` not materially lower), then the tension-graph primitive is **not** the differentiator we claim. In that case a plain supersede-chain plus good retrieval already handles the feud, and the two-corpus thesis's second corpus buys nothing.

- Publish the negative result. State it plainly in the paper.
- Do **not** publish "we would have won if the prompt were tuned / if we'd given the arm one more tool / if the corpus were larger." Any such rescue is a tell that the primitive isn't carrying its weight.
- Pre-register the margin threshold *before* running (a §9 decision), so the result cannot be graded on a curve after the fact.
- Symmetric honesty: if cell 3 also **regresses** on the supersession spine (staleness climbs above 0), that is a real cost of the primitive and must be reported next to the win.

---

## 7. Implementation plan (order, not timeline)

Concrete build order. No owners, no dates.

1. **Vendored data-olympus harness.** Pin the clone (record commit SHA). Confirm `uv run python -m benchmarks.generate_artifacts` reproduces their committed `benchmarks/results/report.md` numbers — this is the "their benchmark is reproducible" gate. If it does not reproduce, stop and report; the head-to-head claim depends on it.
2. **Feud-augmentation generator** (`benchmarks/feud_corpus.py`, extending `governance_corpus.py`): a `_FEUD_TOPICS` table + a `generate_feud_pairs(dest, seed)` that writes co-active contradicting doc pairs by the §3 rule, plus a disjointness test mirroring theirs.
3. **Feud query generator** (extend `governance_queries.py`): add the `feud` stratum builder; emit into the same `queries.yaml` round-trip format (`write/load_governance_queries`).
4. **Corpus loaders (two targets):**
   - *data-olympus target:* the feud pairs are already valid markdown in their bundle; their `Index` ingests them unchanged (no tension state — that is the point).
   - *daftari target:* a prep script that (i) writes the same docs into a daftari vault, (ii) `vault_index` / `vault_reindex`, and (iii) **pre-logs a `TensionEntry` per feud pair via `vault_tension_log`** (tensions are not in the documents; they live in `.daftari/tensions.md`, `src/curation/tension.ts:97–110`). This is a mandatory, non-obvious step.
5. **Agent adapter** (new; their harness is retrieval-only): a small CLI that, per cell, drives the substrate's MCP surface + an LLM, with the identical prompt/tool-budget of §4, and emits the structured `{answer, evidence_state, cited_docs}` contract of §5. Cell 3 runs twice:
   - *3a — dedicated-tools:* tension tools exposed but not mandated.
   - *3b — surfaced-in-search:* a **post-search join in the adapter** — after `vault_search` returns, look up each result path in `.daftari/tensions.md` and inject a `[contested: A vs B]` marker into the payload the agent sees. This simulates search-integration *without touching `vault_search` or `index-db`* (~a dozen lines). It is a harness affordance, not a product feature; keep it isolated so the real feature decision (§9) stays downstream of the measured 3b−3a delta.
6. **Metrics computation:** reuse `benchmarks/metrics.py` for accumulation strata; add `feud_*` and `recovery_rate` as pure functions in a sibling module. Deterministic scoring of `evidence_state` against ground-truth corpus state. Compute and report the **3b−3a `feud_surface_rate` delta** explicitly.
7. **Recovery pass:** script that calls `vault_tension_resolve` on each feud, then re-runs the feud queries through the cell-3 adapter (both variants).
8. **Report writer:** extend their `write_report` table shape (§5) to include the feud columns and the two cell-3 rows; emit MD (primary) and optionally LaTeX for the paper.

**Prerequisites / gaps surfaced during inspection (must be resolved before or during build):**

- **Tensions absent from search** (`src/search/hybrid.ts` has no tension path). *Not a blocker for the benchmark* — 3a reaches tensions via the dedicated tools; 3b simulates search-integration with an adapter-level post-join (§7 step 5), so no product feature is required to benchmark either. It *is* the reason the anti-gaming protocol (§4) exists, a real product gap worth naming in the paper's limitations, and the thing the 3b−3a delta is designed to price. **Do not build the real `vault_search` integration before the benchmark** — it would pre-commit the answer to whether the surface is needed and destroy the signal.
- **`vault_tension_log` does not validate that `sourceA`/`sourceB` exist** (Explore finding; `tension.ts:135–147`). Harmless here (we control the corpus) but means the prep script must get paths right — no safety net.
- **Blast recomputed per call** (`tension-blast.ts:207–278`, rebuilds reverse-maps each time). Fine at benchmark scale; note if corpus grows large.
- **No concurrency guard on `.daftari/tensions.md`** (read-modify-write, `tension.ts:131–382`). The prep script must log tensions **serially**, not in parallel, or it will corrupt the log.
- **Legacy tensions without `id` can't be resolved** (`tension.ts:48–49`). Irrelevant — we generate fresh, id-bearing entries.

---

## 8. Paper integration

- **Where it lives:** a new empirical subsection inside PR #168's evaluation section, positioned as the *second corpus* of the two-corpus thesis — the accumulation corpus (their turf, reused) shows daftari holds its own on the subset they measure; the feud corpus shows the axis they structurally cannot measure. This is the concrete instantiation of "their benchmark measures a strict subset."
- **Claim it supports:** the keystone — *"a tension may never masquerade as a supersession"* — becomes *measured*, not asserted. The feud stratum is the operational definition of a tension that must not be collapsed into a supersede-chain; `feud_fabrication_rate` is the number that shows what happens when a system has no choice but to collapse it.
- **What it does not claim:** it does not claim daftari beats data-olympus on *their* metrics (it may tie or slightly lose on recall/tokens — publish that). The win is categorical (a task they can't run), not marginal (a better score on a task they can).
- **Prose:** none written here by design. This memo is input to the writing step, not the writing.

---

## 9. Open decisions (need Mihir before implementation)

1. **Corpus fork** — recommend **hybrid** (governance corpus + documented feud-augmentation, §2). Confirm, or override to A-pure / B-pure.
2. **Agent adapter — which LLM, which prompt shape** *(top blocker)*. daftari's own client is Anthropic-only; the benchmark agent can be anything. **DECIDED 2026-07-03: neutral third-party model via OpenRouter** (the `OPENROUTER_API_KEY` second-rater wiring already in the repo) — pre-empts the "you tested on your own stack" objection. **DECIDED 2026-07-04 (b): the structured `{answer, evidence_state ∈ {settled, contested, unknown}, cited_docs[]}` contract**, scored deterministically (§5), over free-text + LLM-judge — kills judge variance. Adapter built against this contract; see §7 build progress.
3. **Anti-gaming form** — minimal (identical tool budget, §4) vs strong (give cells 1–2 a contradiction-listing tool their substrate can't populate). Recommend at least minimal; strong is more convincing but more build.
4. **Publish the `daftari − tension-graph` cell?** — recommend **yes**. It is the honesty move: it shows the supersede-chain-only version of daftari behaves like data-olympus, which both calibrates our position and makes the tension-graph win attributable. (Matches the adversarial-honesty and no-monetization-lens tenets.)
5. **Answer scorer** — deterministic `evidence_state` (recommended) vs blind cross-family LLM judge (the `OPENROUTER_API_KEY` second-rater pattern) vs both. Recommend deterministic primary + LLM-judge on a sample as validation.
6. **Pre-registered margin threshold** for the kill condition (§6) — pick the number before running, not after.
7. **Surface tensions in `vault_search`?** — the benchmark answered this. Read 4 (900 trials, 3 models): on buried feuds, inline surfacing (3b) 0.444 vs dedicated-tool (3a) 0.185 vs baseline 0.022 — **3b beats 3a across every model**, because weaker models don't reliably invoke the tool. This **flips the earlier single-run lean** (which had 3a≥3b). Evidence now favors building tensions-in-`vault_search`: inline delivery is the robust mechanism. Still a follow-on, but the number now points toward the feature, not away. (Confirm on the live-daftari substrate, Phase 2, before committing product work.)

---

## Results log — live reads (2026-07-04)

All runs: OpenRouter, deterministic classifier, offline-stand-in daftari cells (retrieval = data-olympus `Index`; tensions from the manifest). Small n, single run, no repetitions — directional, not final.

**Read 1 — shared regime, gpt-4o-mini (both sides co-retrieve).** Every cell surfaced 1.00, delta 0. Confounded: all cells received both feud docs, so a capable model surfaces the contradiction unaided. Did not isolate the primitive.

**Read 2 — divergent regime, A-perspective query, gpt-4o-mini.** Tension-graph lifted surface 0.00→0.20 (3b) — small. Two confounds found: (1) the query editorialized toward A ("we're standardizing on {A}"), suppressing surfacing even when B was visible; (2) gpt-4o-mini ignored an explicit inline `[CONTESTED]` marker ~2/3 of the time — a weak model doesn't heed a surfaced tension.

**Read 3 — divergent regime, NEUTRAL query, gpt-5.4-mini (confound #1 removed, capable model).** B buried 5/10 topics (honest, non-tuned). Isolated result:

| Cell | surface | pick | fabricate | miss | surface on 5 BURIED topics |
|---|---|---|---|---|---|
| data-olympus | 0.50 | 0.30 | 0.00 | 0.20 | **0/5** |
| daftari-no-tg | 0.50 | 0.30 | 0.00 | 0.20 | **0/5** |
| daftari-tg-3a | 0.90 | 0.10 | 0.00 | 0.00 | **4/5** |
| daftari-tg-3b | 0.80 | 0.00 | 0.10 | 0.10 | **3/5** |

**Conclusion (scoped).** The tension-graph's value is real but **confined to the recall-limited regime**: where retrieval buries one side, the baseline surfaces 0/5 (it cannot surface what it never retrieved) while the tension-graph surfaces 3–4/5 via its id-based link. Where both sides co-retrieve, the substrate adds nothing (all cells surface). This survives the §6 kill condition — tg beats no-tg on feud queries — but only in the buried regime, which must be stated as the honest scope, not inflated to a general claim.

**Two findings beyond the headline:**
- **Model capability is load-bearing.** gpt-4o-mini ignored surfaced tensions; gpt-5.4-mini heeds them. Advisory surfacing needs a capable consumer — recording a tension is necessary but not sufficient (ties to the advisory-vs-autonomous axis).
- **3a ≥ 3b here (delta −0.10).** The dedicated tool matched/beat the inline marker; inline occasionally induced a fabrication/synthesis (compute-model). This is early evidence *against* rushing to build tensions-in-`vault_search` (§9 item 7) — the dedicated tool is at least as good with a capable model.

**Caveats bounding Reads 1–3:** small n; single run; one model family. Superseded by Read 4.

**Read 4 — publication panel, Phase 1 (25 topics, 15 buried; 3 neutral models × 3 reps @ temp 0.7; 900 trials).** Artifact: `benchmarks/tension-graph/results/{trials.jsonl,summary.md}`.

Buried topics (n=135 trials):

| Cell | surface | 95% CI | vs no-tg |
|---|---|---|---|
| data-olympus | 0.007 | [0.000, 0.022] | — |
| daftari-no-tg | 0.022 | [0.000, 0.047] | baseline |
| daftari-tg-3a | 0.185 | [0.120, 0.251] | z=4.39, p=1.1e-5 |
| daftari-tg-3b | **0.444** | [0.361, 0.528] | z=8.20, p=2.2e-16 |

Co-retrieved topics (n=90): all cells 0.69–0.86, overlapping CIs — substrate adds little. Per-model buried surfacing robust: no-tg 0.00–0.07, tg-3b 0.36–0.51, tg-3a 0.04–0.38 (model-dependent) across gpt-5.4-mini / gemini-2.5-flash / gpt-5-mini.

**Publication-grade conclusion (Phase 1).** On feuds where retrieval buries one side, the accumulation baseline surfaces the contradiction essentially never (2.2%, CI to 4.7%); the tension-graph surfaces it 44% inline / 18% via tool, both p<1e-5, robust across three model families. Where both sides co-retrieve, the substrate adds little. The primitive's value is the recall-limited regime, and **inline delivery (3b) dominates the dedicated tool (3a)** — the tool only helps models that reliably invoke it.

**Read 5 — publication panel, Phase 2: LIVE daftari substrate (675 trials).** Real daftari `reindexVault` + `hybridSearch` (embeddings on, `vector=true`) + `addTension`/`listTensions` over a throwaway temp vault; corpus authored daftari-native (retrieval signal in the body). Same 3 models × 3 reps. Harness: `benchmarks/tension-graph/phase2_build_contexts.ts` → `contexts.jsonl` → Python replay (`run_panel.py --contexts`). Artifact: `results/phase2/` + `results/phase2_contexts.jsonl`.

**Fidelity check passed:** daftari's hybrid retrieval buries the divergent side **15/25 — identical to data-olympus's FTS**. Embeddings did NOT rescue the buried side; the recall-limited regime is real on daftari's actual retrieval.

Buried topics (n=135), Phase 1 stand-in → Phase 2 live:

| Cell | P1 stand-in | P2 live daftari | P2 vs no-tg |
|---|---|---|---|
| daftari-no-tg | 0.022 | 0.081 | baseline |
| daftari-tg-3a | 0.185 | 0.422 | z=6.45, p=1.1e-10 |
| daftari-tg-3b | 0.444 | 0.459 | z=6.99, p=2.8e-12 |

Co-retrieved (n=90): no-tg 0.933, tg 0.97–1.00 (daftari's stronger retrieval surfaces these unaided; substrate adds little). Per-model buried robustness: tg-3b 0.42–0.51 across all three; tg-3a model-dependent (gpt-5.4-mini 0.956, gemini 0.044 — doesn't invoke the tool).

**Final conclusion (substrate-validated).** On feuds where retrieval buries one side, the accumulation baseline surfaces the contradiction ~8%; the tension-graph surfaces it ~42–46%, p<1e-10, robust across three model families and across BOTH the stand-in and the live daftari substrate. Where both sides co-retrieve, the substrate adds little. The primitive's value is the recall-limited regime; **inline (3b) is the robust delivery mechanism, the dedicated tool (3a) only helps models that invoke it**. The stand-in caveat is now retired.

**Remaining caveats:** synthetic corpus (25 feud topics / 15 buried); single benchmark family; a real-world corpus would sharpen external validity. This is now a candidate empirical section for the paper (§8).

### Inspection notes (grounding, not decisions)

- data-olympus is real, reproducible, Apache-2.0. Committed results: `data-olympus` staleness `0.000` vs `bm25` `0.050`; on `graph` queries bm25 stales `1.000` while data-olympus holds `0.000` (`benchmarks/results/report.md`). Their win is genuine and narrow — supersession, not contradiction.
- Their supersession is a *total order* by construction (`make_pair` phase rule, `governance_corpus.py:269`); `staleness_error` is undefined without a `current_id`. A feud has none. This is the structural wall.
- daftari's `TensionEntry` is the missing primitive, fully typed and persisted, with a live resolution path (`vault_tension_resolve` → `{superseded, corrected, accepted, invalid}`). The one gap that shapes the design: tensions are not in `vault_search` — reachable only via dedicated tools.
