# Case-1 conversion test — turnkey kit

> Everything needed to run the go/kill test from `conversion-hypothesis.md` §4 the moment you have
> names. Resolves the operational half of `mavaali-beads-inz.10`. You supply the players and the
> thresholds; this supplies the sample spec, the scripts, and the scoring sheet.

**Priming rule (read first):** daftari is **not** named during recruitment or the playthrough — keep
the player in entertainment intent so the near-miss (L1) is honest. The **debrief introduces
daftari** (that's the attribution lever, L2). T0/T1 then measure whether the debrief landed.

---

## 1. Sample spec

**Naive = both axes, no exceptions:**
- **daftari-naive** — never used daftari, not pre-sold, unaware the game is a daftari pitch. Excludes
  Mihir, the daftari orbit, anyone who's heard the pitch.
- **case-naive** — first-time Case-1 player (no exposure to the frame/solution).

**ICP filter (mandatory):** must have a *real reason-over-accumulated-knowledge problem* — agent-memory
builders, teams maintaining shared knowledge, analysts/researchers over evolving evidence, engineers
fighting stale docs/provenance. Without a real such problem, **T1 cannot fire** → false negative.

**Exclude:** daftari users/contributors, pitch-hearers, Mihir's inner circle (social-desirability
inflates T1), and anyone recruited *as* "come play a spy game" with no knowledge-work context.

**Size:** 5–8 = **directional kill-gate, not a rate estimate.** A real rate needs n≥30 (separate effort).

**Pool sources:** AI-eng / agent-memory communities; daftari-adjacent GitHub watchers who aren't users;
your network filtered to ICP and excluding believers.

---

## 2. Recruit blurb (neutral pretext — copy/paste)

> Hey — I'm playtesting a short Cold War spy mystery. It's a text detective puzzle you play over chat,
> ~30 minutes, no prep. I'm looking for a few first-time players to try it and tell me where it drags
> or confuses. Up for it this week?

Do **not** mention daftari, knowledge tools, or "epistemics." Pick from an ICP-filtered pool so the
right people self-select without being primed on the theme.

*(If you can't pre-filter for ICP, one neutral screen after they say yes: "quick bio — what do you
work on day to day?" Confirm a real knowledge/memory problem exists; if not, thank them and don't run.)*

---

## 3. Session runsheet (the GM — you or Mavaali)

1. Cold Slack-GM playthrough of Case 1. No daftari framing.
2. Log the **verdict**: frame (WEATHERVANE = burned) or truth (CARTOGRAPHER = clean).
3. Log the **near-miss**: did they *nearly* take the frame before self-correcting? Which element
   (fr-028 plant / face-value count / off-station misread)? — this is the L1 signal, more important
   than the final answer.
4. Run the debrief (names the daftari primitives under each move — provenance, verification gate,
   tension-held-open). This is the L2 lever; deliver it fully.
5. Immediately run §4 prompts, in order.

---

## 4. Post-debrief prompts (exact wording, order matters)

Ask in this order — T0 before T1 so comprehension isn't leaked by the felt-need probe.

- **T0 — comprehension:** *"In your own words, what is daftari for?"*
  Score: **pass** = names the discipline/tool purpose (grading sources, tracking provenance, holding
  uncertainty, memory you can reason over); **partial** = "being careful / rigorous" with no daftari
  specificity; **fail** = can't say.
- **T1 — felt-need (PRIMARY METRIC):** *"Thinking about your own work — have you hit a situation where
  this kind of discipline would've saved you? Tell me about one."*
  Probe **once** if vague: *"Can you give a specific example?"*
  Score: **hit** = names a *concrete, specific* past situation. **miss** = "yeah, probably useful" with
  no named instance.
- **T2 — intent:** *"Here's where this lives → [tracked daftari link]."* Log whether they click.

---

## 5. Logging sheet (one row per player)

| Player | ICP role | Verdict (frame/truth) | Near-miss? (which) | T0 (pass/partial/fail + quote) | T1 (hit/miss + the named instance) | T2 click? | Notes |
|---|---|---|---|---|---|---|---|

---

## 6. Go / kill (set the numbers before running — do not peek first)

Primary = **T1 hit rate**. Secondary = T0 comprehension.
- **Kill the serial bet** if T1 hit-rate < ~40% **and** T0 comprehension is low → the mechanism dies at
  L2 on our best case; more episodes won't fix a broken attribution link. Fix the debrief (`inz.11`)
  or stop.
- **Proceed** if T1 ≥ ~40% with concrete instances → this rate is the **baseline every new episode must
  beat**.
- **Ambiguous** (T0 high, T1 low) → game teaches daftari-the-idea, not daftari-the-need → iterate the
  debrief/mechanic, not the cast.

*(~40% is a placeholder. Mihir commits the real threshold before the first session so the result can
falsify the bet.)*

---

## 7. Two-week follow-up (T3/T4 — one message)

> Couple weeks back you played that spy puzzle — random q: did you end up looking at daftari at all, or
> has it come to mind on anything you're working on?

Log: opened/installed (T3), used on own work (T4), or nothing.
