# Declared Frontmatter Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let vault owners opt specific scalar schema-extension fields into a typed SQLite projection, then AND equality/range predicates over those fields into `vault_search`, including filter-only and federated searches.

**Architecture:** Configuration resolves `indexed_fields` names against existing `schema_extensions`. Reindexing writes authored, valid scalar values into a bounded `document_fields` EAV table and fingerprints the resolved declarations. A pure filter compiler validates untrusted MCP input into typed predicates, then search code binds those predicates into lexical, exact-vector, filter-only, coverage, and graph-expansion candidate paths. Unfiltered search remains unchanged.

**Tech Stack:** TypeScript, Node.js, Vitest, better-sqlite3, sqlite-vec, YAML frontmatter, MCP JSON Schema, Biome.

**Spec:** `docs/superpowers/specs/2026-09-03-indexed-frontmatter-filtering-design.md`

## Global Constraints

- Preserve the local git checkout and implement only in `.worktrees/issue-512-indexed-frontmatter`.
- Use red-green-refactor: add one focused failing test, observe the expected failure, implement the minimum behavior, rerun the focused test, then commit each coherent task.
- Never interpolate user-controlled field names, operators, or values as SQL identifiers/fragments. Only closed, internally selected SQL fragments may be interpolated; all values remain bound parameters.
- Preserve current behavior and sqlite-vec KNN for unfiltered searches.
- Treat RBAC post-filtering as the authorization boundary even when readable collections are pushed into SQL.
- Keep `document_fields` rebuildable and keep cached `embeddings` across the schema-version migration.
- Do not add filtering to `vault_search_related`, OR semantics, arrays, aggregation, joins, projections, or a general query DSL.

---

## Task 1: Parse and resolve indexed-field configuration

**Files:**

- Modify: `src/utils/config.ts`
- Modify: `test/utils/config.test.ts`
- Modify: `test/frontmatter/schema-extensions.test.ts`

- [ ] Add failing config tests for a valid `indexed_fields` list resolving string, enum, boolean, number, and date declarations from `schema_extensions`.
- [ ] Add failing tests for unknown names, duplicate names, array fields, more than 64 fields, names over 128 UTF-8 bytes, and non-array/non-string entries. Assert errors name `indexed_fields` and the offending entry.
- [ ] Add failing calendar-date tests showing impossible extension values/defaults such as `2026-02-30` are invalid, while YAML `Date` objects normalize to `YYYY-MM-DD`.
- [ ] Run `npx vitest run test/utils/config.test.ts test/frontmatter/schema-extensions.test.ts` and confirm the new assertions fail for missing validation.
- [ ] Add `IndexedFieldDeclaration` and `indexedFields: IndexedFieldDeclaration[]` to `DaftariConfig`. Parse `indexed_fields` after `schema_extensions`, resolve names without duplicating types, enforce limits, and return declarations in authored order.
- [ ] Reuse `normalizeIsoDate` for schema-extension date values and defaults rather than regex-only acceptance.
- [ ] Rerun the focused tests and `npm run build`; commit as `feat(config): declare indexed frontmatter fields`.

## Task 2: Add the derived SQLite field projection and migration

**Files:**

- Modify: `src/storage/index-db.ts`
- Modify: `test/storage/index-db.test.ts`
- Modify: `test/storage/schema-valid-from-migration.test.ts`

- [ ] Add failing storage tests for the `document_fields` table shape, its three typed lookup indexes, replacement of a document's rows, explicit deletion, and clearing the derived projection.
- [ ] Add a failing migration test proving a version-11 index upgrades without losing durable `embeddings` rows and removes stale projected fields.
- [ ] Run the focused storage tests and confirm failure because schema version 11 has no projection table.
- [ ] Bump the index schema version to 12; create `document_fields(path, field, kind, text_value, number_value, bool_value)` with primary key `(path, field)` and the specified foreign key and lookup indexes.
- [ ] Define `IndexedFieldValue` as a discriminated scalar row and implement `replaceDocumentFields`, `deleteDocumentFields`, and clear-index integration in the same write transactions as document/chunk updates.
- [ ] Ensure schema recreation drops `document_fields` but preserves `embeddings`; make document deletion explicit instead of depending on foreign-key pragma state.
- [ ] Rerun focused tests, build, and commit as `feat(index): store typed frontmatter projection`.

