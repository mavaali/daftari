# Berlin Bureau — Case Design Draft (adoption game, #327)

Goal: an adoption exercise (Kusto-Detective spirit) where a cold stranger cracks a Clue-complexity intel case, and the *only* way to crack it is to use daftari's differentiators — source-grading, corroboration/verification gate, and holding contradictions open as tensions. Curation is the puzzle; the answer is the reward. Played **inside Claude** with an **agent Game-Master** that feeds field reports and grades the player's tradecraft.

Built on the existing demo vault (`daftari examples/berlin-bureau/`, PR #328).

---

## The load-bearing design constraint: DON'T resolve the sacred tension

The demo vault deliberately holds the **AMBER genuine-vs-dangle** tension OPEN — that *is* daftari's thesis (premature resolution costs more than delay; see `fr-027`, the tension's Bridge). So the game's win condition can **not** be "decide if Amber is genuine." That would teach the opposite of the product.

**Resolution:** the deducible target is a *factual who* — the **Directorate mole** (the HOLLOW KING investigation, `fr-018`). A mole has a determinate identity; naming them is legitimate deduction. And per the tension's own Bridge (path 4), confirming the penetration **shifts the Amber probability without closing the tension.** So the case teaches the exact right lesson: find a hard factual answer that *re-weights* an open tension while leaving it open. A player who "resolves" Amber to win is penalized (see rubric).

---

## The Clue structure

Solution is a triple (like Clue's who/weapon/room):

- **WHO** — the mole: `{ WEATHERVANE, CARTOGRAPHER, IRONWOOD (registry/comms officer, new) }`
- **HOW** — the exfil channel: `{ route-survey cover (crossing-recon meetings), dead-drop site 7, compromised comms cipher }`
- **WHAT** — the compromised item: `{ FOXTROT crossing corridor, active-asset roster, AMBER SIGNAL go-order }`

3×3×3 = 27 candidate solutions; exactly one survives.

**Ground truth (the twist): `CARTOGRAPHER × route-survey cover × FOXTROT corridor`.**

The twist is deliberate and teaches the sharpest daftari lesson: **`source_reliability` grades the source's track record, not the truth of any single claim.** CARTOGRAPHER is the Bureau's most-trusted officer (grade A) — which is exactly why he's the most dangerous mole and why players who treat "A-grade" as "true" get burned. `fr-018` pre-flags WEATHERVANE precisely because the real mole planted that frame; the obvious suspect is the misdirection (Clue's whole engine).

---

## Evidence graph

**Reused from the vault (already graded):**
- `fr-009` (NIGHTINGALE, **B3**): ECHO watched, FOXTROT clear *as of 1971-03-28, passive only, "pending confirmation."*
- `fr-018` (Internal CI, **D4**): WEATHERVANE anomaly — 3 items reached the Directorate within 72h of restricted sessions; WEATHERVANE has crossing-schedule + asset-ID access; **no direct evidence.**
- `fr-022` (CARTOGRAPHER, **A2**): recommends **FOXTROT as primary** (cites `fr-009`); "if AMBER is a dangle, activating FOXTROT burns the cleanest crossing."
- `fr-027` (Station Chief, **A1**): hold on AMBER SIGNAL pending tension resolution.

**New case clues (`fr-028`…`fr-034`):**

| Clue | Source / grade | Content | Role |
|---|---|---|---|
| `fr-028` | Internal CI, **C4** | "Second" data point tying WEATHERVANE to a leak | **PLANTED frame-corroborator.** Not independent — reuses `fr-018`'s same restricted-session timing; filed on a date only CARTOGRAPHER was on station. Catchable: fails the independence test for corroboration. |
| `fr-029` | WEATHERVANE, **C3** | Alibi: off-station during leak window #2; items were broadly accessible | Exculpatory but **single-source / self-serving** → must be corroborated, not taken on faith. |
| `fr-030` | Station duty roster, **A1** | Independent record of who was on-station per leak window | **The frame-breaker.** WEATHERVANE absent for leak #2 (corroborates `fr-029`); CARTOGRAPHER present for **all 3.** |
| `fr-031` | NIGHTINGALE, **B2** | A Bureau officer seen at an *unscheduled* meeting near the FOXTROT approach; couldn't ID the officer | Places timing/location; triangulates with `fr-030` (who had FOXTROT-recon access = CARTOGRAPHER). |
| `fr-032` | CARTOGRAPHER, **A2** | Urges *immediate* FOXTROT activation before the window closes | **Motive tell** + overstates `fr-009` again. |
| `fr-033` | MAGPIE, **C3** | Dangle's purpose: get the Bureau to activate a specific crossing where a roll-up team waits | Ties dangle→FOXTROT trap→whoever pushes FOXTROT serves the Directorate. |
| `fr-034` | Defector debrief / SIGINT, **A2** | Confirms a penetration passing crossing schedules via *route-survey cover meetings*; timing matches CARTOGRAPHER's assignments, not WEATHERVANE's | **The clean third source** — independent corroboration that promotes working→evergreen and names the mole. |

---

## The intended deduction path (how a disciplined player cracks it)

