---
title: "External git-dir for cloud-synced vaults — design"
date: 2026-06-19
status: draft
motivated_by: Obsidian adoption on an iCloud-hosted vault (PR #138)
---

# External git-dir for cloud-synced vaults

## Summary

Let Daftari keep a vault's `.git` data **outside** the vault directory, so a
cloud-synced vault (iCloud, Dropbox, OneDrive, Google Drive) can have full git
version history without the corruption risk of a `.git/` churning inside a
sync folder.

Mechanism: `git init --separate-git-dir=<external>`. This leaves only a tiny,
static `.git` *file* (`gitdir: <path>`) in the vault — which syncs harmlessly —
while all the objects/index/refs/HEAD live at `<external>` on local disk. Because
every Daftari git command already runs `git -C <vaultRoot> …` and git follows the
`.git` file, **only repo creation changes**; commit/log/history reads are
unaffected.

## Motivation

During the Obsidian adoption of an iCloud-hosted vault, the choice was forced
between (a) `git init` inside iCloud (corruption risk) and (b) `auto_commit:false`
(no version history). External git-dir is the third, better option: history +
safety. It generalizes to any cloud-synced vault.

## Decisions (settled in brainstorming)

- **Trigger = explicit config key**, not path auto-detection. A `git_dir` value in
  `.daftari/config.yaml` opts in; absent = today's in-vault `.git`.
- **`git_dir` value model = sentinel + explicit path.**
- **Import writes the config** via a flag (not advisory-only).
- **History is per-device** (external dir is local, not synced) — accepted.

## Config

New optional key `git_dir`, resolved at load time to `config.gitDir`
(`string | undefined`):

| value | resolves to |
|-------|-------------|
| (absent) | `undefined` → in-vault `.git` (unchanged behavior) |
| `external` | `${XDG_DATA_HOME:-~/.local/share}/daftari/git/<sha256(abs-vault-path)>` |
| `~/x` or `/abs/x` | expanded + resolved absolute |

Resolution happens in `loadConfig` so the rest of the system sees a concrete
absolute path (or undefined). **Validation (loud config error, per Daftari's
loud-config contract):**
- a `git_dir` resolving *inside* the vault is rejected (defeats the purpose);
- a non-string value is rejected.

The per-vault hash keys the external dir to the vault's absolute path, so re-runs
and the running server find the same repo.

## Git layer (`src/utils/git.ts`)

- `ensureGitRepo(vaultRoot, gitDir?)`: when `gitDir` is set and the vault has no
  working repo, run `git init --separate-git-dir=<gitDir>` (creates external repo
  + the `.git` file). When `gitDir` is unset, the current `git init`. Idempotent.
  - mkdir the parent of `<gitDir>` first if needed.
- `commit(vaultRoot, paths, message, identity, opts?: { gitDir?: string })`
  forwards `opts.gitDir` to `ensureGitRepo`.
- **No change** to `fileGitMeta`, `log`, `changedSince`, `isGitRepo` — they read
  through the `.git` file automatically.

### Threading
Auto-commit callers load config already and pass `config.gitDir`:
- `performWrite` (`src/tools/write.ts`)
- `vaultMerge` (`src/tools/write.ts`)
- `applyPlan` (`src/backfill/apply.ts`)
- `initVault` (`src/cli.ts`) — passes `undefined` (a freshly-scaffolded vault is
  not cloud-adopted); behavior unchanged.

Correctness note: `commit` MUST know `gitDir`, otherwise on first write to a
`git_dir`-configured vault whose repo isn't created yet, `ensureGitRepo` would
wrongly `git init` an in-vault `.git/`. Threading prevents that.

## Import command

`daftari import obsidian <vault> --external-git-dir[=<path>]`:
- No value → writes `git_dir: external`; `=<path>` → writes `git_dir: <path>`.
- Also sets `auto_commit: true` (external git-dir is pointless without commits;
  this overrides a prior `auto_commit:false`, which is the intended effect).
- **Apply-gated**, consistent with the `.gitignore` scaffold: the config write
  happens on `--apply`, not on a `--plan` dry-run. On `--plan` with the flag, a
  stderr notice states it will be written on apply.
- **Merge semantics:** if `.daftari/config.yaml` exists, parse it (js-yaml), set
  the two keys, preserve the rest, re-serialize. If absent, create it. (YAML
  comments may not survive a rewrite — documented; acceptable for a config file.)
  If the two keys are already at the target values, no rewrite (idempotent).
- Order: the config is written *before* `runBackfill` delegates, so the apply's
  commit picks up the external git-dir.

## Behavior notes / limitations (documented)

- The vault's `.git` file is static → syncs harmlessly; the churning git internals
  live off-cloud.
- **Per-device history.** The external dir is on local disk, not synced. On a
  second device the synced `.git` file dangles (points to a non-existent path);
  `isGitRepo` returns false, so `ensureGitRepo` re-inits a fresh external repo
  there on the next commit. Vault content syncs everywhere; git history is
  per-device. This is inherent to keeping `.git` out of the cloud and is accepted.

## Non-goals (YAGNI)

- No path auto-detection as the trigger (explicit config only; import's cloud
  detection only drives whether to *suggest*/accept the flag, not silent enabling).
- No cross-device history federation.
- No migration of an existing in-vault `.git/` to external (possible later
  `daftari git externalize` helper).
- `--init` does not grow a `git_dir` flag in v1 (scaffolds fresh local vaults).

## Testing

- **config** (`test/utils/config.test.ts`): `git_dir` absent → undefined;
  `external` → derived `…/daftari/git/<hash>` path; explicit `~/x` expanded;
  explicit absolute passed through; a value inside the vault → loud error;
  non-string → loud error.
- **git layer** (`test/utils/git.test.ts`): `ensureGitRepo(vault, ext)` creates a
  `.git` *file* (not dir) in the vault + a real repo at `ext`; a subsequent
  `commit(..., {gitDir: ext})` lands and `log`/`fileGitMeta` read through it; with
  no `gitDir`, an in-vault `.git/` is created (unchanged). Assert **no `.git/`
  directory** exists in the vault in the external case.
- **import** (`test/import/index.test.ts`): `--external-git-dir` on `--apply`
  writes `git_dir: external` + `auto_commit: true`, merging into an existing
  config without dropping unrelated keys; on `--plan` it does not write; an
  explicit `=<path>` is written verbatim.
- **e2e** (`test/import/*.e2e.test.ts`): adopt a temp vault with
  `--external-git-dir`, apply a scope, assert the vault has a `.git` file (no
  `.git/` dir), the external dir holds the commit, and the doc is committed.

## Open / to verify at implementation

- Confirm `git init --separate-git-dir` behavior when the vault already has a
  dangling `.git` file (the machine-2 case): expect it to recreate the external
  dir and rewrite the file. Kill condition: it errors instead — then
  `ensureGitRepo` must `rm` the dangling `.git` file first.
- Confirm js-yaml is already a direct/transitive dependency usable for the config
  merge (gray-matter bundles it); if not, add the dependency or do a targeted
  text edit.
