# Bi-temporal validity — design

2026-07-26. Status: **proposed — awaiting Mihir's review; implementation not
started.**
Predecessor specs: 2026-06-21 (malformed-date normalization — the date
boundary this reuses), 2026-06-21 sp-a (foreground-current-source — the
annotate-never-filter precedent), 2026-06-25 (synthetic contract supersession
falsifier — where "close the window" first showed up as a retrieval need).

## Why

The vault currently keeps exactly one kind of time: **transaction time** —
when the vault learned or recorded something. `created`/`updated` in
frontmatter (`src/frontmatter/types.ts`), git history underneath, and
`daftari asof` on top (`src/asof/index.ts`) replaying "what did we believe at
commit C / on date D". That axis is well built: `beliefSnapshot`,
`docTrajectory`, and `counterfactualReplay` (`src/asof/snapshot.ts`) all
resolve by discovery against the git tree, nothing synthesized.

What no field expresses is **valid time**: when the recorded fact was true
*in the world*. "Acme's API rate limit is 100 rps" recorded on 2026-03-01
and superseded on 2026-07-01 tells you when we believed it — not whether the
limit was still 100 rps on 2026-06-15, or had silently changed in May and we
were late. Three concrete failures fall out of conflating the clocks:

1. **`daftari asof` answers the wrong question half the time.** It can say
   "on June 1 the vault contained doc X saying Y" but not "on June 1, which
   docs *asserted validity* covering June 1". Belief archaeology without a
   valid-time axis is archaeology of our attention, not of the facts.
2. **Tension false positives.** Two docs saying "the contract term is 12
   months" and "the contract term is 24 months" are a genuine factual
   tension — unless one describes the 2025 contract and the other the 2026
   renewal, in which case they are both true and the disagreement is purely
   temporal. Today nothing structural lets the curation layer tell these
   apart; `TENSION_KINDS` in `src/curation/tension.ts` has a `temporal` kind
   but the classification is entirely the logger's judgment call.
3. **Staleness conflates two distinct decays.** `computeStaleness`
   (`src/curation/staleness.ts`) measures drift past `ttl_days` — *this doc
   needs re-verification*. That is not the same as *this doc's fact has an
   end date and the end date passed*. A doc can be freshly verified
   (score 0) and describe a fact that expired last quarter.

External evidence that this distinction is the load-bearing one: Zep's
Graphiti (~20k GitHub stars) stores `valid_at`/`invalid_at` on every edge,
and its contradiction handling **closes a validity window rather than
deleting** — the feature users cite when switching memory vendors (arXiv
2501.13956). TOKI (arXiv 2606.06240, June 2026) formalizes the same move as
"a bitemporal operator algebra for contradiction resolution in LLM-agent
persistent memory". And "When Facts Expire: Benchmarking Temporal Validity
in Knowledge Graphs" shows exactly failure 3: TTL-only decay conflates
*stale* with *no longer true*, and systems that separate the signals answer
temporal questions correctly where TTL-only systems confabulate.

The design below adds valid time as two optional frontmatter fields and
threads them through four consumers. Frontmatter stays the only metadata
layer, git stays the only version layer, the index stays ephemeral, and the
curation engine stays advisory throughout — nothing here auto-resolves,
auto-closes, or invents a date the caller didn't supply.

## Decision 1 — schema: `valid_from` / `valid_until`, optional, half-open

Two new built-in fields, both optional:

```yaml
---
title: Acme API rate limits
collection: vendors/acme
created: 2026-03-01
updated: 2026-03-01
valid_from: 2026-01-15     # fact holds from this date (inclusive)
valid_until: 2026-05-01    # ...up to but not including this date
ttl_days: 90
---
```

