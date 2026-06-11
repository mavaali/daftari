# Code Coherence — Validated Design

_2026-06-10. Implements GitHub issues #117–#121. Scope decision: **Hold** (build #117–#120 fully; #121 records the edge + vault-relative code nodes only, defers cross-repo content-loading in eval)._

## Problem

Daftari's audit (#85) finds contradictions, broken refs, and staleness **across markdown repos**. It is blind to the doc↔code boundary: a vault doc can describe a code file, the code can change, and the doc silently becomes a lie. There is no machine-traversable edge from a doc to the code it documents, so nothing can check whether the description still holds.

## User outcome

Point the audit at doc repos + code repos. For each doc that declares which code it `describes`, the audit (a) flags the binding if the code file is gone, and (b) with `--semantic`, asks an LLM whether the doc still accurately describes the code, optionally logging drift as a tension. The eval system's cortex-quality sampler becomes aware of doc→code edges.

## What already exists (reused, not rebuilt)

| Sub-problem | Existing machinery |
|---|---|
| Optional string-array frontmatter field | `optionalStringArray` in `src/frontmatter/schema.ts`; built-in field list in `src/frontmatter/types.ts` |
| Non-destructive serialization of a new built-in | `serializeDocument` in `src/tools/write.ts` (writes built-ins in schema order) |
| Per-repo audit config + path validation | `src/audit/config.ts`, `RepoConfig` in `src/audit/types.ts` |
| Edge classification + repo resolution | `classifyEdges`, `resolveRelative`, URL-pattern matching in `src/audit/links.ts` |
| Broken-target detection | `checkBrokenRefs` in `src/audit/checks/broken_refs.ts` |
| LLM calls with retry + JSON parse | `LlmClient` (`completeJson`) in `src/eval/llm.ts` |
| Tension logging | `addTension` in `src/curation/tension.ts` |
| Subgraph edge model | `SubgraphEdge` in `src/eval/types.ts`; `walkHop` in `src/eval/subgraph.ts` |

## Design by issue

### #117 — built-in `describes` field

`describes: string[]` joins `BuiltinFrontmatter`. `string[]` is already within `ExtensionValue`, so the `Frontmatter` index signature is unaffected. Add `"describes"` to `BUILTIN_FRONTMATTER_FIELDS`, `optionalStringArray("describes")` to `validateFrontmatter`, and `describes: fm.describes` to `serializeDocument`'s ordered block (placed after `tags`, before `questions_*`, near the other relationship fields).

**Decision — always-serialize, consistent with siblings.** Every built-in array is written even when empty (`sources: []`, `questions_answered: []`). `describes` follows suit. Rationale: minimum surprise; the serializer has no empty-array-omission path and adding one for a single field is a special case. Documented in `docs/file-format.md`.

**Entry syntax.** `repo:path` or `repo:path::symbol`. v1 resolves at file level; the `::symbol` suffix is parsed-and-retained but resolution ignores it (v2). A bare `path` with no `repo:` prefix resolves against the doc's own repo.

### #118 — `type: docs | code` on repo config

Add `type: "docs" | "code"` to `RepoConfig` (default `"docs"`). Parse from YAML `type:` and validate the discriminant in `config.ts` (config error on any other value). CLI `--repo` repos default to `docs`; a `--code-repo <path>` flag registers a `code` repo.

`collect.ts` branches: `docs` repos collect as today (glob markdown, parse frontmatter, headings, links, mtimes). `code` repos are **indexed by path only** — `collectCodeRepo` globs all files (not just `.md`), records `relPath`/`absPath`, no body read, no frontmatter, no link extraction. A `code` `RepoSnapshot` carries a docs map whose entries are path-only stubs (empty headings/links) so downstream existence lookups (`byRepo.get(repo).docs.has(path)`) work unchanged.

### #119 — `describes` edges in the classifier

New `DescribesEdge` (distinct from `LinkEdge`): `{ sourceRepo, sourcePath, targetRepo, targetPath, symbol: string|null, raw }`. `classifyDescribesEdges(snapshots)` reads each docs-repo doc's `describes` frontmatter, parses `repo:path::symbol`, resolves `repo` via the repo-name map (bare path → source repo), and emits an edge. `checkDescribesRefs(snapshots, describesEdges)` reuses the broken-ref shape: target repo unknown or target path absent in that repo's docs map → `missing_file`. Reported in a new report section + counted in totals; `failOn.brokenDescribes` (default 1) extends `computeExitCode`.

Frontmatter for `describes` must be read during collection — `collect.ts` currently discards parsed frontmatter. Store `describes` (already-validated `string[]`) on `DocSnapshot.describes`.

### #120 — `--semantic` LLM drift check

