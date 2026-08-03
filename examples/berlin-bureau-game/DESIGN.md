# Berlin Bureau — the serial (design)

> Roadmap for turning the Berlin Bureau adoption game from a single case into a **beloved,
> recurring world** — a Cold War *Slow Horses*. This is a design/creative doc, not an
> implementation plan. It sets the cast, tone, and the case menu; each episode is still built and
> gated the same way (`case_lint` PASS + a playtest — see `framework.md`).
>
> Status: design approved in principle (2026-08-03). Cases 0–1 shipped; Cases 2+ are the roadmap
> below. Nothing here is built yet.

---

## 1. North star

**Slow Horses.** Nobody comes back for the plot mechanics — they come back for Jackson Lamb, for
Slough House being the dustbin where the Service exiles its screw-ups, for the dark comedy and the
misfits who are better than the people who threw them away. The operation is just the engine; the
**people and the tone** are why you love it.

The Berlin Bureau already has a recurring set of names (CARTOGRAPHER, WEATHERVANE, NIGHTINGALE,
MAGPIE, the Station Chief). They are not yet *characters*. Making them characters — and building a
resident ensemble you grow to love — is the whole game beyond Case 1.

**The adoption thesis, restated as story:** the exiles do the unglamorous, careful work everyone
else skips — grading a source, checking a date, asking "says who?", refusing to rubber-stamp — and
that discipline is exactly what keeps cracking cases the glossy Service can't. daftari's discipline
*is* the misfits' superpower. If players love the misfits, they love the discipline.

---

## 2. The conceit — the Bureau is Left Luggage

Within the Service, the **Berlin Bureau is the posting nobody wants**: the desk where Head Office
checks the baggage it can't be bothered to carry — burned officers, abrasive analysts, the
"difficult," the ones who were *right at the wrong time*. The Service calls it **"Left Luggage"**
(a nod to the dead-drop left-luggage locker the Bureau lives among — the tutorial's site-7,
`fr-t01`/`fr-t03`). To be sent to Left Luggage is to be told your career is over.

The joke, and the heart: Left Luggage is where the real tradecraft still happens, because nobody
here can afford to be sloppy and nobody here is trying to impress anyone anymore. They have nothing
left but the work.

**Tone:** *Slow Horses* — darkly comic, cynical on the surface, human and warm underneath. Cold War
grime, gallows humour, small dignities. Never grim for its own sake; the comedy is the delivery
system for the discipline.

---

## 3. The cast

### The anchor — Station Chief **Otto Kessler** ("the Bear")
The Jackson Lamb. Once the legendary runner of the GLASS CURTAIN network; now a slovenly, cynical
wreck who runs the dumping ground — and *chose* to. Outwardly he can't be bothered; actually he is
the sharpest tradecraft mind in the Service and he protects his misfits like a bear its cubs, while
insulting them constantly. In Case 1 he is the "Station Chief" who put AMBER SIGNAL on hold and
tasked the mole hunt — the one adult in the room. He is never the puzzle; he is the reason you feel
safe enough to lose.

### The player — the newest exile
You. Your "sin": you **held a contradiction open** — refused to resolve a tension to give a superior
the clean answer they wanted, or wouldn't sign off on thin intelligence. For being *right and
inconvenient*, you were sent to Left Luggage. Case 1 (the HOLLOW KING mole hunt) is your arrival —
your specialty is **source-grading + holding tensions open**, which is exactly why you crack it.
Every later episode teams you with the resident savant of a *different* discipline.

### The ensemble — one misfit per daftari primitive
Each resident is a savant of one daftari muscle: the exact discipline that got them exiled for being
"difficult," and the exact thing that cracks their episode. They headline that episode; they recur
in the others as texture.

