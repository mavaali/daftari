# Learned Tension Priority Ranker (Court v1) — Design Spec

**Status:** PARKED (2026-08-04). Stress-test verdict: not demonstrably better than the hand-tuned ranker in the realistic case, and it strains tenets. Killers: (1) won't activate for small/new vaults — the majority case; (2) the training label (resolution latency) is confounded with *ease/recency*, not priority, so the model learns "surface easy things first"; (3) the eval is circular (validates against the same confounded label); (4) it re-centralizes ranking into a model — the exact move `daftari-tension-resolution-design.md` argued against; (5) sequencing — v0 (the data source) isn't even shipped yet. Superseded by → the v0-ship + legibility-v1 plan (`docs/superpowers/plans/2026-08-04-tension-triage-v0-ship-legibility-v1.md`). Revisit a learned ranker only after v0 generates real triage behavior AND with a non-latency priority label + a non-circular eval.

**Status (historical):** draft — awaiting Mihir approval (revised after technical review, rev 2)
**Disclosure:** HELD (local, uncommitted). The learned priority function is the named moat (`mavaali-vault/projects/daftari-tension-resolution-design.md`, "Disclosure posture"). Do NOT commit to the public `mavaali/daftari` repo until v1 ships as a flag to plant, not a hint to leak.
**Bead:** learned tension ranker spec (P1)
**Branch dependency:** builds ON `feat/tension-triage-card` (worktree `.worktrees/tension-triage-card`), which carries the v0 enrichment (`src/curation/tension-triage.ts`, `read-heat.ts`, `court --triage`, `vault_tension_triage`). That branch is **unmerged and disclosure-held**; this v1 branches from it (or lands after it). It is NOT on the main tree / `feat/jit-anchor-pins`.

---

## 1. Problem

`daftari court`'s default docket ranks open tensions with a **hand-tuned** comparator (`src/court/docket.ts::priorityCompare`): aging tier (stale > aging > fresh > unclassified) → blast total desc → oldest → title. Per `daftari-tension-resolution-design.md`, blast × age is a *defensible structural v0 but org-blind*: it answers "what touches the most and has festered longest," not "what is costing this org now." A fresh contradiction on a hot decision doc should beat a stale one in a dead corner; the hand-tuned rank can't know that.

The design doc's unlock: **don't guess weights — learn the priority function from resolution history.** Which tensions humans resolve first (and which they deliberately leave `accepted`) reveals their true priority ordering. The ranker is *compiled from behavior*, not hand-tuned — compilation-over-retrieval (canonical) applied to triage itself.

**This spec designs that learned ranker (v1).** It replaces `priorityCompare` with a function fit from the vault's own resolution history, keeps every thesis-safety invariant the design doc locked, stays interpretable and dependency-free, and — per technical review — is disciplined about the two ways this class of feature silently cheats: **feature leakage** (features that encode the label) and **feature-timing skew** (using present state to explain past behavior).

## 2. Non-goals (explicit YAGNI)

- **Not** resolving tensions. The ranker orders the docket; the ruling stays a human act via the existing `resolveTension` write path. No batch-apply, ever.
- **Not** an LLM ranker. Curation stays deterministic and LLM-free (mirrors the sleep pass). No token cost, no non-determinism in triage.
- **Not** a new heavy ML dependency. No LambdaMART/GBM runtime, no survival-analysis lib. Daftari is TS + better-sqlite3; the fit must be pure TS.
- **Not** cross-vault / federated learning. Trained per-vault on that vault's `tensions.md` (org-specific revealed priority). Single-node, matching where the data lives.
- **Not** reworking `tension_resolve` reversibility (design doc gap 3). The ranker never writes.

## 3. Decisions (recommended — flag any you reject)

> These are my recommendations, grounded in your prior design doc, Daftari's ethos, and the technical review. Reject any and I'll revise before we plan.