New `src/audit/semantic.ts`: `runSemanticCheck(describesEdges, snapshots, deps)` where `deps = { llm: LlmClient, readFile, model }`. For each resolvable `describes` edge: read doc body + read code-target content (guarded), call `llm.completeJson` with the coherence prompt, collect a `SemanticFinding { source, target, verdict: "coherent"|"drifted"|"contradicted"|"skipped", contradictions: string[], reason }`.

**Read-safety util — `src/audit/readtext.ts`** (shared with #121): `readTextFile(absPath, { maxBytes }) → Result<{ text }, { reason: "too_large"|"binary"|"unreadable"|"encoding" }>`. Reads up to `maxBytes`+1 (default 256 KiB), rejects over-limit, sniffs for NUL byte → binary, decodes UTF-8 strictly. Over-limit / binary / unreadable targets yield a `skipped` verdict, never a model call.

`--semantic` is opt-in. `--auto-tension` logs `drifted`/`contradicted` findings via `addTension` (kind `factual`, sourceA = doc, sourceB = code path, claims from the LLM's contradiction list). Tension logging needs a vault root — `--auto-tension` requires exactly one `docs` repo that is a Daftari vault (else config error).

The default audit never imports the Anthropic SDK at module load — `semantic.ts` receives the client via DI; `index.ts` constructs it only when `--semantic` is set.

### #121 — `describes` as 5th subgraph edge kind (Hold scope)

`SubgraphEdge.kind` gains `"describes"`. In `walkHop`, after the `sources` loop, read `node.frontmatter.describes` (array of strings), emit `{ from, to: codePath, kind: "describes" }`, and load the target **as a code node** via a vault-relative loader that reuses `readTextFile`: if `codePath` resolves inside `vaultRoot` and is readable text, add a `SubgraphNode { path, body, frontmatter: {} }`; otherwise record the edge with **no node** (unresolved external target).

**Generator-contract guard (the buried risk).** Code nodes are tagged so they are excluded from the generator's "supplied docs" / `expected_sources` set — they are grader *context* only. The answerer (vault-tool-only) is never asked to retrieve code. Concretely: `Subgraph` gains `code_nodes: SubgraphNode[]` separate from `nodes`; the generator prompt receives `nodes` as before plus a read-only "Referenced code (context, not citable)" block built from `code_nodes`.

`keepEdge` keeps a `describes` edge when its `from` is a retained node (the `to` may be a code node or an unresolved external path — like `sources`, it is not required to be an in-vault node).

## Data-flow paths traced

- **Happy:** doc with valid `describes: [repo:path]`, code exists → edge resolves, broken-ref clean, `--semantic` reads both, LLM returns `coherent`.
- **Nil/empty:** `describes` absent or `[]` → no edges, no findings, serialization writes `describes: []`. Subgraph: no `describes` edges.
- **Error:** code target missing → `missing_file` finding (#119); code target binary/too-large → `skipped` verdict, no model call (#120); LLM JSON parse fails → `completeJson` returns `err`, finding records the failure, audit continues.
- **Upstream failure:** repo path invalid → existing `config.ts` config error (exit 2); git unavailable in a code repo → irrelevant (code repos aren't mtime-checked); `ANTHROPIC_API_KEY` unset with `--semantic` → config error before any collection.

## Failure modes

- **Succeeds wildly (scale):** a docs repo with thousands of `describes` edges under `--semantic` → thousands of LLM calls. Mitigation v1: `--semantic` is opt-in and sequential; a `--max-semantic <n>` cap (default 200) bounds calls and logs how many edges were skipped (no silent truncation). Reference-integrity (#119) stays O(edges), no model calls, always on.
- **Fails:** a wrong `coherent`/`drifted` verdict is advisory — `--auto-tension` logs a tension (reversible, human-resolved), never edits a doc. No destructive path.
- **6-month consequence:** `describes` is a built-in, so it is now part of the schema contract — removing it later is a breaking change. Accepted: it is a first-class relationship like `sources`. The audit↔eval coupling is kept minimal (shared `readtext.ts` only); eval does not depend on audit repo-config, so the deferred cross-repo loading can be added later without rework.

## NOT in scope

- `::symbol`-level resolution — parsed and retained, resolution deferred to v2.
- External-repo code content-loading in **eval** (#121) — needs audit repo-config threaded into the eval entrypoint; deferred (the Expand option).
- Audit consuming eval coherence verdicts as edge attributes — deferred with the above.
- A DB column for `describes` — unnecessary; `walkHop` already has `node.frontmatter`.
- Concurrency / incremental re-run for `--semantic` — out of scope until the call budget is squeezed.
- Embedding-inferred doc↔code links (no frontmatter) — rejected; explicit bindings are higher precision and #85 already deferred inference.
