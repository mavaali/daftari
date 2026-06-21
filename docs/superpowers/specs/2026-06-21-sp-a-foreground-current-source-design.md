# SP-A — Foreground the current source (design)

**Date:** 2026-06-21
**Status:** Design, approved in brainstorm. Ready for plan.
**Programme:** the current-state projection (post-Recall-Bench forward work). See handoff `docs/superpowers/handoffs/2026-06-21-projection-ethos-and-cf-verdict-pickup.md` §6 and memory `project_currentstate_projection`.

## One line

When a search hit is superseded, daftari resolves the **terminal-current** source (RBAC-respecting) and attaches it to the hit as a **structured pointer + snippet**, alongside the unchanged, fully-labeled stale hit. **No re-ranking.** The agent foregrounds; daftari informs.

## Why (the ethos line this implements)

> daftari may author the **RELATION** and the **EMPHASIS**; it must never author the **VALUE**. Foreground the current source via the `superseded_by` edge; the value is always read from a human source, never minted.

ContextForge *mints* a current-state value into a wiki (and beats daftari on Recall Bench cheaply by doing so) — that is the betrayal of the cortex "edges not prose" thesis. SP-A is the daftari-native answer: **point at** the current source, never synthesize it. This completes the cortex thesis's unfulfilled promise — daftari already computes a supersession/decay signal and currently discards it before the agent can act on it.

This spec is for daftari's **product**, not to chase Recall Bench (concluded as the wrong scoreboard — RB supersession is 100% recency-resolvable, so daftari's LLM has no niche there; see `project_recall_bench_experiment`).

## Grounding: the current code (verified)

- **Two retirement statuses.** `STATUSES = ["draft","canonical","deprecated","superseded","archived"]` (`src/frontmatter/types.ts:13`).
- **`vault_supersede` writes `status: "superseded"` + `superseded_by: <path>`** (`src/tools/write.ts:1036-1037`). The successor is required to exist at write time (no dangling created here).
- **`computeDecay` only emits a banner + `superseded by: <ref>` when `status === "deprecated"`** (`src/curation/decay.ts:41-51`). **`"superseded"` falls through every branch** → `decay: null` (silent/healthy) unless TTL/draft/low-confidence independently trips. So a freshly superseded doc carries no banner.
- **`HybridHit`** (`src/search/hybrid.ts:38-48`) carries the bare `status` string but **not** the structured `superseded_by` target. Decay is attached inline at `hybrid.ts:221-228`; the scorer (`hybrid.ts:195-210`, sort) is pure `bm25*+vector*` with **no status filter on candidates**.
- **`vaultSearch(vaultRoot, args, access?)`** (`src/tools/search.ts:110`) holds the open `db`, runs `hybridSearch`, then RBAC-filters hits via `canRead(access.role, h.collection)` (line 136). Returns early when `!access` (line 134).
- **`getDocument(db, path): IndexedDocument | null`** (`src/storage/index-db.ts:618`) is the by-path lookup for walking the chain. `IndexedDocument` carries `supersededBy`, `status`, `collection`.
- **Serialization:** `server.ts` does `JSON.stringify(result.value, null, 2)` — structured objects pass through to the agent unflattened.
- **`superseded_by` is a frontmatter field**, mirrored to the `documents.superseded_by` index column. It is **not** an edge (the only edge store is `derives_from`, `src/curation/edges.ts`).

**Restated gap:** daftari doesn't merely "throw the signal away at rank" — for the supersession case it **barely surfaces the relation at all** (no banner, no structured current-source pointer). SP-A's cheapest, most ethos-pure win is *upstream of ranking*: make the relation visible. Re-ranking is explicitly out of scope.

## Design (Approach ①: dedicated resolver module + output enrichment)

Two questions the code must answer separately:
- **"Should I trust this doc?"** → the **banner** (trust signal), owned by `decay.ts`.
- **"What should I read instead?"** → the **current-source pointer** (redirection signal), net-new, owned by a dedicated resolver.

