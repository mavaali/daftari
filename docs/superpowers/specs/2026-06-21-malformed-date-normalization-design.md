# Design — Malformed date normalization at the frontmatter boundary

**Date:** 2026-06-21
**Status:** approved design, pre-implementation
**Lineage:** root-cause fix for the throw-on-malformed-date bug found during the coverage-retrieval Stage 1 adversarial review (which added a defensive `isValidIsoDate` guard in `src/search/coverage.ts`). Spawned task `task_62df0457`.

## Problem

`requireDate` in `src/frontmatter/schema.ts` (the shared frontmatter parse boundary) mishandles malformed date strings:

1. **Poison path.** For a string that fails the `^\d{4}-\d{2}-\d{2}$` regex (e.g. non-padded `2026-3-1`, slash `2026/03/01`, textual `March 2026`), it pushes a lint issue **but returns the raw string `v`**. That raw value lands in the `documents.created` / `documents.updated` columns and in every consumer of `parseDocument`.
2. **Out-of-range slips through unflagged.** The regex `^\d{4}-\d{2}-\d{2}$` matches `2026-13-45` (month 13, day 45) and returns it **as-is with no lint issue** — there is no real-calendar validation.

Downstream, any code that does `new Date(\`${created}T00:00:00Z\`).toISOString()` throws `RangeError: Invalid time value` on these values. This already broke `vault_search` via the coverage pass (now guarded) and exposes `src/curation/decay.ts` and any future date-range logic.

The `requireDate` Date-object branch is already correct: it normalizes a valid js-yaml `Date` to `YYYY-MM-DD` and (via the `!Number.isNaN` guard) lets an Invalid Date fall through to the `""` return. **Only the string branch is broken.**

## Goal / non-goals

**Goal:** make `requireDate` store only a strict-valid `YYYY-MM-DD` or the empty string `""` (the established "undateable" sentinel), recovering the one unambiguous malformed case (missing zero-pad) and flagging everything it can't.

**Non-goals:**
- No change to reindex, decay, coverage, or vault_write — they consume `requireDate`'s output and are fixed transitively.
- No removal of coverage's `isValidIsoDate` guard — it stays as independent defense-in-depth.
- No aggressive coercion of ambiguous formats (slash, textual, US-vs-EU). A wrong-but-confident date is worse than none for staleness/windows. (Conservative-hybrid stance, chosen 2026-06-21.)

## Design

### New helper (local to `schema.ts`)
```
normalizeIsoDate(s: string): string | null
```
- If `s` does not match `^\d{4}-\d{1,2}-\d{1,2}$` → return `null` (rejects slash, textual, and any non-ISO shape).
- Zero-pad month and day → candidate `YYYY-MM-DD`.
- Round-trip validate: `const d = new Date(\`${candidate}T00:00:00Z\`)`; valid iff `!Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === candidate`. The round-trip rejects regex-passing-but-out-of-range values like `2026-13-45` (which `new Date` would otherwise roll over).
- Return the candidate, or `null` if invalid.

### Rewritten string branch of `requireDate`
| Input string | Stored value | Lint issue pushed |
|---|---|---|
| `2026-03-01` (canonical, in range) | `2026-03-01` | none |
| `2026-3-1` (recoverable by zero-pad) | `2026-03-01` | **yes** — non-canonical format, but the recovered date is stored |
| `2026/03/01`, `March 2026`, `2026-13-45`, any other | `""` | yes — `expected YYYY-MM-DD date, got "<v>"` |

Logic:
```
if (typeof v === "string") {
  const norm = normalizeIsoDate(v);
  if (norm === null) { issues.push({field, message: `expected YYYY-MM-DD date, got ${JSON.stringify(v)}`}); return ""; }
  if (norm !== v)   { issues.push({field, message: `non-canonical date "${v}", normalized to ${norm}`}); }
  return norm;
}
```
The Date-object branch and the missing/wrong-type branch are unchanged.

### Why flag the recovered case
A recovered date is still a frontmatter defect: `vault_write` rejects non-canonical dates at the write boundary, and reindex's posture is to *surface* divergence (stored value ≠ file literal), not hide it. So `2026-3-1` is normalized for the index **and** reported by `vault_lint`. Bucketing is unchanged — such a doc was already flagged invalid before (the old code pushed an issue too); we only change the stored value from raw to normalized.

## Testing

New `test/frontmatter/schema.test.ts` calling `validateFrontmatter({...})` directly (it returns `{ frontmatter, report: { valid, issues } }`). For both `created` and `updated`:
- Canonical `2026-03-01` → stored unchanged, **no** issue for that field.
- Non-padded `2026-3-1` → stored `2026-03-01`, issue pushed (non-canonical).
- Slash `2026/03/01` → stored `""`, issue pushed.
- Textual `March 2026` → stored `""`, issue pushed.
- Out-of-range `2026-13-45` → stored `""`, issue pushed (regression guard for the unflagged-slip).
- A valid js-yaml `Date` object → normalized to `YYYY-MM-DD`, no issue (Date-branch unchanged).
- An Invalid `Date` object → stored `""` (existing behavior, regression guard).

## Risks
- **Behavior change for existing vaults:** a doc currently indexed with a raw malformed `created` will, after a reindex, store `""` (or a normalized date). The index is an ephemeral rebuildable cache, so this lands on the next reindex; no migration. A doc that silently had an out-of-range date is now correctly undateable — intended.
- **`normalizeIsoDate` scope creep:** keep it private to `schema.ts`; coverage keeps its own guard. If a third date consumer appears, extract a shared util then (YAGNI now).