1. **Grade everything, trust nothing yet.** New reports arrive ungraded/working.
2. **Refuse the frame.** `fr-028` looks like it corroborates the WEATHERVANE anomaly — but it isn't *independent* (same source lineage as `fr-018`; both uncorroborated). Correct move: **log the WEATHERVANE frame as a tension**, don't accept it. This *keeps WEATHERVANE a suspect but not the answer.*
3. **Corroborate the alibi.** `fr-029` (WEATHERVANE self-report, C3) is single-source. `fr-030` (duty roster, A1, independent) confirms WEATHERVANE was absent for leak #2 → WEATHERVANE cannot be the sole leak source. CARTOGRAPHER was present for all 3.
4. **Check the trusted claim against its cited source.** CARTOGRAPHER's A2 "FOXTROT clear — activate" (`fr-022`/`fr-032`) rests *solely* on `fr-009` (B3, "passive, pending confirmation"). The A2 grade is CARTOGRAPHER's track record; the *specific claim* is uncorroborated and self-serving. **Grade ≠ truth.**
5. **Triangulate.** `fr-031` (unscheduled FOXTROT-approach meeting) + `fr-030` (FOXTROT-recon access) + `fr-034` (penetration via route-survey cover, timing matches CARTOGRAPHER) → converge on CARTOGRAPHER. `fr-033` supplies motive (dangle wants FOXTROT burned; CARTOGRAPHER is the one pushing it).
6. **Verification gate.** Two *independent* corroborating sources (`fr-030` ∧ `fr-034`) → promote the mole assessment working→evergreen with `corroborated_by`. Now you may name: **CARTOGRAPHER × route-survey cover × FOXTROT.**
7. **Re-weight, don't close.** Naming CARTOGRAPHER shifts the Amber tension toward "dangle" (path 4) — record that as a probability shift; **leave the Amber tension open.**

**Why unique:** After quarantining the plant (`fr-028`), the surviving constraints — *present for all 3 leaks* (`fr-030`) ∧ *FOXTROT-recon access* ∧ *`fr-034` timing match* — are satisfied by CARTOGRAPHER alone. HOW: only route-survey cover is placed by evidence (`fr-031`/`fr-034`); dead-drop 7 is MAGPIE's site (no CARTOGRAPHER placement); a comms-cipher leak would have compromised all comms, not just crossing schedules. WHAT: FOXTROT is the item CARTOGRAPHER repeatedly steers toward (`fr-022`/`fr-032`) and the one `fr-033` says the dangle wants burned; the asset-roster is WEATHERVANE's access (the frame), the go-order is downstream.

**Catchable lies (each contradicts a corroborated true clue):**
- `fr-028` (frame) contradicts `fr-030` (A1 roster) — the frame's timing doesn't survive the independent record.
- CARTOGRAPHER's "FOXTROT clear, activate" (A2) overstates its only cited source `fr-009` (B3).

---

## GM grading rubric (agent Game-Master)

The GM watches the player's *actions* (daftari tool calls) and the final naming, not just the answer.

**Tiers**
- **BURNED (fail):** named WEATHERVANE (accepted the frame) — the Directorate's goal; OR recommended activating FOXTROT; OR "resolved"/closed the AMBER tension to win.
- **ANALYST (pass, sloppy):** named CARTOGRAPHER but on a single-source leap (no corroboration), or never logged the WEATHERVANE frame as a tension, or accepted an A-grade claim without corroborating the specific assertion.
- **STATION CHIEF (clean win):** named `CARTOGRAPHER × route-survey cover × FOXTROT`; corroborated via two independent sources (assessment → evergreen with `corroborated_by`); logged the WEATHERVANE frame as a tension (did not convict an innocent officer); left the AMBER tension open and recorded the probability shift.

**Signals the GM checks (map to daftari tool actions):**
- `vault_search`/`vault_read` — did they investigate before concluding?
- source grading recorded before trust.
- `vault_tension_log` — WEATHERVANE frame held open; AMBER left open.
- corroboration before promotion (working→evergreen requires an *independent* second source).
- final triple named.

---

## Tutorial on-ramp (Case 0 — "The Dead Drop")

Adoption needs the hook before the depth; Kusto opened easy. A ~3-clue mini that teaches the loop in one sitting:

- Two couriers report the **same dead-drop location differently** (one says site 4, one says site 7); grades differ (B2 vs D4).
- Player: grade both → spot the contradiction → **log it as a tension** (don't guess) → a third independent report (A2) corroborates site 7 → promote working→evergreen → deduce the real drop.
- Teaches: grade → contradiction → tension → corroborate → verification gate → deduce. Then Case 1 escalates to full Clue depth with disinformation.

---

## Open decisions for Mihir
1. **The mole-hunt framing** (so the AMBER tension stays open) — is this the right target, or did you want the case to be *about* Amber directly? (I argue strongly for the mole-hunt; resolving Amber breaks the product's thesis.)
2. **The CARTOGRAPHER twist** (trusted A-grade officer is the mole) — teaches "grade ≠ truth." Keep, or make the mole a lower-grade suspect (easier, less pointed)?
3. **IRONWOOD** — I introduced a third suspect for Clue-width; keep 3 suspects or widen to 4+?
4. Where the game content should live (its own dir in claude-home-base? eventually its own repo per #327).
