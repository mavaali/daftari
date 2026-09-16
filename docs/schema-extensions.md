# Schema extensions

Daftari's built-in frontmatter — `title`, `domain`, `collection`, `status`,
`confidence`, `created`, `updated`, `updated_by`, `provenance`, `sources`,
`superseded_by`, `ttl_days`, `tags`, `questions_answered`, `questions_raised` —
covers most vaults out of the box. When a vault needs domain-specific metadata
(an ADR's decision date, a runbook's owning team, a spec's tracking ID), you
can declare **schema extensions**: typed frontmatter fields, configured per
vault, that participate in validation and serialization alongside the
built-ins.

Extensions are additive. A vault with no `schema_extensions` block behaves
exactly as before — see [Back-compat](#back-compat-for-existing-vaults).

## The `schema_extensions` block

Schema extensions are declared in `.daftari/config.yaml`, the same file that
holds RBAC roles:

```yaml
version: 1
vault_name: my-vault

schema_extensions:
  <field_name>:
    type: string | date | number | boolean | array | enum
    required: true | false           # default false
    default: <value>                 # used when the field is missing on write
    enum:                            # required when type == enum
      - value_a
      - value_b
    items: string                    # required when type == array (v1: array<string>)
    pattern: "<regex>"               # optional, only valid for type == string
```

The block is a mapping from field name to declaration. Declaration order is
preserved — it determines the order extension fields are written to a file.

### Type primitives

| `type`    | Accepts                                  | Serialized as                |
|-----------|------------------------------------------|------------------------------|
| `string`  | a string; optional `pattern` regex check | a YAML string                |
| `date`    | a `YYYY-MM-DD` date                      | a `YYYY-MM-DD` string        |
| `number`  | a finite number                         | a YAML number                |
| `boolean` | `true` / `false`                        | a YAML boolean               |
| `array`   | a list of strings (`items: string`)      | a YAML block sequence        |
| `enum`    | one of the declared `enum` values        | a YAML string                |

`array` in v1 is `array<string>` only — `items` must be `string`. `enum`
requires a non-empty `enum` list of string values.

### Config validation is loud

A malformed `schema_extensions` declaration **fails config load** — the server
refuses to start, the same contract RBAC config errors follow. A broken schema
is better caught at boot than half-applied at write time. Load fails on:

- a field name that shadows a built-in field (`title`, `status`, `tags`, …)
- an unknown `type`
- `type: enum` with no `enum` list, or an empty one
- `type: array` without `items: string`
- `pattern` on a non-`string` field, or a `pattern` that is not a valid regex
- `enum` declared on a non-`enum` field, or `items` on a non-`array` field
- `required` that is not a boolean
- a `default` whose value does not match the declared type

Field-level problems (a document missing a required extension, a value of the
wrong type) stay **advisory**, exactly like built-in frontmatter validation:
they appear in the validation report; `vault_write` rejects an invalid write,
but a read is never blocked.

## How extensions behave

- **Validation.** `vault_write` checks each declared extension against the raw
  frontmatter: a missing required field, a wrong-typed value, an out-of-enum
  value, or a `pattern` mismatch each produces a validation issue and the write
  is rejected.
- **Defaults.** A field that is missing on write and has a declared `default`
  is filled with that default. A required field with a default is therefore
  never "missing".
- **Serialization.** Built-in fields are written first, in their fixed schema
  order; declared extension fields follow, in config declaration order. Any
  *undeclared* frontmatter the document already carries is preserved after
  those, in its existing order, untyped — writes are non-destructive and never
  silently drop a field an author put there (see [Undeclared fields](#undeclared-fields)).
  Output is stable and round-trippable regardless of the input object's key
  order.
- **Reads.** Extension fields are preserved in the file, so they surface in
  `vault_read`'s parsed frontmatter automatically. No read-path configuration
  is needed.

## Structured search with `indexed_fields`

Schema validation does not make every extension queryable. A vault opts scalar
extensions into the rebuildable SQLite search projection with an ordered list:

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
    enum: [planned, active, done]

indexed_fields: [due_date, priority, owner, stage]
```

Every name must resolve to a declared `schema_extensions` field. `string`,
`enum`, `boolean`, `number`, and `date` are supported; arrays cannot be indexed.
A vault may declare at most 64 indexed fields, and each field name may occupy at
most 128 UTF-8 bytes. Config loading fails on unknown, duplicate, oversized, or
array declarations.

`vault_search` accepts up to 16 predicates under `filters`. Predicates are
combined with AND; a document missing any named field does not match. `eq`
supports every indexable type, while `gt`, `gte`, `lt`, and `lte` support only
`number` and `date`. Values are typed rather than coerced, and string/enum
predicate values are capped at 4096 UTF-8 bytes.

```jsonc
// Hybrid retrieval constrained before lexical and vector ranking
{
  "query": "launch dependencies",
  "filters": [
    { "field": "stage", "op": "eq", "value": "active" },
    { "field": "due_date", "op": "lte", "value": "2026-09-30" }
  ]
}

// Structured retrieval without a text query
{
  "filters": [{ "field": "priority", "op": "gte", "value": 2 }]
}
```

A filter-only search orders matches by `updated` descending, then path
ascending, and reports zero search scores with `vectorUsed: false`. With a text
query, the same predicates constrain both lexical retrieval and exact cosine
comparison over the matching documents' durable embeddings; an unavailable
embedding provider still degrades to lexical-only retrieval.

Only a value authored in a document is projected. A schema default is not
silently materialized into the index for an older file that omits the field.
Invalid or oversized authored values remain on disk, are reported during
reindex, and are omitted from the projection. Changing `indexed_fields` changes
the index fingerprint, so the next freshness check rebuilds the projection.
The `document_fields` rows and their typed indexes are derived cache state:
deleting `.daftari/index.db` and running `vault_reindex` recreates them from the
Markdown files.

Federated search validates the same raw predicate list independently against
every selected vault. Each selected vault must declare a compatible indexed
field or the call fails with that mount's alias; use `vaults: ["local"]` when a
heterogeneous mount should be excluded. RBAC filtering happens within each
vault before cross-vault rank fusion, so filtered search does not reveal hidden
documents or hidden-document counts.

This is deliberately not a general query language: there is no OR, NOT,
nesting, aggregation, arbitrary SQL, or automatic indexing of undeclared
frontmatter.

### Undeclared fields

A field that is neither built-in nor a declared extension is still **preserved**
on every write. Declaring it as a schema extension adds validation, typed
serialization, and defaults; leaving it undeclared means it round-trips as-is,
untyped, with no validation. Either way a tool-mediated write (`vault_write`,
`vault_append`, `vault_promote`, `vault_deprecate`, `daftari backfill`) carries
it forward rather than dropping it. To remove an undeclared field on a
`vault_write`, set it to `null` in the payload (opt-in deletion).

What does **not** change: the built-in field set (this release ships zero new
core fields), RBAC, write locks, git auto-commit, the provenance log, and the
curation engine — `vault_lint`, TTL staleness, and the tension log operate on
built-ins only.

To inspect the gap between authored metadata and this declaration, run
`daftari schema infer --vault <path>` and `daftari schema diff --vault <path>`.
The former works without a config and reports the raw frontmatter keys and
value shapes already present. The latter loads this block and reports unused
extensions, observed values that fail the canonical validator, widely used
undeclared fields (two occurrences by default, configurable with
`--min-occurrences`), and near-miss field names. Both are read-only; add
`--scope <folder>` to constrain the walk or `--json` for machine-readable
output. The vault and an explicit scope must exist as directories. Scope checks
use canonical paths so symlinks cannot escape the selected folder or count the
same document twice. Inference examples, distinct tracking, drift problem
categories, and drift path/value evidence are bounded; recursive aliases and
non-finite YAML numbers are rendered as JSON-safe evidence.

## Worked example — an ADR vault

A vault of Architecture Decision Records wants four fields beyond the built-in
set: a tracking ID, a decision date, the deciding stakeholders, and a ratified
flag.

`.daftari/config.yaml`:

```yaml
version: 1
vault_name: adr-vault

schema_extensions:
  adr_id:
    type: string
    required: true
    pattern: "^ADR-[0-9]{3,}$"
  decision_date:
    type: date
    required: true
  stakeholders:
    type: array
    items: string
  ratified:
    type: boolean
    default: false
```

A document in that vault:

```markdown
---
title: "Adopt SQLite for the index store"
domain: accumulation
collection: decisions
status: canonical
confidence: high
created: 2026-05-01
updated: 2026-05-01
updated_by: agent:claude-code
provenance: direct
sources: []
superseded_by: null
ttl_days: null
tags: [storage, index]
questions_answered: []
questions_raised: []
adr_id: ADR-014
decision_date: 2026-04-28
stakeholders:
  - platform
  - data
ratified: true
---

# Adopt SQLite for the index store

...
```

What the schema enforces here:

- `adr_id` is required and must match `^ADR-[0-9]{3,}$` — a write with
  `adr_id: DECISION-1` (or no `adr_id` at all) is rejected.
- `decision_date` is required and must be a `YYYY-MM-DD` date.
- `stakeholders` must be a list of strings if present; it is optional.
- `ratified` is optional; a document written without it gets `ratified: false`.

## Worked example — Distill reader provenance

The distill ingest pipeline can stamp each compiled belief with a **reader
fingerprint**: the LLM run configuration that extracted it (which model was
requested and served, the effective temperature, whether it took the retry
path, a short hash of the extraction prompt contract, the chunk window and
input cap, plus a `readers` parentage set a later merge unions). These land only
if the vault declares them. Declare all eight as **optional** extensions — they
are advisory, they never block a write, and they are absent on any document
distill did not touch:

`.daftari/config.yaml`:

```yaml
version: 1
vault_name: my-vault

schema_extensions:
  reader_model:
    type: string
  reader_served_model:
    type: string
  reader_temperature:
    type: number
  reader_via_retry:
    type: boolean
  reader_prompt_version:
    type: string
  reader_chunk_window:
    type: number
  reader_input_cap:
    type: number
  readers:
    type: array
    items: string
```

Notes on the field semantics distill writes:

- Every field is **optional** — a claim whose run metadata is unknown (an older
  extraction path, or a mock) is stamped with none of them, and that is valid.
- `reader_served_model` carries the sentinel string `"unreported"` when the
  provider did not report a served model. Distill never writes `null` here,
  because a `null` on a declared extension **deletes** the field.
- `reader_temperature` is a `number`, so it cannot carry a sentinel: distill
  **omits** the field entirely when no temperature was sent, rather than writing
  a placeholder.
- `reader_via_retry` is a `boolean` that is often `false`. `false` serializes
  and round-trips like any value — only `null`/absent is dropped — so a
  first-try extraction keeps `reader_via_retry: false` across later
  frontmatter edits (promote, set_tier, …).
- `readers` holds one entry at ingest; a later merge unions the sets from the
  merged beliefs. Each entry is a compact single-line encoding of one reader.

## Back-compat for existing vaults

Schema extensions are opt-in. A vault whose `.daftari/config.yaml` has no
`schema_extensions` block — or has no config file at all — is unaffected:
built-in frontmatter serializes exactly as before, and any custom fields a
document carries are preserved untyped (see [Undeclared fields](#undeclared-fields)).
Adopting extensions is a matter of adding the block; existing documents keep
working, and an extension field is simply absent (or filled from its `default`)
until a write supplies it.

## Out of scope (v1)

Deliberately deferred:

- **Per-collection requirements** — a `required_for: [<collection>]` form so a
  field can be mandatory in one collection and optional in another. v1
  `required` is vault-wide. Tracked as a follow-up.
- **Object / nested types** — extension values are scalars, `string[]`, or
  `null`. Nested mappings are not supported.
- **Custom enums on built-in fields** — extensions add new fields; they cannot
  narrow or redefine a built-in field's allowed values.
- **`array` of non-string items** — v1 `array` is `array<string>` only.
