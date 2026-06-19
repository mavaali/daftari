# External git-dir for cloud-synced vaults — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a vault keep its `.git` data outside the vault dir (`git init --separate-git-dir`), so cloud-synced vaults get git history without the `.git`-in-iCloud corruption risk.

**Architecture:** A `git_dir` config key (`external` sentinel → `~/.local/share/daftari/git/<hash>`, or an explicit path) resolved at config-load to `config.gitDir`. `ensureGitRepo` uses `--separate-git-dir` when it's set; only repo *creation* changes — commit/log/history reads follow the `.git` file unchanged. `commit()` gains a `gitDir` option, threaded from the 4 auto-commit callers. `daftari import … --external-git-dir[=path]` writes the config (apply-gated).

**Tech Stack:** TypeScript (ESM/NodeNext), vitest, the `git` CLI via execFile, js-yaml (already a direct dep in config.ts).

**Spec:** [docs/superpowers/specs/2026-06-19-external-git-dir-design.md](docs/superpowers/specs/2026-06-19-external-git-dir-design.md)

---

## Conventions (every task)
- ESM/NodeNext: local imports use `.js`. No classes; pure functions; `Result<T,E>` (never throw from tool handlers).
- vitest. The commit-audit hook occasionally blocks read-only Bash (ls/cat/rg) with a spurious message; `git add`/`git commit`/`npx vitest`/`npm run build` work — use the Read tool if a read is blocked.
- Git hygiene: `git add` ONLY the files each task changes. Never `git add .`.
- Branch is `feat/external-git-dir` (already checked out — do NOT switch/create branches).

## File structure
- **Modify** `src/utils/config.ts` — add `gitDir?: string` to `DaftariConfig`; a `resolveGitDir` helper; parse `git_dir` in `loadConfig`.
- **Modify** `src/utils/git.ts` — `ensureGitRepo(vaultRoot, gitDir?)`; `commit(..., opts?)`.
- **Modify** `src/tools/write.ts` — `performWrite` params gain `gitDir`; 6 handlers pass `config.value.gitDir`; `vaultMerge` passes it.
- **Modify** `src/backfill/apply.ts` — `applyPlan` passes `config.value.gitDir` to its `commit()`.
- **Modify** `src/import/index.ts` — `--external-git-dir[=path]` flag writes config (apply-gated); update git-init notice.
- **Tests**: `test/utils/config.test.ts`, `test/utils/git.test.ts`, `test/import/index.test.ts`, a new `test/import/external-git-dir.e2e.test.ts`; existing `test/tools/write.test.ts` + `test/backfill/apply.test.ts` must stay green.
- **Modify** `CHANGELOG.md`.

---

## Task 1: Config — parse, resolve, validate `git_dir`

**Files:** Modify `src/utils/config.ts`; Test `test/utils/config.test.ts`

- [ ] **Step 1: Read context**
Read `src/utils/config.ts`: the `DaftariConfig` interface (~line 58), `emptyConfig()` (~line 107), `loadConfig(vaultRoot)` (~line 410) and the `auto_commit` parse block (~line 462). Read `src/utils/hash.ts` to confirm the hashing helper name/signature (expected `sha256Hex(input: string): string`).

