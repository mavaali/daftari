# Handoff — Two-corpus sovereignty paper: full draft written, §9 verified; CB6 keystone measured

**Date:** 2026-06-30
**Paper branch:** `paper/draft-preserve-dont-resolve` → **PR [#168](https://github.com/mavaali/daftari/pull/168) OPEN** (paper draft).
**Merged this session:** PR [#164](https://github.com/mavaali/daftari/pull/164) (CB5+span), [#166](https://github.com/mavaali/daftari/pull/166) (CB6 + paper design), [#167](https://github.com/mavaali/daftari/pull/167) (CB4 foil panel).
**Suite:** `integrations/consensus-bench` 101 green, tsc clean. All paid LLM runs were deleted throwaways; committed suite hermetic.

## One-line
Decided and drafted the **two-corpus sovereignty paper** ("Preserve, Don't Resolve") — contracts (recency-works control) + Wikipedia consensus (recency-fails treatment), unified by the no-mint keystone; built **CB6** to move the keystone from by-construction to **measured**; ran the CB4 foil **model panel** (which honestly refuted a hoped-for result); and grounded **§9 related work** by deep-research + 4 primary-source verifications. Draft is complete; next is prose-tightening + submission prep.

## The deliverable
- **`docs/paper/preserve-dont-resolve.md`** — full first draft, 10 sections, ~3k words, all numbers real. On PR #168.
- **`docs/plans/2026-06-29-two-corpus-sovereignty-paper-design.md`** — the validated design (structure, evidence map, honest assessment, kill conditions, foil-panel methods, NOT-in-scope, failure-modes). On main (merged in #166).
- **`docs/superpowers/drafts/2026-06-29-related-work-research.md`** — verified related-work findings table (deep-research + the 2026-06-30 4-agent verification), caveats, open questions.

## The paper's spine (framing corrections baked in)
- **Central claim:** the *measured invariance* — across recency-works (contracts) and recency-fails (Wikipedia), the separating axis is the same (**non-fabrication + provenance**, not accuracy), and daftari holds it **by construction**.
- **LEAD with the forced/architectural condition** (a consolidation memory that must emit one value has no tension slot). CB6: forced masquerade **17/18** near model-independent. Present abstain-offered fabrication as the honest **model-dependent softness**.
- **Confront "just use GPT-4o"** head-on (§8): it over-abstains (25/33 missed real supersessions); daftari's guarantee is structural, not model-contingent.

## Key results (all runs done; evidence-map appendix in the draft)
- **Contracts (control):** recency accuracy-sufficient >100:1; forced Arm B minting fabricates **4/7** partials; provenance eval LLM governing **0/2** vs daftari **6/6**.
- **Wikipedia (treatment):** recency stale **33/33**, daftari **0/33**; CB4 derivation recall **1/33** mints 0; **CB4 minting foil F = 6–26/49 (MODEL-DEPENDENT panel)** — Haiku 26, GLM-4.6 24, GPT-4o 6 (abstains); CB5 contradiction detector **2→4/33 span**, FP **0/16**, mints 0; **CB6 keystone: forced masquerade 17/18 (Haiku 5/6, GLM 6/6, GPT-4o 6/6), daftari mints 0/6 + 0 false conflicts, n=6 across Trump/Biden/COVID, 2nd-rater 6/6**.

## §9 related work — the honest narrowing (important)
Deep-research (run `wf_ecc62df3-14f`) + 4 primary-source agents established the thesis is **NOT novel on components**. §9 is structured around **two preservation axes**:
- *Supersession-preservation* (keep old as history, resolve current): **Graphiti** [2501.13956] (recency-resolves — the foil behavior, does NOT hold a tension), **Roynard** [2604.11364], **SmartVector** [2604.20598] (preserves but **votes tensions away**), daftari. **No novelty claimed here.**
- *Tension-preservation* (hold two live claims open): **ATMS** [de Kleer 1986] (structural but over logical assumption-sets, not a memory substrate), **ElephantBroker** [2603.25097] (contradiction edge — but LLM-extracted + confidence-decay = **model-dependent**, exactly what §6 measures).
- Consolidation/overwrite pole: Mem0 [2504.19413], A-MEM [2502.12110], **MemGPT/Letta** [2310.08560], **Cognee** [2505.24478] (DB substrate, not markdown).
- Inverse-substrate pole: **Cartridges** [2506.06266]/Engram (trainable KV-cache; use paper's 38.6×/26.4×, NOT company "100×").
- **The gap (defensible):** (1) structural by-construction no-mint *in an agent-memory system* (porting the TMS property to the substrate); (2) the empirical two-corpus invariance; (3) provenance-over-supersession; (4) the git-markdown substrate (Zep even argued "markdown is not agent memory").

## NEXT (pickup)
1. **Prose-tightening pass** over the full draft (register: academic; Mihir's voice memo [[feedback_writing_voice]] leans builder-experimenter — kept for Honest Assessment).
2. **Submission prep:** re-verify the 2026 preprints' currency (EB/Roynard/PAM/TOKI/SmartVector/Cognee/Cartridges); the Microsoft Recall benchmark [Stevenic/recall] only needs verifying IF cited as an eval surface (it is not a §9 competitor).
3. **Deferred (separate paper / bigger builds):** §6.1 comprehension-load ablation = paper B (needs a **derivation-rich corpus** + variance harness — current corpora are derivation-sparse; Stage 5 calibration is OFF the §6.1 critical path); a **genuine-tension corpus at scale** (n=6 → powered); optional **contracts forced Arm B panel** (n=7, in `integrations/contract-bench`, different integration).

## Gotchas / process notes
- **NO CLAUDE ATTRIBUTION on paper commits** ([[feedback_no_claude_attribution_paper]]): `paper/*` + `docs/paper/*` get plain commit messages — no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" footer. The #168 commits were filter-branch-stripped before push. Ordinary daftari code commits keep the default trailer unless told otherwise.
- **Paid runs:** throwaway `_*-run.test.ts`, run once, deleted, never committed. `OPENROUTER_API_KEY` in `~/.zshenv`. Foil panel = `anthropic/claude-haiku-4.5` + `z-ai/glm-4.6` + `openai/gpt-4o`; daftari's own pass stays Anthropic; judge/2nd-rater = `google/gemini-2.5-flash` (cross-family).
- **Concurrency:** 147-call panel runs time out sequentially at 600s → use a concurrency pool of ~8.
- **CB6 tension pairs** are distilled from the linked RfCs and **blind-second-rater-gated** (the bias guard); the box is a rare institution (only Trump/Biden/COVID of 12 candidates → n caps ~6–8).
- **The CB4-panel lesson:** the abstain-offered "26/49" was NOT a conservative lower bound — GPT-4o fabricates only 6/49 by abstaining; capability ≠ minting-aggressiveness. This is why the paper leads with the forced condition.
- Scheduled task `verify-competitor-systems-s9` is **disabled** (its work was done inline this session).

## Memory
`project_daftari_paper` (paper decision + §9 verified state), `project_corpus_b_consensus_bench` (CB5/CB6 + panel), `feedback_no_claude_attribution_paper`, `feedback_writing_voice`. MEMORY.md index updated.
