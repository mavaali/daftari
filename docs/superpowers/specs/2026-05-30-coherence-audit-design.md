# Coherence Audit Mode — v1 Design

**Status:** Approved 2026-05-30. Implementation plan to follow via the writing-plans skill.
**Issue:** [mavaali/daftari#85](https://github.com/mavaali/daftari/issues/85) — Cross-Repo Coherence Audit Mode.
**Relationship to other work:** complements but does not block PR #86 (Multi-vault MCP Router Phase 1). The router runs continuously for agents; this audit runs on-demand for humans / CI. Both touch cross-repo analysis but ship independently.

---

## 1. Purpose

Provide engineering teams with a `daftari audit` CLI subcommand that scans N markdown repos (including the degenerate N=1 case) and produces an actionable coherence report covering:

1. **Broken cross-repo references** — links from repo A to repo B that resolve to missing files or missing heading anchors.
2. **Link-graph transitive staleness** — docs whose own git mtime is fresh but that link to docs whose git mtime exceeds a configurable threshold.

The audit is read-only, deterministic, and CI-friendly (configurable exit-code thresholds, machine-readable JSON output, predictable markdown output).

## 2. Scope

### In scope (v1)

- `daftari audit` CLI subcommand with `--repo <path>` flags and/or `--config audit.yaml`.
- Broken cross-repo reference check (URL match + relative-path-escape detection).
- Link-graph transitive staleness check (git-based mtime, configurable threshold).
- Markdown and JSON report output every run.
- Exit-code-driving threshold config (`fail_on.broken_refs`, `fail_on.transitive_staleness`).
- Performance budget: **<30s on 4000 docs** (single repo or aggregated across N repos).

### Out of scope (deferred)

- **Contradiction detection.** Embedding-similarity candidate-pair surfacing is fuzzy without an LLM and noises up CI signal/noise ratio. Earns its own plan when an LLM verdict step is on the table.
- **Topic-overlap-based dependency inference** (for the staleness check). Same threshold-tuning concern. v1 staleness uses only the explicit link graph.
- **Coherence score** (the `58/100` composite from issue #85). Arbitrary weights, doesn't help CI pass/fail decisions, deferred until a real consumer asks for it.
- **Incremental run caching.** Per the user's "hybrid" decision: v1 walks everything every run. Re-check whether to swap in a vault-backed cache when 30s budget is breached.
- **Custom organizational link conventions** beyond explicit URL match + relative-path escape. Out of scope until a specific convention is named.
- **PR-comment formatting or CI integrations.** The audit emits markdown + JSON; CI owners post/parse however they want.

### Explicit non-goals

- Not a daftari vault. No `.daftari/` directory created. No SQLite index. No embeddings.
- Not a fixer. Pure analysis. No writes, commits, or migrations.
- Not LLM-aware. Text matching + git only.

---

## 3. User interface

### CLI

```bash
# Repos via flags (anonymous, no URL patterns):
daftari audit \
  --repo ~/repos/service-a \
  --repo ~/repos/service-b \
  --output coherence-report.md

# Or with a config file (recommended for CI):
daftari audit --config audit.yaml

# Mix is allowed:
daftari audit --config audit.yaml --repo ~/repos/extra-repo
```

`daftari audit --help` prints usage.

### `audit.yaml`

```yaml
repos:
  - name: service-a
    path: ~/repos/service-a
    docs_glob: "docs/**/*.md"      # default: "**/*.md"
    urls:                          # optional; enables URL-pattern matching
      - "github.com/org/service-a"

  - name: service-b
    path: ~/repos/service-b
    docs_glob: "**/*.md"
    urls:
      - "github.com/org/service-b"

output:
  markdown: coherence-report.md    # default: stdout if absent
  json: coherence-report.json      # default: not emitted if absent

staleness:
  threshold_days: 540              # default: 540 (18 months)

fail_on:
  broken_refs: 1                   # default: fail on any broken ref
  transitive_staleness: 100        # default: generous; teams tune
```

CLI flags override config values where they overlap. Repos passed via `--repo` flag merge with repos in `audit.yaml` (anonymous CLI repos get auto-generated names like `repo-0`, `repo-1`).

### Exit codes

- `0` — audit ran successfully and finding counts were within thresholds.
- `1` — audit ran successfully but at least one threshold was exceeded.
- `2` — config error (missing required fields, unreadable file, malformed YAML).
- `3` — runtime error (unreadable repo, git failure that wasn't recoverable).

`stderr` carries human-readable diagnostics; `stdout` is reserved for the markdown report when no `--output` is specified.

---

## 4. Architecture

A new `src/audit/` directory inside the main daftari package, dispatched as a subcommand from `src/cli.ts`:

```ts
// In src/cli.ts run() function:
if (argv[0] === "audit") {
  const { runAudit } = await import("./audit/index.js");
  return process.exit(await runAudit(argv.slice(1)));
}
```

The subcommand is lazy-loaded so the main `daftari --vault` path pays no import cost.

### Module layout

Each file owns one responsibility with a clear interface:

| File | Exports | Responsibility |
|---|---|---|
| `src/audit/index.ts` | `runAudit(argv: string[]): Promise<number>` | Top-level entry. Loads config, orchestrates pipeline, emits reports, returns exit code. |
| `src/audit/config.ts` | `parseAuditConfig(argv, yamlText?): AuditConfig` | Merge CLI flags + YAML. Throws on bad input (matches existing daftari startup style). |
| `src/audit/collect.ts` | `collectRepos(config: AuditConfig): Promise<RepoSnapshot[]>` | Per-repo: glob docs, parse frontmatter (best-effort), batch-fetch git mtimes, pre-build anchor index. |
| `src/audit/links.ts` | `extractLinks(snapshots: RepoSnapshot[]): LinkEdge[]` | Walk every doc's body, find markdown links, classify as in-repo / cross-repo (URL match or relative-path escape). |
| `src/audit/checks/broken_refs.ts` | `checkBrokenRefs(snapshots, edges): BrokenRefFinding[]` | For each cross-repo `LinkEdge`: target file exists? Anchor exists? |
| `src/audit/checks/staleness.ts` | `checkStaleness(snapshots, edges, thresholdDays): StalenessFinding[]` | Build adjacency list, classify each doc as fresh / directly-stale / transitively-stale via single-pass memoized DFS. |
| `src/audit/report.ts` | `renderMarkdown(report): string`, `renderJson(report): string` | Pure formatters over the in-memory `AuditReport`. |
| `src/audit/exit.ts` | `computeExitCode(report, failOn): number` | Compares finding counts to thresholds, returns 0 or 1. |

Tests mirror `src/audit/` structure (one test file per source file, plus an integration test).

### Why this layout

- **Pure functions throughout.** Each stage takes its inputs and returns its output. `collectRepos` is the only async/IO stage; everything downstream is sync and trivially testable.
- **Single-repo case falls out automatically.** With N=1, `extractLinks` produces edges where source repo == target repo (in-repo links). `checkBrokenRefs` filters to cross-repo edges → empty result. `checkStaleness` runs on the full link graph (in-repo edges still matter for transitive staleness). The single-vault scenario is a degenerate case of the general one, not a separate code path.
- **Tests mirror modules.** Pure functions + one test per file follows daftari's existing convention.

---

## 5. Data shapes

```ts
// src/audit/types.ts

export type AuditConfig = {
  repos: RepoConfig[];
  output: { markdown?: string; json?: string };
  staleness: { thresholdDays: number };
  failOn: { brokenRefs: number; transitiveStaleness: number };
};

export type RepoConfig = {
  name: string;
  path: string;               // absolute after parse
  docsGlob: string;
  urls: string[];             // empty if not configured
};

export type DocSnapshot = {
  relPath: string;            // vault-relative
  absPath: string;
  mtime: string;              // ISO timestamp from git or fs
  mtimeSource: "git" | "fs";  // for transparency
  headings: Set<string>;      // slugified, for anchor lookup
  links: LinkRef[];           // raw extracted; classification happens later
  frontmatter: Record<string, unknown> | null;
};

export type LinkRef = {
  rawHref: string;            // exact text from the markdown
  anchor: string | null;      // "#section-id" → "section-id" or null
  isUrl: boolean;
  isRelative: boolean;
};

export type RepoSnapshot = {
  config: RepoConfig;
  docs: Map<string, DocSnapshot>; // keyed by relPath
};

export type LinkEdge = {
  sourceRepo: string;
  sourcePath: string;         // relPath in source repo
  targetRepo: string;         // same as source if in-repo edge
  targetPath: string;         // relPath in target repo (resolved)
  targetAnchor: string | null;
  rawHref: string;            // for error messages
};

export type BrokenRefFinding = {
  kind: "missing_file" | "missing_anchor";
  source: { repo: string; path: string };
  target: { repo: string; path: string; anchor: string | null };
  rawHref: string;
};

export type StalenessFinding = {
  kind: "direct" | "transitive";
  repo: string;
  path: string;
  mtime: string;
  staleChain?: Array<{ repo: string; path: string; mtime: string }>; // populated only for transitive
};

export type AuditReport = {
  generatedAt: string;
  config: AuditConfig;
  totals: {
    reposScanned: number;
    docsScanned: number;
    brokenRefs: number;
    directlyStale: number;
    transitivelyStale: number;
  };
  brokenRefs: BrokenRefFinding[];
  staleness: StalenessFinding[];
};
```

The JSON output is `AuditReport` directly serialized. Markdown is rendered from the same structure.

---

## 6. Data flow

```
audit.yaml + CLI ──► parseAuditConfig ──► AuditConfig
                                                │
                                                ▼
                                       collectRepos ──► RepoSnapshot[]
                                                              │
                                                              ▼
                                                       extractLinks ──► LinkEdge[]
                                                                             │
                                          ┌──────────────────────────────────┤
                                          ▼                                  ▼
                                  checkBrokenRefs                     checkStaleness
                                          │                                  │
                                          └──────────────┬───────────────────┘
                                                         ▼
                                                  AuditReport
                                                         │
                                              ┌──────────┴──────────┐
                                              ▼                     ▼
                                       renderMarkdown          renderJson
                                              │                     │
                                          write file           write file
                                              │                     │
                                              └──────────┬──────────┘
                                                         ▼
                                                computeExitCode → process.exit
```

Pure pipeline. `collectRepos` is the only IO-heavy stage; all downstream stages are sync, deterministic, and fixture-testable.

---

## 7. Cross-repo reference detection

A link in `<source-repo>/<source-path>` is a **cross-repo reference** iff one of the following matches:

### 7.1 URL match

The link's href is an absolute URL like `https://github.com/<org>/<repo>/blob/<branch>/<path>` (or `tree/<branch>/<path>`).

The audit iterates configured repos; if any repo's `urls` list contains a pattern matching the host+path-prefix portion of the URL (e.g., `github.com/org/service-b`), that's the target repo and `<path>` is the target file. The optional `#anchor` fragment becomes `targetAnchor`.

URLs whose pattern matches no configured repo are **ignored** — they're external references, out of scope.

### 7.2 Relative-path escape

The link's href is a relative path (no scheme). The audit resolves it against the source document's directory using `path.resolve`. If the resolved path lives outside the source repo's root, the audit then checks whether the resolved path lives inside any other configured repo's root. If so, that's a cross-repo reference; otherwise it's a broken relative link (handled by the in-repo broken-ref check, which is in scope as a side effect — see §10.1).

### 7.3 In-repo links

Links that don't escape the source repo are recorded as `LinkEdge` with `sourceRepo === targetRepo`. They aren't broken-ref findings (the in-repo case is fine), but they DO participate in the staleness graph.

### 7.4 Anchor resolution

`#section-id` anchors are matched against the target document's headings, slugified using the GitHub algorithm:
- Lowercase
- Strip all non-alphanumeric except hyphens and underscores
- Replace whitespace with hyphens

The `DocSnapshot.headings` set is pre-built during collect so anchor checks are O(1).

---

## 8. Staleness graph

### 8.1 Direct staleness

A doc is **directly stale** iff `(now - doc.mtime) > thresholdDays`. `mtime` comes from the batched `git log` (§9.1) or falls back to `fs.statSync().mtime` if git is unavailable.

### 8.2 Transitive staleness

Build an adjacency list from `LinkEdge[]` keyed by `(repo, path)`. For each fresh doc, DFS its reachable set; if any reachable doc is directly stale, mark the source doc **transitively stale** and record the path to the stale doc as `staleChain`.

The chain is the path from the fresh root to the first stale leaf (shortest path), reported as `[A, B, C]` where C is directly stale.

### 8.3 Cycles

The adjacency list may contain cycles (A → B → A). DFS uses a `visited` set per-traversal-root to prevent infinite loops. Visited nodes inside a traversal that lead to a stale leaf still propagate the staleness verdict to the root.

### 8.4 Memoization

The "is X transitively stale" computation is memoized across traversals — once a node is classified, subsequent traversals reaching it use the cached verdict. Reduces complexity from O(V × E) worst case to O(V + E).

---

## 9. Performance

### 9.1 Git mtime batching

For each configured repo, the audit runs:

```
git -C <repo.path> log --all --name-only --pretty=format:"COMMIT %aI"
```

This single call yields commit times interleaved with the files touched at each commit. The audit walks the output in commit-date-desc order (git's default) and records the first commit time it sees for each file as that file's mtime. Files in the working tree not present in any commit fall back to `fs.statSync().mtime` with a `mtimeSource: "fs"` flag.

This bounds git overhead at one process spawn per repo, regardless of doc count.

### 9.2 Anchor pre-indexing

During `collectRepos`, each doc's headings are parsed once and slugified into `DocSnapshot.headings: Set<string>`. Anchor lookups in `checkBrokenRefs` are O(1).

### 9.3 Single-pass staleness

Per §8.4, transitive staleness is computed with a memoized DFS. Total work is O(V + E) where V is doc count and E is link count. For 4000 docs × ~5 links/doc average = 20000 edges, this is well under one second.

### 9.4 Budget commitment

v1 commits to **<30 seconds wall-clock** on a 4000-doc single-repo audit, measured on the headline benchmark in §11.

If 30s is breached on real-world vaults, the hybrid plan kicks in: swap the in-memory backend for a vault-backed (cached) backend behind the same audit API. This is a deferred decision, not part of v1.

---

## 10. Error handling

### 10.1 Config errors

`parseAuditConfig` throws synchronously on:
- Missing required fields (repo `name` / `path`).
- Repo paths that don't exist on disk.
- Conflicting CLI + config values (e.g., both specify `--output` to different files — CLI wins, but a warning to stderr).
- Repos sharing the same filesystem path (matches router v1 lesson; one of the deferred backlog items).
- Repos sharing the same `name`.

Errors result in exit code 2 with a stderr message naming the offending field.

### 10.2 Per-file collection errors

- Unreadable file: stderr warning, file omitted from snapshot, audit continues.
- Malformed frontmatter: stderr warning, doc included with `frontmatter: null`, audit continues.
- Files in glob that are not markdown (`.md`/`.markdown`): silently skipped.

### 10.3 Per-link extraction errors

Malformed markdown link syntax is silently skipped (the markdown parser handles this gracefully).

### 10.4 Git failures

If `git log` exits non-zero (not a git repo, file not tracked, git binary missing), the audit logs a stderr warning and falls back to filesystem mtime for that repo. `mtimeSource: "fs"` is set on every affected `DocSnapshot` and surfaced in the markdown report's per-repo summary so operators know the data is approximate.

### 10.5 Runtime errors

Unhandled exceptions (FS errors mid-walk, OOM, etc.) propagate to `runAudit`, which catches them, writes a fatal message to stderr, and returns exit code 3.

---

## 11. Testing

### 11.1 Unit tests

One test file per module under `test/audit/` mirroring `src/audit/`:

- `config.test.ts` — happy path, missing fields, name/path collisions, CLI override, default fill-in.
- `collect.test.ts` — tmpdir fixtures, two fake repos, frontmatter parsing, anchor extraction, `git log` parsing (with a mocked git binary), `fs` fallback when git absent.
- `links.test.ts` — string fixtures, URL match (multiple URL patterns), relative-path escape (positive + negative), anchor extraction.
- `broken_refs.test.ts` — hand-built `LinkEdge[]` + snapshot, exhaustive case table (missing file, missing anchor, both present).
- `staleness.test.ts` — hand-built graph fixtures: linear chain, cycles (must not infinite-loop), branching (verify shortest chain reported), memoization (one classification per node).
- `report.test.ts` — golden-file comparison for markdown and JSON output.
- `exit.test.ts` — threshold-comparison table.

### 11.2 Integration tests

- `audit.integration.test.ts` — full pipeline against `test/fixtures/audit/repo-{a,b}` (real markdown files in `test/fixtures/`, real `git init`'d directories with seeded commits). Asserts:
  - Cross-repo URL ref to `repo-b/docs/api.md` works.
  - Cross-repo relative-path escape works.
  - Broken anchor detected.
  - A doc linking to an old (>540d) doc is reported as transitively stale.
  - Exit code respects `fail_on` thresholds.

### 11.3 Performance benchmark

- `audit.perf.test.ts` — programmatically generates 4000 markdown files across a single `git init`'d tmpdir (with ~5 random cross-references per doc), runs `daftari audit` against it, asserts wall-clock < 30s. Marked as `.skip` by default unless `RUN_PERF=1` is set, to avoid burning CI time on every run.

---

## 12. Open questions for the plan

(Surface to the implementation plan, not the design. Listed here so they don't get lost.)

1. **Markdown parser choice.** daftari already uses `gray-matter` for frontmatter; for body link extraction we either reuse a heading/link regex or pull in `remark-parse`. Lean: regex for v1 (faster, no dep), upgrade to `remark` only if edge cases force it.
2. **`git log` output stability.** The `--pretty=format` we use should be safe, but verify against the daftari root repo's git version pin (Node 20 ships with whichever git the system has). Pin in the test environment.
3. **Where do `--repo` flags' anonymous repos get their URL patterns?** Likely answer: they don't get any, and any URL match against them returns "no match", so URL-based cross-refs to anonymous repos go silently unflagged. Document in the README; defer to plan whether to support `--repo-with-url`.
4. **PR comment templates.** Out of scope for v1, but if a follow-up wants a "compact summary" report variant, the JSON structure should already support it (counts in `totals`, full detail in arrays — consumers can render either).

---

## 13. What this design explicitly is NOT

- **Not a refactor of `src/curation/lint.ts`.** That lint runs on one vault and stays where it is. Audit is a new surface that may eventually share helpers (link extraction, slug computation) — the plan should call out which helpers to extract vs. duplicate.
- **Not a precursor to the router's deferred cross-vault lint** (router Phase 2). Audit is human/CI-facing batch; router cross-vault lint is agent-facing live. They share detection logic in concept; the plan decides whether to extract a shared module now or defer to the second consumer (the router).
- **Not a daftari vault generator.** No `.daftari/` is created. The audit is non-invasive against any repo it scans.

---

*Approved: 2026-05-30. Next step: writing-plans skill produces the task-by-task implementation plan.*
