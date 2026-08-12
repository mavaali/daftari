# JIT Anchor Pin Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan Implementation-Unit by Implementation-Unit. The execution skill owns the per-unit test-first (RED/GREEN/REFACTOR) cycle.

**Readiness:** implementation-ready
**Goal:** At `vault_read`, verify pinned `describes` bindings against the local code tree via git plumbing and attach an advisory `anchors` annotation (intact / moved / missing) — the retrieval-time citation re-check.
**Architecture:** Extend the `describes` grammar with an optional pin suffix; on read, resolve each pinned binding's repo via config, classify the pin with local git only (no network, no LLM), and attach a null-when-silent annotation matching the existing `decay`/`structural` idiom. Advisory always — never mutates state.
**Tech Stack:** TypeScript (Node), vitest, git via `execFile` (`src/utils/git.ts` pattern).
**Source spec:** `docs/superpowers/specs/2026-07-26-citation-anchors-jit-verification-design.md`
**Tracking:** bead `mavaali-beads-xjo`.

---

## Requirements (R-IDs, from the source spec's decisions)

- **R1 — Pin grammar.** A `describes` entry may carry an optional pin suffix `[#L<start>[-<end>]]@<sha>` (`<sha>` = 7–40 hex of a git *blob* id). Backward compatible: bare and `::symbol` forms parse byte-identically; a malformed pin degrades to a bare binding, never a rejected write. (Spec Decision 1.)
- **R2 — Read-path JIT check.** When `vault_read` returns a doc with pinned bindings AND the binding's repo prefix resolves to a locally-present code repo, classify each pin against the working tree using git plumbing only — no network, no LLM — and attach a structured `anchors` annotation. Silence-on-failure: any git error degrades that entry to absent; the read never fails on the check. (Spec Decision 2.)
- **R3 — Advisory only.** A `moved`/`missing` pin never auto-invalidates, demotes, filters, or rewrites the doc. Report only — the curation house rule. (Spec Decision 3.)
- **R4 — Intact-pin freshness (annotate-only).** A doc past `ttl_days` whose pins are all intact gets *softened* decay copy (appended, not replaced). Decay scores/buckets/`vault_status` stay byte-identical with and without pins — no clock manipulation. (Spec Decision 4.)
- **R5 — Repo resolution + kill-switch.** `.daftari/config.yaml` gains `code_repos:` (name→path, `~`/relative expanded, existence NOT checked at load) and `jit_anchors:` (bool, default true; false disables the whole code path). Shape validated fail-loud at load like other blocks. (Spec Decision 2, config.)
- **R6 — malformed_pin lint finding.** A malformed pin suffix surfaces as an advisory `malformed_pin` lint finding, never a write rejection. (Spec Decision 1.)

## Scope Boundaries

**In scope:** R1–R6 — the read-time verification path and its config, plus the two lint touchpoints (malformed_pin, softened copy).

