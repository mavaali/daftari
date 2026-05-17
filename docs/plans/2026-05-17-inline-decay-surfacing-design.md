# Inline Decay Surfacing — Design

**Issue:** [#2](https://github.com/mavaali/daftari/issues/2) (originally "background curation agent" — reframed below)
**Date:** 2026-05-17
**Status:** Design approved; not yet implemented

## Problem

`vault_lint` is advisory and on-demand. Knowledge decay — stale-past-TTL
documents, old drafts, stagnant low-confidence documents, deprecated documents —
is only visible when an agent or human explicitly calls the tool. Layer 4's
promise, "knowledge that stops being true is surfaced, not silently trusted," is
met only reactively, so in practice often not met at all.

## Reframe

The issue title — "run `vault_lint` on a schedule" — proposes a background
scheduler. Rejected:

- **No background agent / daemon / heartbeat.** The only consumer of curation
  findings is the next agent that reads the vault. A read carries `now`; a read
  is the only moment a consumer exists. The read *is* the heartbeat. A timer
  firing while nobody reads computes decay for an empty room. Precedent: write-
  lock TTLs are enforced lazily on access, with no reaper (`src/access/locks.ts`).
- **No digest / delivery channel.** An MCP server has no human watching; a
  periodic report has no consumer.

The feature is **inline decay surfacing**: read and search responses carry a
decay signal the consuming agent cannot help but see.

## Scope (this issue)

Temporal decay only — derivable from a document's own frontmatter:

- past TTL (`updated` + `ttl_days`)
- old draft (`status: draft`, past the draft-age limit)
- stagnant low-confidence (`confidence: low`, untouched past the limit)
- deprecated (`status: deprecated`)

## Design

### `computeDecay(frontmatter, now)`

A pure function in `src/curation/`. **Total** — never throws; returns `null` on
missing or malformed temporal fields (frontmatter is effectively agent input and
is treated as a boundary). Factored out of the per-document temporal checks
currently inside `runLint`; `runLint` then calls the same function, so the
temporal checks cannot drift between `vault_lint` and inline surfacing.

```
computeDecay(fm, now) -> null | {
  level:   "deprecated" | "warn" | "aging",
  reasons: string[],          // granular, e.g. "140d since update, ttl 120d"
  banner:  string | null      // null for aging; set for warn / deprecated
}
```

- **`deprecated`** — `status: deprecated`. Loudest banner.
- **`warn`** — past TTL, or old draft, or stagnant low-confidence. Banner.
- **`aging`** — past ~50% of TTL, not yet expired. **No banner** — the scarcity
  rule: bannering every half-aged document is the alert-fatigue trap. Structured
  field only.
- healthy → `null`. Silent baseline; nothing emitted anywhere.

Banner wording scales off the `reasons` numbers, so a document 5 days past a
120-day TTL and one 300 days past a 30-day TTL read differently. Banner
*structure* is Daftari-authored; agent-authored free text (the deprecation
`reason`, `superseded_by`) stays in structured fields, delimited — never
interpolated into the directive prose (prompt-injection guard).

### `vault_read`

Returns the structured `decay` object as a top-level response field (candidate
home: the advisory validation report it already returns). **The banner is never
inserted into `body`.** `body` must remain a byte-faithful copy of the file —
otherwise a read → modify → `vault_write` round-trip writes the banner into the
file, and every subsequent read accretes another.

### `vault_search`

Each hit carries the *same* structured `decay` field. Search is a triage
surface — the field is enough to decide which document to open; the loud banner
lands at `vault_read`, the moment of use. Read and search expose identical
`decay` data; only the banner is threshold-gated.

### Index change

Add `ttl_days` and `created` columns to the `documents` table
(`src/storage/index-db.ts`), populated at index time (`src/search/reindex.ts`).
Required so `vault_search` can compute decay per hit without re-reading files
(which would reintroduce per-query I/O). The index is ephemeral and rebuildable —
a reindex applies the new schema, no migration.

## What already exists

- `computeStaleness` / `ageInDays` — `src/curation/staleness.ts`. The TTL math.
- Per-document temporal checks — embedded in `runLint` (`src/curation/lint.ts`);
  to be factored out into `computeDecay`.
- `documents` index table — `src/storage/index-db.ts`. Has
  `status` / `confidence` / `updated`; needs `ttl_days` / `created` added.
- Advisory validation report — already returned by `vault_read`; candidate home
  for the `decay` object.
- Staleness distribution — `vault_status` already computes fresh / aging / stale
  tiers (commit `2771b17`).

## NOT in scope

- **Structural decay** (orphan, deprecated-still-linked, unresolved tensions) —
  needs the vault-wide link graph materialized into the index. Tracked as
  [#8](https://github.com/mavaali/daftari/issues/8).
- **`vault_index` decay signal** — also a triage surface; deliberately deferred
  to keep the first cut to read + search.
- **Scarcity cap** — nothing yet *enforces* "few banners." As checks accrete
  (#8 and beyond), banner frequency must be watched; a future "one banner,
  severity-ranked" rule may be needed.
- **Background scheduler / digest** — rejected outright (see Reframe).

## Failure modes considered

- Banner inserted into `body` → file corruption and banner accretion on
  read/write round-trips → banner kept strictly out of `body`.
- Missing or malformed frontmatter → `computeDecay` is total, returns `null`.
- Agent-authored deprecation `reason` as a prompt-injection vector → kept in
  structured fields, never woven into banner prose.
- Alert fatigue if banners proliferate → scarcity rule (no banner for `aging`);
  residual risk tracked under NOT in scope.
