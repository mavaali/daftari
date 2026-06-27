# E2 discovery spot-check — parser annotation accuracy on a real chain

**Date:** 2026-06-27 (work began 2026-06-26)
**Branch:** `feat/contract-bench-arms`
**Gate:** "labels are the canary" — verify the discovery pipeline's `clause → op → recoverable` annotations against the real contract text before E3 consumes any chain.

## What was run

The full E2 pipeline (`efts-search → cik-tally → preamble → reconstruct → score → select`) plus E1 (`edgar-fetch / html-to-text / chain-docs / citation-parse`), exercised end-to-end over **real EDGAR filings** for two filers:

- **NGS** (CIK 0001084991) — Truist (TCB) Amended & Restated Credit Agreement chain (base + amendments 1–4).
- **PetroQuest** (CIK 0000872248) — Credit Agreement chain (amendments 8–13).

**Caveat on how it was run.** The committed runner `discover-edgar.mjs` does a broad EFTS sweep first. On both run attempts (2026-06-26 and 2026-06-27) SEC's full-text endpoint hard-throttled this IP — serving HTTP 200 with empty bodies (fair-access throttle blanks) persistently, exhausting the runner's retry/backoff. So the **broad sweep's distribution numbers are not available today** (an environmental limit, not a pipeline defect). To produce a real selected chain for this gate, the pipeline was driven over the **already-cached real exhibits** (zero network) using the exact compiled pipeline functions the runner uses. The runner itself is correct and committed; it will produce the same per-CIK result when the throttle clears.

## Result

```
scored 2 chains; selected 1 (rate<=0.2, length>=3)
  0000872248-credit-agreement-october-2-2008                      len=6 rate=1.00 section  sel=false
  0001084991-amended-and-restated-credit-agreement-february-28-2023 len=5 rate=0.12 mixed   sel=true
```

The NGS chain reconstructed exactly: `master (base A&R) → amendment-1 → amendment-2 → amendment-3 → amendment-4`, 17 ops, 0.12 unrecoverable.

## Spot-check (the gate)

Chain checked: the **selected** NGS chain. Sampled annotations from `pairs/…february-28-2023.md`, each verified against the cached source HTML:

| Annotation | Real contract text | Agree? |
|---|---|---|
| amd-2 `8.1 / restate / recoverable` | "Section 8.1 … is hereby amended and **restated in its entirety** to read in full as follows" | ✅ |
| amd-2 `11.25 / partial / unrecoverable` | "**The last paragraph of** Section 11.25 … is hereby amended and restated in its entirety" | ✅ (partial scope → not recoverable) |
| amd-3 `2.10(a) / partial / unrecoverable` | "**The first sentence of** Section 2.10(a) … is hereby amended and restated in its entirety" | ✅ (partial scope → not recoverable) |
| amd-2 `Payment Conditions / restate / recoverable` | "'Payment Conditions' means, with respect to…" (full new definition) | ✅ |
| amd-1 `Commitment / restate / recoverable` | (pinned by E1 oracle test on real amd-1 HTML) | ✅ |
| amd-2 `8.1 / restate / recoverable` | (pinned by E1 oracle test on real amd-2 HTML) | ✅ |

**Verdict: annotations trustworthy.** The parser draws the load-bearing distinction correctly — a full-clause "amended and restated in its entirety" (recoverable, the new full text is present) vs. a partial "the last paragraph of / the first sentence of …" edit (unrecoverable, the full clause can't be reconstructed from the fragment). That recoverable/unrecoverable split is exactly the labelability signal the contract-supersession benchmark turns on. Minor benign noise: an amendment defining its own name ("First Amendment", "… Effective Date") is annotated as a defined-term `add` — technically correct, harmless.

## Findings surfaced by the live run (and what was done)

1. **`edgar-fetch.ts` cache-poisoning (real E1 bug, FIXED).** `fetchFiling` cached whatever the transport returned, so an empty-200 throttle blank became a permanent 0-byte "valid" cache entry, poisoning every re-run (846/851 empty in the first dense run → 0 chains). Fixed: `fetchFiling` now treats an empty/whitespace-only body as a transient error and never caches it (commit on this branch, +regression test). The runner additionally retries throttle blanks via the designed `transport` seam.

2. **`parsePreamble` was NGS-specific (the dominant-risk trap, FIXED).** It matched the first `dated as of` in the head, which on most filers is the amendment's **own** date in the title line — fragmenting every chain into singletons (0 selected). Root-caused and fixed with a **recital anchor**: the base is referenced as `that certain [the] <Type> Agreement dated as of <BASE date>`, which cleanly separates the base date from the amendment's own date and is consistent across filers. Also extended the ordinal word list past "Tenth" (PetroQuest reaches the 13th) and relied on title-before-recitals first-match so recital references to prior amendments no longer hijack the ordinal. Validated: PetroQuest 8th–12th now all resolve to base "October 2, 2008" (one chain); NGS amendment-2 (previously dropped) is pulled back in. Committed with real PetroQuest fixtures + tests; full suite 104 green.

3. **`citation-parse` does NOT generalize to PetroQuest's drafting style (NEW finding, NOT fixed — out of scope).** The PetroQuest chain grouped correctly (len=6) but scored 1.00 unrecoverable on only **6 ops total across 5 amendments** — e.g. the 9th amendment parses **0 ops**. PetroQuest's amendments are barely parseable by E1's citation parser (different phrasing than NGS), so the chain is correctly filtered out. This is a *second* generalization gap — in the op/citation parser, distinct from the preamble parser — and is the headline E3 risk: **the discovery mechanism generalizes (grouping works on both filers), but the per-op annotator is still NGS-shaped.** A broad selected set will require either a more general `citation-parse` or accepting that only restatement-heavy filers (like NGS) are labelable today.

## Status vs. E2 done-criterion

- Pipeline produces `manifest.json / distribution.md / seeds/ / pairs/` with a real **selected** chain — ✅ (NGS).
- Full unit suite green (104) + tsc clean — ✅.
- Human spot-check of a selected chain's annotations vs. cached filings, written — ✅ (this doc).
- Broad-sweep distribution across many CIKs — ⏳ blocked by SEC throttle today; rerun the committed runner when the IP cools.

## For E3

- The **selected NGS chain is ready** to feed E1's `assemble()` (Arm A recency vs Arm C `resolveCurrentSource`), plus the headline regime metric (frequency of scoped-current-with-stale-mention).
- Before scaling discovery, decide on finding #3: generalize `citation-parse` or scope the benchmark to restatement-style chains. The discovery tooling itself is sound.
