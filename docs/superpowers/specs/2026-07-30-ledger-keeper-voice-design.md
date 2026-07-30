---
title: "The Daftari speaks — the ledger-keeper voice — design"
date: 2026-07-30
status: draft
motivated_by: "positioning-2026-07 idea 10 — make epistemic discipline legible and lovable"
---

# The Daftari speaks — the ledger-keeper voice

## Summary

Give `vault_lint`'s advisory output an optional **voice**: the dry, margin-note
register of a three-centuries-old ledger-keeper. The findings do not change —
only their human-facing rendering. `LintReport` (`src/curation/lint.ts`) stays
byte-identical for machine consumers; the voice is an *additional* rendered
string, opt-in via config, produced by deterministic templates (no LLM).

> "Entry 47 contradicts entry 12. I have recorded both, as is my duty. One of
> you is wrong."

Zero new detection machinery. The linter already finds everything; this makes
the epistemic discipline legible in a register a clone can't fork. Brand as
moat.

## Motivation

The linter is advisory and easy to ignore (`src/curation/lint.ts` reports, never
acts — six checks plus tension/staged/shadow/coverage health). The positioning
audit (§3, "the discipline tax") names the failure mode: agents and users
default to the lazy path, and a linter that reads as a wall of `LintFinding`
`{path, detail}` rows gets skimmed and dropped. The moat is *non-collapsing,
auditable memory*; the cheapest way to make that moat felt on every run is to
give the advisory layer a character that makes reading it a small pleasure.

This is one of the two **ungated** ideas from the July brainstorm (no corpus-B
dependency, no install-base dependency) — see idea 5 for the other. It ships the
already-shipped discipline (receipts, tensions, decay) into something a user
*wants* to read.

## Decisions (settled)

- **Voice is a rendering layer, never a detector.** It consumes the existing
  `LintReport` and emits human copy. It cannot add, drop, reorder, or re-severity
  a finding. The structured payload returned by the `vault_lint` tool
  (`src/tools/curation.ts`) is unchanged; the voice is a sibling field/renderer.
- **Templated, not generative.** Copy is produced by deterministic string
  templates keyed by `LintCheckName` + the finding's fields. **No LLM call.**
  This keeps `vault_lint` hermetic, free, instant, snapshot-testable, and
  incapable of hallucinating a finding that isn't in the report. It is the
  literal meaning of the brainstorm's "zero new machinery — it's the lint report
  with a voice."
- **Opt-in via loud config.** New `.daftari/config.yaml` key `lint_voice`, one of
  `plain` (default) | `ledger_keeper`. Absent means `plain` means today's output
  byte-for-byte. Any other value is a loud config error (Daftari's loud-config
  contract), not a silent fallback.
- **The voice never editorializes past the finding.** It may name the entry, the
  count, and the recorded fact; it may not invent a cause, assign blame beyond
  "one of these is wrong," or recommend an action the finding doesn't already
  imply. Discipline in the copy mirrors discipline in the vault.
- **v1 scope = `vault_lint` only.** The coherence `audit` report
  (`src/audit/report.ts`) is a candidate for the same treatment but is out of
  scope until v1's kill condition clears.
- **Ship behind a user test.** The kill condition (below) is a *release gate*,
  not a post-hoc metric: the fez does not merge to default-discoverable until it
  has been read by real users who did not build it.

## Config

| `lint_voice` | effect |
|---|---|
| (absent) | `plain` — current structured/plaintext output, unchanged |
| `plain` | explicit default; identical to absent |
| `ledger_keeper` | render findings in the ledger-keeper register |
| anything else | loud config error at load (`config.ts` validation) |

Resolved in `loadConfig` to `config.lintVoice: "plain" | "ledger_keeper"` so the
rest of the system sees a concrete enum, never a raw string.

## Mechanism

New module `src/curation/lint-voice.ts`, pure and dependency-light:

```
renderLedgerKeeper(report: LintReport): string
```

- Input: the existing `LintReport` (already computed by `runLint`).
- Output: a single human-readable brief — a preamble line, then one margin note
  per finding, grouped by check, closing with a one-line tally.
- Each `LintCheckName` gets a persona template. The template receives the
  `LintFinding` (and, for tension/staged/shadow/coverage, the corresponding
  health struct) and returns one line. Templates are pure functions of their
  inputs — same report in, same string out.
- The renderer is selected by `config.lintVoice`. `plain` returns today's
  formatter; `ledger_keeper` returns `renderLedgerKeeper`. The tool's
  machine-readable JSON payload is emitted regardless of voice.

Illustrative templates (final copy to be reviewed against the kill condition):

| check | plain detail | ledger-keeper line |
|---|---|---|
| `deprecatedStillLinked` | `still linked from canonical: X` | "Entry {path} is retired, yet {X} still lean on it. I do not move the dead." |
| `staleFiles` | `{n}d since update, ttl {t}d` | "{path}: {n} days unattended, its warranty being {t}. I record the lapse." |
| `orphanFiles` | `no inbound links` | "{path} speaks to no one and no one to it. Noted, and left where it lies." |
| `unansweredQuestions` | `{n} question(s) raised but not answered` | "{path} asks {n} things this house cannot yet answer. The questions stand." |
| tension health (contradiction) | `total N, stale K` | "{K} disputes have aged past patience. I have recorded both sides of each, as is my duty." |

## Testing

- **Snapshot tests** over hand-built `LintReport` fixtures: one per check, plus a
  full-report golden. Deterministic templates make these exact-match.
- **Invariance test:** for the same vault, the set of `(path, check)` pairs
  surfaced under `ledger_keeper` equals the set under `plain`. The voice cannot
  change *what* is flagged — assert it structurally.
- **Config test:** absent/`plain` produce identical bytes; unknown value errors
  loudly at load.

## Kill condition

It reads as clippy-with-a-fez. **Release gate:** before the ledger-keeper voice
becomes discoverable by default (docs, help text, marketing), it must be read by
at least 3 users who did not build it, in the context of a real lint run, and
land as "I'd keep this on" rather than "cute once." If it doesn't clear that bar,
keep the machinery (the renderer indirection is cheap and harmless) and drop the
persona copy — revert to `plain` as the only shipped voice.

## Non-goals (v1)

- No LLM-generated copy. If a future version wants generative flourish, that is a
  separate spec with its own hermeticity/cost analysis.
- No change to detection, severity, or the machine payload.
- No voice for `daftari audit` yet.
- No per-check voice toggles — one switch, whole report.

## Dependencies & status

- **Ungated.** No corpus-B result and no install base required.
- Touches: `src/curation/lint.ts` (unchanged — consumed only),
  `src/curation/lint-voice.ts` (new), `src/tools/curation.ts` (renderer
  selection), config load/validation (`lint_voice` key).
- Sequences naturally with idea 5 as the two cheap, ungated wins that make the
  already-shipped discipline felt.