- **Interval convention: half-open `[valid_from, valid_until)`**, calendar
  days. Half-open makes contiguity trivial — a successor's `valid_from`
  equals the predecessor's `valid_until`, no off-by-one — and matches the
  invalid-at semantics Graphiti settled on ("the date it stopped being
  true"). Day D is in-window iff `valid_from <= D < valid_until`.
- **Absent means open/unknown**, not invalid. A doc with neither field has
  made no validity claim — exactly the posture `ttl_days: null` already
  takes ("no freshness promise to break", `computeStaleness`). Every
  existing doc is untouched and fully backward compatible; the fields are
  additive to `BuiltinFrontmatter` and `BUILTIN_FRONTMATTER_FIELDS`
  (`src/frontmatter/types.ts`), which also blocks schema-extension name
  collisions for free.
- **Validation follows the 2026-06-21 malformed-date split exactly.**
  `src/frontmatter/schema.ts` gains an `optionalDate` helper beside
  `requireDate`: preserve the author's raw string verbatim, flag anything
  `normalizeIsoDate` can't confirm as canonical real-calendar `YYYY-MM-DD`
  (a tool-mediated write never rewrites what the author put there, #113).
  The index layer does normalize-or-empty at `insertDocument`, so date-math
  consumers never see a poison string. Same boundary, same helper, no new
  rules.
- **`valid_from >= valid_until` is a lint finding, not a rejection.**
  Validation is advisory and always yields a usable `Frontmatter`; the
  curation engine reports the inversion, and consumers treat an inverted
  window as unknown (never as an empty window that would silently mark the
  doc expired everywhere).

Both fields are dates, not timestamps. The vault's whole time vocabulary
(`created`, `updated`, asof's committer-clock day resolution) is
day-granular; introducing a finer clock for one pair of fields would be
false precision agents would dutifully hallucinate into.

## Decision 2 — disjoint windows suppress the *factual* reading, never the tension

If two docs' claims carry validity windows that do not overlap, they are not
contradicting each other — they are describing different eras. The curation
layer gets exactly two advisory behaviors, and no resolution authority:

1. **At log time** (`vault_tension_log`, `src/tools/curation.ts`): when the
   caller logs `kind: factual` and both source docs carry windows that are
   provably disjoint (`a.valid_until <= b.valid_from` or vice versa, both
   bounds present), the tool result carries an advisory note:
   `temporal_hint: "source windows are disjoint (…/…) — consider kind:
   temporal"`. The entry is still logged exactly as the caller asked. An
   absent bound never triggers the hint — unknown means possibly
   overlapping, and a suppression hint built on a guess would be the system
   minting temporal facts it doesn't have.
2. **In lint** (`src/curation/lint.ts`): unresolved *factual* tensions whose
   sources have disjoint windows get a distinct finding — "factual tension
   between docs with disjoint validity windows; likely temporal — reclassify
   or resolve deliberately" — sitting beside the existing
   `STALE_TIER_LINT_COPY` aging surface, not replacing it.

What this decision explicitly does **not** do: edit `tensions.md`. No
already-logged entry has its `kind` rewritten, no entry is auto-resolved
`invalid`, nothing is removed from `computeTensionHealth`'s vault-global
aggregates. The house rule is literal here — vault_lint reports, it does not
fix; `vault_tension_resolve` remains the only path that closes a tension,
and it remains a deliberate act with a named resolver. Reclassification is a
one-line curatorial edit the finding points at, not a side effect.

## Decision 3 — `vault_supersede` may close the window; only the caller holds the pen

`vaultSupersede` (`src/tools/write.ts`) today sets `status: superseded` and
`superseded_by` on the predecessor and touches `updated`/`updated_by`.
It gains one optional argument:

```jsonc
// vault_supersede
{
  "old_path": "vendors/acme/rate-limits.md",
  "new_path": "vendors/acme/rate-limits-2026h2.md",
  "agent": "agent:curation-loop",
  "predecessor_valid_until": "2026-05-01"   // optional, caller-supplied
}
```

When supplied, the predecessor's frontmatter write additionally sets
`valid_until: 2026-05-01` — the Graphiti move: a contradiction (here, an
explicit supersession) **closes a validity window, it never deletes**. The
predecessor stays in the vault, in git, in search (annotated, Decision 5),
with a now-bounded era it remains the canonical record *of*.

When absent, `valid_until` is untouched. It is **never defaulted to
`todayISO()`**, never copied from the successor's `valid_from`, never
inferred from commit dates. The supersession date is transaction time (git
already has it); the validity end is a fact about the world that only the
caller may assert. Store and point, never invent — the same law that makes
`vault_merge` refuse to synthesize prose. A supersession without a known
validity end is common and fine: "this doc replaces that one; when the old
fact actually stopped holding, we don't know" is an honest state and the
schema's absent-means-unknown default expresses it exactly.

Tensions get no such write path. A temporal tension resolved `superseded`
still goes through `vault_tension_resolve` plus an explicit
`vault_supersede`; a tension is never itself a supersession, and closing a
window is never a tension-resolution side effect.

## Decision 4 — `daftari asof` gains the second clock

```
daftari asof <ref-or-date> [--valid <YYYY-MM-DD>] [--vault <path>] …
```

Two clocks, orthogonal semantics:

- **Transaction axis (existing, unchanged):** `<ref-or-date>` picks the
  commit via `resolveAsofCommit` (`src/asof/git-read.ts`) — the vault's
  state *as recorded then*. Everything `beliefSnapshot` reports today keeps
  its meaning.
- **Valid axis (new):** `--valid V` partitions the snapshot's documents by
  window membership at day V, three-valued: **in-window**
  (`valid_from <= V < valid_until`, absent bounds treated as −∞/+∞ when the
  other bound is present), **out-of-window** (V provably outside), and
  **unwindowed** (neither field set — no validity claim, never silently
  counted in or out). The report gains a `validity` section with the three
  buckets and the out-of-window doc list.

The combined query — `daftari asof 2026-06-01 --valid 2026-04-15` — reads:
"take the vault exactly as it stood on June 1, and of those recorded
beliefs, which asserted validity covering April 15". Both clocks can point
anywhere independently; "what do we *now* know was true then" is
`asof HEAD --valid <then>`, and "what did we *then* think was true then" is
`asof <then> --valid <then>`. The valid-axis fields are read from the
frontmatter *in the tree at the chosen commit* — a later window correction
is visible only at later commits, which is precisely the bi-temporal
property: transaction time tells you when the vault's picture of validity
changed. `parseDocument` on historical blobs already handles this
(`loadDocumentsAt`); no index involvement, consistent with asof's
read-only, no-index posture.

## Decision 5 — expired-validity is not staleness; search annotates, never filters

Two decays, two signals, two copies:

- `ttl_days` expiry (`computeStaleness`) keeps meaning **needs
  re-verification** — the doc may still be perfectly true.
- A passed `valid_until` means **recorded as no longer true** — the doc may
  be perfectly fresh (recently verified that the era ended).

A new pure function `computeValidity(fm, now)` in
`src/curation/validity.ts` returns
`"in-window" | "expired" | "not-yet" | "unknown"`, mirroring
`computeStaleness`'s shape and testability. Lint reports the two expiries as
distinct findings with distinct copy — the staleness finding keeps saying
"re-verify"; the validity finding says "recorded validity ended
<valid_until>; if a successor exists, supersede; if the fact still holds,
extend the window". A doc can carry both findings at once, and that
combination ("stale AND expired") is itself informative in a way one merged
signal never is — the exact conflation the facts-expire benchmark measures.

`vault_search` **annotates** hits whose window excludes today —
`validity: "expired"` (or `"not-yet"`) on the hit — via the existing
enrichment pass (`annotateAndLogServedHits`, `src/tools/search.ts`), which
already annotates superseded hits and foregrounds successors rather than
dropping predecessors (2026-06-21 sp-a). It never filters them out and
never down-ranks by validity in v1. Omission is an RBAC concept with a
threat model behind it (2026-07-14: omission over redaction, no existence
leak); repurposing omission as a relevance heuristic would teach agents that
absent means non-existent, which the access layer depends on absent *not*
meaning. An expired doc is often exactly what a valid-time question needs.

## Out of scope

- **Bi-temporal edges.** Graphiti puts windows on edges; daftari's edges
  (`sources`, `describes`, links) stay unwindowed for now. Doc-level windows
  first — edge windows inherit the design later if doc-level earns it.
- **LLM auto-derivation of validity windows.** No pass that reads a body and
  mints `valid_from`. Windows are asserted by authors and callers only.
- **Valid-time fields on tension entries** beyond the Decision 2
  classification hint.
- **Retroactive backfill tooling** (`src/backfill/` growing a windows pass)
  — plausible follow-up, separate spec.
- **Timestamps.** Day granularity only, per Decision 1.

## Kill condition

[HYPOTHESIS] Valid time earns its two fields only if people actually assert
it and the assertions change answers. Concretely, this design is falsified
and should be reverted to plain transaction time if, after a full quarter of
availability on a live vault: (a) fewer than ~10% of docs in
temporally-churning collections (vendors, contracts, pricing — the docs that
motivated this) carry either field, while supersessions in those collections
continue — meaning even the natural authoring moment (Decision 3's optional
close) doesn't get used; or (b) `asof --valid` queries never produce a
partition that differs from what status/`superseded_by` already implied —
meaning the second clock adds fields without adding information. And the
Decision 2 hint dies independently, faster, if it misfires in practice:
disjoint-window pairs that reviewers judge genuinely factual (wrong windows
on atemporal claims) would make the hint a machine for laundering real
contradictions into "temporal" — the one failure mode worse than the false
positives it suppresses, because tensions must never masquerade as settled.
