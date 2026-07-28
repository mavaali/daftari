# Bi-temporal validity — design

2026-07-26. Status: **implemented** (PR #305).

Predecessor specs: 2026-06-21 (malformed-date normalization — the date
boundary this reuses), 2026-06-21 sp-a (foreground-current-source — the
annotate-never-filter precedent), 2026-06-25 (synthetic contract supersession
falsifier — where "close the window" first showed up as a retrieval need).

> **Provenance of this document.** Two designs for this feature were written
> independently on 2026-07-26 and collided at this path. The first was the
> research-brainstorm proposal (#296), never reviewed. The second came from an
> adversarial planning pass (proposer → challenger → resolver) that never saw
> it, and was implemented before the collision surfaced. This file is the
> reconciliation. The proposal's framing and most of its decisions won; where
> the implementation diverges, the divergence is recorded inline with the
> reason. Nothing here is aspirational — every decision below describes code
> that exists.

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
  days. Half-open makes contiguity trivial — a successor's `valid_from` equals
  the predecessor's `valid_until`, no off-by-one — and matches the invalid-at
  semantics Graphiti settled on ("the date it stopped being true"). Day D is
  in-window iff `valid_from <= D < valid_until`.

  This was the sharpest divergence between the two designs: the implementation
  originally shipped a **closed** interval. Half-open won on the argument
  above, and the payoff shows up concretely in Decision 3 — the boundary write
  stops computing "the day before" and writes the caller's date verbatim. That
  path is the one an agent drives, and an off-by-one there silently opens a
  one-day hole in, or double-claims a day of, the vault's account of when a
  fact held. The cost is one line of documentation explaining that "valid
  through March" is written `valid_until: 2026-04-01`.

- **Absent means open/unknown**, not invalid. A doc with neither field has made
  no validity claim — exactly the posture `ttl_days: null` already takes ("no
  freshness promise to break", `computeStaleness`). Every existing doc is
  untouched and fully backward compatible; the fields are additive to
  `BuiltinFrontmatter` and `BUILTIN_FRONTMATTER_FIELDS`
  (`src/frontmatter/types.ts`), which also blocks schema-extension name
  collisions for free.

- **Validation preserves the author's raw string and flags NOTHING.**
  `src/frontmatter/schema.ts` gains an `optionalDate` helper beside
  `requireDate`: it preserves the raw value verbatim (#113) and coerces a
  js-yaml `Date`, but it never pushes a validation issue for a malformed date
  string. Only a *type* error (a number, an array) flags, matching
  `optionalString`/`optionalNumber`.

  **This is a deliberate divergence from the proposal**, which specified
  flagging any value `normalizeIsoDate` cannot confirm, on the stated grounds
  that "validation is advisory and always yields a usable `Frontmatter`". That
  premise is false in this codebase. `report.valid === false` is a hard blocker
  at `src/tools/write.ts:943`, `:1176`, and `:1678`, at
  `src/consolidate/admit.ts:116` (`provenanceKnown = d.validation.valid`), and
  at `src/curation/tier0.ts:150`. Flagging here would let a typo in an
  **optional** field make a document unwritable, unpromotable, and inadmissible
  to the consolidation loop. Malformed endpoints are reported by lint instead,
  which is where the advisory contract actually lives.

- **`valid_until <= valid_from` is a lint finding, and reads as `unknown`
  everywhere.** Both halves matter. Under half-open, `until === from` is an
  empty window, so it is the same defect as an inversion and is reported the
  same way.

  The implementation originally got the second half wrong, and the proposal
  caught it: `computeValidity` *evaluated* a contradictory window rather than
  refusing to. With `from > until` it returned `not-yet` before `from` and
  `expired` after `until` — never `in-window` on any day. One transposed date
  therefore produced a `⚠ STALE` banner on `vault_read`, removal under
  `valid_only`, a wake entry in `daftari sleep`, and an interview question
  asking what replaced a fact that never stopped being true. Lint flagged the
  inversion, but a finding in a report does not contain a bad state
  propagating through four other surfaces.

Both fields are dates, not timestamps. The vault's whole time vocabulary
(`created`, `updated`, asof's committer-clock day resolution) is day-granular;
introducing a finer clock for one pair of fields would be false precision
agents would dutifully hallucinate into.

## Decision 2 — disjoint windows suppress the *factual* reading, never the tension

**Status: not implemented. Deferred to a follow-up.**

The proposal's design stands as written: when two docs' claims carry provably
disjoint windows they are describing different eras, not contradicting each
other, and the curation layer gets two advisory behaviors and no resolution
authority — a `temporal_hint` on `vault_tension_log`, and a distinct lint
finding for unresolved *factual* tensions whose sources have disjoint windows.
Neither edits `tensions.md`, reclassifies an entry, or auto-resolves anything.

It is deferred rather than dropped because it is the piece that connects valid
time back to the tension graph, which is the system's core. It is also the
riskiest piece, by the proposal's own kill condition: a misfiring hint would
launder real contradictions into "temporal", which is worse than the false
positives it suppresses.

## Decision 3 — the caller may close the window; only the caller holds the pen

`vault_supersede`, `vault_deprecate`, and `vault_merge` each gain one optional
argument:

```jsonc
{
  "old_path": "vendors/acme/rate-limits.md",
  "new_path": "vendors/acme/rate-limits-2026h2.md",
  "agent": "agent:curation-loop",
  "predecessor_valid_until": "2026-05-01"   // optional, caller-supplied
}
```

When supplied, the predecessor's frontmatter write additionally sets
`valid_until` to that date **verbatim** — the Graphiti move: a contradiction
(here, an explicit supersession) **closes a validity window, it never
deletes**. The predecessor stays in the vault, in git, in search (annotated,
Decision 5), with a now-bounded era it remains the canonical record *of*. Under
half-open the successor's `valid_from` is the same date, so the two windows
meet exactly and share no day.

When absent, `valid_until` is untouched. It is **never defaulted to
`todayISO()`**, never copied from the successor's `valid_from`, never inferred
from commit dates. The supersession date is transaction time (git already has
it); the validity end is a fact about the world that only the caller may
assert. A supersession without a known validity end is common and fine.

An existing non-null `valid_until` that disagrees causes a **refusal**, not an
overwrite: it is an authored claim, and a convenience argument does not get to
replace one. For `vault_merge`, a conflict on either source refuses the whole
merge — merge is already all-or-nothing.

**Divergence from the proposal, which scoped this to `vault_supersede`
alone:** `vault_deprecate` and `vault_merge` also create `superseded_by` edges,
so covering only one of the three would leave the auditable-supersession claim
two-thirds unfulfilled. The argument extends the proposal rather than
contradicting it. The proposal's argument NAME was adopted — under half-open,
`predecessor_valid_until` is literally the value written.

The write touches the **predecessor only**. `vaultSupersede` gates RBAC on the
predecessor's collection alone (`src/tools/write.ts`), so writing the
successor's `valid_from` would be a write the caller may not be authorized for,
on top of a second lock, a second provenance entry, and a multi-file commit
where there was one. The result carries a `hint` naming the successor and the
suggested `valid_from` instead, so that call goes through the tool carrying the
successor's own gate.

`vault_write` gets no equivalent hook: it is the raw authoring surface, and a
write-time cross-check between `superseded_by` and the validity fields would
reintroduce the Decision 1 blocker.

Tensions get no such write path. A temporal tension resolved `superseded` still
goes through `vault_tension_resolve` plus an explicit `vault_supersede`; a
tension is never itself a supersession, and closing a window is never a
tension-resolution side effect.

## Decision 4 — `daftari asof` gains the second clock

```
daftari asof <ref-or-date> [--valid <YYYY-MM-DD>] [--vault <path>] …
```

Two clocks, orthogonal semantics:

- **Transaction axis (existing, unchanged):** `<ref-or-date>` picks the commit
  via `resolveAsofCommit` — the vault's state *as recorded then*.
- **Valid axis (new):** `--valid V` partitions the snapshot's documents by
  window membership at day V, three-valued: **inWindow**, **outOfWindow**, and
  **unwindowed** (no window asserted, or a contradictory one — never silently
  counted in or out).

The combined query — `daftari asof 2026-06-01 --valid 2026-04-15` — reads:
"take the vault exactly as it stood on June 1, and of those recorded beliefs,
which asserted validity covering April 15". Both clocks move independently.
The valid-axis fields are read from the frontmatter *in the tree at the chosen
commit*, so a later window correction is visible only at later commits —
precisely the bi-temporal property. Drift and the status rollup are untouched:
drift is a transaction-time notion, and mixing the axes is the confusion this
feature exists to remove.

When every document at a ref is unwindowed, the report says so **in words**
rather than printing a bare zero. `0 in-window` reads as "nothing was true
then"; the truth is "nobody recorded it, and nothing may infer it."

## Decision 5 — expired validity is not staleness

Two decays, two signals, two copies:

- `ttl_days` expiry (`computeStaleness`) keeps meaning **needs
  re-verification** — the doc may still be perfectly true.
- A passed `valid_until` means **recorded as no longer true** — the doc may be
  perfectly fresh.

`computeValidity(input, at)` in `src/curation/validity.ts` returns
`"in-window" | "expired" | "not-yet" | "unknown"`, mirroring
`computeStaleness`'s shape and testability. A doc can carry both a staleness
and a validity finding at once, and that combination is itself informative in a
way one merged signal never is.

`src/curation/decay.ts` is **not modified**, and that is load-bearing rather
than incidental. `src/consolidate/admit.ts` builds a `DecayInput` literal field
by field and treats `warn` as edge-blocking, so routing validity through
`DecayInput` would make an expired window silently gate the cortex loop — a
behavioral change smuggled in as a type extension. Validity travels alongside
decay, never inside it.

`vault_search` **annotates** hits with their state at `valid_at`, and
foregrounds the chain member whose window covers that date rather than dropping
the hit (`validAtSource`, Decision 6).

**Divergence from the proposal, at the repo owner's direction:** the proposal
scoped filtering out of v1 entirely, on the grounds that omission is an RBAC
concept with a threat model behind it (2026-07-14) and repurposing it as a
relevance heuristic would teach agents that absent means non-existent. The
implementation ships `valid_only` — **opt-in, defaulting to false**, and
keeping `unknown` hits, since a document that asserts no window is not evidence
its claim was false. Annotation remains the default behavior; nothing is
dropped unless a caller explicitly asks. The proposal's objection is recorded
here rather than dismissed: if `valid_only` ever starts being passed
reflexively, revisit it.

The filter runs **before** the user-facing slice, on the full RBAC-filtered
candidate set. Filtering after the slice would shrink the page below `limit`
whenever expired docs occupy the top slots, and the shortfall would read as a
thin result set rather than as filtering.

## Decision 6 — `validAtSource`: the walk is direction-monotone

When a hit's own window excludes `valid_at`, the chain member whose window
covers it is foregrounded as a structured field mirroring `CurrentSource`.

**Supersession reachability is not fact identity.** `superseded_by` is
functional forward but a relation backward, and `vault_merge` creates fan-in on
every merge. A walk that went forward to a merge node and turned backward would
land on a *sibling* lineage — a document that never made the claim — and
foreground it with a verbatim snippet that makes it look sourced. So two
independent walks run from the seed, forward and backward, and neither ever
changes direction. Two same-depth members covering the date return
`ambiguous`, not a tiebreak: a stable wrong answer is worse than an honest
refusal.

Disclosure is asymmetric, applying the 2026-07-14 edge-graph spec rather than
amending it. A forward unreadable hop degrades to `restricted` — it discloses
nothing, since the seed's own frontmatter names its successor. A backward
unreadable predecessor is skipped **silently** and the walk continues past it:
a marker there would be a pure existence bit reachable only from a reverse
edge, which is that spec's Disposition A (omission). Ambiguity counts readable
members only.

## Decision 7 — adoption and upgrade

`vault_status` reports `validityCoverage {authored, unknown, total}` over the
caller's visible set — a read-only monitor, never a target.

`daftari sleep` wakes canonical accumulation documents whose window ended with
nothing superseding them. `daftari interview` asks the sharper question that
follows — not "is this still accurate?" but "this says it stopped being true on
<date> and nothing replaced it; what did?" That is the primary adoption ramp:
valid time is authored, so windows only enter a vault when someone writes them,
and being asked is when that happens.

OKF rides the `DAFTARI_SIDECAR_KEY` sidecar with no new core field. v0.2's
`stale_after` is a `ttl_days`-derived review clock; overloading it would put
the same collapse into the interchange format that this axis prevents inside
the vault.

**Upgrade:** a vault that declared `valid_from`/`valid_until` under
`schema_extensions` fails config load with a bespoke, actionable error. The
hard fail is kept — silently reinterpreting an authored extension as a built-in
would change its semantics without telling anyone, and the declared type may
not even be a date.

**Deprecation, if it ever comes:** Stage 1 marks the fields deprecated in docs
and tool schemas, all reads still working. Stage 2 removes them from
`BuiltinFrontmatter` and the read surfaces but **keeps them in
`serializeDocument`'s `ordered` literal as passthrough**, so on-disk values
survive — that literal is explicit, and dropping the keys would silently strip
authored values in violation of #113. Stage 3 removes them from `ordered` only
behind an explicit operator-run migration.

## Out of scope

- **Bi-temporal edges.** Graphiti puts windows on edges; daftari's edges
  (`sources`, `describes`, links) stay unwindowed for now.
- **LLM auto-derivation of validity windows.** No pass reads a body and mints
  `valid_from`. Windows are asserted by authors and callers only.
- **Retroactive backfill tooling.** `daftari backfill` preserves an authored
  window and derives nothing.
- **Timestamps.** Day granularity only, per Decision 1.
- **`valid_at` on `vault_search_related`.**
- **Valid-time gating of the consolidation loop.** If ever wanted, a separate
  argued decision with its own tests.

## The limitation, stated plainly

Valid time answers only for facts whose windows were authored *before* the
question was asked. Every commit predating adoption carries no validity fields,
so `daftari asof <historical-ref> --valid <date>` returns 100% unwindowed for
pre-adoption history — permanently, because Decision 1 forbids recovering it.
The axis buys future auditability, not retroactive recall. That trade was put
to the repo owner on 2026-07-26 and accepted.

## Kill condition

[HYPOTHESIS] Valid time earns its two fields only if people actually assert it
and the assertions change answers. Falsified, and revertible to plain
transaction time, if after a full quarter of availability on a live vault:

(a) fewer than ~10% of docs in temporally-churning collections (vendors,
contracts, pricing — the docs that motivated this) carry either field, while
supersessions in those collections continue — meaning even the natural
authoring moment (Decision 3's optional close) doesn't get used; or

(b) `asof --valid` queries never produce a partition that differs from what
status/`superseded_by` already implied — meaning the second clock adds fields
without adding information.

These are **review triggers, not automatic deletions**. A number that opens a
conversation is a monitor; a number that deletes code is a target, and
`validityCoverage` is explicitly not a target. The ~10% figure was chosen
without data and is labelled as such. The honest failure move is deletion via
the Decision 7 procedure, never inferring values to fill the fields.