`hybrid.ts` (ranking) is **untouched**. Rejected alternatives: folding resolution into `decay.ts` (it is a pure single-document function; chain-walk needs index I/O + per-caller RBAC — wrong home); denormalizing the terminal head at write time (chains mutate silently, and RBAC degrade is per-caller, so resolution must be read-time and caller-scoped — the index is ephemeral by design, truth lives in frontmatter).

### A. Output contract & trigger

New **optional** field `currentSource` on `HybridHit`, a discriminated union (absent when the hit isn't superseded):

```ts
export type CurrentSource =
  | { kind: "resolved";   path: string; title: string; snippet: string; hops: number }
  | { kind: "restricted" }                    // current source exists but chain crosses RBAC-invisible material
  | { kind: "dangling";   brokenAt: string }  // a hop's superseded_by points to a missing doc
  | { kind: "cycle" };                        // chain loops; stop and report
```

- **Trigger:** enrich a hit when `getDocument(db, hit.path).supersededBy` is non-null. Keying on the *pointer's presence* (not the status string) covers both `status: "superseded"` and any `deprecated`-with-successor doc, and is robust to the status taxonomy.
- **Additive / lossless:** the stale hit keeps its own snippet, score, and position. `currentSource` is *added*, never substituted. Result set and ordering are byte-for-byte what ranking produced — the "no re-rank" guarantee made structural.
- **Serialization:** zero transport changes (`server.ts` already `JSON.stringify`s the result).

### B. The resolver (`src/search/current-source.ts`)

Pure function: `resolveCurrentSource(db, stalePath, access?) → CurrentSource`.

- **Chain walk:** from `stalePath`, follow `supersededBy` via `getDocument` to the terminal head (first doc whose `supersededBy` is null). `hops` = edges traversed (≥1).
- **Cycle guard:** visited-set of canonicalized paths; a repeat → `{ kind: "cycle" }`. Plus a defensive max-depth cap.
- **Dangling guard:** a hop's successor `getDocument` returns null → `{ kind: "dangling", brokenAt }` (the `brokenAt` path lies in the already-readable portion, safe to name). Reachable when a successor is later renamed/deleted.
- **RBAC degrade (strict):** return `{ kind: "resolved" }` **only if every hop AND the terminal head are readable** (`canRead(access.role, doc.collection)`). If *any* link crosses an unreadable collection → `{ kind: "restricted" }` with no path, title, or hop count — the caller learns only "a current source exists, outside your access." When `access` is undefined (RBAC unconfigured), everything is readable → normal resolution. This is the strict reading of the W provenance-leak fix (PR #142).
- **Snippet:** `title`/`snippet` for the terminal head come from its indexed content — the same snippet mechanism `hybrid.ts` uses — riding as structured JSON fields, never interpolated into directive text (same injection posture as every existing snippet).

### C. `decay.ts` banner fix (the trust signal)

1. **Add a `superseded` branch** so a superseded doc gets a retired-severity banner — reusing the existing `"deprecated"` `DecayLevel` (no enum change) with a superseded-specific head, e.g. *"⚠ SUPERSEDED — a newer version of this document exists; see the current source."*
2. **Stop embedding the document-supplied `superseded_by` ref in the banner text** (both the new superseded branch and the existing deprecated branch). The banner becomes *purely daftari-authored trust prose with no document-supplied strings*; the actual target moves entirely to the structured `currentSource` field (terminal-resolved + RBAC-checked, unlike the raw one-hop frontmatter ref). Benefits:
   - **No contradiction** between a banner naming one-hop B and `currentSource` pointing at terminal C.
   - **Removes an injection surface:** the whitespace-collapse guard at `decay.ts:49` exists *because* a document-authored path is interpolated into the banner. Drop the interpolation, drop the vector.

Split: banner = "should I trust this?" (daftari prose only); `currentSource` = "what do I read instead?" (validated structured pointer).

### D. Tool-handler wiring (`vaultSearch`, `src/tools/search.ts`)

After ranking, enrich each superseded hit — for **both** the `access`-present and `access`-absent paths (restructure the `!access` early return at line 134 so enrichment runs regardless; RBAC degrade no-ops when `access` is undefined). **This early-return restructure is the load-bearing edit** — enrichment must slot inside the existing `try` (db open at line 128, closed in the `finally` at 139), *before* the `finally`, on both branches. RBAC *filtering* of hits stays first (line 136); enrichment runs on survivors, calling `resolveCurrentSource(db, hit.path, access)` with the already-open `db`. Cost is bounded: fires only for the rare superseded hit, one `getDocument` per chain hop.

**Note — deliberate non-reuse of the ranker's doc map.** `rankDocuments` already materializes a `byPath` map (`hybrid.ts:182-183`), but it lives inside `hybrid.ts` and is not exposed. The resolver issues its own `getDocument` calls per hop rather than reusing that map — a deliberate decoupling, since SP-A insists `hybrid.ts` stays untouched and the resolver lives downstream of it. For 1–2-hop chains on rare superseded hits this is negligible.

**Knob (omitted in SP-A):** a `resolveCurrentSource: boolean` search arg (default true) is a trivial future addition if token cost ever bites. Not included now — enrichment is additive, lossless, and bounded.

### E. Test plan

**Resolver unit tests (the bulk):** single-hop resolved; multi-hop → terminal head with correct `hops`; cycle → `{cycle}`; dangling → `{dangling, brokenAt}`; RBAC degrade when terminal unreadable → `{restricted}`; RBAC degrade when an *intermediate* hop unreadable → `{restricted}`; `access` undefined → resolves normally.

**`decay.ts` tests:** `status: "superseded"` now yields a banner (the current gap); superseded and deprecated banners contain no document-supplied path string.

**Search integration tests:** a superseded hit carries `currentSource.resolved` with successor title/snippet; result ordering is unchanged vs. pre-enrichment (no-re-rank guarantee asserted); a historical/as-of query still returns the stale doc in place (no regression).

## Non-goals (explicit — the deferred halves)

- **No ranking/score change**, no query-intent inference, no auto re-ordering. (Re-rank, if ever justified, is a separate flag-gated step with its own spec.)
- **No atomization** — intra-document supersession (both values in one doc) stays out of scope; that is **SP-C** and requires the atom layer.
- **No new edge store** — `superseded_by` stays a frontmatter field; SP-A reads it, doesn't re-home it.
- **No automatic edge acquisition** — SP-A operates on edges that already exist (explicit `vault_supersede`). Acquiring edges without a human (markers/recency/LLM) is **SP-B**, gated on a real use case explicit supersede doesn't cover.
- **`vault_search` only** — `vault_search_related` (`src/tools/search.ts:147`) is a second search surface that also produces hits; enriching it is deliberately deferred. SP-A wires enrichment into `vaultSearch` alone. If related-search enrichment is wanted later, it reuses the same resolver (cheap), but it is not in this scope.

## Decisions log (from the brainstorm)

1. **Mechanism:** enrichment, not re-rank — the only mechanism with full coverage (the successor often isn't a query candidate), the literal "author the relation, never decide," and zero fidelity regression.
2. **Chain:** resolve to terminal head (a one-hop pointer to B is itself stale); walking the pointer is pointing, not minting.
3. **Payload:** structured pointer + successor title/snippet (spares the agent a round-trip; content read from the successor file).
4. **RBAC:** respect, degrade with an honest marker — never leak the path of an unreadable successor; strict (any unreadable hop degrades).

## Memory pointers

`[[project_currentstate_projection]]`, `[[project_recall_bench_experiment]]`, `[[project_contextforge]]`, `[[project_cortex_consolidation_loop]]`, `[[project_deletion_is_not_a_memory_op]]`, `[[feedback_canonicalize_path_keys]]`.