## Task 3: Populate fields and fingerprint index configuration

**Files:**

- Modify: `src/search/reindex.ts`
- Modify: `src/federation/mount-index.ts`
- Modify: `test/search/reindex.test.ts`
- Modify: `test/search/index-state.test.ts`
- Modify: `test/search/watcher-integration.test.ts`

- [ ] Add failing full-reindex tests that persist authored valid scalar values with correct typed columns, omit missing/defaulted/invalid values, normalize dates, and reject text over 4,096 UTF-8 bytes from projection while retaining the document's normal invalid-frontmatter warning behavior.
- [ ] Add failing incremental-index tests proving an edit replaces stale field rows and deletion removes them.
- [ ] Add failing freshness tests proving unchanged declarations remain fresh while changing indexed names, types, enum members, or order makes the index stale.
- [ ] Run focused reindex/index-state tests and observe failures for absent projection/fingerprint behavior.
- [ ] Pass resolved declarations into full and incremental staging. Validate raw frontmatter with schema extensions, derive only authored values, and attach `IndexedFieldValue[]` to each staged document.
- [ ] Compute a stable JSON fingerprint over resolved `{field,type,enum}` declarations in authored order, store it in index metadata, and compare it in `isIndexFresh` for local and mount indexes.
- [ ] Write document fields atomically during full and incremental index updates; preserve the current warning/reporting contract for invalid frontmatter.
- [ ] Rerun focused tests and build; commit as `feat(reindex): project configured frontmatter fields`.

## Task 4: Validate filters and compile safe SQL predicates

**Files:**

- Create: `src/search/field-filters.ts`
- Create: `test/search/field-filters.test.ts`

- [ ] Define external `FieldFilterInput` and internal `CompiledFieldFilter` types. Add failing tests for `eq` on all supported scalar types and `gt|gte|lt|lte` on only number/date.
- [ ] Add failing tests for absent/non-array filters, empty arrays, more than 16 predicates, malformed objects, unknown/undeclared fields, wrong value types, impossible dates, non-finite numbers, oversized strings, arrays, and unsupported operators.
- [ ] Add injection-shaped field/value tests and assert generated SQL contains only fixed `EXISTS` templates plus `?` placeholders while hostile text appears only in bound parameters.
- [ ] Run `npx vitest run test/search/field-filters.test.ts` and confirm the module/tests fail before implementation.
- [ ] Implement `parseFieldFilters(raw, declarations): Result<CompiledFieldFilter[], Error>` with clear `vault_search 'filters'` errors and 16-predicate/4,096-byte caps.
- [ ] Implement `compileFieldFilterSql(filters, pathExpression)` returning `{sql, params}`. Compile each predicate to a correlated `EXISTS` over `document_fields`, AND clauses in input order, and use closed operator/column maps.
- [ ] Rerun focused tests, build, and commit as `feat(search): validate typed field predicates`.

## Task 5: Apply filters to lexical and filter-only retrieval

**Files:**

- Modify: `src/search/hybrid.ts`
- Modify: `src/tools/search.ts`
- Modify: `test/search/hybrid.test.ts`
- Modify: `test/tools/search.test.ts`
- Modify: `test/search/sql-native.test.ts`
- Modify: `test/search/acl-pushdown.test.ts`