| Resident | daftari primitive | Their "sin" (why exiled) | Voice / tell |
|---|---|---|---|
| **Liesl Brandt** — "the Undertaker" | **staleness / decay** — trusts nothing past its half-life | Blocked a "confirmed" op during a crisis because the intel was 9 days stale. She was *right* — it would have walked assets into a trap — but she was blamed for the delay. | Morbid, precise; keeps a "decay wall" of expiry dates; dates everything twice. |
| **Piotr "Pip" Nowak** — "Says-Who" | **provenance / compilation** — "where did this actually come from?" | Exposed a Head Office golden source as *laundered* — a claim compiled from the very report it was "corroborating" — in front of First Desk. Humiliated a mandarin. | Relentless, socially oblivious; draws source-trees on napkins; cannot let a claim stand un-sourced. |
| **Margarethe "Greta" Vogel** — "the Bottleneck" | **the verification / ratification gate** (tier-2 verdict queue) — won't sign off | Refused to rubber-stamp the approval backlog; jammed the queue a week; a window closed. Branded a coward — but the one she wouldn't sign was the rotten one. | Immovable, quietly stubborn; keeper of the gate; "I don't sign what I can't stand behind." |

*(Backlog savants for later seasons: a bi-temporal / "what was true then" savant for valid-at; a
supersession/lineage savant. See §7.)*

### The antagonist — First Desk deputy **Sabine Kroll**
The Diana Taverner. Head Office polish, no tradecraft. She wants Left Luggage shut and its budget
folded into hers, takes credit for the Bureau's saves, and keeps feeding them "dead" cases to
justify closing the desk. The season villain — and, maybe, the season's rot (§6).

---

## 4. The organizing spine (approved)

**One misfit ↔ one daftari primitive. Each case is that character's episode.** Puzzle variety and
character love come from the *same* move: a new episode spotlights a new resident *and* a new
daftari muscle, so no two cases are "grade the sources and hold the tension" again. The recurring
cast is what makes players come back; the rotating primitive is what keeps it fresh and keeps
teaching.

The player's own specialty (source-grading + tensions) anchors Case 1; every later episode pairs the
player with a resident whose discipline the player must *learn* to crack the case — so the player
grows, and the audience learns a second, third, fourth daftari muscle.

---

## 5. The case menu (episodes)

Each episode must still pass the four invariants (A truth-uniqueness, B fairness, C
naive-misdirection, D sacred-tension) and a playtest. The **mechanic** column is the twist: which
daftari muscle is *load-bearing* — the thing a rushed player skips and gets burned for.

| # | Episode (working title) | Headliner | daftari muscle the puzzle turns on | The trap (what the rushed player does) | Status |
|---|---|---|---|---|---|
| 0 | **The Dead Drop** | tutorial | the whole loop, gently | (no trap — tutorial) | **shipped** |
| 1 | **The Hollow King** | the player | **source-grading + tensions** — grade ≠ truth; corroborate before naming | Convicts the pre-framed suspect on face-value count | **shipped** |
| 2 | **The Confirmed Corpse** | Brandt (staleness) | **staleness / decay** — the "confirmed" fact everyone's acting on went stale; only the timestamp saves you | Acts on the freshest-*looking* report without checking when it was actually true | roadmap |
| 3 | **Says Who** | Nowak (provenance) | **provenance / compilation** — a conclusion built on a source that was itself compiled from the thing it "confirms" | Trusts a high-grade corroborator that is secretly downstream of the claim (laundered self-corroboration) | roadmap |
| 4 | **The Bottleneck** | Vogel (ratification) | **the verification gate / tier-2 verdict queue** — rubber-stamping the backlog is how the bad one gets through | Clears the queue to hit the deadline; signs the rotten approval | roadmap |

**Why these four muscles first:** they are the daftari differentiators a newcomer most needs to
*feel* to get the product — freshness (decay), lineage (provenance/compilation), and the human gate
(ratification) — and each yields a clean Clue-style trap distinct from the mole hunt. Episodes 2–4
each need: a `ground_truth`/`frame`/clue encoding that `case_lint` PASSes, implicit-tell prose (tells
shown, never told — §8), a GM rubric, and a playtest that splits rushed→frame / rigorous→truth.

---

## 6. Serial structure

**Standalone episodes + a season arc** (the Slow Horses model). Each case is self-contained and
crackable cold — a stranger can start on any episode (Kusto "case N is public" hook). But a running
thread rewards the returning player:

- **The season question:** Kroll keeps dumping "dead" cases on Left Luggage to justify closing it —
  yet every one turns out to be load-bearing. Across a season, the residents' disciplines keep
  surfacing the same shape: a rot that traces back toward Head Office itself. The exiles, precisely
  because they do the careful work the glossy Service won't, are the only ones who can see it.
