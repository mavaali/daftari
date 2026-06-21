# Handoff — ContextForge verdict, why daftari loses SP1, and the current-state projection design

**Date:** 2026-06-21 (long session; supersedes the earlier same-day `2026-06-21-sp2-killed-sp3-atomization-pickup.md`)
**One-line:** SP1 baseline shipped; SP2 + SP3-doc-detection killed on the same intra-document wall; ContextForge verified to beat daftari on Recall Bench *cheaply*; concluded RB is the wrong scoreboard; then resolved the core ethos question and designed a daftari-native **current-state projection** (foreground, don't mint). Next: spec **SP-A (foreground)**.

---

## 1. What shipped / measured

- **SP1 baseline RUN + DONE.** daftari on Recall Bench EA-180d (27/30 ckpts, 1,489 Qs): **composite 81.8% / 6, hallucination 15.2%, appellate 22.6%.** Curve flat in the low-80s (no degradation cliff — smoke's 86→62 was small-n noise). Hallucination concentrates in temporal-robustness categories: recency-bias-resistance 28%, decision-tracking 24%, synthesis 21%; best temporal-reasoning 2%, contradiction-resolution 10%. Hallucinations are **verified-real supersession** (daftari returns stale revised values; answerer reports them confidently). Results: `docs/superpowers/results/2026-06-21-recall-bench-baseline.md`.
- **`daftari@1.26.0` is live on npm.**
- **Judge runs on OpenRouter, no Azure:** `judge: openai:openai/gpt-5.4-mini` + `OPENAI_BASE_URL=https://openrouter.ai/api/v1`, `OPENAI_API_KEY=<openrouter key>` in the profile's `env.file`. The `openai:` shorthand drops the `;endpoint` spec form — use the env var. Profile: `integrations/recall-bench/profiles/ea-180d-daftari.yaml`.
- **COST LESSON:** the full opus answerer run cost **~$400 (~$25 / 7 min)** — ~3× the estimate. Driver: ~1.8 full-document `vault_read`/Q on long dailies, re-sent across a cumulative agent loop (~4.8 tool calls/Q), **no prompt caching**; the adapter also discards per-call token counts. Before ANY future answer-quality run: prompt-cache the transcript, cap `maxRounds`/trim `vault_read`, sonnet for comparison arms, log tokens.

## 2. What was killed, and the wall behind both

- **SP2 (supersession-aware ranking): KILLED** in spec review. EA supersession is **intra-document** — the current and stale values co-reside in the same daily (`day-0100` has both "$465M current" and "$510M superseded"; `q001`/`q002` share `relevant_days:[1]`). Ranking can't separate two values inside one doc. `docs/superpowers/results/2026-06-21-sp2-ranking-premise-killed.md`; killed spec `…/specs/2026-06-21-sp2-supersession-ranking-retrieval-test-design.md`.
- **SP3 doc-level detection: KILLED** in spec review (same wall). Verified: **zero pure-stale docs** — every doc with "7:00" also has "6:30" (11/11), every doc with "510" also has "465" (81/81). No stale-only doc to anchor a (stale→current) gold edge. **The spec `…/specs/2026-06-21-sp3-supersession-detection-design.md` still needs a KILLED header added** (TODO).
- **Lesson:** the EA journal corpus defeats *every doc-level* supersession approach. The unit must be sub-document (atoms) — or the corpus must change.

## 3. What was learned cheaply — the extraction-fidelity probe (PASSED, $0.04)

Ran Haiku atom-extraction on the 4 correction dailies (`/tmp/atom-probe.mjs`). **Extraction is faithful:** on both correction days Haiku emitted two same-attribute atoms with distinct values + correct current/superseded status + grounded source quotes (day-19: 6:30 current / 7:00 superseded; day-100: $465M / $510M retired). No merging, no hallucinated values. Full corpus atomization ≈ $2. Surfaced the *next* two risks: (1) **attribute labels aren't canonical across docs** (same fact → `briefing_time_preference` / `morning_briefing_time` / `weekday_briefing_time`) — an atomize→detect pipeline needs a canonicalization layer; (2) clean status capture **leaned on explicit markers** — silent supersession (new value, no "superseded" word) is untested and is the harder half. `docs/superpowers/results/2026-06-21-sp3-extraction-fidelity-probe.md`.

## 4. The competitive verdict — ContextForge (the big finding)

Verified against the **real source** (`Betanu701/ContextForge`, re-cloned at `/tmp/cf-verify`; 2★ alpha, that's why web search surfaces namesakes — the popular contextforge.dev is a *different* product).

- **CF beats daftari on RB, same harness + same judges:** CF wiki-stateless 500d = **85.8% / 1.6% hallucination**; CF stateless-expanded 180d = 80.5% / 7.9%; daftari SP1 = 81.8% / **15.2%**; OpenClaw baseline 18.8% halluc. (CF numbers are self-run, reproducible.)
- **How:** CF's consolidation is **pure deterministic regex, no LLM** (`contextforge/wiki.py`). It (a) builds a current-state "wiki" the answerer reads instead of raw dailies, and (b) detects supersession via `_STATUS_WORDS["superseded"]={changed,superseded,replaced,no longer}` + a Change-Log page from `_CHANGE_WORDS`. It keeps raw as authority (lossless-ish too).
- **The catch:** CF's win **leans on the corpus narrating its own corrections in keyword-matchable prose**. By construction (regex + recency) it should degrade on *silent* supersession — but **RB has none of those**: verified across all 6 personas, **every correction has `correctedDay > wrongDay` (newer always correct)** and `irrelevant_after` is a recency cutoff. **RB supersession is 100% recency-resolvable.**
- **Therefore:** daftari's LLM cortex loop has **no demonstrable niche on RB** (the only place LLM beats free recency/regex is recency-fooling cases; RB has zero), and CF already wins RB's metric cheaply. **RB is the wrong scoreboard for daftari.** daftari's real moat is governance (MCP server: RBAC, git versioning, write/process locks, multi-user — CF has none) + lossless audit, which RB doesn't measure.
- **Recommendation: stop the RB-supersession *experimental* thread.** Keep SP1 as the honest published baseline.

## 5. Why daftari loses SP1 (mechanism)

daftari hands the answerer **raw co-resident dailies** (up to 15, several restating both values); the answerer picks the stale one ~15% of the time. CF hands its answerer a **pre-resolved current-state page**. daftari isn't losing on recall — it's losing on **disambiguation**: it never tells the answerer which value is current, because (a) `hybrid.ts:210` ranks BM25+vector only and ignores the `superseded_by`/decay it computes; (b) supersession is intra-doc so rank can't help anyway; (c) **daftari refuses to synthesize by design** ("edges, not prose"). Caveats: we ran daftari at its *floor* (raw, no consolidation) vs CF's *designed* mode; and answerer/embedding models differ (Opus+MiniLM vs gpt-5.4+CF-wiki). But the stale-pick mechanism is daftari-specific and verified.

## 6. The ethos resolution + the design (THE forward work)

**The question:** should daftari add a current-state projection, or does that betray its ethos? **Resolved — the line, given the cortex "edges not prose" thesis:**

> **daftari may author the RELATION and the EMPHASIS; it must never author the VALUE.** Foreground the current source via the `superseded_by` edge; the value is always read from a human source, never minted. CF *mints* a value into a wiki — that's the betrayal. daftari *points*.

Two invariants: **(1) relation, not value; (2) inform, not decide** (current foregrounded; stale demoted-but-returned-and-labeled; agent can override; lossless; **query-conditioned** — "what was the original?" still surfaces the stale first). A projection consistent with this is a **current-state *index*, not a *page*.** This isn't a new betrayal — it **completes the cortex thesis's unfulfilled promise**: daftari computes the supersession/decay signal and currently throws it away at rank.

**Decomposition (too big for one spec; this is for daftari's PRODUCT, not to chase RB):**
- **SP-A — Foreground (the projection). The clear win: cheap, ethos-pure, independent.** Make the existing `superseded_by`/decay signal load-bearing — when an edge exists, foreground the current source, demote-but-keep-and-label the stale, query-conditioned. Works for *already-acquired* edges (explicit `vault_supersede`). *(This is SP2 done right — at edge/atom level, as foregrounding not just rank, scoped to where edges exist, not the raw RB corpus.)* **← spec this first.**
- **SP-B — Acquire** edges without a human each time: explicit `vault_supersede` (today) → marker/recency heuristics (cheap, CF's move, constraint-#2-tense) → LLM cortex detection (expensive, **unproven** — RB showed no case where it beats free recency).
- **SP-C — Atomize** so edges target clean atoms (intra-doc fix). Biggest build; extraction proven feasible (§3), canonicalization is the hard part.

**Value-per-cost is inverted from build intuition:** SP-A is cheapest + most ethos-completing + independent; SP-B/SP-C are progressively more expensive and less proven. **Recommendation: spec SP-A first; gate SP-B/SP-C on a real use case that explicit `vault_supersede` doesn't cover. Do NOT build the expensive halves to chase RB.**

## 7. Recommended next action

Spec **SP-A (foreground)** via the normal brainstorm→spec→plan flow. It's the daftari-native answer to CF (foreground current via the edge graph, never mint a value) and completes the cortex thesis. Independent of the expensive/unproven halves.

## 8. Housekeeping / state

- **Branch `docs/recall-bench-sp1`** (off main, commit `ed8acbc`) holds: SP1 baseline result, SP2-kill finding, killed SP2 spec, the earlier sp2-killed handoff, the profile, `.gitignore`. **Uncommitted on it:** SP3 detection spec (needs KILLED header), SP3 extraction-probe finding, this handoff. Nothing pushed (per repo rule: push only when asked). The ~41 pre-existing untracked items predate this work — leave alone.
- **NOT yet written to docs:** the ContextForge verification findings (§4) and the ethos/projection decomposition (§6) live only in this handoff — consider promoting §6 to a proper design doc when speccing SP-A.
- **MEMORY UPDATES PENDING** (currently understate the CF threat / overstate the RB programme):
  - `project_contextforge` — add: CF *beats* daftari on RB (85.8/1.6 vs 81.8/15.2) via free deterministic regex+recency; wins lean on marker-narrated corpora; doesn't change "adoption threat ≈ zero" but is a real *capability* result.
  - `project_recall_bench_experiment` — add: RB supersession is 100% recency-resolvable (all personas), so daftari's LLM has no niche on RB; RB is the wrong scoreboard; experimental thread concluded; pivot to the §6 projection (product, not benchmark).
  - Consider a new `project_currentstate_projection` (or fold into `project_cortex_consolidation_loop`) capturing the §6 ethos line + SP-A/B/C.
- **Clones:** `/tmp/recall-review` (RB harness, built), `/tmp/cf-verify` (ContextForge). Ephemeral — re-clone if gone (`git clone https://github.com/Betanu701/ContextForge`). Probe script `/tmp/atom-probe.mjs`.
- **Keys:** `integrations/recall-bench/.env` (gitignored) — `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` (OpenRouter) + `OPENAI_BASE_URL`. Mihir's billed keys — live spend.

## 9. Memory pointers

`[[project_recall_bench_experiment]]`, `[[project_contextforge]]`, `[[project_cortex_consolidation_loop]]`, `[[reference_recall_bench]]`, `[[reference_consolidate_budget_cost]]`, `[[project_deletion_is_not_a_memory_op]]`, `[[project_overfunctioning_assistant]]` (advisory-vs-autonomous axis), `[[project_daftari_paper]]`.
