# JIT Anchor Pin Minting + Re-Pin Staged Action — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan Implementation-Unit by Implementation-Unit. The execution skill owns the per-unit test-first (RED/GREEN/REFACTOR) cycle.

**Readiness:** implementation-ready
**Goal:** Close the write-side of the JIT anchor loop: agents mint `describes` pins by naming lines (daftari computes the blob sha), and a relocated pin gets a staged `repin` action that rewrites it to its current `#Lx-y@<sha>` on human ratification.
**Architecture:** Two assemblies of existing plumbing. (1) Minting: a best-effort enrichment inside `vaultWrite` that spots a shaless `#Lx[-y]` tail on a `describes` entry and attaches `@<blob-sha>` via `hashObjectFile` before validation/serialization — the entry lands pinned on disk, no schema change. (2) Re-pin: a new `repin` staged-action type in the existing propose/ratify grammar; dispatch recomputes the relocation fresh at apply time and lands it through `vaultWrite`, inheriting locks, tier guards, commit, and provenance.
**Tech Stack:** TypeScript (Node), vitest, git via `execFile` (`src/utils/git.ts` pattern).
**Source spec:** none (requirements extracted below). Continues `docs/superpowers/plans/2026-08-04-jit-anchor-pin-check-plan.md` (U1–U7, shipped as PR #374) and the verdict in `/tmp/fable-daftari-coderepo-report.md` (option B: "finish the binding layer").

---

## Base-branch note (read first)

[DATA] The read-path work (U1–U7 of the 2026-08-04 plan) is **already on `origin/main`** as squash commit `c3cffa7` (PR #374). The local branch `feat/jit-anchor-pins` carries the same content as two pre-squash commits (`fb84cb`, `3f876fb`) on a lineage that is ~40 commits behind origin/main (missing 3.1.0, multi-user contested beliefs, etc.). **Execute this plan on a fresh branch cut from `origin/main`**, not on the current local branch. Discarding the duplicate local commits is CONFIRMED — see Decisions (resolved), item 1.

All `file:line` citations below are against `origin/main` (`c3cffa7`). Where a file is byte-identical on the local branch (verified for `src/tools/anchors.ts`, `src/audit/describes.ts`, `src/utils/config.ts`, both staged-actions files), the cites hold there too.

## What exists today (all [DATA], verified on origin/main)

- `describes` is a plain optional string array in the schema — `src/frontmatter/schema.ts:400` (`optionalStringArray("describes")`). Pinned entries are just strings, so **no schema change is needed for either deliverable**.
- Pin grammar `[<repo>:]<path>[::symbol][#Lstart[-end]]@<sha>` — `src/audit/describes.ts:29` (`PIN_SUFFIX`, sha-strict: a tail without a 7–40-hex `@sha` is NOT a pin and stays part of the path, `:26-28`), parser `:38-76`, `malformedPin` degrade `:50-56`.
- Classifier `classifyPin` → `intact` / `moved` / `missing` — `src/tools/anchors.ts:28-76`. The relocation search computes the new 1-based range and returns `{ state: "intact", relocated: {start,end} }` at `:73-75`. **Terminology pin-down:** the re-pin candidate is this *intact-via-relocation* case (content found at a new range). `moved` means the pinned block was NOT found — there is no new range to propose, so `moved` is a no-op for re-pin.
- Read annotation: `computeAnchors` (`src/tools/read.ts:487-530`) attaches `ReadAnchors` (`:196-201`) with per-entry `relocated` (`:186-194`, populated at `:515`), pin cap 24 (`:205`), drift banner (`:519-524`), null-when-silent best-effort (`:388-394`), softened decay copy (`:396-424`). Today the `relocated` range is *reported and then dropped* — nothing consumes it.
- Git plumbing: `hashObjectFile` (`src/utils/git.ts:71`, hashes the **working tree as-is, dirty content included** per its doc comment `:66-70`) and `catFileBlob` (`:85`).
- Config: `code_repos` name→local-path map + `jit_anchors` kill-switch — `src/utils/config.ts:264-269`, defaults `:293-294`, `resolveCodeRepos` `:987-1007` (existence deliberately not checked at load).
- Write path: `vaultWrite` (`src/tools/write.ts:816`) merges existing frontmatter under the payload at `:996-1004` (#113), loads config at `:1029`, validates at `:1065`, serializes back to the `.md` at `:1138-1143`. `WriteResult` (`:300+`) already carries optional advisory fields (`supersede_hint:337`, `domain_warnings:343`) — the precedent for a mint-report field. Ratified `write` proposals and propose-only coercions both dispatch back through `vaultWrite` (`src/tools/staged-actions.ts:538-548`, `src/tools/write.ts:918-928`).
- Staged-actions grammar: `STAGED_ACTION_TYPES` (`src/curation/staged-actions.ts:49-57`), producer `vaultStageAction` with write-RBAC gate (`src/tools/staged-actions.ts:143-155`) and stage-time fail-fast for doomed targets (`:157-165`), consumer `vaultRatify` with a per-type dispatch switch (`:529-644`) where a dispatch failure leaves the action pending. Conflict detection + inter-proposal tension come free from `stageActionWithConflictCheck` (`src/curation/staged-actions.ts:388`).
- Sleep cycle: `runSleepCycle` (`src/sleep/cycle.ts:74`) is the deterministic nightly pass — it already sweeps the queue (`:80`), already walks every vault doc via `loadDocuments` (`:83`, loop `:94`), and already lists staged actions for the ratification report (`:184`). Its charter (`:1-13`): no LLM, no doc edits, no resolution. [DATA] The only machine-principal precedent is the tension scan's `agent:sleep-tension-scan` (`src/utils/config.ts:176`, CLI override `src/sleep/index.ts:104-106`); the sleep CLI's access posture is "no `--role` ⇒ unrestricted" (`src/sleep/index.ts:290-302`).
- [DATA] `stageActionWithConflictCheck` performs **no dedup**: a second staging on the same target still lands as a new pending id, and an `inter-proposal` tension is logged naming the contenders (`src/curation/staged-actions.ts:404-428`). Any recurring proposer must dedup on its own side.
- Prior plan's own boundary: "Pin auto-repair — refreshing a `moved` pin is an authoring act, never automated" (2026-08-04 plan, NOT-in-scope list). This plan honors it: re-pin is proposed by machine, applied only on human ratify.

## Design decisions

**D1 — Minting surface: write-path auto-enrichment inside `vaultWrite`, not a new tool and not a new argument.**
An agent writes `describes: ["daftari:src/tools/anchors.ts#L28-76"]` (no sha) through ordinary `vault_write`; daftari computes the working-tree blob sha and lands `...#L28-76@<sha12>` on disk. Rationale, one line each:
- *Vs. a new `vault_pin` tool:* a 35th tool would re-implement lock/commit/provenance/index for what is a field enrichment; the tool surface is already the product's cost center, and the agent's authoring act is "this doc describes those lines" — a write, not a new verb.
- *Vs. a `vault_write` argument:* the intent is already fully expressed *in the entry itself*; a parallel `pin:` argument would say the same thing twice and desynchronize.
- *Principle fit:* "compute the signal, author only the relation" — the agent authors the relation (path + lines); the sha is the machine-verifiable signal, exactly what daftari should compute. The enriched value is serialized back to the source `.md` at the existing chokepoint, matching the frontmatter-boundary rule (derived data cleaned/attached at the write boundary, `write.ts:1138-1143`).
- *Safety of reinterpretation:* [DATA] a shaless `#L28-76` tail is today parsed as part of the *path* (`describes.ts:26-28`), i.e. a reference to a file that does not exist — dead weight the audit flags as missing. Enrichment rescues an otherwise-broken spelling; no working behavior is being redefined. A **bare** entry (no `#L` tail) keeps its v1 meaning — an intentionally unpinned file-level binding — and is never touched; there is no whole-file mint form, because a shaless whole-file pin is indistinguishable from that deliberate bare binding.

**D2 — Mint semantics: working tree, best-effort, never blocking.**
- Sha source: `hashObjectFile` on the configured repo's working tree (dirty content included — same bytes the classifier's intact check compares against, `git.ts:66-70`), truncated to a 12-hex prefix (readable; the classifier prefix-matches, `anchors.ts:48`; grammar accepts 7–40).
- Unresolvable (no `repo:` mapping in `code_repos`, `jit_anchors: false`, file absent, git failure): the entry is left byte-identical as written and the failure is *reported, not raised* — the write path never blocks on pins (2026-08-04 R-posture). No silent no-op: the write result carries a null-when-silent `pin_mint` field naming minted and unresolved entries (the `supersede_hint`/`domain_warnings` precedent).
- Uncommitted content: minting against a dirty file succeeds (pin is immediately `intact` by prefix match); the caveat is that until that blob is committed it is absent from the odb, so a *later* edit degrades the relocation search to `moved` (`anchors.ts:57-58`). The mint report flags this per entry (`committed: false` via `git cat-file -e`) so the agent knows the pin is provisional.
- Call site: `vaultWrite` only (create + update), placed after the #113 frontmatter merge (`write.ts:996-1004`) and after the config load, before validation/serialization. This automatically covers ratified `write` proposals and propose-only coercions, since both re-enter `vaultWrite` at dispatch. `vault_append`/`vault_merge` do not mint in v1 (deferred).

**D3 — Re-pin: a new `repin` staged-action type, manual-ratify, per-doc batching, dispatch recomputes fresh.**
- *New action type vs. reusing `write`:* a `write` proposal would freeze the whole frontmatter payload for up to `ttl_days` (14 days) and replace the `describes` array wholesale at ratify — a stale-clobber hazard against concurrent edits, and illegible in the queue. A `repin` type is self-describing in every existing surface (lint's pending list, ratify elicitation, conflict tensions) for the cost of one enum member + one dispatch case — the grammar's intended extension point.
- *Manual-ratify, not auto-apply:* re-pinning rewrites frontmatter of a belief doc; the curation engine is advisory by decree (CLAUDE.md), the prior plan explicitly reserved pin refresh as "an authoring act, never automated", and the relocation match is exact-substring — a coincidental match must pass a human gate. Auto-apply (a config knob) is deferred until the manual path has a track record.
- *Dispatch recomputes:* code keeps moving between stage and ratify. The `proposed_diff.replacements` captured at stage time is **display/rationale material for the ratifier**; on approve, the dispatch re-runs the classifier against the current working tree and applies the *fresh* relocation + fresh working-tree sha, replacing only the matching entries in the doc's *current* `describes` array (never wholesale). If nothing is currently relocated (code moved back, pin already fixed, block now gone), the dispatch errors and the action stays pending — the standard dispatch-failure contract (`tools/staged-actions.ts:385-387`) — with a message telling the ratifier to reject. The approval is policy-level ("re-pin this doc's relocated pins to wherever they now live"), and the commit/provenance record the actually-applied rewrite.
- *Per-doc batching:* one `repin` action per document, covering all currently-relocated pins. Matches the queue's per-`target_path` conflict detection, keeps the queue human-scale, and dispatch-recompute makes entry-level staleness harmless.
- *Surfacing:* (a) `vault_read`'s existing `anchors` annotation gains a `repin_hint` when ≥1 entry has `relocated` — the exact `vault_stage_action` call to make — so any reading agent can stage the fix in one call; (b) the proposal itself then flows through the untouched generic queue surfaces (lint pending list, ratify elicitation). No new tool, no read-path write (the read path stays strictly read-only — `anchors.ts:4-6`), no audit-path coupling in v1.

**D4 — Auto-stage proposer: piggyback on the sleep cycle, dedup by pending-check, system principal, default on.** (In scope per Decisions (resolved), item 3.)
- *Host — `runSleepCycle`, not the audit batch, not a new subcommand:* the cycle already walks every doc (`cycle.ts:83-94`) and already mutates the queue (`sweepExpiredActions`, `:80`), so U7 piggybacks instead of adding a second full-vault scan; the audit is a read-only coherence report and stays one; `computeRepin` is deterministic git work, honoring the cycle's no-LLM charter (`:1-13`).
- *Dedup — proposer-side pending-check, because the producer has none:* [DATA] `stageActionWithConflictCheck` re-stages duplicates and tension-logs them (`curation/staged-actions.ts:404-428`); collapse (`:204`) keys on action *id*, not target+type, so nightly re-staging would pile up. U7 snapshots `listStagedActions` (`:270`) once per cycle and skips any doc that already has a **pending** `repin` (non-pending history never blocks a fresh proposal).
- *Producer — reuse `vaultStageAction` with `access` undefined:* operator CLI is unrestricted without `--role` (the tension-scan posture, `sleep/index.ts:290-302`, gate conditional at `tools/staged-actions.ts:143`); this inherits U4's stage-time recompute, `proposed_diff.replacements` stamping, and fail-fasts with zero reimplementation.
- *Identity — `agent:sleep-repin`:* follows the one existing machine-principal convention, `agent:sleep-tension-scan` (`config.ts:176`).
- *Kill-switch — `auto_repin`, default `true`:* staging is advisory (human ratify still gates every apply), and the pass no-ops unless `jit_anchors` is on AND `code_repos` is non-empty — configuring `code_repos` is the real opt-in, so default-on delivers the proposer Mihir asked for without touching unconfigured vaults.
- *Scope cap — candidate filter, O(docs-with-pinned-describes):* only docs whose frontmatter `describes` carries ≥1 real `@sha` pin with a repo mapped in `code_repos` (the `computeAnchors` filter, `read.ts:493-497`) reach `computeRepin`; everything else is a frontmatter-only skip inside the loop the cycle already runs.

## Decisions (resolved)

Reviewed by Mihir 2026-08-12; the former "Decisions for Mihir" section is settled:

1. **Branching:** cut a NEW branch off `origin/main` (`c3cffa7`); the local `feat/jit-anchor-pins` pre-squash duplicates (`fb84cb`, `3f876fb`) are discarded.
2. **MCP exposure:** `repin` stays MCP-reachable through `vault_stage_action`/`vault_ratify` — write-RBAC + ratify-grant gated, same posture as `supersede`. No CLI-only carve-out.
3. **Auto-staging:** IN SCOPE (override of the original defer) — a proposer that auto-stages repin proposals ships in this plan as **U7** (design in D4, requirement R8).

## Requirements

- **R1 — Shaless-pin mint.** A `describes` entry of the form `[<repo>:]<path>#L<start>[-<end>]` (line-range tail, no `@sha`) written through `vault_write` is enriched in place to `...#L<start>-<end>@<sha12>`, where the sha is the configured repo's current working-tree blob id of `<path>`. Bare entries (no `#L` tail) and already-pinned entries are untouched.
- **R2 — Mint never blocks, never lies.** Any mint failure (unmapped repo, `jit_anchors: false`, absent file, git error, malformed range) leaves the entry byte-identical as written and the write proceeds; the outcome is reported in a null-when-silent `pin_mint` result field (minted entries, unresolved entries with reasons, per-entry `committed` flag).
- **R3 — No schema change.** `describes` stays `string[]`; enrichment happens pre-validation/serialization inside the write path so the pinned entry lands in the source `.md`.
- **R4 — `repin` staged action.** A new staged-action type `repin` targeting one vault doc, proposing to rewrite its intact-via-relocation pins to their current `#Lx-y@<sha12>`. Stage-time fail-fast: staging errors when the doc currently has no relocated pin. Per-doc batching.
- **R5 — Manual ratify; fresh recompute at dispatch.** `repin` applies only via `vault_ratify` approve. Dispatch re-classifies against the current working tree, rewrites only the matching entries in the doc's current `describes`, and lands through `vaultWrite` (locks, tier guard, commit, provenance, index inherited). No relocated pins at dispatch time → error, action stays pending.
- **R6 — Read-path surfacing.** When `vault_read`'s anchors annotation contains ≥1 relocated entry, it includes a `repin_hint` naming the ready-made `vault_stage_action` call. The read path itself never stages or writes.
- **R7 — Invariants preserved.** Read path stays read-only; pins never block writes; code repos are never mutated (no `hash-object -w`, nothing written outside the vault); `anchors: null` indistinguishability and all RBAC gates unchanged.
- **R8 — Auto-stage proposer.** The `daftari sleep` circadian cycle stages one `repin` proposal per doc that currently has ≥1 relocated pin, under principal `agent:sleep-repin`. Idempotent across runs: a doc with a **pending** `repin` is skipped (no duplicate proposal, no inter-proposal tension from the proposer itself); non-pending history (ratified/rejected/expired) never blocks a fresh proposal. Gated by `auto_repin` (default `true`) and `jit_anchors`; empty `code_repos` ⇒ no-op. The proposer only stages — it never ratifies, never writes a doc, never fails the cycle.

## Scope boundaries — NON-goals

- **`::symbol` resolution** — stays carried-but-unresolved (audit v1 posture). Line ranges are the precision instrument.
- **Remote-repo support** — `code_repos` values remain local checkouts; no network, ever, on this path.
- **Storing or indexing code** — daftari holds beliefs about code, never a second copy of it (verdict section A, REJECT).
- **Auto-apply** — `repin` lands only through human `vault_ratify` approve; no config bypasses that gate. (Auto-*staging* is in scope — U7/D4. Applying is not.)
- **Minting in `vault_append` / `vault_merge`** — deferred; `vaultWrite` covers the create/update/ratify paths that matter first.
- **Lint finding for an un-mintable shaless tail** — the existing `malformed_pin` lint (`src/curation/lint.ts:451-459`) only fires on `@sha` pins; extending it is follow-up work.

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `src/tools/pin-mint.ts` | shaless-tail parse + mint (one entry array in, enriched array + report out) | **Create** |
| `src/tools/write.ts` | `vaultWrite` mint call site + `pin_mint` result field | Modify |
| `src/tools/repin.ts` | compute current relocated pins → replacement entries for one doc | **Create** |
| `src/curation/staged-actions.ts` | `STAGED_ACTION_TYPES` + `"repin"` | Modify |
| `src/tools/staged-actions.ts` | stage-time `repin` validation/fail-fast; ratify `repin` dispatch case; tool descriptions | Modify |
| `src/tools/read.ts` | `repin_hint` on `ReadAnchors` | Modify |
| `src/sleep/cycle.ts` | U7 proposer pass inside `runSleepCycle` + `repin` result surface | Modify |
| `src/sleep/report.ts` | Morning Report section for auto-staged repins | Modify |
| `src/utils/config.ts` | `auto_repin` key (boolean, default `true`) beside `jit_anchors` | Modify |
| `test/tools/pin-mint.test.ts`, `test/tools/repin.test.ts` | unit tests for the new modules | **Create** |
| `test/tools/write.test.ts`, `test/tools/staged-actions.test.ts`, `test/tools/read.test.ts`, sleep-cycle tests | integration scenarios | Modify |

New logic lives in `pin-mint.ts` / `repin.ts` rather than inside `write.ts`/`staged-actions.ts`: independently testable against a temp git repo, and the tool files stay orchestrators (the `anchors.ts` precedent).

## Implementation Units

### U1. Mint module: shaless-tail parse + sha attach

- **Goal:** `mintDescribesPins(vaultRoot, entries: string[]) → Promise<MintOutcome>` — returns the (possibly) enriched entry array plus a report; pure with respect to the vault (touches only the configured code repos, read-only).
- **Requirements:** R1, R2, R7.
- **Dependencies:** none.
- **Files:** `src/tools/pin-mint.ts` (create); test `test/tools/pin-mint.test.ts` (create).
- **Approach:**
  1. Own end-anchored tail regex `#L(\d+)(?:-(\d+))?$` applied **only after** `parseDescribesEntry(raw, "")` confirms no real pin (`pin`/`malformedPin` absent) — `PIN_SUFFIX` is sha-strict, so the two grammars cannot overlap. Do NOT modify `parseDescribesEntry`: changing what `path` means for a shaless tail would ripple into audit missing-file semantics for entries that never get minted.
  2. Resolve `repo` via `loadConfig().codeRepos` (`""` sentinel for bare-prefix = the vault itself, never a code repo — skip, matching `read.ts:493-497`). Honor `jitAnchors === false` → no-op.
  3. Mintable entry: `hashObjectFile(repoRoot, path)` (`git.ts:71`), take a 12-hex prefix, rewrite the entry to `<head>#L<start>-<end>@<sha12>` (single-line `#L40` normalizes to `#L40-40`, matching parse semantics `describes.ts:47`). Then `git cat-file -e <sha>` (new one-line helper `blobExists` in `git.ts`, same `execFile` pattern) → per-entry `committed` flag.
  4. `end < start`, zero/negative line numbers, or git failure → entry left byte-identical, pushed to `unresolved` with a reason string. The function never returns `err` — mint is advisory enrichment (R2).
  5. `MintOutcome = { entries: string[], minted: {entry, pinned, committed}[], unresolved: {entry, reason}[] }`; when nothing was mintable, `minted`/`unresolved` are empty and `entries` is the input array unchanged.
- **Test scenarios:**
  - Happy: `repo:src/a.ts#L10-20` with mapped repo + committed file → entry becomes `repo:src/a.ts#L10-20@<12hex>`; classifier (`classifyPin`) reports `intact` for the minted pin; `committed: true`.
  - Happy: single-line `repo:src/a.ts#L10` → `#L10-10@<sha12>`.
  - Edge (uncommitted): file modified but not committed → mint succeeds against working-tree bytes, `committed: false`; classifier still `intact` (prefix match vs. same working tree).
  - Edge (no mapping): `ghost:src/a.ts#L10-20` with `ghost` absent from `code_repos` → entry byte-identical, one `unresolved` with a "no configured repo" reason.
  - Edge (bare + already-pinned pass-through): `repo:src/a.ts` and `repo:src/a.ts#L10-20@abc1234` → both untouched, absent from `minted`/`unresolved`.
  - Edge (kill-switch): `jit_anchors: false` → all entries untouched, empty report.
  - Error (malformed range): `repo:src/a.ts#L20-10` → untouched + `unresolved` (inverted range); `repo:missing.ts#L1-5` (path absent from repo) → untouched + `unresolved` (git failure surfaced as reason).
  - Error (repo path configured but checkout absent on this machine) → untouched + `unresolved`, no throw.
- **Patterns to follow:** `computeAnchors`' candidate filter (`read.ts:493-497`); `Result`-free advisory posture of `computeDecay`; temp-repo fixtures from `test/tools/anchors.test.ts`.
- **Verification:** every scenario green on a real temp git repo; the module performs zero writes anywhere (assert repo + vault mtimes unchanged).

### U2. `vaultWrite` integration + `pin_mint` result field

- **Goal:** Wire U1 into the write path and report the outcome.
- **Requirements:** R1, R2, R3.
- **Dependencies:** U1.
- **Files:** `src/tools/write.ts` (call site after the #113 merge `:996-1004` and the config load `:1029`, before `validateFrontmatter` `:1065`; `WriteResult` `:300+`; `vault_write` tool description `:2426+`); test `test/tools/write.test.ts`.
- **Approach:**
  1. When `rawFrontmatter.describes` is a non-empty array, call `mintDescribesPins`; write `outcome.entries` back into `rawFrontmatter.describes` so validation, hooks, and serialization all see the pinned values and the enriched entry lands in the `.md` (R3, `:1138-1143`).
  2. Add optional `pin_mint?: { minted: …, unresolved: … }` to `WriteResult` — present only when at least one entry was mintable (null-when-silent; `supersede_hint`/`domain_warnings` precedent). Extend the tool's output schema and one sentence in the input-schema `describes`-relevant description.
  3. Propose-only path (`:866-945`): no minting at stage time — the raw payload is staged verbatim and minting happens when ratify dispatches back through `vaultWrite`. One code comment stating this; no code change.
- **Test scenarios:**
  - Happy integration: `vault_write` a doc with one shaless entry (mapped repo) → on-disk `.md` frontmatter carries `@<sha12>`; result `pin_mint.minted` names it; a follow-up `vault_read` shows `anchors` with `intact`.
  - Edge: mixed array (bare + shaless-mintable + shaless-unmappable + already-pinned) → exactly one minted, one unresolved, two untouched; array order preserved.
  - Edge: no `describes` / all-bare `describes` → `pin_mint` absent from the result entirely.
  - Edge: update path — existing doc with pinned entries, payload re-sends them plus one new shaless entry → old pins byte-identical, new one minted (no re-minting of existing pins).
  - Error: mint helper throwing (simulated) must not fail the write — write lands with entries as written (best-effort wrap).
  - Integration (staged write): propose-only role writes a shaless entry → staged verbatim; ratify approve → landed doc is pinned (mint ran at dispatch).
- **Patterns to follow:** `supersede_hint` assembly and its output-schema entry; best-effort wrapping in `computeAnchors` (`read.ts:388-394`).
- **Verification:** on-disk file, result field, and read-back annotation all agree; a mint failure never fails or blocks a write.

### U3. Re-pin computation module

- **Goal:** `computeRepin(vaultRoot, docRelPath) → Promise<Result<RepinPlan, Error>>` — classify the doc's pinned entries now and return the replacement list for currently-relocated pins.
- **Requirements:** R4, R5.
- **Dependencies:** none (consumes existing `classifyPin`).
- **Files:** `src/tools/repin.ts` (create); test `test/tools/repin.test.ts` (create).
- **Approach:**
  1. Read + parse the doc; iterate pinned `describes` entries whose repo resolves in `codeRepos` (same candidate filter + 24-cap as `computeAnchors`, `read.ts:495-501`).
  2. For each entry classified `{ state: "intact", relocated }` (`anchors.ts:73-75`): build the replacement raw string `<head>#L<newStart>-<newEnd>@<sha12(hashObjectFile now)>`, preserving any `repo:`/`::symbol` head verbatim.
  3. `intact` without `relocated` (nothing to do), `moved` (block gone — nothing to propose), `missing`, and classifier-null entries are all skipped; `RepinPlan = { replacements: {old, new}[], skipped: {entry, state}[] }`.
  4. Errors (`err`) only for doc-level failures (unreadable doc, config load failure) — per-entry problems degrade to `skipped`.
- **Test scenarios:**
  - Happy (moved-block re-pin): commit file, pin `#L5-8@sha`, insert 10 lines above, commit → one replacement with `#L15-18@<new sha12>`; applying it and re-classifying yields plain `intact` (no `relocated`).
  - Edge (missing-block no-op): pinned block deleted (`moved` classification) → zero replacements, entry in `skipped` with state `moved`.
  - Edge: file deleted (`missing`) → skipped, state `missing`.
  - Edge: all pins plain-intact → empty replacements (feeds U4's stage-time fail-fast).
  - Edge: unmapped repo / unpinned entries → not candidates, absent from both lists.
  - Error: doc path unreadable → `err`, no partial plan.
- **Patterns to follow:** `computeAnchors` structure; sha12 + head-preservation rules from U1 (extract the shared `formatPin(head, start, end, sha)` helper into `pin-mint.ts` and import — do not duplicate).
- **Verification:** replacement round-trip (apply → reclassify → plain `intact`) proven on a real temp repo.

### U4. `repin` staged-action type: enum + producer validation

- **Goal:** Make `repin` a first-class member of the staged-action grammar with stage-time fail-fast.
- **Requirements:** R4, R7.
- **Dependencies:** U3.
- **Files:** `src/curation/staged-actions.ts` (`STAGED_ACTION_TYPES` `:49-57` — append, do not insert); `src/tools/staged-actions.ts` (`vaultStageAction` type-specific validation next to the `write` shape check `:104-122`, the not-found fail-fast `:157-165`, and the `vault_stage_action` description/`proposed_diff` doc `:728-767`); tests `test/tools/staged-actions.test.ts`, `test/curation/staged-actions.test.ts`.
- **Approach:**
  1. Append `"repin"` to `STAGED_ACTION_TYPES`. The jsonl log, collapse, conflict check, TTL sweep, lint pending list, and sqlite mirror are all type-agnostic — [DATA] no other change in `curation/staged-actions.ts` is needed.
  2. In `vaultStageAction`, for `repin`: `proposed_diff` may be `{}` or carry an optional advisory `replacements` array (shape-checked if present). After the existing RBAC gate and target-exists check, run `computeRepin`; zero replacements → `err("nothing to re-pin: no pin on <path> is currently relocated")` — the doomed-proposal fail-fast precedent (`:157-165`). When staging proceeds, stamp the computed replacements into `proposed_diff.replacements` so the ratifier's elicitation shows the concrete old→new (display only; R5's dispatch recompute is authoritative).
  3. Extend the tool description's `proposed_diff` catalog with the `repin` line.
- **Test scenarios:**
  - Happy: doc with one relocated pin → stages; the recorded `proposed_diff.replacements` names old→new; result carries id/expiry.
  - Edge (fail-fast): doc with only plain-intact pins → stage errors, queue untouched.
  - Edge: doc with no pins at all / target doc absent → stage errors (fail-fast; the existing not-found branch for the latter).
  - Edge: conflict — a pending `supersede` already targets the doc → repin still stages, `conflicts_with` + inter-proposal tension fire (existing generic machinery, one assertion).
  - Error (RBAC): read-only role staging repin → denied by the existing write gate (`:143-155`), one assertion.
  - Error (malformed input): `proposed_diff.replacements` present but not an array of `{old,new}` strings → stage errors naming the field.
- **Patterns to follow:** the `write`-type stage-time payload validation (`:104-122`); append-not-insert enum convention.
- **Verification:** `repin` proposals live in the queue, survive collapse/reindex, appear in lint's pending list with no further changes.

### U5. `repin` ratify dispatch

- **Goal:** On approve, recompute fresh and land the rewrite through `vaultWrite`; on any mismatch, error and stay pending.
- **Requirements:** R5, R7.
- **Dependencies:** U3, U4.
- **Files:** `src/tools/staged-actions.ts` (new `case "repin"` in the dispatch switch `:529-644`; `vault_ratify` description `:790-807`); test `test/tools/staged-actions.test.ts`.
- **Approach:**
  1. `computeRepin(vaultRoot, action.targetPath)` at dispatch time. Zero replacements → `err` ("nothing is currently relocated — reject this action"); action stays pending (the standard dispatch-failure contract).
  2. Read the doc's **current** `describes`, replace each entry that exactly matches a `replacement.old`… note: recompute derives `old` from the current doc itself, so match-by-construction; entries not in the plan are untouched; array order preserved.
  3. Dispatch through `vaultWrite` with `{ path, frontmatter: { describes: newArray }, body: <current body>, agent: principal, run_id }` — #113 merge preserves all other frontmatter; locks, tier guard, RBAC, auto-commit, provenance, and index refresh are inherited. (Body is re-sent unchanged; `vaultWrite` has no frontmatter-only mode — [DATA] every dispatch case sends full payloads.)
  4. No tier-0 gate: repin never changes `status`, so the promote/deprecate gates don't apply (matches the `supersede`/`confidence-up` cases, which are also ungated).
  5. Shadow mode: inherited — `vaultWrite` returns `shadow: true` and the action stays pending (existing `:652-654` handling, zero new code; one test).
- **Test scenarios:**
  - Happy: stage repin, ratify approve → doc's pin rewritten to the new range+sha, auto-commit present, provenance line recorded, action `ratified`; re-read shows `anchors` plain-`intact` and no `repin_hint`.
  - Edge (drift between stage and ratify): after staging, code moves *again* → approve applies the freshest range (not the staged one); assert the landed pin matches a classify-at-assert-time recompute.
  - Edge (stale proposal): after staging, the pin is hand-fixed (or code moved back) so nothing is relocated → approve errors, action stays pending; reject works normally.
  - Edge (missing-block at dispatch): pinned block deleted after staging → approve errors (skipped as `moved`, zero replacements), stays pending.
  - Edge (shadow mode): approve under `shadow_mode` → nothing written, `shadow: true`, action pending.
  - Error (RBAC): ratifier role lacking write on the collection → inner `vaultWrite` denies; action stays pending.
- **Patterns to follow:** the `supersede` dispatch case (`:571-589`) for shape; error copy tone from the tier-0 gate messages ("… the action stays pending").
- **Verification:** full stage→ratify→re-read loop green; a repin can never wholesale-replace `describes` (assert untouched sibling entries byte-identical).

### U6. Read-path `repin_hint`

- **Goal:** Close the loop for reading agents: when relocation is detected, say exactly how to stage the fix.
- **Requirements:** R6, R7.
- **Dependencies:** U4 (the hint names a real action type).
- **Files:** `src/tools/read.ts` (`ReadAnchors` `:196-201`, banner assembly `:519-524`, output schema for `vault_read`); test `test/tools/read.test.ts`.
- **Approach:**
  1. Add optional `repin_hint?: string` to `ReadAnchors`, set only when ≥1 entry carries `relocated`: one sentence naming the count and the call — e.g. `N pin(s) have relocated — stage a fix with vault_stage_action { action_type: "repin", target_path: "<doc>" }`. (Exact copy: Deferred to Implementation.)
  2. No staging, no writes, no new git work from the read path — the hint is derived entirely from the already-computed entries (R7).
- **Test scenarios:**
  - Happy: doc with a relocated pin → `repin_hint` present, names the doc's vault-relative path.
  - Edge: all pins plain-intact / `moved`-only / `missing`-only → no hint (relocation is the only machine-fixable state).
  - Edge: `anchors: null` cases (no pins, unmapped repo, kill-switch) → unchanged, no hint field anywhere.
  - Integration: hint's suggested call, executed verbatim against the same vault, stages successfully (U4).
- **Patterns to follow:** the drift-banner conditional (`:519-524`); null-when-silent contract.
- **Verification:** hint appears exactly when a repin would stage successfully, and never otherwise.

### U7. Auto-stage proposer in the sleep cycle

- **Goal:** Each `daftari sleep` circadian pass stages a `repin` proposal for every doc with a currently-relocated pin — idempotently, under the system principal `agent:sleep-repin` — so relocations reach the ratification queue without waiting for a reading agent; humans still decide at ratify.
- **Requirements:** R8, R7.
- **Dependencies:** U3 (detector: `computeRepin`), U4 (producer: `vaultStageAction` + stage-time validation).
- **Files:** `src/utils/config.ts` (`autoRepin` field beside `jitAnchors` `:264-269`, default `:293-294`, parse beside the `jit_anchors` branch `:1199-1205`); `src/sleep/cycle.ts` (proposer pass inside `runSleepCycle` `:74`, `SleepCycleResult` `:50-72`); `src/sleep/report.ts` (Morning Report section); tests: sleep-cycle test file (extend; create beside the existing sleep tests if absent), `test/utils/config.test.ts`.
- **Approach:**
  1. Config: add `auto_repin` (boolean, default `true`) — same parse shape as `jit_anchors` (`config.ts:1199-1205`), surfaced as `cfg.autoRepin`.
  2. In `runSleepCycle`, after the sweep (`cycle.ts:80`) and the `loadDocuments` call (`:83`): when `autoRepin && jitAnchors && Object.keys(codeRepos).length > 0`, run the proposer; otherwise skip the pass entirely (D4 kill-switch — the no-op leaves the cycle byte-identical to today).
  3. Candidate filter (scope cap, D4): from the docs the cycle already loaded, keep only those whose frontmatter `describes` has ≥1 entry that `parseDescribesEntry` reads as a real `@sha` pin with a repo mapped in `codeRepos` (the `computeAnchors` filter, `read.ts:493-497`). No second vault scan; non-candidates cost one frontmatter check inside the existing loop's data.
  4. Dedup (R8, the load-bearing contract): snapshot the queue once via `listStagedActions` (`curation/staged-actions.ts:270`) and build the set of `target_path`s with a **pending** `repin`; skip those docs. [DATA] This check is mandatory because `stageActionWithConflictCheck` deliberately re-stages duplicates and tension-logs them (`:404-428`) — without it, every nightly run would add a duplicate pending action plus an `inter-proposal` tension per relocated doc. Non-pending statuses (ratified/rejected/expired) do not block. Reorder the cycle's existing `listStagedActions` usage (`:184`) so the ratification report reflects the post-staging queue: sweep → pending snapshot → stage → re-list for the report.
  5. For each remaining candidate: `computeRepin` (U3); zero replacements → silent skip (nothing relocated — no queue noise, unlike U4's caller-facing fail-fast). Else stage via the U4 producer `vaultStageAction` with `access` undefined (operator CLI ⇒ unrestricted, the tension-scan posture `sleep/index.ts:290-302`; gate conditional at `tools/staged-actions.ts:143`), `proposed_by: "agent:sleep-repin"` (D4 identity), and a rationale naming the old→new ranges; U4 recomputes and stamps `proposed_diff.replacements` (accepted double-compute — detector-first keeps doomed calls out of the producer).
  6. Per-doc failures (unreadable doc, git error, producer `err`) degrade to an `errors` entry in the result — the proposer never fails the cycle (advisory posture, R8). Extend `SleepCycleResult` with `repin: { staged: {path, actionId}[], skippedPending: number, errors: {path, reason}[] }` (present only when the pass ran) and render one Morning Report section listing what was staged for ratification (`report.ts`).
- **Test scenarios:**
  - Happy: vault doc pins a temp-repo block; relocate the block (insert lines above, commit); run `runSleepCycle` → exactly one pending `repin` on the doc with `proposed_by === "agent:sleep-repin"`, `proposed_diff.replacements` naming old→new; result `repin.staged` lists it; ratifying it applies (U5, one integration assertion).
  - Edge (idempotent re-run): run the cycle twice on an unchanged vault → second run stages nothing, logs zero inter-proposal tensions, result shows `skippedPending: 1`.
  - Edge (pending already): a human-staged pending `repin` on the doc before the cycle → proposer skips it, no duplicate, no tension.
  - Edge (non-pending history): a *rejected* `repin` on the doc, pin still relocated → proposer stages a fresh proposal (history never blocks).
  - Edge (kill-switches): `auto_repin: false` → pass skipped, no `repin` field in the result; `jit_anchors: false` likewise; empty `code_repos` likewise — cycle output byte-identical to pre-U7 in all three.
  - Edge (nothing relocated): candidates exist but all pins plain-intact → zero proposals, `repin.staged` empty, queue untouched.
  - Error (per-doc degrade): one candidate doc unreadable mid-pass → it lands in `repin.errors`, every other candidate still stages, cycle returns `ok`.
- **Patterns to follow:** the sweep's housekeeping-first placement and error posture (`cycle.ts:78-81`); `agent:sleep-tension-scan` attribution (`config.ts:176`); the `computeAnchors` candidate filter (`read.ts:493-497`); `SleepCycleResult` sectioning + `renderMarkdown` section style (`report.ts`).
- **Verification:** two consecutive `daftari sleep` runs on an unchanged vault with one relocated pin produce exactly ONE pending `repin` and ZERO inter-proposal tensions (the dedup contract, asserted on the raw queue); with `auto_repin: false` the cycle result deep-equals the pre-U7 shape.

## Sequencing

U1 and U3 are independent (U3 wants U1's shared `formatPin` helper — build U1 first or extract the helper when U3 goes red). Order: **U1 → U2 → U3 → U4 → U5 → U6 → U7**. U2 and U3 are parallelizable after U1; U7 depends only on U3 + U4, so it is parallelizable with U5/U6 (its ratify-integration assertion needs U5 last).

## Deferred to Implementation

- Exact `pin_mint` / `RepinPlan` field names and the `repin_hint` copy string — settle against the neighboring shapes when tests are red.
- Whether `blobExists` (`cat-file -e`) is worth a helper vs. reading `catFileBlob(...).ok` — decide in U1 (the latter fetches content unnecessarily but adds no code).
- Where exactly the U2 call sits relative to the pre-write transform hooks (`write.ts:1041-1050`) — before them, so a hook sees final entries; confirm no hook in the wild rewrites `describes` (none in-repo).
- Whether U5 needs `base_version` optimistic-concurrency on its inner `vaultWrite` — the write lock may suffice; decide when the drift test is red.
- U7: exact `repin` result-field names in `SleepCycleResult` and the Morning Report copy — settle against `report.ts`'s section style when tests are red.

## Deferred to Follow-Up Work

- Minting in `vault_append` / `vault_merge`.
- `malformed_pin` lint extension for un-mintable shaless tails (inverted range).
- Symbol (`::symbol`) resolution; remote-repo support (explicit NON-goals above).

## Risks

- **Reinterpretation of `#L` tails (U1):** any vault that today has a *literal* file path ending `#L<digits>` would start being minted. [HYPOTHESIS] no real vault has one (the mavaali-vault has zero non-empty `describes`); kill condition: a corpus grep at implementation time finds a genuine colliding path — then gate minting behind an explicit config flag instead.
- **Exact-substring relocation false positives (U3/U5):** a duplicated block can relocate-match the wrong copy. Mitigated by the human ratify gate and by `relocated` picking the first match deterministically — but the ratifier sees old→new lines and can reject. Not auto-apply for exactly this reason.
- **Dirty-tree pins (U1/D2):** a pin minted from uncommitted bytes survives the intact check but cannot relocation-search after further edits until the blob is committed. Reported per entry (`committed: false`); documented, not prevented.
- **Proposer queue pressure (U7):** on a vault with many relocated pins, the first auto-run stages one proposal per doc at once. Bounded by per-doc batching (one action per doc, D3) and the 14-day TTL sweep; the dedup contract caps steady-state at one pending `repin` per doc. If the first Morning Report shows an unratifiable pile, drop `auto_repin` to `false` — the kill-switch exists for exactly this.
