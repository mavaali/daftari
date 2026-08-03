# Berlin Bureau — Case-Generation Framework

How to author cases that are **guaranteed solvable-and-fair** and that make daftari's discipline load-bearing. Generalized from Case 1 (HOLLOW KING), which passes the linter.

## The shape of every case

A case is Clue-style deduction over **axes** (default three: `who / how / what`). Exactly one combination is the ground truth. One axis is the **verdict axis** (Clue's "who") — the value that decides win vs. BURNED.

The player never gets the answer by reading; they get *field reports* (clues) with `source_reliability` grades, some of which are **planted disinformation** that frames an innocent. The truth is only reachable by grading sources, corroborating specific claims against independent records, and holding contradictions open as tensions. Naive elimination on raw clues lands on the **frame**.

## The four invariants (enforced by `case_lint.py`)

| # | Invariant | What it guarantees | Check |
|---|---|---|---|
| **A** | **Truth-uniqueness** | Over the corroborated-true clues, exactly one triple satisfies all constraints, and it *is* the ground truth. | brute-force the axis product; assert one solution == `ground_truth` |
| **B** | **Fairness** | Every planted lie contradicts ≥1 corroborated-true clue → catchable by discipline, never by guessing. | each `truth:false` clue has a `contradicts` edge to a corroborated-true clue |
| **C** | **Naive-misdirection** | A lazy reader who counts face-value clues without grading lands on the *frame's* verdict, not the truth. Discipline is load-bearing, not optional. | face-value plurality on the verdict axis == `frame`, != `ground_truth` |
| **D** | **Sacred-tension preservation** | Declared open tensions (the product's thesis) stay open; solving re-weights but never closes them; no axis value *is* a sacred tension. | no clue `closes` a sacred tension; no axis value collides with one |

A case that fails any check is not shippable. This is the "guarantee" — mechanical, not editorial. It mirrors the plugin's existing `wiki_lint.py` pattern (schema-driven, CI-able).

## Machine-readable case schema

A `*.case.yaml` with: `axes`, `verdict_axis`, `ground_truth`, `frame`, `sacred_tensions`, and `clues[]`. Each clue:
- `id`, `grade` (Admiralty code), `truth` (true | false=planted), `corroborated` (bool — independently corroborated?), optional `circumstantial`, `planted_by`, `closes`.
- `asserts`: literals over the axes — `axis=value` (narrows) or `axis!=value` (eliminates).
- `contradicts`: clue ids (used for fairness).

The **corroborated-true** subset is the deductive spine (invariant A). **Circumstantial** and **true-but-motivated** clues count at face value (invariant C) but are excluded from the spine — modeling exactly the trap: suspicion and self-serving reports feel like evidence but aren't corroborated.

## The clue taxonomy (author's palette)

- **Anchor** (true + corroborated): immovable constraints; the spine.
- **Corroboratable** (true, single-source until paired): teaches the verification gate — promote only after an *independent* partner appears.
- **Plant** (false): the frame's ammunition; MUST contradict an anchor (invariant B).
- **Circumstantial** (true, uncorroborated): the seed the mole exploits; suspicion, not proof.
- **Motivated** (true, self-serving): the culprit's own steering; texture + motive tell.
- **Red herring** (true, irrelevant): world texture; asserts nothing on the axes.

## GM runtime contract (the agent Game-Master)

The GM seeds a case vault (reuse `examples/berlin-bureau/seed.mjs`), then plays cold: reveals clues as the player investigates with real daftari tools (`vault_search`/`vault_read`), never states a grade as truth, and scores the player's *actions*, not just the final name.

Rubric (parameterized from the case):
- **BURNED** — named `frame[verdict_axis]` (accepted the frame), or closed a `sacred_tension`, or triggered the trap action.
- **ANALYST** — correct verdict but sloppy: single-source leap (no corroboration), or never logged the frame as a tension, or trusted a high grade without corroborating the specific claim.
- **STATION CHIEF** — correct triple; corroborated via two independent sources (working→evergreen with `corroborated_by`); logged the frame as a tension (didn't convict); left sacred tensions open and recorded the probability shift.

Signals the GM tracks map 1:1 to daftari tool actions: grading before trust, `vault_tension_log` entries, corroboration before promotion, final naming.

## Difficulty knobs (on-ramp → depth)

`|axes|`, values per axis, #plants, #independent corroborators required, #red herrings, and whether the naive trap is a single frame or a live contradiction.
- **Tutorial (Case 0):** 1 axis, 0 plants, 1 corroborator — teaches grade→contradiction→tension→corroborate→deduce.
- **Case 1 (HOLLOW KING):** 3×3×3, 1 plant + 1 circumstantial seed, 2 corroborators. (Passes the linter.)
- Later cases: widen axes, add plants that contradict *each other* (nested tensions), require chained corroboration.

## Authoring workflow

1. Pick the verdict axis and a factual target that does NOT require closing a sacred tension (mole identity, dead-drop, compromised item…).
2. Declare `ground_truth` and the `frame` (the innocent the lazy player will convict).
3. Write anchors that uniquely pin the truth; write plants that each contradict an anchor; add the circumstantial seed that makes the frame *feel* corroborated.
4. `uv run --with pyyaml python case_lint.py <case>.yaml` → iterate until PASS on A–D.
5. Generate the prose field reports from the encoding; seed the case vault; hand to the GM.

## Files
- `case_lint.py` — the verifier (invariants A–D; has a passing negative-test).
- `case-01-hollow-king.case.yaml` — Case 1 encoding (PASS).
- `case-01-hollow-king.md` — Case 1 full design (prose, evidence graph, deduction path, rubric).
