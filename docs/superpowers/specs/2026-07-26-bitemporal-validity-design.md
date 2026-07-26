# Bi-temporal validity — design record

2026-07-26. Status: implemented.

Adds `valid_from` / `valid_until`: an optional, closed, day-granular interval
recording when a document's claim was true **in the world**, alongside the
transaction time the vault already records.

This record exists because several decisions here are load-bearing in ways the
code cannot state on its own, and at least four of them were wrong in the first
draft. The plan went through an adversarial review pass (proposer → challenger
→ resolver, artifacts under `.jugalbandi/bitemporal-validity-spec/`); eleven
challenges were raised, ten accepted, one escalated to the human.

## Why

Daftari models transaction time twice over: git history (`src/utils/git.ts`,
`src/asof/git-read.ts`) and the `created` / `updated` frontmatter fields.
`daftari asof <ref>` reconstructs the vault as of a transaction time.

It modeled valid time nowhere. `ttl_days` looks like it fills the gap and does
not: `computeStaleness` (`src/curation/staleness.ts:35`) measures
`now - updated` against a *review promise*. `ttl_days: 45` says "re-check me in
45 days", not "this price held for 45 days". Collapsing the two is the same
collapse-to-a-convenient-answer the architecture refuses elsewhere.

Two payoffs:

- **Query.** "What did Plan Pro cost in February 2026?" becomes answerable by
  following authored intervals along authored supersession edges, instead of
  inferring valid time from `updated` — which is when someone typed, not when
  the fact started.
- **Self-check.** A `superseded_by` edge is otherwise an unfalsifiable
  assertion. With a second axis it is checkable: A superseding B while B claims
  validity through 2026-12-31 and A claims validity from 2026-04-01 means the
  vault asserts two contradictory things. That is a deterministic lint finding
  rather than invisible incoherence.

## Limitation, stated up front

Valid time is answerable **only** for facts whose intervals were authored
*before* the question was asked. Every commit predating this feature carries no
validity fields, so `daftari asof <historical-ref> --valid-at <date>` returns
100% `unknown` for pre-adoption history, permanently, by construction — D2
forbids recovering it. The feature buys future auditability, not retroactive
recall.

That payoff curve was put to the human on 2026-07-26 and accepted: ship in
full, with the `daftari interview` extension as the authoring ramp and the
adoption review trigger as the checkpoint.

## Decisions

**D1 — Two built-in optional fields**, not a config schema extension.
Extensions (`src/utils/config.ts` `SchemaExtension`) are opaque to lint,
search, decay, and `asof`, and a per-vault field name would make cross-vault
semantics (OKF, `daftari import`) meaningless.

Semantics: closed on both ends, day-granular. `valid_until: null` with a
`valid_from` means **open-ended**, not "unknown end". `valid_from: null` with a
`valid_until` means open-start. Both null means **valid-time-unknown** — the
pre-feature state of every document.

**D2 — Authored, never inferred.** No derivation anywhere. `daftari backfill`
will not propose it (it preserves an authored value and derives nothing);
`daftari import obsidian` will not synthesize it; no LLM pass extracts it; the
consolidation loop never stages a validity edit. `created`/`updated`/git dates
are transaction time and must never be laundered into valid time. The sole
exception is D7, which is an opt-in caller-supplied date, not an inference.

**D3 — Absent validity is `unknown`, never "always valid."** Both-null
documents are reported in a dedicated bucket by every surface: never counted
valid, never counted invalid, never filtered out of search. Same discipline as
`computeDecay` returning `null` for a healthy doc. Treating absent validity as
"true forever" would invent exactly the claim the feature exists to prevent.

**D4 — Conflicts are lint findings only. Never schema issues.**

No validity condition ever produces a `validateFrontmatter` issue.
`ValidationReport` (`src/frontmatter/schema.ts:256`) has no severity tier, and
`report.valid === false` is a hard blocker in `vault_write`, `vault_promote`,
`vault_merge`, `src/consolidate/admit.ts:116`, and `src/curation/tier0.ts`. An
issue here would let a typo in an **optional** field make a document
unwritable. Only a *type* error flags (a number, an array), matching
`optionalString`/`optionalNumber` — a non-string cannot be preserved verbatim
anyway.

Five deterministic lint kinds: `malformed-endpoint`, `inverted`,
`supersession-overlap`, `supersession-gap`, `expired-canonical`. None logs a
tension: two documents disagreeing about an interval is not proof of
contradiction, and `vault_tension_log` stays a deliberate act.

Consequence accepted deliberately: a typo'd `valid_from` is invisible until
`vault_lint` runs. That is the correct trade for a field nobody must author.

**D5 — Read and search surface validity additively; decay is untouched.**

`src/curation/decay.ts` is not modified, and that is a decision rather than an
omission. `src/consolidate/admit.ts:120-127` builds a `DecayInput` literal
field by field, and `endpointState` treats `warn` as edge-blocking
(`:171-173`) — so routing validity through `DecayInput` would make an expired
interval silently gate the cortex loop, a behavioral change smuggled in as a
type extension. Validity travels alongside decay, never inside it. If gating
consolidation on validity is ever wanted, it is a separate argued decision with
its own tests.

**D6 — `validAtSource` foregrounding is direction-monotone.**

**Supersession reachability is not fact identity.** `superseded_by` is
functional forward but a relation backward, and `vault_merge`
(`src/tools/write.ts`) manufactures fan-in on every merge. A forward-then-
backward turn through a merge node reaches a *sibling* lineage — a document
that never made the claim — and would foreground it with a verbatim snippet
that makes it look sourced.

