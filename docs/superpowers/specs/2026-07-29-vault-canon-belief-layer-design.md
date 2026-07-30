# vault_canon — The Belief Layer (Design)

- **Date:** 2026-07-29
- **Status:** Draft (design approved in brainstorming + Jugalbandi; pending spec review)
- **Target repo:** `daftari` (intended home: `docs/superpowers/specs/2026-07-29-vault-canon-belief-layer-design.md`)
- **Verified against:** `origin/main` @ 7b81ad7 (v1.32.0)
- **Authors:** Mihir Wagle (design decisions) + Mavaali (synthesis)

---

## 1. Problem

Daftari has solved multi-user *permissions* (RBAC, both-sides tension visibility, stateless serve) but not multi-user *belief*. Today a shared vault holds **one** truth; multiple users read the same collections through role ACLs, but there is no model for "Alice believes X, Bob believes Y, keep both, attributed, until reconciled." Every other shared AI-memory product collapses a group to one answer. This is the differentiated unlock on daftari's hardest axis.

**7th-grader differentiation:** *"Everyone else's shared AI memory picks one answer for the whole group. Daftari remembers that Alice and Bob believe different things — and keeps both, cleanly, until they get sorted out."*

## 2. Goal / Non-goals

**Goal.** A read-time MCP tool, `vault_canon`, that computes — for a set of holders, an emergent topic, and an as-of time — the **settled** belief (where holders agree) and the **contested** belief (where they clash), attributed and never auto-resolved.

**Non-goals (v1, explicit YAGNI).**
- Materialized/cached canon (add only if a real query is measured slow).
- A `recorded_at` column (dropped — `updated` + git commit time are the record clock).
- Sub-document "claim" entities (daftari is document-granular; a claim = a document).
- Any auto-winner resolution (resolution stays a manual curatorial act via existing `vault_tension_resolve`).
- Cross-vault canon; holder auth beyond RBAC.
- **Detection canon** (LLM contradiction-hunt at query time) — rejected for v1; see §7.

## 3. Definitions

- **Claim = document.** Verified: daftari has no sub-document claim entity; knowledge is document-level.
- **Holder.** A user or agent identity. Ground truth is the RBAC `principal` (`--user/--role`). Not a full user system — a thin registry (see §5.2).
- **Canon (computed, not stored).** `canon(holders, topic, as-of) = resolve(those holders' currently-valid documents in that topic at that time)`.
- **Currently-valid.** `valid_from ≤ as-of < valid_until` (half-open; reuse `computeValidity`). Fossils (superseded by a later still-valid contradictory doc) fall out by `valid_until` and are **not** tensions.
- **Two clocks.** *World clock* = `valid_from` (when the belief applies). *Record clock* = `updated` (server-stamped; git commit time is the precise mirror). No third timestamp.
- **Settled.** Among the visible, currently-valid docs of the holder-set in the topic, no tension links them.
- **Contested.** A tension links them → return a **trajectory**: the attributed docs, each stamped with both clocks, in temporal order. Never collapsed.
- **Topic (emergent, bounded).** The **depth-2 ego-graph** from a seed document over the combined `tension` + `derives_from` edges (see §5.3 — Jugalbandi C1). Semantic search finds the seed only.

## 4. Locked decisions (provenance: brainstorming dialogue)

1. Holders are first-class sources — a tension side generalizes from a doc to a holder.
2. Canon is **computed, not stored**.
3. Contested canon is a **trajectory** (both clocks), **never auto-resolved**.
4. Default read = **shared/consensus** canon over all RBAC-readable holders; one engine, holder-set `{me}` = personal canon.
5. Topic is **emergent** from the graph (bounded to depth-2 per C1).
6. Epistemic commitment = **Option C (hybrid relational)** — see §7.

## 5. Architecture (v1: read-time, Approach 1)

A new MCP tool `vault_canon` computes everything live. Nothing is stored.

