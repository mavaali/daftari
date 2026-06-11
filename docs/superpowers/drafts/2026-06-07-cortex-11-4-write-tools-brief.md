# Build brief — §11.4: `vault_supersede` + `vault_merge` + `vault_set_confidence`

**Branch:** `mihir/supersede-merge-confidence`
**PR title:** `feat(write): vault_supersede + vault_merge + vault_set_confidence (§11.4)`
**Base off `origin/main`** (which now contains §11.1 backfill #110, §11.2 staged-action queue #111, and the 1.17.0 cut #112).

## Why this is next

§11.2 shipped the staged-action queue and `vault_ratify`. On approve, ratify dispatches `promote`/`deprecate` to real write tools, but **`supersede` / `merge` / `confidence-up` punt** with `Result.ok({applied:false, deferred_to:"§11.4"})` and land in status `ratified-pending-tool`. §11.4 builds the three missing write tools and **wires them into ratify**, retiring the punt. After this, every action type in the staged-action enum can actually be applied.

Source of truth for the design: §11.4 in `docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md`. This brief expands it.

## What exists already (read these first)

- **Write-path pattern:** `src/tools/write.ts` — every write tool validates inputs, acquires a file lock, mutates the file, refreshes the index, auto-commits, appends provenance, releases the lock. `performWrite()` is the shared engine; it is **single-file / single-commit**. Tools return `Result<WriteResult,Error>`, never throw.
- **Multi-file commit precedent:** `src/backfill/apply.ts:137` — `commit(vaultRoot, paths[], message, agent)` commits several files in one commit. `vault_merge` needs this (it touches 3 docs); `performWrite` won't fit merge as-is.
- **Frontmatter:** `STATUSES` already includes `"superseded"` and the `superseded_by` field exists (`src/frontmatter/types.ts`). `CONFIDENCES = [low, medium, high]`.
- **RBAC:** `canWrite(role, collection)` / `canPromote(role)` in `src/access/rbac.ts`. Collection = frontmatter `collection` or top-level dir (see `collectionOf` in write.ts).
- **Helpers in write.ts:** `requireString`, `readBaseVersion`, `serializeDocument`, `applyExtensionDefaults`, `todayISO`, `requireIndexReady`, `collectionOf`.
- **Ratify dispatch to extend:** `src/tools/staged-actions.ts` — `vaultRatify` (the `DEFERRED_ACTION_TYPES` branch at ~L186) and `DEFERRED_ACTION_TYPES` in `src/curation/staged-actions.ts:55`.

---

## Tool 1 — `vault_set_confidence` (simplest; build first)

Narrow tool to change only `confidence`, avoiding a full-document overwrite for a nudge.

**Args:** `path` (req), `confidence` (req, enum low|medium|high), `reason` (req — a confidence change is a calibration claim; force an audit trail), `agent` (req), `base_version` (optional, same optimistic-concurrency token as other write tools).

**Behavior:**
- Validate `confidence ∈ CONFIDENCES`.
- RBAC: `canWrite` on the doc's collection.
- Load doc; if not found → err. No-op guard: if current confidence already equals the target, **still rewrite** is wasteful — return an err or a no-op `WriteResult`? Recommend: return `err("confidence already <x>")` so a staged confidence-up that's already satisfied surfaces rather than churning a commit. (Open question — see below.)
- New frontmatter: `{...old, confidence, updated: today, updated_by: agent}`; body unchanged.
- Reuse `performWrite` with `action: "confidence-set"` (extend the `WriteResult["action"]` union + provenance). Commit message: `vault_set_confidence: <path> <old>→<new> by <agent> — <reason>`.

**Action string:** add `"confidence-set"` to `WriteResult["action"]` and the provenance `action` doc comment.

## Tool 2 — `vault_supersede`

Mark a doc explicitly superseded by a named successor. Distinct from `vault_deprecate`: deprecate sets `status="deprecated"` with an *optional* successor; supersede sets `status="superseded"` and **requires** `superseded_by`.

**Args:** `old_path` (req), `new_path` (req — the successor; mandatory), `reason` (optional, recorded in commit), `agent` (req), `base_version` (optional).

**Behavior:**
- Guard `old_path !== new_path`.
- Verify **both** docs exist (the successor must be real). `new_path` missing → err.
- RBAC: `canWrite` on `old_path`'s collection.
- New frontmatter for `old_path`: `{...old, status:"superseded", superseded_by:new_path, updated, updated_by}`. Body unchanged. `performWrite`, `action:"supersede"`.
- Commit message: `vault_supersede: <old_path> superseded by <new_path> by <agent>[ — <reason>]`.
- **Open:** restrict source status (only supersede a `canonical`/`draft` doc) or allow from any status? Recommend permissive for v1, last-write-wins — but surface, don't guess.

**Action string:** add `"supersede"` to the union + provenance.

## Tool 3 — `vault_merge` (hardest; touches 3 docs)

Combine two source docs into a target, and mark both sources superseded by the target. The spec says merge is **always-staged in v1** (the loop never auto-applies it; a human ratifies → this tool runs).

**Key decision: the tool does NOT synthesize prose.** The merged body is supplied by the caller (the loop/agent that staged it, or a human). `vault_merge` is mechanical: write the target with the supplied body+frontmatter, then supersede both sources to point at the target. Auto-synthesizing a merge is out of scope (and would be an LLM call — the write layer is LLM-free).

**Args:** `path_a` (req), `path_b` (req), `target_path` (req — may equal `path_a` to "merge B into A", or be a new path), `body` (req — the merged markdown body), `frontmatter` (optional — overrides for the target; default: start from `path_a`'s frontmatter, stamp `updated`/`updated_by`, `provenance:"synthesized"`), `agent` (req).

**Behavior (one atomic commit over up to 3 files):**
- Guards: `path_a !== path_b`; both sources exist.
- RBAC: `canWrite` on the collection of **each** of `path_a`, `path_b`, and `target_path` (a merge writes/mutates all three).
- Write `target_path` with merged body + frontmatter (validate via `validateFrontmatter`).
- Mutate `path_a` and `path_b` to `status:"superseded"`, `superseded_by:target_path` (unless that source *is* the target).
- **Commit all touched paths in one commit** via `commit(vaultRoot, [target, path_a, path_b], msg, agent)` — model on `src/backfill/apply.ts`, NOT `performWrite` (which is single-file). Index each written doc (`indexDocument` per path). Provenance: one entry per file (`action:"merge"` on the target, `action:"supersede"` on each source — or `"merge"` on all three; pick one and document).
- Lock: acquire file locks on all three paths before writing; release all in `finally`. Watch lock-ordering (acquire in a deterministic sorted order to avoid self-deadlock if two merges overlap — though the one-process invariant makes this theoretical).
- Commit message: `vault_merge: <path_a> + <path_b> → <target_path> by <agent>`.

**Action string:** add `"merge"` to the union + provenance.

`vault_merge` is the riskiest tool here (multi-file atomicity, lock ordering, RBAC across 3 collections). If `performWrite` can be cleanly generalized to a multi-file variant rather than hand-rolling, prefer that — but **STOP and report** if generalizing it threatens the single-file callers.

---

## Wire into §11.2 ratify (required — this is the point)

In `src/tools/staged-actions.ts` `vaultRatify`, replace the deferral branch with real dispatch, and empty out `DEFERRED_ACTION_TYPES` in `src/curation/staged-actions.ts` (or delete it). Define the **`proposed_diff` schema per action type** so stage→ratify round-trips:

- **`supersede`** → `proposed_diff = { superseded_by: "<new_path>" }`. Dispatch: `vault_supersede({ old_path: targetPath, new_path: proposed_diff.superseded_by, reason: rationale, agent: principal }, access)`.
- **`confidence-up`** → `proposed_diff = { confidence: "<low|medium|high>" }` (the new value; `confidence-up` is the action_type name, `vault_set_confidence` is the tool — note the mismatch, keep the enum name). Dispatch: `vault_set_confidence({ path: targetPath, confidence: proposed_diff.confidence, reason: rationale, agent: principal }, access)`.
- **`merge`** → `proposed_diff = { merge_from: ["<path_a>","<path_b>"], body: "<merged>", frontmatter?: {...} }`; the staged `target_path` is the merge target. Dispatch: `vault_merge({ path_a: merge_from[0], path_b: merge_from[1], target_path: targetPath, body, frontmatter, agent: principal }, access)`.

On dispatch success → `recordDecision(status:"ratified", ...)` and return `{applied:true, commit}`. On failure → return the err, leave the action pending (same contract as promote/deprecate today).

**You WILL break §11.2 tests** that assert the punt — update them:
- `test/tools/staged-actions.test.ts` — the "approving a supersede is a graceful punt" test must change to assert the supersede now applies (status `ratified`, doc superseded). Add merge + confidence-up approve tests.
- Remove/repurpose any `deferred_to:"§11.4"` assertions and the `ratified-pending-tool` expectation.
- Update the `vault_ratify` tool description string (it currently says supersede/merge/confidence-up are staged-only).

## Architecture constraints (from CLAUDE.md)

- No classes. Functions and types. `Result<T,Error>`; never throw from handlers.
- Tests mirror `src/`; every new tool gets a test file (`test/tools/write-*.test.ts` or add to `write.test.ts`).
- Auto-commit is the version layer; provenance is the advisory audit trail.

## Test plan

- `vault_set_confidence`: changes confidence + commits + provenance; rejects bad enum; RBAC denial; already-at-target behavior (per the open-question decision).
- `vault_supersede`: sets status/superseded_by + commits; rejects missing successor; rejects self-supersede; RBAC denial.
- `vault_merge`: writes target + supersedes both sources in **one commit** (assert `git log` shows all three in one commit); merge-into-`path_a` (target==path_a); RBAC denial on any of the three collections; rejects path_a==path_b.
- **Ratify integration:** stage+approve each of supersede / merge / confidence-up end-to-end (verifies dispatch + commit + status `ratified`, not `ratified-pending-tool`).
- Optimistic concurrency: `base_version` mismatch rejects (set/supersede).

## Out of scope

- LLM-driven merge synthesis (the merged body is supplied, not generated).
- Auto-applying merge outside ratification (merge stays human-gated).
- Strength/loop integration (§11.3+).
- A dedicated narrow RBAC grant for confidence/supersede (reuse `canWrite`).

## Open questions — surface, don't guess

1. **`vault_set_confidence` no-op:** err vs silent no-op when confidence is already the target? (Recommend err, so a redundant staged confidence-up surfaces.)
2. **`vault_supersede` source-status restriction:** allow superseding any status, or only `canonical`/`draft`? (Recommend permissive v1.)
3. **`vault_merge` provenance action:** `"merge"` on all three files, or `"merge"` on target + `"supersede"` on sources? (Recommend the latter — it reads truthfully per file.)
4. **`vault_merge` target frontmatter default:** inherit from `path_a`, or require explicit frontmatter? (Recommend inherit from `path_a` + `provenance:"synthesized"`, overridable.)
5. **Generalize `performWrite` to multi-file, or hand-roll merge on the backfill pattern?** STOP and report if generalizing risks the single-file callers.

## Process

1. Read CLAUDE.md + the files listed under "What exists already."
2. TDD. Build confidence → supersede → merge → ratify-wiring (simplest first).
3. `npm run build && npm test && npm run lint` — all green.
4. `[Unreleased] / ### Added` CHANGELOG entry. **No version bump.**
5. PR body: what each tool does, the ratify wiring + updated §11.2 tests, the five open questions with recommendations, reference §11.4 + PRs #109/#111.
6. **If anything in this brief conflicts with what existing code makes idiomatic, STOP and report.**
