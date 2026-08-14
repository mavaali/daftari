# RESUME HANDOFF — Tension Triage Card (v0)

> Written 2026-08-01 before a ~5h pause. Read this + the requirements doc to resume cleanly.

## Where the work lives
- **Worktree:** `/Users/mihirwagle/projects/daftari/.worktrees/tension-triage-card`
- **Branch:** `feat/tension-triage-card` (based off `origin/main` @ `c70908c` — NOT the stale local `main`, which was 104 commits behind).
- **Spec:** `docs/plans/2026-08-01-tension-triage-card-requirements.md` (this dir, uncommitted).
- Nothing is committed yet. Disclosure is held — do NOT `git add`/commit/push or open a public issue without Mihir's explicit go.

## Locked decisions (see requirements doc "Resolved Decisions")
- Surface C: MCP tool engine + `daftari tensions` CLI renderer. No GUI.
- Scope A: read-only (v0 SEES, does not ACT). `tension_resolve` untouched.
- Card fields: kind, age_days, primary/advisory blast + hidden_downstream, tier+confidence per side, read-heat per side. Deferred: criticality, provenance, recommended-kind, composite score/ranker.
- Ordering: clusters by size desc, tensions within by age_days desc. NO composite score.
- Read-heat window default 30 days. `instrumented` flag distinguishes cold from pre-log.

## DONE (verified — TDD, all green, `tsc --noEmit` clean)
1. **Story 2** — `src/curation/read-heat.ts` + `test/curation/read-heat.test.ts` (10 tests). Pure `computeReadHeat(entries, docs, {now, windowDays})` → `Map<file, {count, last_read, instrumented}>`.
2. **Story 1 pure core** — `src/curation/tension-triage.ts` + `test/curation/tension-triage.test.ts` (13 tests). Pure `computeTensionTriage(tensions, {docMeta, readHeat, blastByTension}, now)` → `{cluster_count, tension_count, clusters[]}`. Groups via `computeTensionClusters`, size-desc clusters, age-desc tensions, per-side unknown handling, unavailable-blast handling, asserts no score field.

Run to confirm: `npx vitest run test/curation/read-heat.test.ts test/curation/tension-triage.test.ts`

## TODO (resume here)
1. **Async loader** (add to `tension-triage.ts` or a sibling): `loadTensionTriage(vaultRoot, now, entryFilter)`:
   - `listTensions(vaultRoot)` → filter in-scope (loader can pass through `computeTensionTriage`'s own filter).
   - `loadDocuments(vaultRoot)` (`src/curation/vault-docs.ts`) → build `docMeta` Map (tier, confidence, created from `d.frontmatter`).
   - Build reverse maps once: `buildReverseSourceMap(docs)` + `buildReverseLinkMap(docs)` (`src/curation/tension-blast.ts`). Per tension, `computeBlast({seeds: [sourceA, sourceB], reverseSource, reverseLink})` → map to `TriageBlast` (`bucketHiddenDownstream(0)`="none" when no RBAC hiding). Key by tension id.
   - `readReadLog(vaultRoot)` → `computeReadHeat(entries, docsWithCreated, {now, windowDays:30})`.
   - Call `computeTensionTriage`. Mirror `loadTensionClusters`'s Result + `entryFilter` signature.
2. **MCP tool** `vault_tension_triage` in `src/tools/curation.ts` — mirror `vaultTensionClusters` (lines ~254-270): `requireReadAccess`, `openIndexForAccessOrNull`, pass `visibleTensions(db, entries, access)` as the entryFilter. Register in the tool list block (near line ~1116). Add its schema/description.
   - **RBAC decision Mihir hasn't answered:** v0 default = apply `visibleTensions` to which tensions appear + compute blast on the readable doc graph; do NOT replicate the per-tension #217 kept/hidden downstream recompute (that's in `vaultTensionBlast` lines ~322-343). If he wants full parity, add it. Proceed with the default unless he says otherwise.
3. **Story 3 CLI** — `daftari tensions` in the CLI (`src/cli.ts` + `src/serve/` or wherever subcommands live — grep `daftari ` subcommand registration). Calls the loader, prints grouped tables per cluster; `--limit`, `--window` flags; empty state "No open tensions", exit 0. TDD it.
4. Full suite + `tsc` before any completion claim. Then use `superpowers:finishing-a-development-branch` to decide merge/PR with Mihir.

## Gotchas
- Baseline had 2 flaky timeout failures in `test/tools/staged-actions.test.ts` (5s timeouts, machine under load) — unrelated to this work.
- `ageInDays(date, now)` from `src/curation/staleness.js`. `Tier`/`Confidence` from `src/frontmatter/types.js`. `HiddenDownstream` + `bucketHiddenDownstream` from `src/curation/tension-blast.js`.
- Every in-scope tension's two endpoints always share one cluster (min size 2) — there are no cluster-less "standalone" tensions; singletons are just 2-doc clusters.