### 5.1 Data flow
```
seed (doc path OR semantic-search hit)
  → topic engine: depth-2 ego-graph over tension + derives_from        (§5.3)
  → collect component docs
  → keep currently-valid at as-of (computeValidity)
  → RBAC-filter (readable docs/holders only)                            (§5.5)
  → group by holder (via registry)                                     (§5.2)
  → resolve: settled vs contested-trajectory                           (§5.4)
  → attach vault_receipt + flags
  → return
```
All of the above runs inside **one SQLite read transaction (WAL, `BEGIN DEFERRED`)** and against **one git commit ref pinned at call start** (Jugalbandi C3 — correctness, not perf).

### 5.2 Holder registry (`src/holders/registry.ts`)
- Normalizes stamped identity strings (`updated_by`, `principal`, git author) → a **canonical holder id**.
- **Write-forward, many-to-one**: many historical strings (e.g. `mavaali-v1`, `mavaali`) map to one holder (Jugalbandi C2). Git history is immutable, so reconciliation happens at read time via the map.
- Reuses the existing optional `authorMap` config pattern, extended to one-to-many. Population is via the existing config file (human-authored `authorMap`); no new admin surface in v1. Confirm the existing config schema accepts one-to-many before writing `registry.ts` (if not, that schema extension is the first task).
- **Unregistered strings are flagged, never silently split** into new holders — surfaced as a `ghost_holder_warning` (count + the unrecognized strings) so a rename doesn't manufacture a fake disagreement.

### 5.3 Topic engine (`src/canon/topic.ts`)
- Input: a seed document path.
- Output: the **depth-N ego-graph** (default N=2) — the seed, its direct `tension`/`derives_from` neighbors, and (at N=2) their direct neighbors. Does **not** expand to the full reachable component.
- Rationale (C1): connected-component-as-topic transitively lumps unrelated disputes ("Q1 revenue" reaching "interest rates"). The boundary predicate is "has a direct relational claim to something the caller named," which is topically coherent and bounded.
- **Depth is an optional per-call parameter `depth` defaulting to the constant `2`.** It is the traversal rule itself, not a band-aid size cap. The single source of truth is the `depth` param; the constant is only its default.

### 5.4 Canon resolver (`src/canon/resolve.ts`)
- Input: the topic doc set, holder-set, as-of.
- Filter to currently-valid; group by canonical holder.
- **Settled**: no tension among the surviving visible docs → return the agreed claim(s) with citations.
- **Contested**: a tension links surviving docs (intra-holder or inter-holder) → return a **trajectory** of attributed docs, each with `{holder, valid_from, updated/git-time, path}`, temporally ordered. No winner is chosen.
- Resolution remains a separate manual act (`vault_tension_resolve`); this tool never mutates.

### 5.5 RBAC integration & the `partial_visibility` flag (Jugalbandi C4)
- The holder-set and doc-set are RBAC-filtered; a holder/doc you cannot read is omitted (consistent with existing "omit, not redact").
- **The false-settled hole:** the both-sides rule hides a tension when one side is unreadable, so the resolver could report "settled" when a dispute is behind an ACL. Fix: the result carries `partial_visibility: true` and a **count** of hidden tensions touching this topic (never their content). "Settled" without the flag = no tensions exist; "settled" with the flag = no *visible* tensions exist.

### 5.6 As-of query API (`src/asof/` refactor)
- `asof` is CLI-only today. Extract its validity-partition logic into a callable function the resolver uses. No behavior change to the CLI.