### NOT in scope (deferred to follow-up work)
- **`daftari audit --pin` / `--pin --apply` backfill** (spec Decision 5) — the pin *writing/backfill* mechanism. The audit CLI (`runAudit`, `src/audit/index.ts:103+`) has no `--pin` flag today (verified — no matches; `:66-101` is the `HELP` constant); that's a separate feature. Pins are still writable now via ordinary `vault_write` frontmatter. — *rationale: writing path is independent of the read-time check; ship the signal first.*
- **Lint-side softened decay copy** (spec Decision 4, lint half) — descoped from U7 (review #2). `lint.ts` has no `describes` parsing or code-repo classifier, so softening lint copy needs lint to invoke the U4 classifier + resolve `code_repos` per doc — a real addition. U7 ships the read-path softening only; lint softening follows once the classifier is proven on the read path. — *rationale: avoid an architectural gap in an MVP; the read-path is where the signal is consumed at point-of-use anyway.*
- **Batch audit pin classifier + moved-first `--max-semantic` ordering** (spec Decision 3, batch half) — the batch audit already checks `describes`; adding the pin classifier there is a follow-up. — *rationale: the read-path is the novel, unbuilt piece; batch is enhancement.*
- **LLM semantic drift on the read path** — read-time stays git-plumbing only by design (spec Out of Scope).
- **Symbol (`::symbol`) resolution** — carried-but-unresolved (audit v1 posture); the pin range is the precision instrument.
- **Pin auto-repair** — refreshing a `moved` pin is an authoring act, never automated.

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `src/audit/describes.ts` | `describes` binding grammar/parse | Modify — pin-suffix parse + extend `ParsedDescribes` |
| `src/utils/git.ts` | git execFile helpers | Modify — add `hashObjectFile`, `catFileBlob` (optional `lsTreeEntry`) |
| `src/utils/config.ts` | `.daftari/config.yaml` load + validate | Modify — `code_repos` + `jit_anchors` block |
| `src/tools/anchors.ts` | pin classifier (intact/moved/missing) | **Create** — one responsibility: classify one pinned binding |
| `src/tools/read.ts` | `vault_read` result + annotation assembly | Modify — `anchors` field + assembly + best-effort wrap |
| `src/curation/lint.ts` (+ `tier0`/decay copy) | lint checks & decay banner | Modify — `malformed_pin` finding + softened intact-pin copy |

New classifier lives in its own module (`anchors.ts`) rather than inside `read.ts`: it's independently testable, and `read.ts` should orchestrate, not own git-classification logic.

## Implementation Units

### U1. Pin-suffix grammar on `describes`

- **Goal:** Parse an optional `[#L<start>[-<end>]]@<sha>` suffix on a `describes` entry, backward compatible.
- **Requirements:** R1, R6.
- **Dependencies:** none.
- **Files:** `src/audit/describes.ts` (parser at `:20-34`, `ParsedDescribes` type at `:9-13`); test `test/audit/describes.test.ts`.
- **Approach:**
  1. Extend `ParsedDescribes` with optional `pin: { sha: string; start: number | null; end: number | null }`.
  2. In `parseDescribesEntry`, apply the end-anchored pin regex `(?:#L\d+(?:-\d+)?)?@[0-9a-f]{7,40}$` BEFORE the `::`/`:` splits; strip a matched pin, parse the remainder with the existing logic untouched, then attach the pin.
  3. A non-matching suffix is treated as a bare binding (byte-identical to today). Signal a *malformed* pin (a `@`-suffixed entry whose sha isn't 7–40 hex, or `end < start`) via a distinguishable parse result the lint check (U6) reads — do not throw, do not reject.
- **Test scenarios:**
  - Happy: `api:src/retry.ts#L40-58@9f3c2ab` → repo `api`, path `src/retry.ts`, pin {40,58,`9f3c2ab`}.
  - Happy: `api:src/retry.ts@9f3c2ab` (whole-file pin) → pin {null,null,sha}.
  - Happy: bare `#L40` single line → {40,40} (per spec `:52-53`; end defaults to start so U4's slice is a total function — review #8).
  - Edge: bare `api:src/retry.ts` (no pin) → parses byte-identically to today, `pin` undefined.
  - Edge: `::symbol` + pin → `api:src/retry.ts::withRetry#L40-58@9f3c2ab` → symbol carried, pin attached.
  - Edge: path legitimately containing `@`/`#` mid-string, no trailing pin → unaffected (end-anchored).
  - Error: malformed sha (`@zzz`) or `end < start` → bare binding + malformed-pin signal, no throw.
- **Patterns to follow:** existing `parseDescribesEntry` split order; `DescribesEdge.raw` already preserves the original entry (`:49-56`) — keep `raw` intact for U6/U4 traceability.
- **Verification:** all describes tests pass; a pinned entry round-trips; a malformed pin never throws.

### U2. Config: `code_repos` + `jit_anchors`

- **Goal:** Load and fail-loud-validate the two new config keys.
- **Requirements:** R5.
- **Dependencies:** none.
- **Files:** `src/utils/config.ts` (`loadConfigUncached`, `emptyConfig`, a new `validateCodeRepos`); test alongside existing config validation tests.
- **Approach:**
  1. Add `codeRepos: Record<string,string>` and `jitAnchors: boolean` to `DaftariConfig`; defaults `{}` / `true` in `emptyConfig`.
  2. `validateCodeRepos`: mapping of name→string path; expand paths by **reusing the existing `expandTilde` helper (`config.ts:945`) and the vault-relative `resolve(vaultAbs, expandTilde(raw))` pattern (`:965`)** — do not hand-roll expansion (review #4). **Do not check existence at load** (a synced vault may lack the checkout — spec Decision 2; note `src/audit/config.ts:78`'s `validateRepoPath` DOES check existence — deliberately NOT mirrored here). Non-object or non-string value → fail-loud error naming the key.
  3. `jit_anchors` must be boolean if present, else fail-loud; absent → true.
- **Test scenarios:**
  - Happy: `code_repos: {api: ../code/api}` → resolves to vault-relative absolute path.
  - Happy: `jit_anchors: false` → `jitAnchors === false`.
  - Edge: both absent → `{}` and `true`.
  - Edge: `~/x` expands to homedir; absolute path passes through.
  - Error: `code_repos: [..]` (array) or `code_repos.api: 5` (non-string) → fail-loud with the key named.
  - Error: `jit_anchors: "yes"` → fail-loud.
  - Edge: a configured path that doesn't exist on disk → loads WITHOUT error (existence deferred to read path).
- **Patterns to follow:** the `embeddings` block validation (`~:1206-1229`) and sibling `validate*` helpers.
- **Verification:** config loads with new keys; malformed shapes fail loud; missing checkout does not.

### U3. Git helpers: `hashObjectFile`, `catFileBlob`

- **Goal:** Add the two git plumbing calls the classifier needs (optional `lsTreeEntry` only if U4 proves it needed).
- **Requirements:** R2 (enabling).
- **Dependencies:** none.
- **Files:** `src/utils/git.ts`; test `test/utils/git.test.ts`.
- **Approach:**
  1. `hashObjectFile(repoRoot, path) → Result<string>` via `git -C <repoRoot> hash-object -- <path>`.
  2. `catFileBlob(repoRoot, sha) → Result<string>` via `git -C <repoRoot> cat-file blob <sha>`.
  3. Reuse the existing `execFile` no-shell pattern (`:41-56`); return `Result` (`.ok=false` on any failure), never throw.
- **Test scenarios:**
  - Happy: hash-object of a committed file returns a stable sha; `catFileBlob` of that sha returns exact content.
  - Edge: `hashObjectFile` of a path absent from the tree → `.ok=false` (feeds `missing`).
  - Edge: `catFileBlob` of a sha not in the odb → `.ok=false` (feeds `moved`).
  - Edge: prefix-match — pin sha is a 7-char prefix of the 40-char current blob id (classifier's prefix rule; helper returns full sha, comparison is the classifier's job).
  - Edge (review #9): `hashObjectFile` on a modified-but-uncommitted working-tree file returns the *working-tree* blob hash, not HEAD's — the `intact` path (Decision 2 step 2) hashes the current file, which may be dirty.
- **Patterns to follow:** `fileGitMeta`/`log` execFile helpers; temp-vault test setup via `test/helpers/temp-vault.js`.
- **Verification:** helpers return correct shas/content on a real temp repo; failures are `.ok=false`, not throws.

### U4. Pin classifier module

- **Goal:** Classify one pinned binding as `intact` | `moved` | `missing`, with `relocated` line numbers when found via content search.
- **Requirements:** R2, R3.
- **Dependencies:** U1, U3.
- **Files:** `src/tools/anchors.ts` (create); test `test/tools/anchors.test.ts` (create).
- **Approach (spec Decision 2 classification, git plumbing + one guarded read):**
  1. Target path absent → `missing`.
  2. `hashObjectFile` current blob; pin sha is a prefix of it → `intact` (unchanged).
  3. Blob differs AND pin has a range: `catFileBlob(pin.sha)`, slice lines `start..end` via `readTextFile` guarded read (`readtext.ts:35-73`), search current file for that exact text → found → `intact` + `relocated:{start,end}`; not found → `moved`.
  4. Otherwise (whole-file pin, differing blob, or blob git no longer has) → `moved`.
  - Every branch is a pure classification from git output; any helper `.ok=false` degrades the entry to absent for the caller to skip (U5 owns the best-effort wrap).
- **Test scenarios:**
  - Happy intact (unchanged blob): pin sha prefix-matches current → `intact`, no relocated.
  - Happy intact-via-relocation: content moved to new line range, exact text still present → `intact` + `relocated`.
  - Happy moved: pinned range text no longer present in current file → `moved`.
  - Edge missing: file deleted → `missing`.
  - Edge whole-file pin, blob changed → `moved`.
  - Edge: pinned blob absent from odb (never committed / gc'd) → `moved`.
  - Edge: guarded read rejects (file > size cap / binary) → degrade to absent (skip), never throw.
- **Patterns to follow:** `readtext.ts` guarded read; `Result` returns.
- **Verification:** each classification branch is covered on a real temp repo with a committed → mutated file.

### U5. Read-path `anchors` annotation

- **Goal:** Attach the `anchors` annotation to `vault_read`, null-when-silent, best-effort, capped.
- **Requirements:** R2, R3.
- **Dependencies:** U4, U2.
- **Files:** `src/tools/read.ts` (`VaultReadResult` at `:105-133`, assembly at `:256-274`, recordRead `:190-198`); test `test/tools/read.test.ts`.
- **Approach:**
  1. Add the `anchors` field (shape per spec `:157-170`) to `VaultReadResult`.
  2. **Wire config into the read path (review #1 — P0).** `read.ts` imports no config today and `vaultRead(...)` takes no config. Inside the best-effort block, call `loadConfig(vaultRoot)` (mtime-keyed cache, `config.ts:1011`, so per-read cost is negligible) and read `jitAnchors` / `codeRepos` from it. Do NOT change `vaultRead`'s signature — resolve config internally.
  3. After the existing annotation computations (`structural`/`contested`, ~`:203-254`), if `jitAnchors` is on: read `frontmatter.describes`, keep only pinned entries whose `repo` resolves in `codeRepos`, classify each via U4, cap at 24 (`checked`/`skipped` counts), build the `banner` (decay-banner idiom).
  4. Return `null` when: no pinned bindings, no resolvable repo, or `jit_anchors:false`.
  5. Wrap the whole block best-effort — any throw (including a config-load failure) is swallowed to `anchors:null`; the read never fails (recordRead contract, ~`:190-198`).
- **Test scenarios:**
  - Happy: doc with one intact + one moved pin, repo resolvable → annotation with both entries, correct states, `banner` set.
  - Positive disclosure (review #6): a resolvable repo with a `moved`/`missing` pin MUST produce a NON-null annotation naming that entry — the whole point of the signal.
  - Invariant (review #6): `checked + skipped === ` the pinned-binding count, and `skipped` is ONLY the over-cap remainder (guards a silent skipped under-count).
  - Edge null: doc with no pins → `anchors:null`.
  - Edge null: pinned binding but repo not in `code_repos` (or checkout absent) → `anchors:null` (indistinguishable from no-pins — the disclosure rule).
  - Edge kill-switch: `jit_anchors:false` → `anchors:null`, classifier never invoked.
  - Edge cap: 30 pinned bindings → `checked:24`, `skipped:6`.
  - Error best-effort: classifier OR `loadConfig` throws → `anchors:null`, read still returns ok.
  - Integration: read result shape matches the null-when-silent contract of `decay`/`structural`.
- **Patterns to follow:** the conditional-spread annotation assembly at `:256-274`; `contested` null-when-silent precedent.
- **Verification:** annotation appears only when warranted; kill-switch and best-effort both hold; read never throws on the check.

### U6. `malformed_pin` lint finding

- **Goal:** Surface a malformed pin as an advisory lint finding.
- **Requirements:** R1, R6.
- **Dependencies:** U1.
- **Files:** `src/curation/lint.ts`; test `test/curation/lint.test.ts`.
- **Approach (review #3 — lint has NO `describes` machinery today; this adds it from scratch, still one-pass-sized):**
  1. Import `parseDescribesEntry` (from U1) into `lint.ts`.
  2. Add `"malformed_pin"` to the `LINT_CHECKS` array **appended, not inserted** (`:59-60` convention) and to the `checks` record literal (`:251-264`).
  3. In the existing per-doc loop (`:290-302`), iterate `fm.describes` (if present), parse each entry, and on a malformed-pin signal push a `malformed_pin` finding `{path, detail}` naming the entry. Advisory, report-only.
- **Test scenarios:**
  - Happy: doc with a well-formed pin → no finding.
  - Error: doc with `@zzz` / `end<start` → one `malformed_pin` finding naming the entry.
  - Edge: doc with no `describes` → no finding.
  - Edge: `malformed_pin` appears in `LINT_CHECKS` order LAST (append convention) and totals roll up in `totalFindings`.
- **Patterns to follow:** existing `LintFinding` shape, the `checks` record literal, and the explicit "Appended, not inserted" comment at `:59-60`.
- **Verification:** malformed pins are reported, well-formed ones are silent; `LINT_CHECKS`/`checks` stay consistent.

### U7. Decision-4 softened decay copy — read-path only (annotate-only)

- **Goal:** When a doc is past TTL but all its pins are intact, soften the decay *copy* on the **read path** — without touching decay scores/buckets.
- **Requirements:** R4.
- **Dependencies:** U4, U5.
- **Files:** the read-path decay banner in `src/tools/read.ts`; test `test/tools/read.test.ts`.
- **Approach (review #2 — P0 scoping):** the lint-side softened copy is **descoped from this feature and deferred** (see Deferred to Follow-Up Work). Reason: `lint.ts` has no `describes` parsing and no code-repo classifier, so softening lint copy would require lint to invoke the U4 classifier + resolve `code_repos` per doc — a real architectural addition, not "append copy." U7 therefore softens only the read path, where the `anchors` result (U5) already exists. In the read-path decay banner, if the doc is past TTL AND the just-computed `anchors` shows all pins intact, append the softening clause ("past TTL, but its N code pins are intact…"). **Do not** alter `computeStaleness` output, decay score, bucket, or `vault_status` distribution — copy only.
- **Test scenarios:**
  - Happy: past-TTL doc, all pins intact → softened banner copy present; read-path decay score/bucket byte-identical to no-pins baseline.
  - Edge: past-TTL doc with a `moved` pin → NOT softened (some pin drifted).
  - Edge: past-TTL doc with no pins → banner unchanged (today's behavior).
  - Integration (review #7): assert the doc's `staleFiles` lint finding and its `detail` decay-score string are **byte-identical** with and without pins (lint is untouched by U7), and `vault_status` distribution identical — no clock manipulation anywhere.
- **Patterns to follow:** the read-path decay-banner idiom; the annotate-only invariant (this is the first place that must prove it doesn't mutate state).
- **Verification:** softened banner appears only for all-intact past-TTL docs; no decay/bucket/status/lint value changes.

## Sequencing

U1, U2, U3 are independent (parallelizable). U4 needs U1+U3. U5 needs U4+U2. U6 needs U1. U7 needs U4+U5. Suggested order: **U1 → U3 → U2 → U4 → U5 → U6 → U7** (U6 can slot in any time after U1).

## Deferred to Implementation
- Exact `ParsedDescribes` malformed-pin signalling shape (a `malformedPin: true` flag vs. a separate return) — decide when U1's tests are red; both U4 and U6 consume it.
- Whether `lsTreeEntry` is needed at all — U4 may be fully served by `hashObjectFile` + `catFileBlob`; add it only if a committed-vs-dirty distinction proves necessary.
- Exact `banner` copy string — settle against the existing decay-banner wording when U5 is wired.
- The pinned-line-slice search strategy (exact substring vs. trimmed) in U4 step 3 — tune against a real moved-code fixture.

## Deferred to Follow-Up Work
(see Scope Boundaries → NOT in scope: `--pin` backfill, batch pin classifier + moved-first ordering, LLM semantic drift, symbol resolution, pin auto-repair.)

## Risks
- **Perf (spec kill condition):** the check must add < ~50ms p95 to `vault_read` under the pin cap, or the default flips to `jit_anchors:false`. U5 verification should include a rough timing sanity check on a real vault.
- **Annotate-only invariant (U7):** the first curation signal near decay state — a test MUST assert byte-identical decay/bucket/status with and without pins, or freshness-laundering creeps in.
- **Disclosure:** `anchors:null` must be truly indistinguishable between "no pins" and "repo absent" (U5) so absence leaks nothing.
