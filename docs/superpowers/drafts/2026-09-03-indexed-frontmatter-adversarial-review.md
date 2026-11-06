# Adversarial review — declared frontmatter indexing and filtering

2026-09-03. Reviewed artifact:
`docs/superpowers/specs/2026-09-03-indexed-frontmatter-filtering-design.md`.

Verdict: **GO WITH CHANGES**. The initial design had two correctness failures
and four operational gaps. The revised spec resolves the design failures and
turns filtered-vector cost into an empirical merge gate.

## What it is

[DATA] The design adds an opt-in `indexed_fields` list that references typed
`schema_extensions`, stores authored scalar values in a derived SQLite side
table, and adds conjunctive equality/range predicates to `vault_search`. It
supports text-plus-filter and filter-only calls, validates each selected
vault's schema under federation, and preserves markdown as the source of truth.

## What's genuinely good

- [DATA] One declaration owns each type. `indexed_fields` names existing
  extensions instead of creating a second, conflicting type map.
- [DATA] The public grammar has five operators, AND composition, and bounded
  cardinality. It does not smuggle in a query language.
- [DATA] Config fingerprints close a real freshness hole: markdown mtimes alone
  cannot detect a changed indexed-field projection.
- [DATA] Missing fields fail the predicate instead of receiving invented
  defaults. Reindexing remains a projection of authored markdown.
- [DATA] The design names federation incompatibility instead of silently
  skipping a vault or ignoring a predicate.

## What's overstated or missing

### 1. Critical — generic predicates cannot pass through the current KNN budget

[DATA] The initial design said a joined side-table predicate would constrain
sqlite-vec before `v.k`. sqlite-vec recognizes KNN constraints only on metadata
columns declared on the `vec0` table. A correlated predicate on
`document_fields` runs outside that virtual-table constraint. Nonmatching
vectors could therefore consume all K slots.

Worst case: the first 256 semantic neighbors miss `priority >= 2`, while the
257th matches. Post-filtering returns no vector hit even though an eligible hit
exists.

Disposition: fixed. Filtered vector ranking now materializes eligible paths and
computes exact cosine distance over their cached chunk embeddings. Unfiltered
calls retain sqlite-vec KNN. The implementation must prove equivalence against
a brute-force oracle and pass the 10,000-document p95 gate.

### 2. High — text-required search does not answer the motivating query

[DATA] The initial design preserved `vault_search`'s non-empty-query rule. That
cannot directly answer “which entities have `due_date` in this range?” because
the caller has no honest lexical term to supply.

Disposition: fixed. A non-empty filter list can stand alone. Filter-only hits
are unranked, carry zero relevance scores, and sort by `updated DESC, path ASC`.

### 3. High — config drift can leave a stale projection marked fresh

[DATA] The current freshness manifest tracks markdown mtimes, not
`.daftari/config.yaml`. Adding or removing an indexed field could leave old
rows active indefinitely.

Disposition: fixed. A canonical indexed-field fingerprint participates in
freshness and forces a rebuild on field, type, enum-domain, or order changes.

### 4. High — post-ranking expansion can violate a filter

[DATA] Coverage and graph expansion add documents after the initial rank. RBAC
filters those additions today, but a new field predicate would not apply
automatically.

Worst case: a correctly filtered seed pulls an unfiltered same-entity or graph
neighbor into the final hits.

Disposition: fixed in the spec. Every independent added hit must satisfy the
compiled predicates. Lifecycle attachments may explain a matched hit without
becoming counted hits.

### 5. Medium — shape-valid dates may still be impossible dates

[DATA] The extension validator currently accepts any `YYYY-MM-DD` shape, while
built-in date normalization rejects impossible calendar values. Ordered custom
date filtering would otherwise index `2026-02-30` as if it were meaningful.

Disposition: fixed. Index projection and config-default validation use
`normalizeIsoDate`; bad authored values stay in markdown, produce no field row,
and enter the invalid-frontmatter warning path.

### 6. Medium — opt-in alone does not bound index amplification

[HYPOTHESIS] Machine-generated configuration could declare hundreds or
thousands of fields and multiply each document into the same number of index
rows. This concern is disproved if config provenance has a separate hard size
and key-count bound; no such bound appears in the reviewed config path.

Disposition: fixed. The revised design caps indexed fields at 64, field names
at 128 UTF-8 bytes, predicates at 16, and indexed string values at 4,096 UTF-8
bytes.

### 7. Medium — federation's correct behavior has a usability cost

[DATA] An omitted `vaults` argument searches all available mounts. One mount
without the field will make a filtered default-scope call fail, even if the
caller intended the local vault.

Disposition: accepted. Silent exclusion makes absence ambiguous, and silently
ignoring the predicate returns false positives. Documentation must show
`vaults: ["local"]` for vault-specific fields.

### 8. Residual risk — exact filtered vector search may be slow for broad filters

[HYPOTHESIS] Exact distance over a selective field subset will stay within the
250 ms p95 gate at 10,000 documents. A benchmark over cached 384-dimensional
vectors with a predicate matching 10% of documents disproves the hypothesis if
p95 exceeds 250 ms.

Disposition: unresolved by design. The benchmark is a merge gate. Failure
ships filtered search as lexical-only with `vectorUsed: false`; it does not
ship an unbounded slow path or a starving approximate path.

## Substitution test result

[DATA] This feature has one implementation graph and shared invariants across
config, index, and search. Parallel implementers would collide in the same
files and split the model needed to reason about freshness, RBAC, and ranking.
A single implementation owner is the correct execution model.

[HYPOTHESIS] Independent adversarial checkpoints add value here through fresh
assumption attacks, not through multi-agent production. This is disproved if
the post-implementation review finds only issues already encoded in the spec
and tests. The final review must therefore try to break the diff rather than
summarize it.

## Implications for implementation

- Preserve the reviewed invariants in test names, not comments alone.
- Prove each TDD red failure before production edits.
- Run a second adversarial review over the finished diff, including SQL query
  plans, RBAC/federation probes, malformed inputs, config drift, and the
  filtered-vector benchmark.
- Block handoff on every critical or high finding. Record medium findings with
  an explicit fix, acceptance, or follow-up Beads issue.