### 5.7 MCP tool surface (`src/tools/canon.ts`)
`vault_canon({ seed | query, holders?, as_of? })` →
```
{
  settled:  [{ claim, citations: [path...] }],
  contested:[{ trajectory: [{ holder, path, valid_from, updated }],
              hint_ordering }],   // hint_ordering: "by_valid_from" | "by_updated" —
                                   // names which clock the trajectory is sorted on. A
                                   // presentation hint ONLY; never implies a winner.
  flags: {
    graph_completeness: "curated",       // §7
    partial_visibility: bool, hidden_tension_count: n,
    unindexed: bool, unindexed_paths: [...],   // §7
    ghost_holder_warning?: { count, strings: [...] }
  },
  receipt: <vault_receipt over all cited docs>
}
```
- `holders` defaults to all RBAC-readable holders (shared canon); `{me}` for personal.
- `as_of` defaults to now.

## 6. Module boundaries
| Module | Responsibility | Depends on |
|---|---|---|
| `src/holders/registry.ts` | string → canonical holder id; alias map; ghost flag | config `authorMap` |
| `src/canon/topic.ts` | depth-2 ego-graph from seed | tension log, derives_from store |
| `src/canon/resolve.ts` | validity filter, holder grouping, settled/contested | validity, registry, tension log |
| `src/asof/` (refactor) | callable validity-at query | index-db |
| `src/tools/canon.ts` | MCP tool, RBAC gate, flags, receipt assembly | all above, `vault_receipt`, RBAC |

Each unit is independently testable: topic engine (graph in → doc set out), resolver (doc set + holders → settled/contested), registry (strings → ids).

## 7. Epistemic commitment — Option C (hybrid relational)

The tension + `derives_from` graph is **not** a complete or symmetric index of all real contradictions (Jugalbandi's hardest challenge). Therefore "settled" **cannot** mean "no contradiction exists." Daftari's answer, consistent with *"it remembers, it doesn't resolve for you"*:

- **Relational canon:** "settled" = *no contradiction anyone has recorded*. Every result is labeled `graph_completeness: "curated"`. Canon promises **faithfulness to what is recorded, not omniscience** — and says so in the output contract.
- **Unindexed flag:** any doc in scope that has never been through a consolidation pass (no `tension`/`derives_from` edges evaluated) is flagged `unindexed: true` with its paths, so the caller knows "settled" excluded docs the graph never examined.
- **Background consolidation** shrinks the unindexed set over time (reuse the existing `consolidate`/`sleep` machinery — no new pass invented).

Rejected: **Option B (detection canon)** — an LLM contradiction-hunt at query time makes detection quality the guarantee (fragile), is far more expensive, and breaks the ethos by having the vault infer for the reader. It is a *different product*, not v1.

## 8. Edge cases
- **All-fossil topic** (nothing valid at `as-of`): return `settled: []` with an explicit "no current belief; history available via `asof`."
- **Giant/dense graph**: bounded by the depth-2 rule (§5.3), not a post-hoc cap.
- **Same human, two identity strings**: reconciled by the registry (§5.2); unmapped → `ghost_holder_warning`.
- **Concurrent write mid-call**: prevented by the single read txn + pinned git ref (§5.1).
- **Intra-holder contradiction** (Alice holds two valid contradictory docs): a contested trajectory with a single holder — same object, one holder.

## 9. Risks / open questions
- **Depth default tuning.** Depth is a per-call `depth` param defaulting to `2` (§5.3). Open question is only whether `2` is the right *default* topic radius for real vaults — bench with a real corpus.
- **Ghost-holder false merges.** A too-aggressive alias map could merge two genuinely different holders. The map is human-authored; treat merges as high-trust operations.
- **`unindexed` noise.** In a fresh vault most docs are unindexed; the flag may be loud until consolidation catches up. Acceptable — it is honest.
- **Receipt cost.** Assembling `vault_receipt` over a large topic set may dominate latency; measure before optimizing.

## 10. Provenance
Design decisions Q1–Q5 + architecture from the 2026-07-29 brainstorming dialogue; four revisions (C1–C4) and the Option-C commitment from the same-day Jugalbandi Challenger→Resolver pass. Substrate facts verified in code against `origin/main` @ 7b81ad7. Full trail in the Daftari vault: `projects/mihir-project-spine.md`.
