# Berlin Bureau — the adoption game

A Kusto-Detective-style adoption game for daftari (issue #327). A cold player cracks a Cold War
mole-hunt case inside Claude, with an **agent Game-Master**, and the *only* way to crack it is to
use daftari's differentiators: **source-grading** (Admiralty code), **corroboration / the
verification gate**, and **holding contradictions open as tensions**. Curation is the puzzle; the
answer is the reward. It is built on the same fictitious world as the [`berlin-bureau`](../berlin-bureau)
demo vault.

**It is validated:** a rushed player is misdirected onto a framed innocent (BURNED); a rigorous one
reaches the real mole (STATION CHIEF). The discipline is load-bearing — demonstrated, not asserted.

## What's here

| Path | What it is |
|---|---|
| `gm-skill.md` | The case-agnostic **Game-Master**: briefs the player, lets them investigate a case vault with real daftari tools, grades their tradecraft against a hidden solution key, delivers the verdict + an adoption-pitch debrief. |
| `framework.md` | The case-generation framework: four invariants, clue taxonomy, GM contract, difficulty knobs, authoring workflow. |
| `case_lint.py` | The verifier — proves a case is **solvable-and-fair** (invariants A–D). Supports `mode: tutorial`. Run with `uv run --with pyyaml python case_lint.py <case.yaml>`. |
| `cases/case-01-*` | **Case 1 — HOLLOW KING** (mole hunt, with a disinformation trap): prose design, machine encoding, and the GM-only solution key. |
| `cases/case-00-*` | **Case 0 — The Dead Drop** (tutorial on-ramp, no trap): encoding + GM-only key. |
| `cases/case-01-vault/`, `cases/case-00-vault/` | The **playable case vaults** (daftari vaults) + a `seed.mjs` each. |

> **The solution keys (`*-solution.key.yaml`) are GM-only.** They are never placed inside a player
> vault. The GM reads them to score.

## Playing a case

Each case vault ships a `seed.mjs` that builds a live, indexed daftari vault and logs the case's
sacred tension. It writes a `.daftari/config.yaml` granting a `player` role read access — **required**,
because daftari resolves an unknown `--role` to a no-permission guest, which would serve an empty
vault.

```bash
npm run build                                     # so dist/ exists
node examples/berlin-bureau-game/cases/case-01-vault/seed.mjs /tmp/hollow-king
# point a daftari MCP at the seeded vault, then run the GM (gm-skill.md) against it:
node dist/cli.js --vault /tmp/hollow-king --user player --role player
```

The GM (an agent running `gm-skill.md`, handed the case vault + its solution key) briefs the player
and runs the investigation over the real `vault_search` / `vault_read` / `vault_tension_*` tools.

## Authoring a new case

1. Write `ground_truth` + `frame` + clues in a `*.case.yaml`.
2. `case_lint.py` must **PASS** (solvable-and-fair).
3. Write the field-report prose with **implicit** tells — the reports must NOT footnote their own
   (non-)independence or "grade ≠ truth"; the player derives the tradecraft. (`case_lint` PASS is
   necessary but not sufficient — it cannot see prose that gives the answer away.)
4. **Playtest**: a rushed player must be misdirected onto the frame; a rigorous one must solve it.
5. Write the GM rubric into the solution key.
