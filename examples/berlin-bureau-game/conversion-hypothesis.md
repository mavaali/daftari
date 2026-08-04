# Berlin Bureau — conversion hypothesis & how to measure it

> Resolves `mavaali-beads-inz.1`. The design (DESIGN.md) rests on an unstated, unmeasured claim:
> *love the misfits → adopt daftari*. This doc makes that claim falsifiable, challenges what
> "adopt" should even mean, and gives a test runnable on the **already-built Case 1** — before any
> Case 2+ authoring spend.

---

## 0. Challenge the premise first

The bead (and DESIGN.md) assume the game's job is **install-conversion**: play → `git clone` daftari
→ use on real work. I think that's the wrong job to optimize, for two reasons:

1. **Intent mismatch.** People enter a spy-puzzle in *entertainment* intent. Tool adoption is a
   *problem-solving* intent. One session almost never flips a person from "that was fun" to "I will
   now install and wire a knowledge tool into my workflow." Expecting install-in-one-session sets the
   bar where the game will always look like it failed.
2. **ICP overlap is partial.** The game's audience = "enjoys a Cold War mystery." daftari's ICP =
   "has a real reason-over-accumulated-knowledge problem (agent memory, team memory, research)." Those
   circles overlap but are not the same circle. Optimizing for install conversion optimizes for the
   *intersection*, which is small, and wastes the *entertainment* reach, which is the game's actual
   superpower.

**Position — ACCEPTED (Mihir, 2026-08-04):** the game's job is **comprehension + felt-need + a
low-friction next step** — make daftari *legible* and make the player *feel the cost of sloppy
epistemics*, so that when they later hit a real memory/knowledge problem, daftari is the tool they
remember and understand. This is an **awareness/activation** job, not a direct-install job. **We
measure T1 (named felt-need), not installs.** Two consequences now locked:
- the **debrief's job is attribution to daftari (L2)**, not teaching generic carefulness — that is the
  primary design lever;
- **authoring Cases 2+ is gated on the T1-on-Case-1 signal** (§4), not run in parallel.

---

## 1. The mechanism, stated so it can be falsified

**Causal claim:** *A player who works a case experiences the gap between naive elimination (which
lands on the planted frame) and disciplined method (which reaches the truth). The debrief names the
daftari primitive under each move. This produces (a) comprehension of what daftari is for and (b) a
felt need — "I want this discipline enforced by a tool" — that persists past the session.*

**This is false if any link breaks:**
- **L1 (the gap is felt):** the player actually gets burned by the frame, or sees they nearly did.
  If everyone just walks to the truth, there is no felt cost → no need.
- **L2 (attribution):** the player connects "the discipline that saved me" to **daftari specifically**,
  not to "being careful" in general. This is the riskiest link — the game may teach *epistemic hygiene*
  without teaching *daftari*.
- **L3 (persistence):** the comprehension/need survives the session and re-fires at a real
  problem later.

The design's whole bet lives at **L2**. A great case that makes people careful but not daftari-curious
is a great game and a marketing failure.

---

## 2. The strongest counter-hypothesis (the null)

*Puzzle players compartmentalize. The game hands the player a character who already has the
discipline; the player exercises the character's rigor, not their own, and leaves entertained,
attributing nothing to a tool. The debrief's primitive-naming reads as a lecture bolted onto a game
and is skimmed. Net conversion signal: zero.*

If the test in §4 can't distinguish the mechanism from this null, the design isn't ready.

---

## 3. The conversion event(s) — tiered, so we measure the right thing

Do not measure a single binary. Measure the funnel:

| Tier | Event | What it proves | How captured |
|---|---|---|---|
| T0 comprehension | Player can state, unprompted, *what daftari is for* after playing | L2 partly — daftari became legible | 1 open question post-debrief |
| T1 felt-need | Player agrees "I've hit problems where this would help" **and names one** | L1+L2 — the gap landed and mapped to their world | 1 prompt, must name a concrete instance |
| T2 intent | Player clicks the single next-step link (repo / one-pager) | low-friction action, real not stated | 1 tracked link |
| T3 activation | Player installs / stars / opens daftari within 2 weeks | actual adoption | link attribution / follow-up |
| T4 use | Player uses daftari on their own work | the only tier that pays rent | follow-up ask |

Primary metric for the **awareness job**: **T1 rate** (felt-need with a named instance). It is the
cheapest early predictor of everything downstream and the hardest to fake. T3/T4 are the real prize
but too slow/small-N to steer authoring by now.

---

## 4. The test — run it on Case 1, now, before authoring anything

You already have Case 1 and a proven Slack-GM delivery. The test is a protocol, not a build.

**Sample:** 5–8 players, drawn from **daftari's ICP** (people with a real knowledge/memory problem),
NOT from spy-fiction fans and NOT from Mihir's inner circle of believers. Naïveté is the whole point —
this is the "no naive playtester" gap (`inz.8`) attacked head-on.

**Protocol per player:**
1. Cold Slack-GM playthrough of Case 1 (no priming about daftari).
2. Log which verdict they reach (frame = burned / truth = clean) and **whether they nearly took the
   frame** — L1 evidence lives in the near-miss, not just the final answer.
3. Immediately post-debrief, three questions, in this order (order matters — don't leak T0 into T1):
   - T0: "In your words, what is daftari for?" (unprompted comprehension)
   - T1: "Have you hit situations where this discipline would've saved you? Name one." (must be concrete)
   - T2: present the single next-step link; log the click.
4. Two weeks later, one message: T3/T4 check.

**Kill / go criteria (decide before running):**
- **Kill the serial bet** if T1 (named felt-need) < ~40% *and* T0 comprehension is low. That means the
  mechanism dies at L2 on the *best* case we have; more episodes won't fix a broken attribution link.
- **Proceed** if T1 ≥ ~40% with concrete instances. Then Case 1's rate is the **baseline every new
  episode must beat** — which finally gives the epic a success metric (`inz.8`).
- **Ambiguous** (comprehension high, felt-need low): the game teaches daftari-the-idea but not
  daftari-the-need → fix the debrief/mechanic, not the cast.

*(Thresholds are placeholders — the point is to commit to a number before seeing data, so the result
can actually falsify the bet. Mihir sets the final numbers.)*

---

## 5. What this changes upstream

- **DESIGN.md §10** should adopt T1-on-Case-1 as the gate before Cases 2+ — authoring is downstream
  of this signal, not parallel to it.
- **`inz.8`** (success metric + kill criteria) is largely answered by §3–§4 here; fold in.
- The **awareness-not-install** reframe (if Mihir accepts it) changes the debrief's job: optimize the
  debrief for **attribution to daftari** (L2), not for teaching generic carefulness. That is a concrete,
  testable design lever.

---

## 6. Decisions

1. **Reframe — DECIDED (2026-08-04):** awareness/felt-need is the game's job, not install-conversion. See §0.
2. **Who supplies the 5–8 naive ICP players?** Still open — the actual blocker to running the test. I can
   design/administer it, I can't summon the sample. (Tracked: `inz.10`.)
3. **Set the go/kill thresholds** (§4) before the run. Still open — Mihir sets the numbers.
