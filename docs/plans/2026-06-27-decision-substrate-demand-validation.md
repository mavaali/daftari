# Demand validation — the decision-substrate wedge (link 5: will anyone pay for governance/provenance?)

**Date:** 2026-06-27
**Owner:** Mihir (this is customer discovery — conversations, not code). Claude scaffolds; cannot run it.
**Why now:** The revealed-cost archive (`docs/superpowers/results/2026-06-27-revealed-cost-archive-financial.md`) killed the cost-of-fabrication market thesis: where recency fails (daftari's niche) the stakes are low/unmonetized. The only live wedge is **governance/provenance**, and the only way to know if it's a *company* is to find out whether someone pays for it. No artifact answers this — talking to people does.

## The hypothesis under test (state it so it can fail)
Teams that make **multi-stakeholder decisions which flip-flop across threads/meetings** will pay for a **shared decision substrate** that records `{decision, who, when, what-it-superseded, why}` with **RBAC + provenance + no-mint** — because today a stale/reverted decision gets acted on by someone who wasn't in the room, and that costs real time/rework/trust.

**Kill condition:** if people consistently say "Slack search / a Notion doc / a decision log is fine," or can't name a *recent, costly* instance, the wedge is dead and daftari is a feature.

## Who to talk to (start inside your own WorkIQ pain)
People who *own* cross-stakeholder decisions and feel the reversal pain:
- Chiefs of staff / program leads (live in decision-threading)
- EMs / tech leads on cross-team initiatives
- PMs arbitrating across stakeholders
- Legal/compliance ops, RevOps (already think in provenance/audit)
- Founders/operators in 20–200-person orgs (small enough to feel it, big enough to have it)

Begin with the exact people in the WorkIQ flip-flop you lived ([[project_decision_substrate_usecase]]) — you have the visceral case; find others who share it.

## What to ask (discovery, NOT a pitch — do not mention daftari)
Anchor on the *last real instance*, not hypotheticals:
1. "Tell me about the last time a decision your team made got **reversed or changed** — and someone kept acting on the old one."
2. "Who acted on the stale version? Were they in the room when it changed? How did they find out it had changed (or not)?"
3. "What did that cost — time, rework, a wrong commitment, trust?"
4. "Where does the *current* state of that decision live today? How do you check what's current vs superseded?"
5. "Walk me through what you do now to keep everyone on the current decision." (current workaround = the real competitor)
6. "Whose job is it to keep that straight? Is there budget against it?"

Discipline (your anti-sycophancy tenets apply to *you* here): don't lead, don't pitch, don't explain daftari. Count **unprompted** mentions of the pain. A polite "yeah that'd be useful" is not demand.

## Signals & thresholds (pre-register, so a weak result is legible)
- **GREEN (build):** ≥ ~6 of ~10 conversations surface a *specific, recent, costly* reversal-acted-on-stale instance UNPROMPTED, name a current workaround they're unhappy with, and point to a budget owner.
- **WEAK:** the pain is recognized but soft (no cost, no budget, workaround "good enough").
- **KILL:** people don't recognize the pain, or the workaround (Slack/Notion/doc) is genuinely sufficient.
- **The honest trap (from memory):** SP-B is partly a **social/access** problem, not a memory problem — if the fix is "be in the meeting" or "the org should communicate better," daftari doesn't solve it. Listen for whether the gap is *substrate* (no current-state record) vs *access* (wasn't invited). Only the former is daftari's.

## Output
A short written read after ~8–10 conversations: GREEN/WEAK/KILL + the 2–3 sharpest verbatim quotes + whether it's a substrate or an access problem. That read — not corpus (B) — is what decides company-vs-feature.

## Related
[[project_decision_substrate_usecase]], [[project_currentstate_projection]] (SP-B is the build this would gate), `docs/superpowers/results/2026-06-27-revealed-cost-archive-financial.md` (why this is now the decisive question), [[project_engram]] (the cost axis they own; this is the axis they don't).