- [ ] Add failing hybrid tests proving document- and chunk-level BM25 exclude nonmatching docs before rank/limit and keep unfiltered results byte-compatible.
- [ ] Add failing tool tests allowing absent/blank `query` only when `filters` is nonempty, rejecting empty query plus empty/no filters, and returning filter-only results ordered by `updated DESC, path ASC` with all scores zero and `vectorUsed: false`.
- [ ] Add failing equality/range, AND, missing-field, limit, and RBAC tests. Assert restricted docs do not consume the filter-only result limit and do not leak through counts/messages.
- [ ] Run focused tests and observe expected failures in query validation and result selection.
- [ ] Thread compiled filters through `HybridSearchOptions` and both lexical SQL paths. Add a SQL-native filter-only selector that includes readable collection pushdown and still passes results through `canRead`.
- [ ] Change `vaultSearch` validation so filter parsing happens before opening the index or loading embeddings. Return `query: ""` and a filter-specific summary for filter-only calls.
- [ ] Apply the same compiled predicate check to independently added coverage and graph-expansion documents before they enter results; leave explanatory current-source attachment behavior unchanged.
- [ ] Extend the MCP input schema with `filters` and make `query` optional at JSON-schema level while enforcing the query-or-filter invariant in the handler.
- [ ] Rerun focused tests, build, and commit as `feat(search): filter lexical and structured retrieval`.

## Task 6: Preserve hybrid semantics with exact filtered vector search

**Files:**

- Modify: `src/search/hybrid.ts`
- Modify: `test/search/vector.test.ts`
- Modify: `test/search/hybrid.test.ts`
- Modify: `test/search/acl-pushdown.test.ts`

- [ ] Add failing tests proving filtered vector search never uses the approximate `embeddings_vec ... MATCH ... k=?` path, computes cosine distance from durable cached embeddings only for eligible paths, collapses chunks to the best distance per document, and preserves readable-collection pushdown.
- [ ] Add failing tests that unfiltered searches still use sqlite-vec KNN and that missing query embeddings fall back to filtered lexical ranking.
- [ ] Run focused vector/hybrid tests and confirm filtered calls currently consume the unfiltered KNN budget.
- [ ] Implement an exact filtered vector ranking query: materialize eligible document paths via bound field predicates and readable collections, join chunks to durable `embeddings` for the active model, compute `vec_distance_cosine`, group by path using the best chunk, and rank deterministically.
- [ ] Select exact filtered vector ranking only when filters are present; retain the existing approximate vec0 path for unfiltered queries and skip all vector work for filter-only queries.
- [ ] Inspect `EXPLAIN QUERY PLAN` in tests to confirm a `document_fields` lookup index narrows eligible paths before the embeddings scan.
- [ ] Rerun focused tests, build, and commit as `feat(search): rank filtered vectors exactly`.

## Task 7: Validate and execute filters across federation

**Files:**

- Modify: `src/federation/mounts.ts`
- Modify: `src/tools/search.ts`
- Modify: `test/federation/search.test.ts`

- [ ] Add failing mount-loading tests proving each `LoadedMount` exposes its resolved indexed declarations.
- [ ] Add failing federated search tests for shared-compatible filters, a selected vault with an undeclared/incompatible field, explicit `vaults: ["local"]`, filter-only RRF inputs, prefixed paths, RBAC, and no hidden-document existence/count disclosure.
- [ ] Run federation tests and confirm filters are neither validated nor propagated today.
- [ ] Add indexed declarations to `LoadedMount`; validate the same raw predicate list independently against every selected vault before any search begins.
- [ ] Pass each vault's typed compiled predicates into its local search pipeline and preserve existing per-vault post-filtering and cross-vault RRF behavior. Prefix paths only after each vault's filtering/authorization pass.
- [ ] Return an alias-qualified error when a selected mount cannot support a predicate; keep omission-as-all-vaults semantics and document the `vaults: ["local"]` escape hatch.
- [ ] Rerun focused federation tests, build, and commit as `feat(federation): enforce indexed filters per vault`.

## Task 8: Prove the performance fallback and document the contract

**Files:**

- Create: `test/search/indexed-fields-performance.test.ts`
- Modify: `docs/schema-extensions.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/architecture.md`
- Modify: `src/tools/search.ts`