So: two independent walks from the seed, forward along `superseded_by` and
backward along `supersessionPredecessors`, and neither ever changes direction.
64-hop cap per direction. Two or more covering members at the same hop depth
return `{ kind: "ambiguous", count }` over readable members only — there is no
`localeCompare` tiebreak, because a stable wrong answer is worse than an honest
refusal.

**D7 — Supersession boundary: opt-in, predecessor-only, three tools.**

`vault_supersede`, `vault_deprecate`, and `vault_merge` accept an optional
`boundary` — "the date the successor takes over". The predecessor (both
sources, for merge) gets `valid_until: boundary - 1 day`, only if its current
value is null; a conflicting authored value **refuses** rather than being
overwritten. For merge, one conflicting source refuses the whole merge — merge
is already all-or-nothing.

**The successor is never written.** `vaultSupersede` writes one document and
gates RBAC on the predecessor's collection only, so writing the successor would
be a second lock, a second provenance entry, a multi-file commit, and a
cross-collection write bypass. `WriteResult` carries a `hint` instead, so the
agent makes that call deliberately through the tool carrying the successor's
own gate.

`vault_write` gets **no** hook, deliberately: it is the raw authoring surface,
and a write-time cross-check between `superseded_by` and the validity fields
would reintroduce the D4 blocker. Lint is the safety net for edges created that
way — the same posture the vault takes for every other raw-authored
inconsistency.

**D8 — Downstream consumers, one addition each.** `daftari asof --valid-at`
(pure post-filter over `loadDocumentsAt`; drift is untouched because drift is a
transaction-time notion); `vault_status.validityCoverage`; `daftari sleep`
waking `expired-canonical` docs; `daftari interview` asking what replaced them
— which is also the primary adoption ramp for the axis.

**D9 — Disclosure posture: forward markers, backward omission.**

The asymmetry is deliberate and applies the 2026-07-14 edge-graph
existence-disclosure spec rather than amending it.

- **Forward walk:** any unreadable hop → `{ kind: "restricted" }`, strict,
  exactly as `resolveCurrentSource` (`src/search/current-source.ts:50`). This
  discloses nothing new — the seed's own frontmatter already contains
  `superseded_by: <path>`.
- **Backward walk:** unreadable predecessors are **skipped silently** and the
  walk continues past them. A marker would disclose a pure existence bit — *an
  unreadable document exists and claims this document replaced it* — obtained
  solely from a reverse-edge walk, with no corresponding fact in anything the
  caller can read. That is the class the spec assigns Disposition A (omission).
- `ambiguous.count` counts readable members only, so it cannot leak either.

**D10 — OKF rides the sidecar; no new OKF core field.** OKF v0.2's
`stale_after` is a review clock derived from `ttl_days` (`src/okf/map.ts:59`) —
transaction-time flavored. Do not overload it and do not invent a core field;
the two fields round-trip through `DAFTARI_SIDECAR_KEY`, which already carries
raw frontmatter verbatim.

**D11 — Upgrade and deprecation procedure.**

*Upgrade:* `validateExtension` (`src/utils/config.ts`) special-cases the two
names and returns an actionable error instead of the generic "shadows a
built-in" message. The hard fail is **kept** — silently reinterpreting an
authored extension as a built-in would change its semantics without telling
anyone, and the declared type may not even be a date.

*Deprecation, if it ever comes:* Stage 1 — mark deprecated in docs and
inputSchema descriptions, all reads keep working. Stage 2 (one release later) —
remove from `BuiltinFrontmatter` and the read surfaces, but **keep in
`serializeDocument`'s `ordered` literal as passthrough** so on-disk values
survive; that literal is explicit, so dropping the keys would silently strip
authored values and violate the #113 non-destructive contract. Stage 3 —
removal from `ordered` only behind an explicit operator-run
`daftari migrate strip-validity`.

**D12 — The embedding cache is exempt from the schema-bump drop list.**

`src/storage/index-db.ts` dropped `embeddings` on every `SCHEMA_VERSION` bump.
It is keyed on `(content_hash, model, dim)` — a content-addressed cache, not a
projection of the `documents` schema — so no column change can invalidate a row
in it, and the ALTER-racing rationale that justifies the drop list does not
apply. Dropping it meant paying a hosted provider to regenerate vectors that
were already correct. `embeddings_vec` stays dropped: a vec0 mirror,
repopulated from the cache at zero provider cost. Landed as its own commit
ahead of the feature so the 9 → 10 bump does not force a paid re-embed.

## Non-goals (v1)

- No valid-time versioning of a single document. One document, one interval;
  "held X in Q1 and Y in Q2" is what supersession chains are for.
- No inference of validity from body text, by LLM or regex.
- No automatic tension logging from interval overlap.
- No `valid_at` on `vault_search_related`.
- No index-time interval query API — the annotation pass runs over an
  already-small candidate set.
- No OKF core field.
- No boundary hook on `vault_write`.
- No validity gate on the consolidation loop.

## Kill conditions

Review triggers, not automatic deletions. A number that opens a conversation is
a monitor; a number that deletes code is a target, and `validityCoverage` is
explicitly not a target.

- **Adoption.** If `validityCoverage.authored / total` stays below ~10% across
  real vaults two releases after ship, open a review of the feature's value.
  The review decides; the number opens the conversation. The 10% figure was
  chosen without data and is labeled as such. The honest failure move is
  deletion via the D11 procedure, never inferring values to fill the fields.
- **`validityConflicts` never fires, or fires constantly.** Zero findings on a
  vault with authored intervals means the check is vacuous. Findings on a
  majority of superseded pairs means the interval semantics do not match how
  people author — the semantics are wrong, not the vault.
- **`valid_at` goes unused.** If the annotation pass never runs in real
  traffic, the axis is an authoring burden with no retrieval payoff, and D6
  should be reverted while the fields stay as documentation.
