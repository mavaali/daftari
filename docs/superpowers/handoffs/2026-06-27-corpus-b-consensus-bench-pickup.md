# Handoff — Engram → market-question KILL → corpus (B) consensus-bench started

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms` (NOT pushed)
**Suite:** consensus-bench 8 tests green, tsc clean. New commits this session: `f579239`, `a4378be`(prev), `f6bd2bb`, `a074054`, `20ac256`, `f5cab2f`.
**One-line:** Researched Engram (the efficiency pole) → it forced the untested "is no-mint worth money?" link → ran a revealed-cost archive (WEAK→KILL: edge⊥stakes) → two parallel tracks chosen: (1) demand-validation scaffold (Mihir's), (2) corpus (B) build STARTED (parser + resolveCurrent shipped).

---

## The arc this session

1. **Engram researched** (`engram.com`, $98M, Stanford/Chris Ré, "Cartridges"/LoRA, "100× fewer tokens", customers MS/Notion/Harvey). It's the **memory-into-weights / token-efficiency pole** — inverse of daftari on substrate AND model. Memory: `project_engram`. Its commercial thesis is STRONGER (universal, measurable pain); it doesn't refute daftari's correctness thesis but exposed the untested link.
2. **The market question** (link 2 of company-vs-feature): is stale-restatement fabrication *costly*? Designed a **revealed-cost archive** (NOT a benchmark — cost must be revealed, not asserted). Design: `docs/plans/2026-06-27-revealed-cost-archive-design.md` (`f579239`).
3. **Ran it** (4-agent fan-out + `deep-research` workflow: 100 agents, 17 primary sources, 25 claims 3-vote-verified). Result `docs/superpowers/results/2026-06-27-revealed-cost-archive-financial.md` (`f6bd2bb`). **Raw = 3 cases (MidFirst $0, RCS $1.5M, Carrington $5.25M); WEAK.** BSI refuted (data-ingestion). **The C4 criterion guts it:** all 3 survivors are "correct value is the MORE-RECENT one, actor used an OLDER value" = recency-RESOLVABLE → daftari NOT differentiated → under the full CLEAN bar → **0–1 → KILL/very-WEAK.**
4. **META-FINDING (carry, spans contracts/finance/Wikipedia): daftari's edge (recency-FAILS) and economic STAKES are ANTI-CORRELATED.** Where recency fails (daftari's niche) stakes are low/unmonetized; where stakes are high, recency suffices.
5. **Two tracks chosen** (Mihir picked both): demand-validation + corpus (B).

## Track 1 — demand validation (Mihir's; NOT code)
Scaffold `docs/plans/2026-06-27-decision-substrate-demand-validation.md` (`a074054`). The decisive company-vs-feature question now = "will anyone pay for governance/provenance?" Anchored on the WorkIQ decision-substrate pain. Falsifiable hypothesis, who to talk to, JTBD questions (last real reversal, not hypotheticals), pre-registered GREEN/WEAK/KILL, and the honest **substrate-vs-access** trap. **This — not corpus (B) — resolves company-vs-feature.** Status: written, awaiting Mihir running ~8–10 conversations.

## Track 2 — corpus (B) consensus-bench (BUILD STARTED)
**Purpose NARROWED today:** corpus (B) is now a **mechanism-proof for the paper** (framing-B empirical win + the cortex loop's first eval surface), NOT a market probe (the cost-axis is dead). Scope decision: **staged — build Trump first as the cheap falsifier, scale to multi-article only if it works.**

**The corpus is ideal** (verified on real data, the contract-bench lesson applied): `Talk:Donald_Trump/Current_consensus` is a **human-maintained, dated supersession GRAPH** — 76 items, active = current ground truth, `{{hide|...Superseded by [[#C15|#15]]...}}` blocks = directed dated edges. Free ground truth, no LLM labeler → clears the contamination gate. Maps 1:1 onto the contract-bench amendment chain. The keystone occurs naturally (#17 carries partial amendments before #50 supersedes it).

**Shipped (TDD, `integrations/consensus-bench/`, 8 tests, tsc clean):**
| Module | Commit | What |
|---|---|---|
| `src/consensus-parse.ts` | `20ac256` | `parseConsensus(wikitext)→ConsensusItem[]{num,anchor,status,statement,supersededBy,supersedes}`. 5 tests: active item, superseded+edge (#4→#15), supersedes reverse-edge no-leak (#17 supersedes #11 / superseded by #50), content-vs-header statement, completeness guard (all 76 contiguous, no drops). |
| `src/consensus-resolve.ts` | `f5cab2f` | `resolveCurrent(items,num)→{item,resolved,chain}` — the daftari arm (resolveChain analog). 3 tests: active→self; multi-hop **11→17→50→70** (terminal active, post-cutoff Feb 2025); **NO-MINT guard** — dead-end #4→#15 ("lead rewrite", no in-corpus successor) returns `resolved:false`, never mints. Single-successor walk + cycle guard. |

**Fixture:** `src/__fixtures__/trump-current-consensus.wikitext` (committed, real, 37KB, pulled via `curl -A "daftari-research mihir.wagle@gmail.com" "https://en.wikipedia.org/w/index.php?title=Talk:Donald_Trump/Current_consensus&action=raw"`). Wikipedia API is unthrottled, no auth (unlike SEC).

## NEXT (corpus B, in order)
1. **Topic grouping** — connect the supersession graph into topic-chains (lead-sentence chain 11→17→50→70, infobox-image, etc.) so a QA = "current consensus on topic X?". Pure graph code, no network. Cheap — could do first.
2. **Arm A (recency)** — THE real remaining work: a SECOND acquisition layer over the **talk-page archives** (not the consensus box) — the messy stream where superseded positions get re-asserted (the 18% revert finding, `docs/superpowers/results/2026-06-27-corpus-b-recency-fails-probe.md`). Recency = most-recent position on topic X from the archives. Needs its own brainstorm→acquire (Wikipedia API: archive pages + revision history).
3. **Arm C wiring** — `resolveCurrent` + held-out box as ground truth.
4. **The run** — on post-cutoff items (#67–76, contamination-safe), recency vs daftari + no-mint/tension checks. The oracle-edge arm is near-tautological (like contract CB3); the CB4-analog (cortex-ACQUIRED edges from the archives) is the publishable contribution.

## Design brainstorm (later 2026-06-27) — decisions locked, spec DEFERRED, ONE open question

Ran the corpus-design brainstorm before building further. Outcome: most of the design is already settled (or already built), the scope is already staged Trump-first, and the spec was **deferred** (Track 1 demand-validation is the needle-mover, not this). No spec written. Decisions captured here so the build can resume without re-brainstorming.

**Locked (all consistent with this handoff or already built):**
- **Arm conditions = BOTH, as a decomposition** (mirrors framing-A's extraction-vs-resolution split):
  - **Condition 2 — asymmetric / oracle-edge:** daftari handed the human-authored supersession chain; the near-tautological CB3-analog. Upper-bound sanity check.
  - **Condition 1 — symmetric / cortex-ACQUIRED edges from the archives:** the CB4-analog, **the publishable contribution**. This is the real test.
  - The gap (C2 − C1) = daftari's extraction loss, quantified (the 4× contract-pipeline lesson, measured not assumed).
- **Contamination = post-cutoff anchor (#67–76, clean primary) + pre-cutoff extension** only where a coherent perturbation exists (numeric/factual items perturb; wording decisions mostly don't), reported as a separate secondary set, never pooled. NB: perturbation is *weaker* here than contracts — post-cutoff is the robust defense.
- **Labeling = deterministic-only + human (Mihir) spot-check.** Score only instances where alignment is citation-anchored (`rv per consensus #N`) and stale-vs-novel is determinable from the diff. No LLM aligner (no contamination). Small N is the accepted cost.
- **QA buckets (3):** current-decision (baseline competence) / stale-restatement-trap (recency returns stale → daftari's clean win) / live-tension-not-supersession (the keystone — daftari must refuse to present a still-contested item as settled, where recency AND any minting baseline are tempted).
- **Scope = staged, Trump-first cheap falsifier** (already decided in this handoff; the brainstorm's "scale-in-from-start vs gate-behind-pilot" question resolves to **gate behind pilot**).

**THE ONE OPEN DECISION (resolve before writing the spec):** which arm set?
- **Recency-only** (this handoff's NEXT plan): recency vs daftari + no-mint/tension. Cheaper, faster to the falsifier; cortex-acquired-edge-vs-recency carries the paper. Risk: leaves "why not just have an LLM read the archives?" unanswered.
- **Recency + llm-consolidate** (chosen in the brainstorm session as the "beat LLM-consolidation" bar): adds a third arm (LLM reads raw archives), pre-empts that reviewer, mirrors framing-A's honest bar. Cost: a second LLM arm + cross-judge on a tiny post-cutoff N.
- Mihir leaned toward the harder bar in-session but **deferred the build**, so this is left explicitly UNDECIDED. Decide here first.

**Build's step-1 gate (whichever arm set):** on the post-cutoff pilot (#67–76), confirm the *baseline you're beating actually fails* before scaling acquisition — recency fails on those specific items (recency-only), and/or llm-consolidate fails reading the stream (if that arm is kept). If the baseline already recovers current consensus, the win localizes to the tension/tainted subset (the clean-contract-clause outcome) — know that cheaply, first.

**Strategic correction carried in:** corpus (B) is a **paper mechanism-proof, NOT a market answer** (cost-of-fabrication thesis is dead, edge ⊥ stakes). Lower priority than Track 1. Don't let it crowd out the demand conversations.

## Gotchas / carry
- Real chains DON'T always terminate active: #4→#15 dead-ends at a superseded item ("Superseded by lead rewrite", unlisted). `resolveCurrent` returns unresolved — correct (no-mint), not a bug.
- `{{0}}N.` template = zero-padding for alignment; real num is the anchor `C<n>`. Active items are `'''...'''` lines; superseded/canceled wrapped in `{{hide|header|...|content=...}}` — statement lives in `content=`.
- `supersededBy` parsed from the hide HEADER; `supersedes` from the body via `\bSupersedes\s+\[\[#C(\d+)`; item body bounded to the next anchor (no cross-item leak).
- Root `npm test`/`vitest` auto-globs `integrations/**` (no config change needed); `.claude/**` excluded.
- Benign on every commit: `lint-staged could not find any staged files matching configured tasks`.
- `git status` still shows the large pile of older untracked drafts/scripts/pools from prior sessions — unrelated, left as-is.

## Memory updated
`project_engram` (new + market result), `project_contract_supersession_benchmark` (revealed-cost result + meta-finding), `MEMORY.md` index. Corpus (B) build progress is captured here (this handoff) — consider a `project_corpus_b_consensus_bench` memory if it grows.

## Strategic state (the honest frame)
System/thesis SOLID. Cost-of-fabrication MARKET thesis DEAD (edge⊥stakes). Live wedge = sovereignty/provenance + multi-stakeholder decision substrate (governance, not avoided fines). Engram owns the efficiency axis untouched. Corpus (B) = paper mechanism-proof, not a market answer. The needle-mover is Track 1 (demand), not Track 2 (corpus).
