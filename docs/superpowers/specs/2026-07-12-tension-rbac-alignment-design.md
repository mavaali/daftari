# Tension-tool RBAC alignment — design

2026-07-12. Status: approved by Mihir (session dialogue), pending spec review.
Issue: #212. Predecessor: #211 (contested annotations), whose final review
found this gap.

## Why

#211 gates the inline `contested` annotation on the counterpart's collection:
a caller who cannot read the other side of a tension sees nothing — no
existence leak. But the dedicated tension tools bypass that gate entirely:
`vault_tension_log`, `vault_tension_resolve`, `vault_tension_clusters`, and
`vault_tension_blast` require only `hasAnyRead`
(`src/tools/curation.ts:45-50`), so a role with read access to one collection
can read the **entire** tension log — cross-collection claims included — and
can log or resolve tensions naming documents it cannot read. The strict rule
on the search path is one tool call away from meaningless.

The write side is the sharper edge: `vault_tension_log` accepting claims that
quote unreadable documents is cross-ACL quote laundering — content from
collection Y enters a record readable (today) by any-reader, authored by a
role that never had read on Y.

## Decisions (all three settled with Mihir)

1. **Visibility = both sides readable.** A tension entry is visible to a
   caller only if the caller can read BOTH `sourceA`'s and `sourceB`'s
   collections. Not-visible entries are omitted entirely — no redaction, no
   existence leak. Rationale: half a tension is not actionable, and the
   redaction variant leaks that the readable side's claim was authored in
   reaction to something hidden.
2. **Aggregates filter before computing.** `vault_tension_clusters` clusters
   only visible entries; `vault_tension_blast` seeds only from visible
   entries. Cluster sizes, counts, and blast radii reveal nothing about
   hidden tensions. A cluster spanning hidden entries splits into smaller
   visible clusters — honest from the caller's vantage.
3. **Write side requires read-both.** `vault_tension_log` denies unless the
   caller can read both named collections (you cannot quote what you cannot
   read). `vault_tension_resolve` requires the same, layered UNDER the
   existing ratify rule for loop-authored entries (both checks must pass).
   The engine stays advisory; nothing about what a tension *is* changes.

## Architecture (Approach B — one shared rule)

### Shared collection resolution

`counterpartCollection` in `src/search/contested.ts` moves to
`src/storage/index-db.ts` as an export:

```ts
// The collection that RBAC-gates access to `path`: the indexed row when
// present; the canonical path's first segment otherwise (the S1/#192 rule —
// key on where the bytes live). The fallback errs closed: a `..`-leading or
// empty segment matches no role's read list.
export function collectionForPath(db: IndexDb, path: string): string;
```

`contested.ts` consumes it with zero behavior change (its existing 14 tests
pin this). One rule now governs every tension-visibility decision.

### New module: `src/curation/tension-access.ts`

```ts
// True iff the caller may see this tension entry: read access to BOTH
// sides' collections. `access` undefined ⇒ RBAC unconfigured ⇒ visible,
// matching every other read surface. Sides are canonicalized before
// resolution (aliasing must not widen visibility).
export function canSeeTension(
  db: IndexDb,
  access: AccessContext | undefined,
  sourceA: string,
  sourceB: string,
): boolean;

// The subset of `entries` visible to the caller, original order preserved.
export function visibleTensions(
  db: IndexDb,
  entries: TensionEntry[],
  access?: AccessContext,
): TensionEntry[];
```

Path canonicalization: reuse `contested.ts`'s lexical rule. To avoid a
duplicate, `canonicalRel` is exported from `contested.ts` (it is already the
load-bearing alias defense there; the test files pin it). `tension-access.ts`
imports it. No new canonicalization code.

### Tool handler changes (`src/tools/curation.ts`)

All four tension handlers open the index via the existing exported
`openIndexForActiveProvider` (the `vault_themes` pattern) and close it in a
`finally`. `requireReadAccess` (hasAnyRead) stays as the outer cheap gate on
all four — this work tightens, never loosens.

- **`vault_tension_clusters`**: after reading the log, filter through
  `visibleTensions` BEFORE handing entries to the clustering pass.
- **`vault_tension_blast`**: same filter before blast seeding. When the
  caller passes a specific doc path, that path's own collection must also be
  readable (deny with the standard access-denied error otherwise).
- **`vault_tension_log`**: before appending, deny unless
  `canSeeTension(db, access, sourceA, sourceB)`. Standard error:
  `access denied: role '<role>' cannot log a tension naming collection '<c>'`
  — naming only the collection derived from the CALLER'S OWN input (no new
  information disclosed).
- **`vault_tension_resolve`**: after locating the entry by id, if the entry
  is not visible to the caller, return the **same error as a nonexistent
  id** (`tension not found: <id>`) — the denial must not confirm existence.
  If visible, the existing loop-authored ratify rule still applies on top.

### Index dependency note

These handlers gain a read-only index dependency (collection lookup). If the
index is empty/unavailable, `collectionForPath` falls back to the first path
segment for every path — degraded but fail-closed, and identical to the
contested-annotation behavior in the same state. No reindex is triggered by
these tools (they are not search; an empty index just means segment-rule
gating).

### Non-goals

- Blast's downstream doc list can still name documents in unreadable
  collections. That is the edge-graph exposure class (`vault_edges`,
  `vault_lint` share it) — a separate issue, filed as follow-up, not
  smuggled in here.
- `vault_provenance`, edge tools, `vault_lint`: unchanged.
- No changes to the tension log format, `tension.ts` parsing, or what a
  tension is. No redaction mode. No per-entry ACL metadata.
- No-RBAC mode (`access` undefined everywhere): bit-for-bit unchanged
  behavior on all four tools.

## Error handling

All denials are `Result.err` (no throws from handlers). The resolve-invisible
case is the single deliberate deviation from standard phrasing (see above).
Index open failure inside a tension handler: fall back to segment-rule gating
(never fail the tool call for RBAC-lookup reasons alone).

## Testing

`test/curation/tension-access.test.ts` (module):
1. Both sides readable ⇒ visible; either side unreadable ⇒ invisible (both
   directions).
2. Alias-path sides (`x/../x/a.md`) resolve before gating — an alias never
   widens visibility (written FIRST, per the #127/#128 precedent).
3. Unindexed side falls back to first segment; `..`-leading/empty segment ⇒
   invisible to every role.
4. `access` undefined ⇒ everything visible.
5. `visibleTensions` preserves order and drops only invisible entries.

`test/tools/curation.test.ts` additions (e2e per tool):
6. clusters: a cross-collection tension vanishes from a one-sided reader's
   clusters AND is absent from counts/sizes; a both-sides reader sees it.
7. blast: hidden tensions do not seed; explicit doc path in an unreadable
   collection ⇒ access denied.
8. log: one-sided role denied (error names only the caller-supplied
   collection); both-sides role logs successfully; no-access-context logs
   successfully (no-RBAC mode).
9. resolve: invisible tension ⇒ error string identical to a genuinely
   nonexistent id (assert string equality between the two cases); visible +
   loop-authored still requires ratify.
10. contested.ts regression: full existing contested + search test files
    stay green (the `collectionForPath` extraction is behavior-neutral).
