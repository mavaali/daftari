## Pre-release audit — Obsidian adoption (`daftari import obsidian`)

Branch `feat/obsidian-adoption`. Build clean; full suite 1204 passed / 3 skipped.
Final code review APPROVED. This audit covers the five environment-delta axes the
test suite does not model. The feature's defining environment fact: **it targets a
foreign Obsidian vault, not a vault scaffolded by `daftari --init`** — so every
"the vault was set up by Daftari" assumption is suspect.

### 1. Input validation parity — ACCEPT (clean)
`runImport` rejects: unsupported type (exit 1), a vault path that isn't an existing
directory (`directoryExists` returns false for a missing path *and* for a file —
`stat.isDirectory()`), and inherits backfill's `--scope` guards (empty `--scope`
rejected; `--apply` requires `--scope`; whole-vault apply impossible). Vault
defaults to `.` when omitted. No gap found.

### 2. Environment delta — TWO FINDINGS (fix decisions below)
- **2a. Non-git vault is silently `git init`-ed.** Most Obsidian vaults are not git
  repos. `applyPlan` → `commit()` → `ensureGitRepo()` (`src/utils/git.ts:62`) runs
  `git init --quiet` if no repo exists. The feature *works* (derivation falls back
  to mtime via `fileGitMeta`'s non-git branch, `git.ts:127`), but it **mutates the
  user's vault** — creates `.git/` — without telling them. For a coexistence user
  who syncs the vault via iCloud/Obsidian Sync, an unannounced `.git/` is a
  surprise. Risk: trust erosion on the adoption front door; possible sync
  interactions. — **decision: fix now (surface it).**
- **2b. No `.gitignore` scaffolded → ephemeral `.daftari/*` unprotected.** `daftari
  --init` writes `VAULT_GITIGNORE` (ignores `.daftari/index.db`, `locks.db`,
  `*.jsonl`, etc. — `src/cli.ts:51`). `import`/`backfill` write **no `.gitignore`**;
  backfill only *prints a reminder* to add the plan file by hand
  (`src/backfill/index.ts:132`). The apply commit itself is safe (it stages only
  the applied doc paths via `git add -- <paths>`), but once the user runs the
  server (creating a multi-MB `index.db`) and later does any `git add .` /
  `git commit -a`, the ephemeral index + curation logs leak into their repo. This
  is the exact "provenance log documented as gitignored but never added to
  .gitignore" past failure. — **decision: fix now (scaffold ignores on import).**

### 3. Scale delta — ACCEPT, with budget
New scale surface = the plan walk. Obsidian vaults run large (1k–10k notes).
`generatePlan` runs ~2 git subprocesses per *non-conformant* doc (sequential) plus
`harvestInlineTags` (O(lines) per doc) in obsidian mode. Memory: the full plan
(all PlanEntry objects) is held in RAM and written as JSONL — linear in doc count,
no full-batch model activation (unlike the embedding path). Budget at 5k docs:
RSS ~ low hundreds of MB (plan entries only); wall time dominated by git subprocess
fan-out — minutes, not seconds, but **progress is shown** (`planProgress` heartbeat
every 50 docs once total ≥ 50, `src/backfill/index.ts:142`). No O(n²); apply is
per-folder. Accept; the slowness is visible and bounded.

### 4. Doc-vs-code delta — ACCEPT (clean), modulo 2b
- CHANGELOG entry matches behavior (inline tags, source→sources, custom fields
  preserved, wikilinks untouched). ✓
- `import --help` claims: harvests `#tags` ✓, maps Web Clipper `source` ✓,
  wikilinks untouched ✓, mirrors backfill two-step ✓, `--scope` required on apply ✓.
- The one doc-vs-reality gap is 2b: the spec's "git is the undo" assumes a git repo
  exists; on a foreign vault that's only true *after* the silent init (2a).

### 5. Silence audit — FINDINGS FOLD INTO 2a/2b
- Long plan walk: progress heartbeat present. ✓
- Missing/!dir vault: clear error + exit 1. ✓
- "Nothing to backfill" no-op: message + exit 0. ✓
- **Silent git init (2a)** and **silent absence of .gitignore protection (2b)** are
  the two silence violations — the user is not told the vault became a git repo, nor
  that ephemeral state is unprotected.

### Decisions
- **Fix now:** 2a (announce when adopting a non-git vault that Daftari will init
  git) + 2b (scaffold the `.daftari` gitignore protections on import if absent).
  Both are small, both are on the adoption front door, both prevent a real
  first-contact footgun. Recommend bundling: on a non-git vault, `import` prints a
  one-line notice and writes a `.gitignore` (or appends the `.daftari/*` block if a
  `.gitignore` already exists) before the apply.
- **Accept:** axes 1, 3, 4 (clean). Scale is visible and bounded.
- **No tickets** beyond the two fix-now items.

### Resolution (2026-06-19) — FIXED in commit `e5bff2a`
- 2a: `runImport` now writes a stderr notice when the target vault is not a git
  repo (`src/import/index.ts:80`). 2b: `ensureVaultGitignore` (shared with
  `--init` via the new `src/utils/vault-gitignore.ts`, so the ignore block can't
  drift) scaffolds/append the `.daftari/*` rules on `--apply` only — a `--plan`
  dry-run writes nothing. Covered by `test/utils/vault-gitignore.test.ts` and the
  extended `test/import/index.test.ts`. Full suite: 1209 passed / 3 skipped.
