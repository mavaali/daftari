# Related-work research — verified findings (deep-research pass)

**Date:** 2026-06-29. **Run:** deep-research `wf_ecc62df3-14f` (104 agents, 21 sources,
93 claims → 25 verified, 24 confirmed / 1 killed, 3-vote adversarial). Feeds §9 of
`docs/paper/preserve-dont-resolve.md`.

## Headline
The "preserve, don't resolve" thesis is **NOT novel on its components** — bi-temporal
invalidation, supersession-without-deletion, unresolved-contradiction representation, and
provenance all exist in prior art and MUST be cited. The **defensible, narrowed gap** is the
**structural conjunction** (by-construction no-mint of a tension, vs model-dependent
resolution) + the **substrate** (git-versioned markdown vault) + the **empirical two-corpus
invariance** (no one has run this measurement).

## Verified prior art (3-vote confirmed; cite these)

| system | id / date | what it does | why it's prior art / how we differ |
|---|---|---|---|
| **Mem0** | 2504.19413 (Apr 2025) | ADD/UPDATE/DELETE consolidation, overwrites | consolidation pole; we preserve |
| **A-MEM** | 2502.12110 (Feb 2025) | "memory evolution" mutates existing memories in place | overwrite pole |
| **Generative Agents** | 2304.03442 (Apr 2023) | reflection = ADDITIVE layer over retained stream | prior art for "preserve raw, layer inference"; no supersession/no-mint claim |
| **Zep / Graphiti** | 2501.13956 (Jan 2025) | bi-temporal KG; invalidates-not-deletes; retains superseded edges | **but FORCES recency resolution** — never holds a tension open |
| **ATMS** | de Kleer 1986 (AIJ 28:127-162) | multi-context contradiction via labels + nogoods | deep prior art for representing an UNRESOLVED contradiction → "representing a tension" is NOT our novelty |
| **ElephantBroker** | 2603.25097 (Mar 2026) | **distinguishes supersession edge vs contradiction edge** | SHARPEST competitor — but classification is LLM-extracted (model-dependent), resolves via confidence decay + scoring penalty, canonicalizes/archives losers; only structural guarantees are safety/contamination, NOT no-mint → confirms the master gap |
| **Roynard "Knowledge Layer"** | 2604.11364 (Jun 2026) | supersession-as-relationship, preserves both claims append-only, explicit provenance | does NOT distinguish tension vs supersession; no no-mint guarantee; NOT zero-LLM (that claim REFUTED 0-3) |
| **TOKI** | 2606.06240 (Jun 2026) | bitemporal operator algebra typing contradiction-RESOLUTION heuristics | opposite design: resolve-with-theory, not preserve |
| **Trust-Align** | 2409.11242 (ICLR 2025) | correct refusal + citation quality via model alignment | non-fabrication is BEHAVIORAL/trained, not structural |
| **"Correctness is not Faithfulness"** | 2412.18004 (Dec 2024) | citation correctness ≠ faithfulness; post-rationalization up to 57% | non-fabrication is gameable behavior |
| **Portable Agent Memory** | 2605.11032 (May 2026) | Merkle-DAG provenance (BLAKE3+Ed25519), derivation lineage | provenance-as-tamper-evidence, NOT provenance-over-what-supersedes-what |
| **AIS** | 2112.12870 (Dec 2021) | attribution measurement framework | measures attribution post-hoc, no guarantee |
| **MIRAGE** | 2406.13663 (Jun 2024) | post-hoc RAG attribution via model internals | behavioral, not by-construction |
| survey | 2603.07670 (Mar 2026) | names continual-consolidation/learned-forgetting as frontier | single-author, no track record → cite as "a recent 2026 survey," NOT "the standard" |
| **Zep blog** | getzep.com "Markdown is not agent memory" | argues AGAINST markdown as agent memory | engage directly on the substrate axis |

## Required corrections / caveats (apply before submission)
- **ATMS citation → de Kleer 1986 (AIJ)**, NOT the IJCAI-93 PDF (would not parse; secondary).
- **Do NOT attribute deterministic/zero-LLM to Roynard** — that convergence claim was REFUTED 0-3.
- **Narrow the differentiator to STRUCTURAL (by-construction) no-mint** — ElephantBroker already represents tension-vs-supersession; Graphiti/Roynard already preserve superseded structure; ATMS already represents unresolved contradiction.
- **2026 preprints (EB, Roynard, Portable Agent Memory, TOKI, survey) have no citation track record** — re-verify currency at submission; the landscape may shift.

## Open questions (NOT resolved this pass — verify against primary before any claim)
- Did later Mem0 (Mem0g) drop the graph layer? Unresolved — check repo/changelog.
- **MemGPT/Letta, Cognee, Engram (Stanford Cartridges/weights-writeback), SmartVector (2604.20598), Microsoft Recall benchmark (Stevenic/recall)** — none produced a surviving verified claim; verify each against a primary source before inclusion. Engram (the inverse-substrate competitor) especially.
- Is there ANY system whose supersession/contradiction *classification* (not just storage) is deterministic/by-construction rather than LLM-extracted? Confirming the negative across MemGPT/Cognee/Letta would harden the master gap.
- Stress-test the substrate-differentiator (git-versioned markdown vault) against Cognee and Obsidian/markdown-targeted memory tools before asserting it unclaimed.