- **D1 — Model class: interpretable learned linear weights** over legible features. Small-N regime, deterministic/LLM-free ethos, and the legibility guarantee (a human reads *why* something ranks high) all point here. Every rank carries its per-feature contributions.
- **D1a — Fit method: pairwise-logistic is v1; Cox is the stretch.** (Flipped after review.) At N≈tens–hundreds of resolutions with ~15 features, a Cox partial-likelihood fit is over-parameterized (~10 events/covariate ⇒ needs ~150+ *events* for 15 features) and tie-cursed (latencies are day-granular, so ties are the norm, needing Efron/Breslow). Pairwise-logistic on comparable resolved pairs degrades gracefully, needs no tie approximation, and L2 keeps it stable. Cox stays a documented stretch option.
- **D2 — Training signal: resolution latency, pairwise.** For two resolved tensions i, j that were both open over an overlapping window, the human acting on i before j is a priority-order label. `accepted` counts as an act (see §4). This directly fits "the metric is un-triaged, not un-closed."
- **D3 — Surface: replace court's default docket ranking.** Once active, bare `daftari court` orders by learned priority; `court --triage` stays the unranked enriched card; `vault_tension_triage` stays the unranked agent engine. Below cold-start / below the activation gate, the default falls back to today's `priorityCompare` with an explicit banner. One ranked home, no new mode.

## 4. Data model, label, and the two timing hazards

**Source of truth:** `.daftari/tensions.md` (`parseTensionLog`). Each `TensionEntry` carries `date` (t₀, logged), and on resolution `resolution.resolved_at` (t₁) + `resolution.kind` (superseded|corrected|accepted|invalid) + `kind` (temporal|factual|interpretive|inter-proposal|unspecified).

**Label — pairwise order (D2).** For resolved tensions with computable t₁: latency `L = days(t₁ − t₀)`. Training example = an ordered pair (i, j) where both were open simultaneously and `Lᵢ`/`Lⱼ` give a clear order; target = "i is higher priority than j." Overlapping-window comparability avoids comparing tensions from disjoint eras.

**`accepted` handling (thesis-critical).** `accepted` = terminal SUCCESS (both views deliberately stand), an *act*, so it's an observed event with its own latency. It must NOT be treated as unresolved/low-priority. **But** (review should-fix #3) a long-deliberation `accepted` produces a long latency that the model could read as "deprioritize things like this" — the opposite of intent. **Mitigation:** the §10 spike MUST plot latency stratified by `resolution.kind` before the fit is trusted. If `accepted` is a distinct slow mode, either model resolution-kind as a competing risk or document the explicit assumption "accept-latency ≈ priority" and down-weight. No blind pooling.

### Hazard A — feature leakage (BLOCKER, fixed)
The label lives on the time axis `t₀ → t₁`. Therefore **no age-derived feature may be a covariate.** Excluded from `X`: `ageDays` (= `now − t₀`, and for open tensions that IS the censoring time), `agingTier` (a bucketing of `ageDays`). Age enters ONLY as the survival/latency axis, never as a predictor. A test asserts no age-derived column is present in the feature matrix. (Without this, Harrell's C inflates on the model reading the clock, and the banner would advertise leakage as evidence — §9 invariant 3's honesty depends on this.)

### Hazard B — feature-timing skew (BLOCKER, new — not in v0)
`loadTensionTriage` enriches only **open** tensions from **current** vault state; its features (tier, confidence, and especially the 30-day read-heat window) are *now*-relative. Training labels are historical. Explaining a tension resolved 6 months ago with today's 30-day read-heat, or with a doc's *current* tier/confidence (which may already reflect the resolution), is train/inference skew and partial leakage.

