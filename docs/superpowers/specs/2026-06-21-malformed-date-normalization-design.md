# Design — Malformed date normalization at the frontmatter boundary

**Date:** 2026-06-21
**Status:** approved design, pre-implementation
**Lineage:** root-cause fix for the throw-on-malformed-date bug found during the coverage-retrieval Stage 1 adversarial review (which added a defensive `isValidIsoDate` guard in `src/search/coverage.ts`). Spawned task `task_62df0457`.

## Problem

`requireDate` in `src/frontmatter/schema.ts` (the shared frontmatter parse boundary) mishandles malformed date strings:

1. **Poison path.** For a string that fails the `^\d{4}-\d{2}-\d{2}$` regex (e.g. non-padded `2026-3-1`, slash `2026/03/01`, textual `March 2026`), it pushes a lint issue **but returns the raw string `v`**. That raw value lands in the `documents.created` / `documents.updated` columns and in every consumer of `parseDocument`.
2. **Out-of-range slips through unflagged.** The regex `^\d{4}-\d{2}-\d{2}$` matches `2026-13-45` (month 13, day 45) and returns it **as-is with no lint issue** — there is no real-calendar validation.

Downstream, any code that does `new Date(\`${created}T00:00:00Z\`).toISOString()` throws `RangeError: Invalid time value` on these values. This already broke `vault_search` via the coverage pass (now guarded). `src/curation/decay.ts` documents itself as NaN-safe/total so it likely already tolerates these values — but any future, less-defensive date consumer would be exposed. Fixing the boundary removes the hazard class rather than relying on every consumer to guard.

The `requireDate` Date-object branch is already correct: it normalizes a valid js-yaml `Date` to `YYYY-MM-DD` and (via the `!Number.isNaN` guard) lets an Invalid Date fall through to the `""` return. **Only the string branch is broken.**

## Goal / non-goals

**Goal:** ensure the search **index** stores only a strict-valid `YYYY-MM-DD` or the empty string `""` (the established "undateable" sentinel) for `created`/`updated` — recovering the one unambiguous malformed case (missing zero-pad) and emptying the rest — **without rewriting the author's source file**, while `vault_lint` still flags every malformed value (including the previously-unflagged out-of-range case).

**Non-goals:**
- No rewriting of on-disk frontmatter. The frontmatter layer preserves the author's raw date verbatim (#113); only the derived index is cleaned.
- No removal of coverage's `isValidIsoDate` guard — it stays as independent defense-in-depth.
- No aggressive coercion of ambiguous formats (slash, textual, US-vs-EU). A wrong-but-confident date is worse than none for staleness/windows. (Conservative-hybrid stance, chosen 2026-06-21.)
- **Not in scope: the extension-field date validator** (`case "date"` at `schema.ts:59-65`) carries the same loose `^\d{4}-\d{2}-\d{2}$` regex. It validates config-declared schema-extension fields, which do not feed the `created`/`updated` → `new Date().toISOString()` hazard paths. Left untouched deliberately; a follow-up could share the helper if extension dates ever need normalizing.

## Design

### Layering decision (revised after adversarial review)

An earlier draft put the normalize-or-empty inside `requireDate`. **That was wrong:** `requireDate`'s output is the validated `Frontmatter`, which `serializeDocument` writes **back to the source `.md` file** on every `vault_deprecate` / `vault_supersede` / `vault_set_confidence` / `vault_append`. Nulling a malformed date there silently overwrites the author's `created`/`updated` on disk — violating the explicit non-destructive invariant in `serializeDocument` (*"a tool-mediated write never silently drops a field the author put there, #113"*) and Daftari's lossless ethos.

So the cleaning is split by layer:
- **Frontmatter boundary (`requireDate`) — preserve, don't rewrite.** Returns the author's raw string verbatim; only *flags* anything that isn't canonical real-calendar ISO (so `vault_lint` surfaces it, and the previously-unflagged out-of-range case is now caught). The source file is never altered.
- **Index layer (`insertDocument`) — normalize-or-empty.** The index is a derived cache, so it stores canonical `YYYY-MM-DD` (recovering `2026-3-1` → `2026-03-01`) or `""` (the established "undateable" sentinel) for unrecoverable values. Every index write — full reindex and incremental — funnels through `insertDocument`, the single chokepoint. Date-math consumers (`getDocumentsInDateRange`, the coverage window, decay) therefore never see a poison string.

