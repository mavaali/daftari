---
title: "Obsidian adoption (in-place) — design"
date: 2026-06-19
status: draft
supersedes_issue: daftari-obsidian-import-issue.md
---

# Obsidian adoption (in-place)

## Summary

Let a user adopt an existing Obsidian vault into Daftari **in place** — Daftari
indexes and curates the same files Obsidian authors. This is the adoption front
door: a coexistence user keeps writing in Obsidian, points their LLM at Daftari,
and the answers get better.

This is **not** a new import subsystem. It is a thin, Obsidian-aware, discoverable
wrapper over the existing `daftari backfill` machinery. Almost every hard part the
originating issue worried about is already solved in the codebase.

## Origin and the corrections it forced

The work began from `daftari-obsidian-import-issue.md`, an AI-generated draft. Three
of its load-bearing claims were checked against the repo and do not hold:

1. **"Critical Dependency: Frontmatter Merge Bug" — does not exist.** The issue's
   central blocker (`#[TBD]`: "backfill replaces frontmatter wholesale instead of
   merging field-by-field") is contradicted by the code. Field-by-field merge with
   existing-fields-preserved is implemented and is the most heavily tested behavior
   in the repo:
   - `vault_write` update merges existing frontmatter under the payload, preserves
     undeclared custom fields, treats explicit `null` as deletion —
     `src/tools/write.ts:454`.
   - `backfill/deriveProposed` preserves every present field and fills only missing
     ones — `src/backfill/derive.ts:135`.
   - Coverage: `test/tools/write.test.ts:828` ("frontmatter merge on update (#113)",
     incl. "preserves all six custom fields from the issue #113 repro at once"),
     plus `derive.test.ts`, `apply.test.ts`, `plan.test.ts`.
   - **Consequence:** nothing to fix first.

2. **Wikilinks are already resolved Obsidian-style.** `extractLinks` parses
   `[[Note Name|alias#anchor]]`, and `resolveLink` does basename resolution with
   first-write-wins on collisions — `src/curation/vault-docs.ts:54`. The issue's
   "Option A (convert) vs Option B (teach Daftari)" fork is moot: Option B already
   ships. We **never convert** wikilinks (conversion would break Obsidian's own
   rendering for a coexistence user, and is lossy on name collisions).

3. **There is no `type` field in Daftari.** The issue's field-mapping table invents
   `type` (default `note`). Daftari's built-ins are `domain` / `status` /
   `confidence` / `provenance` (etc.); the issue's defaults for those
   (accumulation / canonical / medium / direct) already match `deriveProposed`
   exactly — `src/backfill/derive.ts:189`.

## User model (decided)

Coexistence, not migration:

- Obsidian stays the **authoring** surface (manual notes, Web Clipper clips).
- Daftari is the **indexed, curated, LLM-facing** layer over the **same files**.
- New notes appear over time (manual + clipped). Daftari indexes them live and
  fills missing frontmatter on a **deliberate** pass — never automatically.

This model makes in-place adoption correct and a separate copy wrong: a copy
diverges (new Obsidian notes are invisible to Daftari until re-sync; Daftari's
cleanups are invisible to Obsidian), which breaks the "side by side, answers
improve" loop.

## Architecture

### Entry point

`daftari import obsidian <vault>` — a thin wrapper over `runBackfill`, run
**in-place** on `<vault>`, with Obsidian-aware derivation enabled. It **mirrors
backfill exactly**:

- `--plan [--scope <folder>]` — the dry-run. Walk, derive, write the plan to
  `.daftari/backfill-plan.jsonl`. Modifies no markdown.
- `--apply --scope <folder> [--yes]` — write proposals for one folder, one commit.
  `--scope` required (no accidental whole-vault write). Per-folder ratification.
- `--agent`, `--vault` semantics identical to backfill.

Rationale for a named command over a `backfill --obsidian` flag: discoverability.
This is the first thing a new user reaches for; `backfill` reads as an internal
git-migration tool.

### Obsidian-aware derivation (the only net-new logic)

Applied during the plan/derive step, additive to `deriveProposed`:

1. **Inline `#tag` harvest.** Scan the body for Obsidian tags (`#tag`,
   `#nested/tag`; chars `[A-Za-z0-9_/-]`, must start with a letter per Obsidian's
   rule that a purely-numeric `#123` is not a tag). Merge into `tags`, deduped
   against any frontmatter tags. **Exclusions:** ATX headings (`#`/`##`...),
   fenced and inline code, and `#fragment` inside URLs. Existing `tags` are
   preserved and unioned, never replaced (#113 semantics).

2. **`source` → `sources[]`.** Web Clipper writes a `source` (string URL). If
   present and `sources` is absent/empty, copy the URL into `sources[]` (additive).
   The original `source` key is left intact (survives as a custom field via the
   serializer's raw pass-through, `src/tools/write.ts:150`). No data moved or lost.

Everything else Web Clipper writes (`author`, `published`, `description`, ...) has
no Daftari built-in and is preserved untouched as a custom field — the #113
guarantee.

### Ongoing "clean up new entries" — no new mechanism

- The existing chokidar watcher (`src/search/watcher.ts`) indexes any out-of-band
  edit/add live (~500ms debounce; already iCloud/Dropbox/FSEvents-aware). A new
  clip is searchable almost immediately, conformant or not — indexing only needs
  YAML to parse, not to be schema-valid (`src/search/reindex.ts:186`).
- Filling a new note's frontmatter is a **deliberate** re-run of the adopt pass,
  which is already incremental: `classifyDoc` skips conformant docs and only plans
  `missing`/`partial` (`src/backfill/derive.ts:94`). Re-running next week picks up
  exactly the new notes.
- The LLM can also fill frontmatter directly via `vault_write` (merge preserves
  existing fields).
- A dedicated MCP "derive frontmatter" tool is **deferred to v2** (YAGNI).

This split honors the project's advisory principle (CLAUDE.md: "the curation
engine is advisory; vault_lint reports, it does not auto-fix"). Auto-stamping on
file-arrival is explicitly rejected: it would turn the watcher into a mutator —
a git commit on every Obsidian save, racing atomic-rename/iCloud syncs — and
would assert `status`/`confidence` on a note the human is mid-thought on.

### Index

After `--apply`, ensure the index reflects the new frontmatter (`reindexVault`
exists). On a long-running server the watcher covers this; for the CLI adoption
run we build/refresh the index so search works on first use.

## Non-goals (explicit)

- No frontmatter-merge bug fix (phantom).
- No wikilink conversion; no new wikilink resolver (Option B already ships).
- No `type` field.
- No `--target` / copy mode. In-place is the model; cross-vault is YAGNI for the
  coexistence user and can be a separate adapter later if a real need appears.
- No auto-stamp-on-save.
- No bulk false-calibration beyond backfill's existing suggest-don't-assert
  defaults (canonical/medium), which the adopter ratifies per folder.
- No sidecar metadata format (CLAUDE.md).

## Safety

Reuses backfill's apply path verbatim:

- Validate-before-write: never writes frontmatter the validator would reject;
  reports instead (`src/backfill/apply.ts:renderEntry`).
- Idempotence: byte-identical render → no write, no commit churn.
- Collision detection: a foreign value in a built-in field is preserved and the
  doc is skipped with rename guidance.
- One git commit per ratified folder → git is the undo.
- Per-folder ratification prompt (`--yes` to skip; refuses on non-TTY without it).
- Content preserved field-by-field (#113).

**Accepted cost (decided):** in-place means Daftari's frontmatter
(`domain`, `status`, `confidence`, `provenance`, `updated_by`, ...) is written
into the live Obsidian files and renders as Obsidian **Properties**. A sidecar is
not an option (CLAUDE.md). This is the deal of in-place adoption.

## Validating the value (post-import)

> Reconstructed from the brainstorming side-chat (the exact transcript markdown
> was not available to this session) and then corrected against the actual
> `daftari eval` tooling — the side-chat version may carry the same inaccuracy
> noted below, so reconcile before trusting either. Kill condition for this whole
> section: if `daftari eval` cannot produce a stable day-one number on a freshly
> imported, un-curated vault, the protocol below needs rework.

Adoption produces two distinct kinds of value on two different clocks. Conflating
them makes the feature look either over- or under-delivering, so the adopter
should measure them separately — and `daftari eval`'s **by-tier** output is
exactly the separation.

**1. Retrieval value — available day one, frontmatter-independent.** The moment a
vault is indexed, an LLM pointed at Daftari retrieves over the *content*, whether
or not Daftari frontmatter has been filled (indexing only needs YAML to parse, not
to validate — `src/search/reindex.ts:186`). This is the bulk of the "answers get
better" promise and does **not** wait on the deliberate frontmatter pass. It maps
to `daftari eval`'s **`retrieval` tier**.

**2. Curation value — accrues as frontmatter (and edges) fill.** Confidence
weighting, staleness/TTL, lint, tension surfacing, and consolidation key off
structure the adopter hasn't created yet. It maps to eval's **`cross_reference`**
and **`contradiction`** tiers, which lean on cross-document structure that grows
as the cleanup loop runs (deliberately, never auto). Track it as a trend, not a
day-one number.

**How `daftari eval` actually works (so the protocol is honest).** `eval` is not
a retrieval-on/off switch. It samples a question set *from the vault*
(`sampleSubgraph`), runs an answerer LLM (k samples) over Daftari's tool surface,
and an LLM grader scores answers against vault-derived expected answers — emitting
an overall score plus the three tier means (pipeline at `src/eval/index.ts:285`
`runTopLevel`; tiers surfaced at `:260`; grading in `src/eval/score.ts`). There is
no "Daftari off" arm.

**Protocol for the adopter:**

1. **Day-one baseline.** Run `daftari eval` immediately after import (frontmatter
   mostly unfilled). Expect the `retrieval` tier to already be strong — that is
   the retrieval value, landed on day one. Note the default `--n 15` splits ~5
   questions per tier, so a single-run tier mean is noisy; raise `--n` for a
   stabler day-one number.
2. **Trend.** Re-run after each cleanup pass as coverage rises (track coverage via
   the `daftari backfill --plan` summary or `vault_lint`). Watch the
   `cross_reference` / `contradiction` tiers climb — that is the curation value
   maturing.

Keeping the tiers separate is the point: a flat `cross_reference` curve is not a
failed import if the `retrieval` tier is already high — they are different
mechanisms on different timelines.

**Caveat (do not oversell the A/B).** `eval` generates its question set from the
vault and stamps a `vault_hash`, so the question set *evolves* as the vault is
curated. Cross-run tier comparisons are therefore **directional, not a controlled
A/B on a frozen set**. A rigorous before/after on identical questions would need a
pinned question set across runs — out of scope here; treat the trend as a signal,
not a measurement.

## Testing

Mirror the backfill test structure. New cases:

- Inline `#tag` harvest: basic, nested (`#a/b`), dedupe vs frontmatter tags,
  and exclusion of ATX headings, fenced/inline code, and URL `#fragment`s.
- `source` → `sources[]`: maps a Web Clipper `source`, leaves `source` intact,
  no-ops when `sources` already present.
- Web Clipper fixture round-trip: a realistic clip (`source`, `author`,
  `published`, `tags`) keeps every custom field, gains `sources`, gains only the
  missing Daftari fields.
- Wikilinks left intact (no conversion) and still resolve via `resolveLink`.
- Idempotent re-run: a second adopt pass over an already-adopted folder is a
  no-op; a folder with one new clip plans only that clip.
- Dotdir exclusion: `.obsidian/` and `.trash/` markdown never appears in a plan.

## Open / to verify at implementation

- `[HYPOTHESIS]` the walk's glob relies on the `glob` package default of not
  matching dotfiles (it sets `ignore` but not `dot`), so `.obsidian/`/`.trash/`
  need no explicit ignore. Kill condition: a `.trash/*.md` shows up in a dry-run
  plan; if so, add Obsidian-specific ignores. Note: dotdir skipping is governed by
  two independent paths — the walk's glob (`src/storage/local.ts:45`) and the
  watcher's chokidar `ignored` option (`src/search/watcher.ts`). The dotdir test
  should target the **walk** path, since that's what the plan/derive step uses.
- Confirm `reindexVault` is the right post-apply hook for the CLI path vs.
  instructing `--reindex`.
