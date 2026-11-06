# Declared frontmatter indexing and filtering — design

2026-09-03. Status: **approved in chat; pending written-spec review**.

Issue: [#512](https://github.com/mavaali/daftari/issues/512). Beads: `daftari-j2r`.

## Problem

[DATA] Daftari preserves arbitrary YAML frontmatter in markdown, and
`schema_extensions` gives selected custom fields types and validation. The
SQLite index promotes only built-in belief metadata. `vault_search` therefore
cannot answer a structured query such as “which tasks have `priority >= 2` and
`due_date < 2026-10-01`” without reading every matching document after retrieval.

[DATA] The current search candidate budgets belong to FTS5 and sqlite-vec.
Filtering their output afterward can starve the result set: disallowed
candidates consume the finite lexical or vector pool before eligible documents
reach the handler.

## Goals

1. Let a vault opt selected scalar `schema_extensions` into the ephemeral
   SQLite index.
2. Add typed equality and range predicates to `vault_search`.
3. Apply predicates inside lexical, vector, and filter-only SQL paths.
4. Preserve RBAC omission, federation semantics, markdown authority, and
   backward compatibility.
5. Fail loudly on malformed configuration and malformed filters.

## Non-goals

- A general query language, boolean expression tree, sorting language, joins,
  aggregation, grouping, or projections.
- Automatic indexing of undeclared frontmatter.
- Array membership, substring search, regex search, full-text search over
  custom values, or filtering `vault_search_related`.
- Replacing markdown frontmatter with SQLite state.
- Adding a new frontmatter type. Existing `number` covers integers and
  non-integer finite numbers.

## Decision 1 — `indexed_fields` references `schema_extensions`

The vault declares each field's type once:

```yaml
schema_extensions:
  due_date:
    type: date
  priority:
    type: number
  owner:
    type: string
  stage:
    type: enum
    enum: [queued, active, done]

indexed_fields:
  - due_date
  - priority
  - owner
  - stage
```

`indexed_fields` is an optional list of at most 64 unique field names. Each
name may contain at most 128 UTF-8 bytes. Omission and an empty list mean that
Daftari indexes no custom fields and behaves as before. These bounds keep a
mistyped or machine-generated config from multiplying every document into an
unbounded field projection.

Config loading rejects:

- a non-list value;
- a non-string or empty entry;
- a duplicate entry;
- more than 64 entries or a name longer than 128 UTF-8 bytes;
- a name absent from `schema_extensions`; or
- an extension of type `array`.

The supported indexed types are `string`, `enum`, `boolean`, `number`, and
`date`. Strings, enums, and booleans support equality. Numbers and dates
support equality and ordered comparisons. The array type stays unsupported
because one row can contain many values and “equal” has no unambiguous v1
meaning.

[HYPOTHESIS] A reference list is safer than a second field-to-type mapping
because the two declarations cannot disagree. This hypothesis is disproved if
vault owners need to index undeclared fields without validating writes; issue
#512 instead asks for opt-in, typed fields and points to the existing schema
machinery.

## Decision 2 — predicates are a bounded, conjunctive list

`vault_search` gains one optional argument:

```json
{
  "query": "renewal",
  "filters": [
    { "field": "priority", "op": "gte", "value": 2 },
    { "field": "due_date", "op": "lt", "value": "2026-10-01" },
    { "field": "stage", "op": "eq", "value": "active" }
  ]
}
```

Each predicate has exactly `field`, `op`, and `value`. The operators are `eq`,
`gt`, `gte`, `lt`, and `lte`. All predicates are ANDed. Callers express a
closed interval with two predicates on the same field. A document missing any
referenced field does not match.

The tool accepts at most 16 predicates. It rejects an empty `filters` list,
unknown keys, undeclared or unindexed fields, unsupported operators, and values
that do not match the declared type. It also rejects range operators for
`string`, `enum`, and `boolean` fields. Dates must be real calendar dates in
canonical `YYYY-MM-DD` form. Numbers must be finite. Enum values must belong to
the declared set. String and enum values may contain at most 4,096 UTF-8 bytes;
the same cap applies at index time so an equality lookup cannot place a
multi-megabyte YAML scalar in a B-tree key.

The list shape makes the MCP JSON Schema explicit and keeps SQL construction
independent of caller-supplied property names. The grammar contains no OR,
negation, nesting, or field-to-field comparison.

## Decision 3 — filters may run without free text

The current tool requires a non-empty `query`. Issue #512's motivating range
query has no necessary lexical term, so the new input contract requires at
least one of:

- a non-empty `query`; or
- a non-empty `filters` list.

When `query` is absent or blank, Daftari skips embedding and FTS work. It reads
matching documents through the typed field indexes, applies readable-collection
pushdown, orders by `updated DESC, path ASC`, and applies `limit`. Filter-only
hits use `score: 0`, `bm25Score: 0`, and `vectorScore: 0`; `vectorUsed` is false.
Zero states that the result is unranked instead of pretending every match has
maximum semantic relevance.

When `query` is present, ranking and scores retain their current meanings.
Filters restrict the candidate universe but do not contribute to relevance.

The response keeps `query` as a string for compatibility; filter-only searches
return `query: ""`. The human-readable summary calls these “filtered results,”
not BM25 results.

## Decision 4 — a controlled typed side table stores the projection

The index schema gains a derived table:

```sql
CREATE TABLE document_fields (
  path          TEXT NOT NULL,
  field         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  text_value    TEXT,
  number_value  REAL,
  bool_value    INTEGER,
  PRIMARY KEY (path, field),
  FOREIGN KEY (path) REFERENCES documents(path) ON DELETE CASCADE
);

CREATE INDEX idx_document_fields_text
  ON document_fields(field, text_value, path);
CREATE INDEX idx_document_fields_number
  ON document_fields(field, number_value, path);
CREATE INDEX idx_document_fields_bool
  ON document_fields(field, bool_value, path);
```

`kind` records `string`, `enum`, `date`, `number`, or `boolean`. Strings and
enums use `text_value`; dates use canonical `YYYY-MM-DD` in `text_value`;
numbers use `number_value`; booleans use `bool_value` as 0 or 1. Each row sets
one value column. Storage helpers bind field names and values as parameters;
caller input never becomes an identifier or raw SQL fragment.

This is a controlled entity-attribute-value projection: config bounds the
fields, types bound the values, one document has at most one row per field, and
the API admits only five operators. Dynamic columns were rejected because
each config edit would mutate SQLite DDL and interpolate vault-owned field
names. A JSON blob plus expression indexes was rejected because it weakens
type enforcement and still requires dynamic index lifecycle management.

The index schema version increases. A schema mismatch drops derived document,
chunk, field, FTS, and vector-mirror tables but preserves the content-addressed
embedding cache.

## Decision 5 — indexing reads authored values, never implied defaults

A full reindex loads config once, validates raw frontmatter against
`schema_extensions`, and projects only valid, present values named by
`indexed_fields`. An incremental index update uses the same function and
replaces the document's complete field-row set in the same transaction as its
document and chunk rows.

Missing values create no row. `schema_extensions.default` remains a write-time
materialization rule; reindexing an older file does not invent a value that is
absent from markdown. Invalid authored values create no field row and add the
field to the existing `invalidFrontmatter` warning path. Index projection uses
`normalizeIsoDate`, not the extension validator's current shape-only date
check, so impossible dates such as `2026-02-30` cannot enter an ordered index.
Config-default validation adopts the same real-calendar check. Values over the
4,096-byte string cap are invalid for indexing but remain untouched in
markdown. The markdown file stays the source of truth.

Deleting or replacing a document deletes its field rows. The schema declares a
foreign key for integrity, but helpers also delete by `path` explicitly because
the current connection setup does not rely on foreign-key enforcement.

## Decision 6 — config changes invalidate index freshness

The current manifest proves that markdown mtimes match the indexed snapshot;
it does not cover `.daftari/config.yaml`. Daftari therefore stores a canonical
fingerprint of the resolved indexed declarations in `meta`. The fingerprint
contains each indexed field's name, type, enum values, and declaration order.

`isIndexFresh` compares the stored fingerprint with current config. A missing
or different fingerprint makes the index stale and triggers the normal full
rebuild. A completed full rebuild stores the new fingerprint with the document
manifest. An incremental write never changes it.

This catches adding or removing an indexed field, changing a type, and changing
an enum domain without treating unrelated RBAC, hook, or search-tuning edits as
index changes.

## Decision 7 — SQL filters constrain every candidate path

A pure compiler validates filters against the vault's resolved indexed
declarations and produces typed predicates. A storage helper converts only
those trusted operators into correlated `EXISTS` clauses with bound values.

The lexical document query, lexical chunk query, title/tag query, and
filter-only query use the same `EXISTS` predicates. This placement is required:
applying predicates after retrieval lets ineligible documents occupy the
candidate pool and can return too few hits despite eligible documents existing.

The vector path needs a different physical plan. [DATA] sqlite-vec applies KNN
constraints only to metadata columns declared on the `vec0` virtual table and
allows at most 16 such columns. A joined `document_fields` predicate cannot be
pushed through `v.k`; post-filtering the K nearest vectors therefore violates
the no-starvation requirement. See sqlite-vec's
[vec0 metadata documentation](https://github.com/asg017/sqlite-vec/blob/main/site/features/vec0.md#metadata-columns).

When filters are present, vector ranking bypasses approximate `vec0` KNN. It
materializes eligible document paths from `document_fields`, joins their chunks
to the durable `embeddings` cache, computes exact cosine distance with
`vec_distance_cosine`, and keeps the best chunk per document. This scans only
eligible chunks and cannot starve. Unfiltered searches retain the current
`vec0` KNN path and its `vec_knn_k` budget.

Dynamic custom metadata columns on `embeddings_vec` were rejected. They would
cap a vault's indexed fields at sqlite-vec's metadata-column limit, rebuild
virtual-table DDL on config edits, and require one vector row per document chunk
instead of the current content-hash/collection mirror. Exact search over the
filtered subset keeps the generic side table, preserves the deduplicated
embedding cache, and changes only filtered calls. A performance test records
the tradeoff rather than describing exact scan as free.

Readable collections remain pushed into vector and filter-only SQL. The tool
handler retains its post-query RBAC filter as defense in depth. Counts,
summaries, rerank candidates, coverage additions, graph expansion, current
source enrichment, and read logging operate only on permitted hits.

Coverage and graph expansion do not bypass the filters. Any document added
after the initial rank must satisfy the same compiled predicates before it can
enter the result. Current-source enrichment may attach a successor that does
not match because the attachment explains the matched hit's lifecycle; it does
not become an independent hit or affect the count.

## Decision 8 — federation fails on incompatible selected vaults

Each selected vault resolves and validates the same caller predicates against
its own `schema_extensions` and `indexed_fields`. A federated search fails if
any selected vault lacks a field or declares an incompatible type or enum
domain. Silent skipping would make “no result” mean either “no matching
document” or “that vault could not execute the filter.” Silently ignoring a
predicate would return false positives.

Because an omitted `vaults` argument selects local plus every available mount,
a caller whose mounts do not share the field must pass an explicit compatible
scope such as `vaults: ["local"]`. The error names the incompatible vault and
field but reveals no document existence or count.

The referenced-vault config projection already carries `schema_extensions`.
It gains `indexed_fields`; hooks and other executable or mutable config remain
excluded. Mount indexes use the same field fingerprint, rebuild behavior, and
redirected index location as their existing document indexes.

## Error contract

Configuration errors occur at config load and begin with `malformed config:`.
Filter errors occur before opening an index or embedding a query and begin with
`vault_search 'filters'`. Errors include the predicate index and field when
available. Examples:

- `vault_search 'filters[0].field' names undeclared indexed field "severity"`
- `vault_search 'filters[1].op' cannot use "gte" with enum field "stage"`
- `vault_search 'filters[2].value' must be a finite number for "priority"`
- `vault_search requires a non-empty 'query' or at least one filter`

Errors quote values with JSON encoding and never include document values.

## Security and performance invariants

- Field names and values are SQL parameters. Operators map through a closed
  switch; no caller text enters SQL syntax.
- At most 16 predicates bound query construction and database work.
- Indexed and queried string values are capped at 4,096 UTF-8 bytes.
- RBAC constrains candidate selection before limits and remains enforced after
  retrieval.
- Filter validation happens before query embedding, so an invalid request does
  not spend model or API work.
- The index remains disposable. Deleting `index.db` and reindexing from markdown
  plus config reproduces all custom field rows.
- No error, count, or remainder reports unreadable documents.

## Documentation and tests

Update `docs/schema-extensions.md`, `docs/getting-started.md`, and the MCP tool
description with configuration, operators, filter-only semantics, federation
behavior, and examples.

Tests must cover:

- config defaults and every rejection listed in Decision 1;
- schema-version rebuild and preservation of the embedding cache;
- full and incremental indexing, replacement, deletion, absent values,
  defaults, invalid values, all supported types, and config fingerprint drift;
- equality and each range boundary, repeated-field intervals, conjunction,
  missing fields, empty results, limits, and filter-only ordering;
- lexical, chunk, title/tag, and vector candidate pushdown;
- exact filtered-vector equivalence against a brute-force oracle, plus a
  recorded 10,000-document filtered-search benchmark;
- invalid filter shapes, types, dates, enums, operators, and the 16-predicate
  cap;
- RBAC omission, rerank pools, coverage additions, and graph expansions;
- compatible and incompatible federated vaults; and
- unchanged behavior for a vault with no `indexed_fields` and for ordinary
  text-only `vault_search` calls.

## Kill conditions

Stop or redesign before merge if any of these occurs:

1. SQL query plans for an equality or range predicate scan all
   `document_fields` rows instead of using a typed index.
2. A restricted role can infer an unreadable document through hits, counts,
   errors, candidate starvation, or timing assertions in deterministic tests.
3. Changing `indexed_fields` can leave a fresh-looking index with stale custom
   rows.
4. Filter-only results require fabricated positive relevance scores.
5. A 10,000-document benchmark shows exact filtered-vector ranking exceeds
   250 ms p95 for a predicate matching 10% of documents on the supported local
   development machine. If it fires, filtered calls ship lexical-only in v1
   with `vectorUsed: false`; they do not silently run an unbounded slow path.
6. Supporting filters in FTS or vector paths requires caller-controlled SQL
   syntax or dynamic SQLite columns.

## Displacement

This work displaces broader structured-query features. It deliberately leaves
OR, sorting, arrays, aggregation, and `vault_search_related` filters for
evidence-backed follow-ups. Adding them now would expand the public query
language before the typed equality/range wedge proves useful.