**Fix — as-of feature reconstruction.** Training features for a historical tension are reconstructed **as of its log date t₀**, using the existing snapshot machinery (`src/asof/`, `daftari asof` reads the vault + tension log at a past commit). Specifically:
- `tier`, `confidence`, doc `status`: read from the doc's frontmatter as-of t₀ (git history via asof).
- read-heat: computed over the 30-day window ending at t₀, from the read log as-of t₀ (not the now-window).
- blast, clusterSize, kind, precedents: reconstructed on the as-of graph.
- **Inference (scoring open tensions)** uses present-day features (correct — you're ranking what to look at now). Train-as-of-t₀ / score-as-of-now removes the skew while keeping scoring live.
- **Cost/feasibility gate:** as-of reconstruction per historical tension is the expensive part. The §10 spike measures it on the real log; if per-tension asof is too slow for the training set size, v1 falls back to **time-stable features only** (blast, kind, clusterSize, per-side status) and defers tier/confidence/read-heat to v1.1 — explicitly, not silently.

**Feature set (X), after both fixes:** `blast.primary`, `blast.advisory`, `blast.total`, `blast.maxDepth`, `clusterSize`, `kind` (one-hot), per-side `status`, per-side `decayLevel`, per-side `tier`, per-side `confidence`, per-side read-heat `count` + recency, `precedents` count. All reconstructed as-of t₀ for training; live for scoring. **No age-derived column.**

## 5. Model

**Form:** monotonic linear scorer `priority(x) = Σ wᵢ · φᵢ(x)`; `φ` = normalized transforms (z-score continuous, ordinal for tier/confidence/status, one-hot for `kind`). Higher = surface sooner.

**Fit (D1a):** pairwise-logistic. For each comparable resolved pair, logistic regression on `φ(xᵢ) − φ(xⱼ)` predicts the observed order; L2 (ridge) with a fixed documented λ for small-N stability. No hyperparameter search in v1 (avoids leakage theatre). Cox partial-likelihood is a documented stretch alternative; D1 (interpretable linear weights) holds for either.

**Normalization determinism (review should-fix #5):** z-score means/SDs are **frozen at fit time from the training rows** and stored in `RankerModel.featureStats`. Scoring an open tension applies those frozen stats only — never stats recomputed from the current open set. A test asserts: same entry + same `RankerModel` ⇒ identical `score` and `contributions` regardless of what else is on the docket.

**Interpretability output:** fitted weights are inspectable; each ranked entry reports its top ± feature contributions ("#1: high read-heat + two Tier-1 sides + wide blast"). Legibility guarantee, not nice-to-have.

## 6. Cold-start & activation

- **Activation floor is comparable-pairs-based, not row-count** (review should-fix #4 / Q5). A minimum number of comparable resolved pairs (set from the spike, provisional ~200 pairs) is required before a fit is attempted.
- Below floor: default docket uses today's `priorityCompare`, banner: `learned ranker inactive: <k>/<K> comparable pairs`.
- At/above floor AND past the activation gate (§8): default docket uses the learned rank; banner names it active with the held-out concordance interval vs baseline.
- Honest posture: no garbage rankings from thin data; the user always knows which ranker they're seeing.

## 7. Architecture & integration

**Branch base:** `feat/tension-triage-card` (carries `loadTensionTriage` → `TriageTension` with per-side `{tier, confidence, read_heat}`, blast, kind, age). Verified shape: `TensionTriageResult.clusters[].tensions[]` is `TriageTension`; sides are `TriageSide {path, claim, tier, confidence, read_heat}`. **Note:** `loadTensionTriage` filters to `inScope` (open, non-accepted) — so it is the **scoring** feature path, not the training path. Training needs the as-of reconstruction (§4 Hazard B), which is new code.

**New module:** `src/court/ranker.ts`
- `extractFeaturesAsOf(vaultRoot, tension, t0): FeatureVec` — as-of training features (uses `src/asof`).
- `extractFeaturesLive(triageTension): FeatureVec` — scoring features from the v0 enrichment (one path with the card).
- `buildPairs(resolved): TrainingPair[]` — comparable overlapping-window pairs with order labels.
- `fitRanker(pairs): RankerModel | null` — null below the pair floor; returns `{weights, featureStats, nPairs, heldOut}`.
- `scoreEntry(model, featureVec): {score, contributions}` — pure, uses frozen `featureStats`.

**Wiring in `src/court/docket.ts`:** `buildDocket` gains a ranker path: build pairs from the `rulings` it already loads (+ as-of features), fit; when active, score open entries via `extractFeaturesLive` (reusing the triage enrichment) and sort by score; else keep `priorityCompare`. `DocketEntry` gains optional `priorityScore: number | null` + `contributions`. `Docket` gains `rankerStatus: {active, nPairs, floor, concordance: {point, lo, hi} | null}` for the banner. (Note: today's `DocketEntry` does NOT carry tier/confidence/read-heat — those come from the triage enrichment join, which this work wires in; the earlier claim that they're "already on DocketEntry" was wrong and is corrected here.)

**Renderers:** `src/court/report.ts` (bare `court`): score + banner + top contributions. `court --triage` and `vault_tension_triage`: unchanged (unranked). [Q2: whether to expose the ranked docket via MCP — recommend keep MCP unranked in v1.]

## 8. Evaluation (does learned beat hand-tuned?)

Pre-registered, mirroring your eval discipline:

- **Metric: concordance (Harrell's C)** on held-out resolved pairs — fraction whose predicted order matches actual. 0.5 = coin flip.
- **Protocol: temporal split** (fit before cutoff D, evaluate after) so there's no look-ahead. **With a bootstrap** over the held-out pairs to get a CI, because at this N a single split's C has SE ≈ ±0.05–0.10.
- **Baseline:** current `priorityCompare` scored on the same held-out pairs.
- **Activation gate (review should-fix #4):** learned rank becomes primary only if the **bootstrap lower bound** of `C_learned` exceeds `C_baseline` — NOT a hardcoded 0.03 margin (that was inside the noise band and is removed). Fail ⇒ keep `priorityCompare`, banner says so. **The ranker earns the default slot; it is not granted it.**
- The gate metric is the leakage-free C (Hazards A+B fixed), and the CI is shown in the banner — evidence, not a claim.

## 9. Thesis-safety invariants (from the design doc — non-negotiable)

1. **Advisory only, never batch-apply.** Ranker orders; never resolves. No "accept all."
2. **`accepted` is terminal success.** Triaged-and-left = done. Metric is un-triaged, not un-closed.
3. **Interpretable, and honest about its evidence.** Every rank exposes contributions; the activation banner shows a leakage-free concordance CI, not a bare claim.
4. **Fallback is honest.** Below floor or below the gate, show the hand-tuned rank and name which is active.
5. **Reversibility of resolution** stays out of scope (ranker never writes) but remains an open dependency for the resolve act (design doc gap 3).

## 10. Spike (do first, before the fit — resolves the open ML risks)

A one-to-two-day measurement spike on the **real `tensions.md`** history, producing a short written finding:
- Latency distribution **stratified by `resolution.kind`** (Hazard/accepted check, §4).
- Resolved:censored ratio over time and comparable-pair count (sets the §6 floor).
- Cost of per-tension as-of feature reconstruction (Hazard B feasibility gate — full features vs time-stable-only fallback).
- Whether day-granular ties dominate (confirms D1a: pairwise over Cox).
- Baseline `priorityCompare` concordance on the held-out pairs (the number to beat).
Only after the spike do we commit the fit method, feature set, and floor.

## 11. Open questions

- **Q1 — pairwise-logistic vs Cox:** decided pairwise for v1 (D1a); spike confirms.
- **Q2 — expose ranked docket via MCP?** Recommend keep `vault_tension_triage` unranked in v1.
- **Q3 — two-axis confidence** (feature-research doc): ranker consumes `kind` + per-side `confidence` as-is; no dependency on that unbuilt feature.
- **Q4 — read-heat single-node:** `.daftari/read-log.jsonl` is local + git-ignored ⇒ read-heat single-node in v1; as-of windows still reconstructable from the log's own history.
- **Q5 — activation floor:** pairs-based, provisional ~200; spike sets it.
- **Q6 (new) — as-of cost:** if reconstruction is too slow, v1 ships time-stable features only and defers tier/confidence/read-heat to v1.1 — an explicit, banner-visible degradation.

## 12. Test scenarios (for the plan phase)

- **No age-derived column in X** (Hazard A guard).
- **As-of training features** reconstructed at t₀, not now (Hazard B guard); scoring uses live features.
- Cold-start: below pair floor ⇒ `priorityCompare`, banner shows pair count, no score.
- Activation: past floor AND bootstrap-lower-bound(C_learned) > C_baseline ⇒ learned rank + score + contributions.
- Gate failure: past floor but CI fails ⇒ fallback to `priorityCompare`, banner explains.
- `accepted` treated as observed event (not censored, not auto-low-priority); stratification assumption documented.
- Frozen `featureStats`: same entry + same model ⇒ identical score/contributions regardless of docket composition.
- Determinism qualifier: same `tensions.md` + same `now` ⇒ identical weights/ordering (fit's censoring is `now`-dependent; memoization key includes `now` at day granularity).
- Legacy `unspecified`/id-less tensions excluded from training, ranked/branded unruleable (matches current docket).
- Feature parity: scoring reuses the v0 triage enrichment (one live path).