- [ ] **Step 2: Write failing tests** (add to `test/utils/config.test.ts`; mirror the file's existing temp-vault + `writeFileSync(configPath, …)` pattern)

```typescript
// absent → undefined
it("leaves gitDir undefined when git_dir is absent", () => {
  // write a config.yaml without git_dir (or rely on an existing fixture)
  const cfg = loadConfig(vaultRoot);
  expect(cfg.ok && cfg.value.gitDir).toBeUndefined();
});

it("resolves the 'external' sentinel to a path under the data home, outside the vault", () => {
  writeFileSync(configPathFor(vaultRoot), "git_dir: external\n");
  const cfg = loadConfig(vaultRoot);
  expect(cfg.ok).toBe(true);
  if (!cfg.ok) return;
  expect(cfg.value.gitDir).toMatch(/daftari\/git\//);
  expect(cfg.value.gitDir!.startsWith(resolve(vaultRoot))).toBe(false);
});

it("expands ~ and resolves an explicit git_dir path", () => {
  writeFileSync(configPathFor(vaultRoot), "git_dir: ~/somewhere/daftari-git\n");
  const cfg = loadConfig(vaultRoot);
  expect(cfg.ok && cfg.value.gitDir).toBe(join(homedir(), "somewhere/daftari-git"));
});

it("rejects a git_dir that resolves inside the vault (loud error)", () => {
  writeFileSync(configPathFor(vaultRoot), "git_dir: ./inside\n");
  const cfg = loadConfig(vaultRoot);
  expect(cfg.ok).toBe(false);
});

it("rejects a non-string git_dir", () => {
  writeFileSync(configPathFor(vaultRoot), "git_dir: [1,2]\n");
  expect(loadConfig(vaultRoot).ok).toBe(false);
});
```
(Adapt `configPathFor`/imports to the file's existing helpers; import `homedir` from `node:os`, `join`/`resolve` from `node:path`.)

Run `npx vitest run test/utils/config.test.ts` → new cases FAIL.

- [ ] **Step 3: Implement** in `src/utils/config.ts`

Add imports at top (merge with existing node imports):
```typescript
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256Hex } from "./hash.js"; // confirm name in Step 1
```
Add to the `DaftariConfig` interface (after `autoCommit`):
```typescript
  // Absolute path to an external git directory (git's --separate-git-dir), or
  // undefined for a normal in-vault .git. Set via the `git_dir` config key so a
  // cloud-synced vault can hold only a static `.git` file while git's churn
  // lives off-cloud. Always resolved to an absolute path OUTSIDE the vault.
  gitDir?: string;
```
`emptyConfig()` needs no change (omitting the optional key = undefined).

Add the resolver (near the other validate* helpers):
```typescript
function dataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Resolves the optional `git_dir` config value to an absolute path outside the
// vault, or undefined when absent. `external` derives a stable per-vault path;
// anything else is treated as a filesystem path (~ expanded). A value that would
// land inside the vault — or a non-string — is a loud config error.
function resolveGitDir(raw: unknown, vaultRoot: string): Result<string | undefined, Error> {
  if (raw === undefined || raw === null) return ok(undefined);
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return err(new Error("malformed config: 'git_dir' must be a non-empty string"));
  }
  const vaultAbs = resolve(vaultRoot);
  const gitDirAbs =
    raw === "external"
      ? join(dataHome(), "daftari", "git", sha256Hex(vaultAbs).slice(0, 16))
      : resolve(expandTilde(raw));
  const rel = relative(vaultAbs, gitDirAbs);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return err(
      new Error(`malformed config: 'git_dir' must resolve outside the vault (got ${gitDirAbs})`),
    );
  }
  return ok(gitDirAbs);
}
```
In `loadConfig`, after the `auto_commit` block, add:
```typescript
  const gitDir = resolveGitDir(root.git_dir, vaultRoot);
  if (!gitDir.ok) return gitDir;
```
Add `gitDir: gitDir.value` to the `DaftariConfig` object returned at the end of `loadConfig` (the one with `autoCommit`, `watch`, etc.).

- [ ] **Step 4: Verify** `npx vitest run test/utils/config.test.ts` → PASS; `npx tsc --noEmit` → exit 0.
- [ ] **Step 5: Commit** (`git add src/utils/config.ts test/utils/config.test.ts`) — `git commit -m "feat(config): resolve git_dir (external sentinel / explicit path) for separate-git-dir"`

---

## Task 2: Git layer — `ensureGitRepo(gitDir?)` + `commit` option

**Files:** Modify `src/utils/git.ts`; Test `test/utils/git.test.ts`

- [ ] **Step 1: Read context** — `src/utils/git.ts`: `ensureGitRepo` (line 63), `commit` (line 74), the private `git()` helper (line 39), `isGitRepo` (line 56). Read `test/utils/git.test.ts` for the temp-repo fixture pattern.

- [ ] **Step 2: Write failing tests** (`test/utils/git.test.ts`)

```typescript
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
// use the file's temp-dir helper for `vault` and a separate `ext` temp dir

it("ensureGitRepo with gitDir creates an external repo + a .git FILE, no .git/ dir", async () => {
  const r = await ensureGitRepo(vault, ext);
  expect(r.ok).toBe(true);
  expect(statSync(join(vault, ".git")).isFile()).toBe(true);   // a file, not a dir
  expect(existsSync(join(ext, "HEAD"))).toBe(true);            // real repo lives at ext
});

it("commit with gitDir lands in the external repo and is readable via log", async () => {
  // write a file in `vault`, then:
  const c = await commit(vault, ["note.md"], "msg", "human:tester", { gitDir: ext });
  expect(c.ok).toBe(true);
  const l = await log(vault, { limit: 1 });
  expect(l.ok && l.value[0]?.subject).toBe("msg");
});

it("ensureGitRepo without gitDir still creates an in-vault .git/ dir", async () => {
  const r = await ensureGitRepo(vault2);
  expect(r.ok).toBe(true);
  expect(statSync(join(vault2, ".git")).isDirectory()).toBe(true);
});

it("re-inits when a dangling .git file points nowhere (second-device case)", async () => {
  // write a bogus `.git` file in a fresh vault pointing to a missing dir:
  writeFileSync(join(vault3, ".git"), "gitdir: /no/such/place\n");
  const r = await ensureGitRepo(vault3, ext3);
  expect(r.ok).toBe(true);
  expect(existsSync(join(ext3, "HEAD"))).toBe(true);
});
```

Run `npx vitest run test/utils/git.test.ts` → new cases FAIL.

- [ ] **Step 3: Implement** in `src/utils/git.ts`

Add imports:
```typescript
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
```
Replace `ensureGitRepo`:
```typescript
// Initializes a git repo for the vault if one does not already exist. When
// `gitDir` is given, the repo's data lives there (git init --separate-git-dir),
// leaving only a static `.git` FILE in the vault — so a cloud-synced vault never
// holds churning git internals. Idempotent.
export async function ensureGitRepo(
  vaultRoot: string,
  gitDir?: string,
): Promise<Result<void, Error>> {
  if (await isGitRepo(vaultRoot)) return ok(undefined);

  if (gitDir) {
    // A leftover `.git` FILE (e.g. synced from another device, pointing at a
    // path that doesn't exist here) makes git refuse to init. isGitRepo already
    // returned false, so it's not a live repo — remove the stale pointer first.
    try {
      const s = await stat(join(vaultRoot, ".git"));
      if (s.isFile()) await rm(join(vaultRoot, ".git"));
    } catch {
      /* no .git present — fine */
    }
    await mkdir(dirname(gitDir), { recursive: true });
    const init = await git(vaultRoot, ["init", "--quiet", `--separate-git-dir=${gitDir}`]);
    if (!init.ok) return init;
    return ok(undefined);
  }

  const init = await git(vaultRoot, ["init", "--quiet"]);
  if (!init.ok) return init;
  return ok(undefined);
}
```
Update `commit` signature + first line:
```typescript
export async function commit(
  vaultRoot: string,
  paths: string[],
  message: string,
  identity: string,
  opts: { gitDir?: string } = {},
): Promise<Result<{ hash: string }, Error>> {
  const ready = await ensureGitRepo(vaultRoot, opts.gitDir);
  if (!ready.ok) return ready;
  // …rest unchanged…
```

- [ ] **Step 4: Verify** `npx vitest run test/utils/git.test.ts` → PASS (all 4 new + existing). `npx tsc --noEmit` → 0. **If the dangling-.git test fails** because `git init --separate-git-dir` behaves differently across versions, the `rm` of the stale file (already in the impl) is the mitigation — confirm it's reached; adjust only if a real divergence appears.
- [ ] **Step 5: Commit** (`git add src/utils/git.ts test/utils/git.test.ts`) — `git commit -m "feat(git): ensureGitRepo external git-dir + commit gitDir option"`

---

## Task 3: Thread `gitDir` into the auto-commit callers

**Files:** Modify `src/tools/write.ts`, `src/backfill/apply.ts`; existing tests must stay green.

- [ ] **Step 1: Read context** — In `src/tools/write.ts`: the `performWrite` params interface and its `commit(params.vaultRoot, [params.relPath], params.commitMessage, params.agent)` call; the SIX handlers that call `performWrite` (`vaultWrite`, `vaultAppend`, `vaultPromote`, `vaultDeprecate`, `vaultSetConfidence`, `vaultSupersede`) — each already passes `autoCommit: config.value.autoCommit`; `vaultMerge`'s `commit(...)` call. In `src/backfill/apply.ts`: `applyPlan` loads config (line ~106) and calls `commit(vaultRoot, applied, message, agent)` (~line 157).

- [ ] **Step 2: Implement** (behavior-preserving; existing tests are the guard)

`src/tools/write.ts`:
1. Add `gitDir?: string;` to the `performWrite` params interface (next to `autoCommit`).
2. In `performWrite`, pass it: `await commit(params.vaultRoot, [params.relPath], params.commitMessage, params.agent, { gitDir: params.gitDir });`
3. In EACH of the six handlers, where they build the `performWrite({...})` object and already set `autoCommit: config.value.autoCommit,`, add `gitDir: config.value.gitDir,`.
4. In `vaultMerge`, its `commit(vaultRoot, writes.map((w) => w.relPath), …, agent.value)` → add `{ gitDir: config.value.gitDir }` as the final arg.

`src/backfill/apply.ts`:
5. `applyPlan`'s `commit(vaultRoot, applied, message, agent)` → `commit(vaultRoot, applied, message, agent, { gitDir: config.value.gitDir })` (config is already loaded in that function).

`src/cli.ts` `initVault`: **no change** (omitting opts = in-vault `.git`, unchanged).

- [ ] **Step 3: Verify** `npx vitest run test/tools/write.test.ts test/backfill` → all green (no behavior change when gitDir is undefined). `npx tsc --noEmit` → 0. `npx vitest run` full suite green.
- [ ] **Step 4: Commit** (`git add src/tools/write.ts src/backfill/apply.ts`) — `git commit -m "feat(write): thread config.gitDir into auto-commit callers"`

---

## Task 4: `daftari import … --external-git-dir[=path]`

**Files:** Modify `src/import/index.ts`; Test `test/import/index.test.ts`

Behavior: the flag writes `git_dir` (+ `auto_commit: true`) into `<vault>/.daftari/config.yaml`, merging into any existing config, **on `--apply` only** (a `--plan` dry-run writes nothing — notice only). `--external-git-dir` → `git_dir: external`; `--external-git-dir=/p` → `git_dir: /p`. The flag is stripped from the args forwarded to `runBackfill`.

- [ ] **Step 1: Read context** — current `src/import/index.ts` (`runImport`: the type check, vault/passthrough parsing loop, the `directoryExists` guard, the non-git notice at ~line 81, the `isApply` gating + `ensureVaultGitignore` block at ~line 91). Note `test/import/index.test.ts` mocks `runBackfill`.

- [ ] **Step 2: Write failing tests** (`test/import/index.test.ts`; use temp dirs + read back config.yaml)

```typescript
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";

it("--external-git-dir writes git_dir: external + auto_commit: true on apply", async () => {
  const v = mkdtempSync(join(tmpdir(), "imp-"));
  await runImport(["obsidian", v, "--apply", "--scope", "x", "--external-git-dir"]);
  const cfg = load(readFileSync(join(v, ".daftari", "config.yaml"), "utf-8")) as Record<string, unknown>;
  expect(cfg.git_dir).toBe("external");
  expect(cfg.auto_commit).toBe(true);
  // and the flag was NOT forwarded to runBackfill:
  const [argsArr] = (runBackfill as any).mock.calls.at(-1);
  expect(argsArr).not.toContain("--external-git-dir");
});

it("--external-git-dir=/p writes the explicit path", async () => {
  const v = mkdtempSync(join(tmpdir(), "imp-"));
  await runImport(["obsidian", v, "--apply", "--scope", "x", "--external-git-dir=/tmp/ext-git"]);
  const cfg = load(readFileSync(join(v, ".daftari", "config.yaml"), "utf-8")) as Record<string, unknown>;
  expect(cfg.git_dir).toBe("/tmp/ext-git");
});

it("merges into an existing config without dropping other keys", async () => {
  const v = mkdtempSync(join(tmpdir(), "imp-"));
  mkdirSync(join(v, ".daftari"), { recursive: true });
  writeFileSync(join(v, ".daftari", "config.yaml"), "auto_commit: false\nwarm_embeddings: false\n");
  await runImport(["obsidian", v, "--apply", "--scope", "x", "--external-git-dir"]);
  const cfg = load(readFileSync(join(v, ".daftari", "config.yaml"), "utf-8")) as Record<string, unknown>;
  expect(cfg.git_dir).toBe("external");
  expect(cfg.auto_commit).toBe(true);          // overridden
  expect(cfg.warm_embeddings).toBe(false);     // preserved
});

it("does NOT write config on --plan (dry-run)", async () => {
  const v = mkdtempSync(join(tmpdir(), "imp-"));
  await runImport(["obsidian", v, "--plan", "--external-git-dir"]);
  expect(existsSync(join(v, ".daftari", "config.yaml"))).toBe(false);
});
```
(`runBackfill` stays mocked as in the file. Clean up temp dirs in afterEach.)

Run `npx vitest run test/import/index.test.ts` → new cases FAIL.

- [ ] **Step 3: Implement** in `src/import/index.ts`

Add imports:
```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path"; // resolve already imported
import { dump, load } from "js-yaml";
```
Add a helper:
```typescript
// Writes git_dir (+ auto_commit:true) into the vault's config.yaml, merging into
// any existing config. Returns "written" or "present" (idempotent no-op).
function writeGitDirConfig(vaultRoot: string, gitDirValue: string): "written" | "present" {
  const cfgPath = join(vaultRoot, ".daftari", "config.yaml");
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    const parsed = load(readFileSync(cfgPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cfg = parsed as Record<string, unknown>;
    }
  }
  if (cfg.git_dir === gitDirValue && cfg.auto_commit === true) return "present";
  cfg.git_dir = gitDirValue;
  cfg.auto_commit = true;
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, dump(cfg), "utf-8");
  return "written";
}
```
In `runImport`, in the arg loop that builds `passthrough`, intercept the flag (do NOT push it to passthrough):
```typescript
  let externalGitDir: string | undefined; // undefined = flag absent
  // inside the for-loop over `rest`, before the generic passthrough push:
  if (a === "--external-git-dir") { externalGitDir = "external"; continue; }
  if (a.startsWith("--external-git-dir=")) { externalGitDir = a.slice("--external-git-dir=".length) || "external"; continue; }
```
After the `directoryExists` guard and `isApply` is known, gate the write to apply:
```typescript
  if (externalGitDir !== undefined) {
    if (isApply) {
      const res = writeGitDirConfig(resolvedVault, externalGitDir);
      if (res === "written") {
        process.stderr.write(
          `daftari import: configured external git-dir (git_dir: ${externalGitDir}, auto_commit: true) in ${resolvedVault}/.daftari/config.yaml\n`,
        );
      }
    } else {
      process.stderr.write(
        `daftari import: --external-git-dir will be written to config on --apply (dry-run writes nothing)\n`,
      );
    }
  }
```
Update the non-git notice (~line 81) so it isn't misleading under external-git-dir:
```typescript
  if (!isGit) {
    process.stderr.write(
      externalGitDir !== undefined
        ? `daftari import: '${vault}' is not a git repository — Daftari will initialize git data at an external location (config git_dir), keeping .git out of the vault.\n`
        : `daftari import: '${vault}' is not a git repository — Daftari versions changes with git and will initialize one here.\n`,
    );
  }
```
Place the config-write BEFORE `return runBackfill(...)` so the apply's commit (which re-reads config) picks up `git_dir`.

- [ ] **Step 4: Verify** `npx vitest run test/import/index.test.ts` → PASS (incl. existing). `npx tsc --noEmit` → 0.
- [ ] **Step 5: Commit** (`git add src/import/index.ts test/import/index.test.ts`) — `git commit -m "feat(import): --external-git-dir flag writes git_dir config (apply-gated)"`

---

## Task 5: End-to-end + CHANGELOG

**Files:** Create `test/import/external-git-dir.e2e.test.ts`; Modify `CHANGELOG.md`

- [ ] **Step 1: Write the e2e** (mirror the temp-git-vault fixture from `test/backfill/apply.test.ts` / `test/import/adoption.e2e.test.ts`)

Build a temp vault with one non-conformant `notes/x.md`. Use an **explicit** external path under the temp dir (so it's self-contained + cleanable, not the `~/.local/share` derived path):
```
runImport(["obsidian", vault, "--apply", "--scope", "notes", "--yes",
           `--external-git-dir=${extDir}`])
```
Assert after:
- `statSync(join(vault, ".git")).isFile()` is true (a `.git` FILE, not a dir).
- NO `.git/` directory in the vault (`statSync(join(vault,'.git')).isDirectory()` is false).
- The external repo exists: `existsSync(join(extDir, "HEAD"))`.
- `notes/x.md` was committed: `log(vault, {limit:1})` returns a commit whose subject contains the backfill message (or `git -C vault rev-parse HEAD` succeeds).
- `notes/x.md` on disk has Daftari frontmatter (parse it).
Clean up `vault` and `extDir` in afterEach.

Run `npx vitest run test/import/external-git-dir.e2e.test.ts` → iterate to green.

- [ ] **Step 2: Full suite + build** — `npm run build` (clean); `npx vitest run` (whole suite; the known embedding/search flake can be re-run once). Report honest final numbers.

- [ ] **Step 3: CHANGELOG** — add under `## [Unreleased]` → `### Added`:
```markdown
- `git_dir` config key (and `daftari import … --external-git-dir[=path]`) — keep a
  vault's git data outside the vault via `git init --separate-git-dir`, so a
  cloud-synced (iCloud/Dropbox/…) vault gets version history without a churning
  `.git/` inside the sync folder. `external` derives a per-vault path under the
  data home; an explicit path is also accepted. History is per-device.
```

- [ ] **Step 4: Commit** (`git add test/import/external-git-dir.e2e.test.ts CHANGELOG.md`) — `git commit -m "test(git-dir): e2e external git-dir adoption + CHANGELOG"`

---

## Out of scope (do not build)
- Path auto-detection as the trigger (explicit config only).
- Cross-device history federation.
- Migrating an existing in-vault `.git/` to external (possible later helper).
- A `git_dir` flag on `--init`.
- Version bump / `npm publish` (Mihir's release step).

## Verification checklist (before "done")
- [ ] `npm run build` clean; `npx vitest run` green.
- [ ] Existing `test/tools/write.test.ts` + `test/backfill/**` unchanged and green (proof gitDir-undefined path is byte-identical).
- [ ] Manual: `daftari import obsidian <tmp-vault> --apply --scope X --yes --external-git-dir=<tmp-ext>` → `.git` is a file, `<tmp-ext>` holds the repo, no `.git/` dir in the vault.
- [ ] Run pre-release-assumption-audit before claiming complete (esp. the per-device / dangling-.git path and config-merge comment-loss).
