# Design — Edge-aware coverage retrieval

**Date:** 2026-06-21
**Status:** approved design, pre-implementation
**Lineage:** follows the Recall Bench recall-vs-disambiguation analysis ([#148](https://github.com/mavaali/daftari/pull/148)), the distractor placebo ([#149](https://github.com/mavaali/daftari/pull/149)), and SP-A current-source foregrounding (v1.27.0). Handoff: `docs/superpowers/handoffs/2026-06-21-recall-retrieval-pickup.md`.

## Problem

Recall Bench analysis established that daftari's dominant failure under longitudinal memory is **retrieval recall**, not disambiguation:

- 68% of hallucinations were recall-misses (the relevant days were never retrieved); only 32% were disambiguation. Multi-day questions hallucinated 18.2% vs single-day 9.4%.
- **Oracle arm:** supplying the true relevant span cut recall-miss hallucination 27.8% → 1.3% (same answerer, only context changed). The "confabulation floor" was a mirage; the true ceiling is ~1%.
- **Distractor placebo:** adding co-ranked *stale* docs back to a correct context re-induced hallucination 0% → 28% (disambiguation) / 0% → 19% (recall-miss). Clean context ≈ 0%; stale distractors break it.

So the failure decomposes into **two levers**: (1) **span recall** — assemble the complete cluster of relevant docs; (2) **distractor suppression** — foreground current, demote stale. SP-A (shipped, v1.27.0) is the suppression lever. This feature adds the **recall** lever and composes the two.

### Why "edge-aware" and not "always expand"

On a mature native vault (one-fact-per-file + a dense `derives_from` edge graph), pure lexical coverage is wasteful and noisier — it ignores the curated graph the cortex loop paid to build. But edge-following alone whiffs on cold-start / edge-sparse regions, non-derivational relatedness, and imported journals. The non-wasteful design is **edge-aware**: prefer the edge graph where dense, fall back to bounded lexical/entity coverage where sparse.

### Grounding in a real vault (not just RB)

Probed `inverse-problem-vault` (the live vault the Daftari MCP serves; 32 files, 4 collections, daily `daftari-sweep` agent):

- **Real cluster sizes are 3–7 docs** (`spectral-scaling` = 7, `scaling-laws` = 3, most tags 1–2). A "complete cluster" is small.
- **The edge graph is nearly empty: 2 edges** in `derives_from_edges`, despite weeks of curation. **On the flagship native vault, edge-following has almost nothing to follow.**

Consequence that shapes the design: the **entity+date-window fallback is the common path today**, not an edge case. Edge-following is a future (dense-graph) optimization. This is why the build is **fallback-first** and why the latency worry about edge traversal is moot today.

## Goals / non-goals

**Goals**
- One retrieval primitive that degrades gracefully across vault maturity.
- Improve span recall (assemble the cluster) without minting values or synthesizing prose — daftari authors relation/emphasis, never content.
- Compose recall with the existing SP-A suppression lever.
- Be useful *now* on edge-sparse vaults (journals, cold-start), decoupling value from the cortex/atomization timeline.

**Non-goals**
- No new synthesized content (no "wiki" page). The feature only changes *which existing docs* a call returns and their ordering/annotation.
- No agent-driven search loop. The agent does not control iteration; daftari's only lever is what a single `vault_search` call returns.
- No NL intent-parsing of the query (avoids the SP-A query-conditioning fidelity trap). Signals derive from the *result set* and *doc frontmatter*, not query text.
- No re-ranking of the original relevance order (SP-A already established it does not re-rank; coverage only *adds* and *annotates*).

## The surface

**Folded transparently into `vault_search`.** No new tool, no new param. The agent calls `vault_search` exactly as today and receives a better-covered, de-staled set. Rationale: the agent cannot loop its own search, so the lever must live in what one call returns; a new tool would face a discovery problem and a `mode` param would face the conditioning trap (the agent may never set it).

`vault_search` keeps its existing relevance ranking and return contract. After ranking, two conditional passes run before the response is built:
1. **Coverage pass** — conditionally widens the result set (this feature).
2. **Suppression pass** — SP-A `resolveCurrentSource`, already running at `src/tools/search.ts:150`.

## Mechanism

### Seeds
Take the top-K ranked hits as seeds (K ≈ 3, config-overridable).

### Edge signal (always runs; future dense-graph path)
For each seed, look up its `derives_from` edges **via the materialized SQLite `derives_from_edges` table** (`idx_edges_from` / `idx_edges_to`) — **never** the jsonl-collapsing `listEdges`, which re-scans the whole edge log per call. An edge in `trigger-bearing` status pointing to a doc **not already in the result set** is an incompleteness signal → pull that doc in (1-hop only). Edge strength gating reuses the existing `trigger-bearing` floor; no new threshold is invented.

On real vaults today this is nearly silent (2 edges). It is built second (Stage 2), not first.

### Fallback signal (the path that fires today; entity within a date window)
Fires only when the edge signal added little/nothing **and** the result set looks like a multi-doc cluster:

- **Entity detection (from seed docs, not the query):** the dominant frontmatter tag shared by **≥2 of the top seeds**; if seeds share no tag, fall back to high-overlap content terms (BM25). The ≥2-seeds-agree condition is the "this looks like a cluster" signal — it keeps single-fact queries quiet.
- **Window:** `[min(seedDates) − pad, max(seedDates) + pad]`, anchored on each doc's `created` date (the day it pertains to; config-overridable to `updated`), pad ≈ vault write cadence, hard-max span = `EDGE_HALF_LIFE_DAYS` (90d).
- **Pull:** docs matching the entity **and** falling in the window **and** not already in the result set, via the lexical index. Capped (see Caps).

If neither signal fires (single-fact query / no ≥2-seed shared entity) → return the ranked set unchanged → **zero waste**. This is the answer to the native-vault waste concern: on a mature vault the signal stays quiet.

### Caps (the waste/noise governor; each maps to an observable)
- **`coverageMaxAdd`** ≈ 5 — max docs added beyond the relevance top-N. Grounded in the observed max real cluster size (7) minus typical top-N overlap. Config-overridable.
- **`coverageTokenCap`** — hard ceiling on total returned content tokens (the real backstop). On overflow, drop lowest coverage-value + stale docs first (stale = SP-A `currentSource`-demoted). Protects context regardless of `coverageMaxAdd`.
- **Edge expansion** — 1-hop only, `trigger-bearing` floor (existing).
- **Date window** — bounded span as above, hard-max 90d.

### Net-new index capability
The fallback requires a **date-range query** on the lexical path. The index stores `created` / `updated` but has no range query today. This is the only net-new index capability and is isolated to Stage 1's fallback work.

## Suppression integration (second lever, no new code)

The widened set feeds SP-A's `resolveCurrentSource` (`src/tools/search.ts:150`), which already runs on every search. Stale/superseded docs are demoted + annotated (`currentSource`); current is foregrounded. "Coverage assembles the cluster, suppression cleans it." The coverage pass simply hands SP-A a wider set before it acts. Edges/supersession must exist for suppression to bite (raw imported journals have none; a native vault does) — but suppression failing open (no demotion) is safe, and coverage still helps recall.

## Return shape (backward-compatible)

Same hit array. Added docs carry:
- `viaCoverage: true`
- `coverageReason: 'edge' | 'entity-window'`

`currentSource` annotations are already present from SP-A. Agents that ignore the new flags still receive a strictly better set — no contract break.

## RBAC

The coverage pass must respect the same ACL filter the existing search applies (`canRead(access.role, hit.collection)` at `src/tools/search.ts:140,190`). Added docs are filtered identically; a coverage pull must never surface a doc the caller could not retrieve directly. SP-A's strict-RBAC-degrade behavior (established v1.27.0) applies to the `currentSource` resolution of added docs as well.

## Testing

Tests mirror `src/` structure (project convention). Coverage:
- **Trigger unit tests:** ≥2-seed shared-tag fires; single shared tag does not; no shared entity → quiet; single-fact query → quiet.
- **Caps:** `coverageMaxAdd` truncates; `coverageTokenCap` drops stale-first then lowest-value; window bounds exclude out-of-range docs.
- **RBAC:** an added doc in a collection the caller cannot read is filtered out (alias/canonicalization covered per `feedback_canonicalize_path_keys`).
- **Suppression compose:** a stale added doc is demoted via `currentSource`; current foregrounded.
- **Backward-compat:** existing `vault_search` callers/tests unaffected when no signal fires.
- **Native sanity (inverse-problem-vault):** quiet on single-fact queries; assembles the 3–7 cluster on entity queries.

## Measurement

- **Offline recall/coverage:** on RB `questions.jsonl` (`integrations/recall-bench/results/ea-180d-partial-2026-06-21/`, has `qa.relevantDays` + `retrieval[].path`) — does the assembled set now contain the missed `relevantDays`? recall@k / span-coverage metric.
- **End-to-end:** re-run the oracle harness (`/tmp/oracle-recall.mjs`) substituting the feature's retrieval for daftari's raw retrieval; measure hallucination drop toward the ~1% oracle ceiling.
- **Native sanity:** the inverse-problem-vault checks above.

## Staging (fallback-first — driven by the empty-edge-graph finding)

- **Stage 1 — entity+date-window fallback + suppression + caps.** Includes the net-new date-range query. The path that actually fires on real (edge-sparse) vaults today; delivers measurable value immediately. Ships the recall lever composed with SP-A suppression.
- **Stage 2 — edge 1-hop expansion** via the SQLite `derives_from_edges` table. The future dense-graph optimization; near-silent today.
- **Stage 3 — measurement harness wiring:** offline recall metric + oracle re-run.

Each stage is independently shippable and testable, matching the SP-A/B/C rhythm. The net-new date-range query is contained in Stage 1.

## Risks / open items

- **Entity precision.** "Dominant shared tag" can over-pull on a coarse tag. Mitigated by ≥2-seed agreement + caps + SP-A demotion of stale members. Watch in native-sanity tests; refine the term-overlap backup if tags prove too coarse.
- **Window anchor (`created` vs `updated`).** Journal day-docs make these equal; for revised native docs they diverge. Default `created`; config-overridable. Revisit if native vaults show drift.
- **Latency at scale.** Bounded by reading the SQLite edge index (not the jsonl) + one capped lexical query. Negligible today; re-measure if a vault grows large or the edge graph densifies.
- **Token cap eviction order.** "Lowest coverage-value + stale first" needs a concrete value function in Stage 1; start simple (rank position + `currentSource` staleness) and refine against the offline metric.
