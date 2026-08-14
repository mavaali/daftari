# Daftari Legibility & Observability Surface — Design

Readiness: requirements-only
Epic: `mavaali-beads-jos` (children `.1` A, `.2` B, `.3` C)
Status: A ready to build; B/C spec-only (depend on A)

## Problem

Daftari holds graded, contested, provenance-linked knowledge and runs a deterministic nightly maintenance pass (`daftari sleep`). Both are strong internally but **illegible from the outside**:

1. You cannot ask "which of our beliefs touch this file / this doc?" — the graph is write-time only.
2. The nightly `sleep` pass computes a rich report but **persists no run history** — you cannot inspect what a past run found or whether the loop is still doing work.
3. There is no way to *browse* the vault as a human — only query it through an agent.

Three independently-shippable surfaces close these gaps. Order by leverage-per-cost: **A → B → C**. B and C depend on A (both consume the backlink query).

## What already exists (reuse, don't rebuild)

- **Reverse maps** — `buildReverseSourceMap` and `buildReverseLinkMap` (`src/curation/tension-blast.ts`) already invert `sources:` and body wikilinks into `target → Set<docPath>`. Used today only inside blast-radius. Slice A exposes them as a query.
- **Describes-pin edges** — `parseDescribesEntry` / `classifyDescribesEdges` (`src/audit/describes.ts`) already parse each doc's `describes:` frontmatter into `{repo, path, pin}` edges (doc → code). Slice A inverts these (code → docs).
- **Pin classifier** — `classifyPin` (`src/tools/anchors.ts`) already classifies a pin as intact/moved/missing against a repo working tree. Slice A optionally annotates code-facet hits with this.
- **Sleep report** — `runSleepCycle` → `SleepCycleResult` (`src/sleep/cycle.ts`) already computes the full nightly summary. Slice B persists it; it does not recompute it.
- **`daftari serve`** — already the MCP HTTP server (stateless, per-request RBAC). Slice C's viewer MUST use a **different** subcommand name; `serve` is taken.
- **`tippani`** (Mihir's repo) — frontend/scaffold to reuse for slice C. Inspect before building C.

---

## Slice A — Backlinks / mentions query

The reverse of the knowledge graph: given a target, return the docs that reference it. Two facets, one tool.

- **R1** — Given a **vault doc path**, return the set of docs that reference it, split by edge kind: `source` (cite in `sources:`) and `link` (body wikilink). Computed from `buildReverseSourceMap` + `buildReverseLinkMap` over the loaded doc set.
- **R2** — Given a **code file path** (optionally repo-qualified `repo:path`), return the docs whose `describes:` bindings pin that file, via `parseDescribesEntry` matching on resolved `{repo, path}`.
- **R3** — Each code-facet hit MAY carry an optional pin `state` (`intact`/`moved`/`missing`) from `classifyPin`, only when the target repo root is resolvable and `--verify` (or the tool's `verify` arg) is requested. Absent verification, hits carry the raw pin span only. Verification failure degrades to "no state", never a false state (mirrors the read-path contract).
- **R4** — Target kind is inferred from the argument: a path that resolves to an existing vault doc → doc facet (R1); otherwise → code facet (R2). An explicit `kind: doc|code` override MUST be accepted to disambiguate.
- **R5** — Surface as **one MCP tool** (`vault_backlinks`) AND a **CLI** path (`daftari backlinks <target>` or a `--mentions` flag on the existing search command — pick one in the plan). RBAC: read-only, no credentials/mutation. Deny-all guest sees nothing (consistency with existing read tools).
- **R6** — Empty result is a valid, non-error response: `{ target, kind, references: [] }`. A target that matches nothing is not an error.

### Data flow — four paths (R1/R2)
- **Happy**: target has references → grouped list with counts.
- **Empty**: target valid, zero references → `references: []`, `count: 0`.
- **Error**: malformed target (e.g. empty string) → tool error, no partial write (read-only anyway).
- **Upstream failure**: `loadDocuments` fails or a describes entry is malformed → skip the bad edge (never surface a false backlink), return what loaded, and, for R3, degrade pin state to absent.

### NOT in scope (A)
- Transitive/multi-hop backlinks (1-hop only). — deferred; blast-radius already does multi-hop internally.
- Symbol-level (`::symbol`) resolution — pins are file-level in v1; carry the symbol string, don't resolve it.
- Writing/mutating any edge.

---

## Slice B — Persisted sleep/distill run ledger

- **R7** — Each `daftari sleep` run appends one record to a persisted ledger (`.daftari/runs.jsonl`, content-light: timestamp, run kind, counts from `SleepCycleResult` — staleness buckets, wake count, tensions open, ratification history — NOT full doc bodies).
- **R8** — `daftari runs` lists recent runs (id, kind, timestamp, one-line summary). `daftari runs show <id>` prints that run's stored summary.
- **R9** — Distill runs (compile-on-ingest branch) append with `kind: distill` once that branch merges; the ledger schema MUST accommodate both without change.
- **R10** — The ledger is append-only and self-pruning (cap N most-recent, mirror the existing monotonic-growth discipline). No live-attach in this slice.

### NOT in scope (B)
- Live-attach / streaming progress of a running job — deferred to when a long LLM-driven run (distill) exists to attach to.
- Cancelling runs.

---

## Slice C — Read-only web viewer

- **R11** — A new subcommand (name TBD, NOT `serve`) serves a **read-only** local browse UI: doc pages (rendered markdown + frontmatter), backlinks panel (reuses Slice A), open tensions, provenance/pin state.
- **R12** — Loopback-only by default; no mutation endpoints; reuses the same RBAC identity resolution as `serve`.
- **R13** — Reuse `tippani` scaffold/frontend where it fits (inspect first; do not import blindly).

### NOT in scope (C)
- Editing docs from the UI (read-only).
- Auth/multi-tenant hosting beyond loopback.

---

## Failure-mode check (epic)

- **Succeeds wildly**: backlink queries over a huge vault → reverse maps are O(docs) built once per `loadDocuments`; acceptable, same cost blast-radius already pays. Cache within a single tool call.
- **Fails**: all three surfaces are read-only — worst case is a stale/empty read, never data loss. The ledger (B) is append-only; a corrupt line is skipped, not fatal.
- **6-month consequence**: no schema change (A), one content-light jsonl (B), one new read-only subcommand (C). Nothing here constrains the core knowledge model or adds a mutation path to maintain.
