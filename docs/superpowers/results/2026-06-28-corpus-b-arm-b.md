# Corpus (B) Arm B — LLM-synth (Haiku) vs recency vs daftari

**Date:** 2026-06-28
**Spec:** `docs/superpowers/specs/2026-06-28-corpus-b-arm-b-llm-synth-design.md`
**Models:** Arm B = `anthropic/claude-haiku-4.5`; blind judge = `google/gemini-2.5-flash` (cross-family), both via OpenRouter, temp 0. One run, ~$1.

**Verdict:** daftari is the **only never-stale arm**. LLM-consolidation (Haiku) inherits recency bias — it returns the **stale** version on **20/33 (61%)** of scorable stale-traps. But Haiku **did not fabricate** (0 minted values on traps, 0/5 on the no-mint probe), so the no-mint differentiator did *not* fire against this conservative cheap model — the honest-partial outcome the spec anticipated, in the staleness direction.

## A/B/C comparison (33 scorable stale-traps)

| Arm | stale | governing | abstain | other / fabricate |
|---|---|---|---|---|
| **A — recency** | **33** | 0 | 0 | 0 |
| **B — LLM-synth (Haiku)** | **20** | 1 | 12 | **0** |
| **C — daftari** | **0** | 16* | rest | **0** |

\* Arm C governing is gated on inline-marker localizability (16/33); it is **never
stale** on any of the 33. The clean cross-arm axis is **staleness**: A=33, B=20, C=0.

No-mint probe (5 absent-topic questions): Arm B **abstain (correct) = 5/5, fabricate = 0**.

## Reading

- **LLM-consolidation is recency-trapped.** Given the same two versions Arm A sees —
  `[governing (older), stale (newer)]` — Haiku takes the newer (stale) version 61% of
  the time and recovers the governing one only once. Without the supersession edge it
  has no way to know the older text was the consensus, so it defaults to recency. This
  is the core result: **"just have an LLM consolidate the stream" inherits the same
  failure as naive recency** — daftari (edge-resolution) is the only arm that is never
  stale.
- **Haiku is conservative, not a fabricator.** On the 2-choice trap it either picks a
  shown version (20 stale, 1 governing) or abstains (12 `CANNOT DETERMINE`); it never
  invented a third value (`other`=0). On the no-mint probes it refused all 5 (didn't
  pull an answer from priors). So the **no-mint advantage daftari has is real but
  undemonstrated against this model** — a cheap conservative LLM doesn't mint here.
- **Honest framing:** daftari's edge over Haiku-consolidation in this run is the
  **never-stale property** (0 vs 20/33) plus determinism/zero-cost — *not* no-mint,
  which a more aggressive model would be needed to exercise.

## Honest precision

- Arm B's 12 abstentions are not "stale" — but counting them generously, Arm B is still
  *wrong (stale)* on 61% of traps where daftari is wrong on 0%.
- Arm B `governing`=1 vs Arm C `governing`=16 are **not** directly comparable: Arm C's
  governing count is gated on marker-localizability, Arm B's is not. Staleness is the
  apples-to-apples metric.
- Single cheap model, temp 0, one run. The fabrication question is model-dependent; an
  optional stronger/more-aggressive model spot-check could test whether minting appears
  — deferred (the staleness result is already decisive and the cost discipline holds).

## Next (separate, gated)

- Optional: a stronger/more-aggressive model spot-check to probe the fabrication axis.
- Pre-cutoff perturbation; the CB4 acquired-edge arm (the publishable contribution);
  fuller Arm C localization for no-inline-marker items.
