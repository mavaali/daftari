---
title: "Memory divorce kit — the model-swap stunt — design"
date: 2026-07-30
status: draft
motivated_by: "positioning-2026-07 idea 5 — same memory, three brains, scored"
---

# Memory divorce kit — the model-swap stunt

## Summary

Package the manifesto ("rent the brain, own the memory") as a runnable
benchmark: import a provider's memory export into a Daftari vault, then run **the
same question set against the same vault while switching answerer model families**
(Anthropic to OpenRouter-hosted models), scored by the existing eval harness. The
deliverable is a **continuity score** — "same memory, three brains" as a number,
not a vibe.

Two thin parts, both leaning on machinery that already exists:

1. **A provider-memory importer** — a new `daftari import` type that adopts a
   memory export (ChatGPT / Claude) into a vault as staged drafts.
2. **A model-swap eval mode** — run `daftari eval` over one question set and one
   vault across multiple `answerer_model`s, then compare answer quality across
   families.

## Motivation

The moat argument (positioning §2–§4) is "memory you own, portable across brains."
It is currently asserted in a manifesto, not demonstrated. The cheapest way to
make it *undeniable* is a live stunt with a score attached: an agent mid-task
swaps Claude to GPT to a local model with the vault as its only continuity, and
the eval harness reports whether answer quality holds. If it holds, that is the
demo no provider-native memory can match (their memory doesn't travel). If it
doesn't hold, this was the cheapest possible way to learn the moat leaks — which
is exactly what a kill condition is for.

The pieces are already on disk:
- `daftari eval run --model <id>` runs an answerer LLM k times against an
  in-process vault tool surface, scored by `aggregateScore`/`gradeAnswer`
  (`src/eval/`), keyed by `answerer_model` in the `EvalRun`.
- `src/eval/llm-openrouter.ts` already provides a second model-family transport
  behind the same `LlmClient` interface (built for the Stage-5 decorrelation
  panel; runs on `OPENROUTER_API_KEY`).
- `daftari import` already adopts foreign content in place via the backfill flow
  (`src/import/index.ts`, v1 = obsidian).

So this spec is mostly **orchestration + one new importer**, not new infra.

This is one of the two **ungated** brainstorm ideas (no corpus-B dependency, no
install base) — see idea 10 for the other.

## Part 1 — provider-memory importer

New import type(s) alongside `obsidian`: `daftari import chatgpt <vault>` and
`daftari import claude <vault>` (names track the export source).

### Decisions (settled)

- **Reuse the backfill two-step UX** exactly as obsidian import does
  (`plan` then `apply`), so adoption is previewable and reversible.
- **Everything lands as `draft`, staged for ratification — never auto-canonical.**
  A provider memory export is unaudited, provenance-poor material; it enters the
  vault as claims to be reviewed, honoring "the vault never mints a value."
- **Provenance is stamped honestly.** Each imported doc records
  `source: <provider>-memory-export` and the export's own timestamp where
  available; confidence defaults to `low`. No fabricated `derives_from` edges.
- **Format adapter per provider, one normalized target.** Providers ship
  different JSON/markdown export shapes; each gets a small adapter that maps to
  one intermediate `{title, body, created, tags}` record, then the shared
  backfill derivation produces frontmatter + markdown. Adding a provider = one
  adapter, no core change.
- **Import writes nothing outside the vault** and is idempotent on re-run (same
  export produces the same staged plan).

### Out of scope (v1)

- Extracting *tensions* from contradictory memories automatically — imported
  claims that disagree surface through normal lint/tension flow after
  ratification, not at import time.
- Two-way sync back to the provider. Import is one-directional by design (that is
  the point — you are leaving).

## Part 2 — model-swap eval mode

The stunt is a comparison, not new scoring math. Concretely:

- **Fix the vault and the question set.** Generate one question set over the
  imported vault (`daftari eval generate`); freeze it.
- **Run the answerer across model families.** Execute `daftari eval run` once per
  target model — e.g. `claude-sonnet-4-6` (Anthropic transport), an
  OpenRouter-hosted GPT, an OpenRouter-hosted open model — same `--vault`, same
  `--questions`, same `--k`. Each run is already tagged with its `answerer_model`.
- **Score continuity across families.** For each model, `daftari eval score`
  yields `score` / `score_std`. The continuity result is the cross-model
  comparison over the *identical* vault + questions: how much does answer quality
  move when only the brain changes? Same-memory continuity = the spread staying
  tight and high.

### Decisions (settled)

- **"Mid-task switch" is realized as per-family runs over one frozen vault
  state**, not as a live model handoff inside a single conversation. The eval
  already runs independent `(q, k)` pairs against a fixed vault; swapping the
  `answerer_model` between runs *is* the swap, and it is reproducible — a live
  in-conversation handoff is theater without a number, whereas this yields the
  number. A scripted live demo can wrap these runs for presentation, but the
  benchmark is the run set.
- **The deliverable is a continuity report artifact**, not just a console line:
  a small compiled result (`.daftari/eval/` sibling) listing per-model
  `score`/`score_std` over the shared question set, plus the spread. This is the
  "experiment isn't done until it's written" contract — the artifact is the
  proof.
- **No new transport work assumed beyond what exists.** If a target family isn't
  reachable through the current Anthropic + OpenRouter transports, that model is
  simply out of the panel for v1; the spec does not block on adding transports.
- **Grader model is held fixed across the panel** so the comparison measures the
  answerer, not the grader. (`daftari eval score --grader-model` is pinned for
  all families in a run set.)

## Deliverables

1. `daftari import chatgpt|claude <vault>` — provider-memory adoption, staged.
2. A documented run recipe + a thin wrapper that executes the eval panel over one
   vault/question set across N models and writes the continuity report.
3. One published continuity result over a real imported vault — the artifact that
   settles the kill condition.

## Kill condition

Continuity scores are actually mediocre across model families — the vault does
*not* carry answer quality when the brain changes. If per-model `score` spreads
wide or drops sharply off the strongest family, the "same memory, three brains"
claim is weaker than the manifesto says. Then: do not ship the stunt as
marketing; keep the importer (it is independently useful) and record the negative
result honestly — it was the cheapest way to find the leak, and it feeds back
into the moat argument rather than papering over it.

## Dependencies & status

- **Ungated.** No corpus-B result and no install base required.
- Leans on: `src/eval/` (run/score/generate, `answerer_model` keying),
  `src/eval/llm-openrouter.ts` (second family transport, `OPENROUTER_API_KEY`),
  `src/import/index.ts` + `src/backfill/` (adoption flow).
- New surface: provider-memory adapters + import type; a continuity-report
  wrapper over the eval panel.
- Env: `ANTHROPIC_API_KEY` and `OPENROUTER_API_KEY` for a multi-family panel;
  a single-family run degrades to a normal eval and cannot demonstrate continuity.
- Sequences with idea 10 as the two cheap, ungated wins that make the shipped
  discipline (receipts, tensions, portability) *demonstrated* rather than
  asserted.
