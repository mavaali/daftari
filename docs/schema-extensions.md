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
  order; extension fields follow, in config declaration order. Output is stable
  and round-trippable regardless of the input object's key order.
- **Reads.** Extension fields are preserved in the file, so they surface in
  `vault_read`'s parsed frontmatter automatically. No read-path configuration
  is needed.

What does **not** change: the built-in field set (this release ships zero new
core fields), RBAC, write locks, git auto-commit, the provenance log, and the
curation engine — `vault_lint`, TTL staleness, and the tension log operate on
built-ins only.

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

## Back-compat for existing vaults

Schema extensions are opt-in. A vault whose `.daftari/config.yaml` has no
`schema_extensions` block — or has no config file at all — is unaffected: write
output is byte-identical to the pre-extension behavior. Adopting extensions is
a matter of adding the block; existing documents keep working, and an extension
field is simply absent (or filled from its `default`) until a write supplies
it.

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