- **Continuity rules (keep it light):** the *cast, tone, and running thread* persist; each case's
  *evidence vault* is self-contained (no case requires having played another). Character beats
  advance between episodes; puzzle state does not carry.
- **A season = ~5–6 episodes** ending on an arc payoff (e.g., the rot named — but, true to the
  thesis and to daftari, a **sacred tension about Head Office stays open** rather than being tied off;
  naming shifts probability, it never closes the genuine uncertainty).

---

## 7. What this asks of the engine (flagged, NOT built here)

The current framework/`case_lint` model a *mole-hunt* shape: axes (who/how/what), a planted frame,
Admiralty grades, one sacred tension. The new muscles need small, additive extensions — to be
designed per episode, not now:

- **A per-case "mechanic" descriptor** so `case_lint` knows which discipline is load-bearing and can
  check the trap is real for *that* muscle (e.g. for staleness: the frame clue must be the freshest-
  looking but stalest; for provenance: the frame corroborator must be graph-downstream of the claim).
- **Encoding vocabulary per muscle:** decay needs per-clue `as_of` / `valid_until` dates; provenance
  needs a `derived_from` edge between clues so "independent" can be *checked*, not asserted; the
  ratification episode needs a `queue` of staged verdicts with one rotten item.
- These are **framework changes** — each gets its own spec + `case_lint` extension + a
  negative-test (a broken case must FAIL) before its episode is authored. Do not hand-wave them into
  prose; the invariant is that discipline stays *mechanically* load-bearing, not just narratively.

**Guardrail:** `case_lint` PASS remains necessary-but-not-sufficient. Every episode still needs a
human/cold-agent playtest, because the linter cannot see prose that gives the answer away.

---

## 8. Guardrails carried forward (do not relitigate)

From the shipped design (`framework.md`, and the vault log):

1. **Curation is the puzzle; the answer is the reward.** Naive elimination must land on a planted
   frame; only the daftari discipline reaches the truth.
2. **Sacred tensions stay OPEN.** Solving shifts a probability; it never closes the genuine
   uncertainty. Closing one to "win" is an auto-fail.
3. **Tells are shown, never told.** Reports must not footnote their own (non-)independence, staleness,
   or "grade ≠ truth." The player derives the tradecraft. (This was *the* bug the first playtest
   caught.)
4. **Solution keys are GM-only.** Never inside a player vault.
5. **Every case: `case_lint` PASS *and* a playtest** (rushed → frame, rigorous → truth).
6. **Tone is load-bearing.** A case that teaches the muscle but isn't *fun/characterful* has failed
   the north star. The debrief is the adoption pitch; the characters are the reason it lands.

---

## 9. Backlog (future muscles → future episodes)

- **Bi-temporal validity (`valid_at`)** — "what did we know then vs. what was true then." A case where
  acting on today's knowledge to judge a past decision is the trap; a new savant headlines.
- **Supersession / lineage** — a retracted-and-replaced report where the deprecated version is still
  being cited.
- **Edges / consumes / staleness-with-respect-to-inputs** — a compiled assessment that went
  quietly wrong because an upstream input changed.
- **Confidence tiers / promotion** — working→evergreen promoted too early.

Each is a candidate episode; each needs the §7 engine work first.

---

## 10. Open questions for Mihir

1. **Cast names/voices** — Kessler / Brandt / Nowak / Vogel / Kroll and the "Left Luggage" conceit are
   my proposals. Keep, rename, or recast? (Especially the anchor — the Lamb is load-bearing.)
2. **Season length + arc payoff** — is ~5–6 episodes/season right, and is "the rot traces to Head
   Office, but the tension stays open" the arc you want, or something less conspiratorial?
3. **Player identity** — fixed continuous character (the newest exile, my recommendation for
   Slow-Horses attachment) vs. a fresh seat per case?
4. **Build order** — which muscle is Case 2: staleness (**The Confirmed Corpse**, my pick — most
   viscerally "aha" for a newcomer), provenance, or ratification?
5. **Engine appetite** — are you happy for each new muscle to get a small `case_lint` extension
   (§7), or do you want to keep every case inside the current who/how/what mole-hunt shape and vary
   only the story?
