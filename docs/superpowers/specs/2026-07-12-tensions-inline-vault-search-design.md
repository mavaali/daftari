# Tensions inline in `vault_search` — design

2026-07-12. Status: approved by Mihir (session dialogue), pending spec review.

## Why

The tension-graph feud benchmark (branch `mihir/tension-graph-benchmark-spec`,
results 2026-07-04) measured the gap this closes: on feuds where retrieval
buries one side, a baseline agent surfaces the contradiction ~8% of the time;
with the tension surfaced **inline in the retrieval payload** (arm tg-3b) it
rises to ~46% (p<1e-10, 3 neutral models, replicated on live daftari hybrid
search). The dedicated-tool arm (tg-3a, `check_contradictions` available but
not surfaced) also beat baseline but lost to inline across all models: agents
do not reliably follow an indirection to a tool they must choose to call.

Today tensions are reachable only through dedicated tools
(`vault_tension_log`, `vault_tension_blast`, `vault_tension_clusters`) — the
3a shape. This design moves the signal to the 3b shape: `vault_search` results
carry the disagreement itself.

## What

Search hits gain an optional `contested` annotation carrying the full
two-sided marker, populated by a post-join against the tension log
(`.daftari/tensions.md`).

### Data shape

New fields on `HybridHit` (`src/search/hybrid.ts`), populated by the tool
handler like `currentSource` — never by the ranker:

```ts
export interface ContestedTension {
  id?: string;        // tension id; absent only for legacy entries
  kind: TensionKind;  // temporal | factual | interpretive | unspecified
  counterpart: string; // vault-relative path of the other side
  claimSelf: string;   // this hit's claim, per the log
  claimOther: string;  // the counterpart's claim
  loggedAt: string;    // entry date, YYYY-MM-DD
}

// on HybridHit:
contested?: ContestedTension[]; // capped at 3, most recent first
contestedCount?: number;        // TOTAL matching tensions (may exceed 3)
```

Orientation is normalized: `claimSelf` is always the hit's own side,
regardless of whether the hit is the entry's `sourceA` or `sourceB`.

`contestedCount` is present iff `contested` is present. The cap keeps a
heavily-feuded doc from blowing the payload; the count keeps the truncation
honest (no silent cap).

### Join semantics

- **Which tensions**: `status` unresolved only (`resolved === false`).
  Resolved tensions do not annotate — their outcome is already expressed
  through supersede/deprecate edges and `currentSource` foregrounding, and the
  keystone ("a tension may never masquerade as a supersession") cuts both
  ways: a live-disagreement marker must mean live disagreement.
- **Match rule**: hit joins an entry when the hit's path equals the entry's
  `sourceA` or `sourceB` after canonicalization. Both entry paths are
  canonicalized (POSIX-normalized, vault-relative, `..`/`.` segments resolved)
  when the lookup map is built; hit paths come canonical from the index.
  An alias-path test (`x/../x/a.md` style) is written before the join code —
  path aliasing has produced two prior security bugs (#127, #128).
- **Where**: in `vaultSearch` (`src/tools/search.ts`), inside the existing
  per-hit enrichment loop that runs `resolveCurrentSource` — i.e. after RBAC
  filtering and the coverage pass, on surviving hits only. Runs before
  `enforceTokenCap`; annotations are not counted by the token cap (they are
  bounded by the 3-per-hit cap instead).
- **Scope**: `vault_search` only. `vault_search_related` is a follow-on if
  wanted; the benchmark evidence is for search.

### Tension-log access: mtime-keyed cache

Reuses the E2 config-cache pattern (`src/utils/config.ts`, merged #197): the
parsed log plus a derived `Map<canonicalPath, TensionEntry[]>` is cached
per vault, keyed on `tensions.md` `mtimeMs`; `statSync` per search, full
re-read + re-parse only when the mtime changes. ENOENT (no tension log) is
itself a cache state: an absent file caches an empty map. Appends via
`vault_tension_log` / `vault_tension_resolve` change the mtime and bust the
cache naturally. No SQLite schema change; tension logs are typically tens of
entries — indexing them is not warranted at current scale.

New module: `src/search/contested.ts` (cache + lookup + per-hit join),
keeping `search.ts` at its current altitude. `src/curation/tension.ts` is
consumed read-only (`parseTensionLog`).

### RBAC

An annotation quotes the counterpart's claim, so it crosses the ACL boundary
(same exposure class as the provenance leak, backlog item W). Rule: annotate
only when the caller can read the **counterpart's** collection.

- Counterpart collection: from the index `documents` row for the counterpart
  path; if the counterpart is not indexed (deleted/renamed since logging),
  fall back to the path's first segment — the same physical-target rule as
  the S1 fix (#192). The fallback errs closed: an unreadable-by-segment path
  never annotates.
- Not readable → the annotation is **omitted entirely** (not redacted): no
  existence leak. The tension remains visible via tension tools to roles that
  can see both sides.
- No access context (unrestricted caller, e.g. tests or single-user mode) →
  annotate freely, matching existing search RBAC behavior.
- `contestedCount` counts only tensions the caller is permitted to see —
  count and array are filtered by the same rule, so the count never reveals
  the existence of hidden tensions.

### Tool surface

`vault_search`'s MCP description gains one sentence: results may carry
`contested` — unresolved recorded tensions involving the document, with both
claims shown; `contestedCount` gives the total when more than 3 exist. No new
tool, no new parameters. (Agents key off descriptions; without this sentence
the field is dead weight.)

### Error handling

Annotation failure is never search failure. Missing `tensions.md` → no
annotations. Unparseable entries → `parseTensionLog` already
tolerates/legacy-reads them; entries it cannot attribute to a path simply
don't join. A `statSync` error other than ENOENT degrades to no annotations
for that call. All paths return `ok`; per repo style, no throws from tool
handlers.

## Testing

Mirrors `test/tools/search.test.ts` conventions (fixture vault + real index);
new file `test/search/contested.test.ts` for the module, additions to the
tool test for end-to-end:

1. A logged unresolved tension annotates hits on **both** sides, with
   `claimSelf`/`claimOther` correctly oriented per side.
2. A resolved tension does not annotate.
3. Alias-path entry (`notes/../notes/a.md`) still joins its canonical hit
   (written first).
4. Counterpart in an unreadable collection → annotation omitted, count
   excludes it; readable counterpart → present.
5. >3 tensions on one doc → array capped at 3 (most recent first),
   `contestedCount` reports the true total.
6. Cache: log appended after first search → second search sees the new
   tension (mtime bust); absent log → no annotations, no error.
7. `vault_search` result shape unchanged when no tensions exist (fields
   absent, not empty arrays).

## Non-goals

- No change to ranking: contested-ness is an annotation, never a score input.
- No `vault_search_related` support (follow-on).
- No SQLite tension index.
- No annotation of resolved tensions.
- No auto-logging of tensions from search-time signals.
