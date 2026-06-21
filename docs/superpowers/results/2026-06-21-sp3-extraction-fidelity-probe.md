# SP3 probe — atomization-fidelity on EA journal dailies

**Date:** 2026-06-21
**Cost:** ~$0.04 (13k Haiku tokens, 4 docs).
**Question:** Can Haiku faithfully extract atomic claims from EA journal prose — separating co-resident competing values (stale vs current) into distinct, correctly-attributed, grounded atoms? This is the load-bearing unknown for any atomization-based SP3 (extraction is the risky step; detection between clean atoms is the easier one).

## Setup

`claude-haiku-4-5`, one extraction call per doc, on the 4 dailies carrying the two known corrections: Jamie briefing (day-0001 wrong, day-0019 corrected) and Condor valuation (day-0060, day-0100 corrected). Prompt asked for atoms `{entity, attribute, value, qualifier, status, source_quote}` with explicit instructions: copy values verbatim, never merge two different values for the same attribute, capture only *stated* status, ground each atom in a source quote. (With-markers text — explicit supersession keywords left in.)

## Result: PASS on extraction fidelity

The two correction days produced exactly the supersession-ready structure we need:

- **day-0019 (Jamie):** two atoms, same attribute `morning_briefing_time` — `6:30 AM` (status **current**) and `7:00 AM` (status **superseded**) — each grounded. The supersession is directly readable off the atom pair.
- **day-0100 (Condor):** two atoms, same attribute `base_case_value` — `$465M` and `$510M` (status **retired**) — separated and grounded.

Across all four docs: no merged values, no hallucinated figures; every atom carries a verbatim `source_quote`. Faithfulness held. At ~$0.04/4 docs, full-corpus atomization is ~$2.

## Two risks the probe surfaced (the real next bottlenecks)

1. **Attribute labels are not canonical across documents.** The same real-world fact was labeled `briefing_time_preference` (day-1), `morning_briefing_time` (day-19), `weekday_briefing_time` (day-60) — three strings for one attribute. A `superseded_by` detector keying on "same entity+attribute" would fail to link atoms across docs. **An atomize→detect pipeline needs a canonicalization / entity-attribute-resolution layer between the two steps.** This — not extraction — is now the main engineering risk.

2. **Clean status capture leaned on explicit markers.** day-19/day-100 got "superseded"/"retired" *because the prose said so* ("retired the earlier $510M baseline"). The **inference case** — a later doc asserting a new value *without* announcing supersession — is untested. That's the harder half and the real subject of the with-markers-vs-stripped comparison.

## Bonus finding

On *narrated* correction days the supersession is already fully encoded within a single doc's atoms (two same-attribute atoms, current + superseded). So cross-doc detection is mostly needed for **silent** supersession (a new value stated with no "this replaces X"). The narrated cases are nearly free once atomized.

## Operational notes

- `max_tokens: 2000` truncated output on the dense dailies (day-19, day-60 ended mid-atom). Real atomization needs higher `max_tokens` → more output cost, but still cheap.
- Extraction is verbose (~20 atoms from day-1, many trivial). A real pipeline wants to filter to atoms that carry competing values / status.

## Implication

Extraction fidelity — the unknown that justified the probe — is **not** the blocker. Atomization is viable and cheap on Haiku. The atomization-based SP3 is worth building, but its design must now center on (a) attribute/entity **canonicalization** across atoms and (b) **silent**-supersession inference (the stripped-marker case), because those are where the remaining risk lives. Extraction is solved enough to build on.