### Shared helper (`src/utils/dates.ts`)
```
normalizeIsoDate(s: string): string | null
```
- If `s` does not match `^\d{4}-\d{1,2}-\d{1,2}$` → `null` (rejects slash, textual, any non-ISO shape).
- Zero-pad month/day → candidate `YYYY-MM-DD`.
- Round-trip validate: `const d = new Date(\`${candidate}T00:00:00Z\`)`; valid iff `!Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === candidate`. The round-trip rejects regex-passing-but-out-of-range values like `2026-13-45` (which `new Date` would otherwise roll over). Returns the candidate or `null`.

A leaf util so both layers (`schema.ts`, `index-db.ts`) share one implementation without a layer inversion.

### `requireDate` string branch — preserve raw, flag malformed
```
if (typeof v === "string") {
  if (normalizeIsoDate(v) !== v) {
    issues.push({ field, message: `expected YYYY-MM-DD date, got "${v}"` });
  }
  return v; // raw; the index layer cleans, the source file stays as the author wrote it
}
```
| Input string | `frontmatter.created` (on-disk) | Index column | Lint issue |
|---|---|---|---|
| `2026-03-01` | `2026-03-01` | `2026-03-01` | none |
| `2026-3-1` | `2026-3-1` (preserved) | `2026-03-01` (recovered) | yes |
| `2026/03/01`, `March 2026`, `2026-13-45` | preserved verbatim | `""` | yes |

The Date-object branch (valid → ISO, Invalid → `""`) and the missing/wrong-type branch are unchanged. Tests assert on issue *presence* per field, not exact message text.

### `insertDocument` — index normalization
```
const created = normalizeIsoDate(doc.created) ?? "";
const updated = normalizeIsoDate(doc.updated) ?? "";
```
bound into the INSERT in place of `doc.created`/`doc.updated`. Coverage's own `isValidIsoDate` guard stays as independent defense-in-depth.

## Testing

**Frontmatter layer** — `test/frontmatter/schema.test.ts` calling `validateFrontmatter({...})` directly (returns `{ frontmatter, report: { valid, issues } }`). For `created` (and one `updated` case): canonical → preserved, no issue; non-padded `2026-3-1` → **preserved raw** + flagged; slash/textual/out-of-range/rollover → **preserved raw** + flagged; non-leap `2026-02-29` flagged but real leap `2024-02-29` accepted; valid js-yaml `Date` → ISO, no issue; Invalid `Date` → `""`. Assert on issue *presence* per field, not exact message text.

**Index layer** — appended to `test/storage/index-db.test.ts`: `insertDocument` then `getDocument`/`getDocumentsInDateRange` — recoverable `2026-3-1`/`2026-7-9` → stored `2026-03-01`/`2026-07-09`; unrecoverable slash/out-of-range → `""`; canonical untouched; a doc whose date normalized to `""` is excluded from `getDocumentsInDateRange`.

**Cross-feature** — the coverage `computeWindow` test that previously inserted `2026-3-1` as an "unusable" seed is updated to a slash date, since the index now *recovers* `2026-3-1` (and would include it in the window). The "ignored when unparseable" intent is preserved with a value the index genuinely stores as `""`.

## Risks
- **Behavior change for existing vaults:** on the next reindex, a doc indexed with a malformed date now stores `""` (unrecoverable) or a normalized date (recoverable) in the index. The index is an ephemeral rebuildable cache — no migration. The **source file is unchanged**. An out-of-range date is now correctly undateable in the index — intended.
- **Defense-in-depth redundancy:** `insertDocument` cleaning makes coverage's `isValidIsoDate` guard rarely-if-ever exercised via the normal insert path. Kept deliberately (independent layer; the task required it).