- [ ] Add a deterministic 10,000-document performance test/benchmark fixture with a 10% matching predicate and warmed database. Measure the exact filtered-vector query p95 across repeated runs on the supported local development machine.
- [ ] Run the benchmark. If p95 is at most 250 ms, retain exact filtered vector search and record the measured command/result in the test comment or a results note. If it exceeds 250 ms, change filtered calls to lexical-only with `vectorUsed: false`, add a regression assertion, and do not ship the slow path.
- [ ] Document `schema_extensions` plus `indexed_fields`, supported types/operators, caps, AND/missing semantics, authored-only indexing, filter-only ordering/scores, federation compatibility, and the fact that the database projection is rebuildable.
- [ ] Update `vault_search` tool descriptions/examples without describing this as a general query language.
- [ ] Run the benchmark again after documentation/code cleanup; commit as `docs(search): explain declared field filtering`.

## Task 9: Full verification and durable issue update

**Files:**

- Modify if needed: implementation and tests from Tasks 1–8
- Update through CLI: Beads issue `daftari-j2r`

- [ ] Run focused suites for config, schema extensions, storage, reindex/freshness, filter compiler, hybrid/vector/ACL, tool search, and federation.
- [ ] Run `npm run build`, `npm run lint`, and `npm test`. Fix every regression introduced by this branch and rerun the failing scope before rerunning the full suite.
- [ ] Inspect `git diff --check`, `git status --short`, and `git diff --stat origin/main...HEAD`.
- [ ] Update `daftari-j2r` with implemented behavior, performance result, validation commands/results, and remaining risk. Keep it open until the PR is review-ready and checks are green.

## Task 10: Cold adversarial review and remediation

**Files:**

- Create: `.jugalbandi/review-issue-512/diff.md`
- Create: `.jugalbandi/review-issue-512/findings.md`
- Modify if needed: any reviewed implementation/test/doc files

- [ ] Resolve the default branch with `git symbolic-ref refs/remotes/origin/HEAD`; generate the raw `origin/main...HEAD` diff at a unique `.jugalbandi/review-issue-512/` path.
- [ ] Confirm full project checks pass before review. Identify whether a matching Jugalbandi final plan exists; do not attach the approved superpowers spec/plan as reviewer context.
- [ ] Spawn the cold reviewer with exactly: `Read .jugalbandi/review-issue-512/diff.md. That diff is the entire change under review — it is all the context you get. Write your findings to .jugalbandi/review-issue-512/findings.md.`
- [ ] Triage findings by Critical/High/Medium/Low. Fix all Critical and High findings through new failing tests. Give each Medium finding an explicit fix or documented disposition; fix useful Low findings without scope expansion.
- [ ] Rerun focused and full verification after remediation, regenerate the review diff, and commit review-driven fixes. Keep reviewer artifacts uncommitted unless repository convention explicitly tracks them.

## Task 11: Open the pull request and iterate to review-ready

**Files:**

- Modify if needed: files implicated by CI or review comments
- Update through CLI: GitHub issue #512, pull request, Beads issue `daftari-j2r`

- [ ] Read and follow `superpowers:finishing-a-development-branch`. Rebase or merge the latest `origin/main` only if needed, without touching the original dirty checkout; rerun full verification after integration.
- [ ] Push `codex/issue-512-indexed-frontmatter` to `origin` and verify the remote SHA matches local HEAD.
- [ ] Open a PR against `main` that links `Fixes #512`, states behavior/non-goals/security properties, lists tests and performance result, and summarizes adversarial-review dispositions.
- [ ] Watch required checks to completion. For every failing check, reproduce locally when possible, add or adjust a regression test, fix, rerun proportional/full verification, commit, push, and verify the new remote SHA.
- [ ] Read all PR review comments and requested changes. Address actionable comments with the same test-first loop; respond with concrete evidence or an explicit technical rationale when no code change is warranted.
- [ ] Repeat until required checks are green and there are no unresolved actionable comments. Mark Beads `daftari-j2r` complete only then, recording the PR URL and verified final remote SHA.

