# Scoped addressing — design

2026-11-08. Status: **implemented on `feat/scoped-addressing`; pending review**.

Prior-art scan: none. The vault and `docs/` have no earlier scoped or stable
addressing design.

## Problem

Several writers, such as a CI job, an editor agent, and a review bot, want to
share memory about one subject. For example: "the checkout repo's tests need a
local Postgres". Today each writer has to invent a path. Two writers pick two
paths, so one fact ends up in two notes. Looking a path up through the index
would race, and the index could drift from the markdown.

Writers need a stable address that each of them can compute without
coordinating, such as `repo::github.com/acme/checkout` plus
`tests-need-local-postgres`. A second write to the same address must update
the same note. It must also never silently overwrite a concurrent writer.

## Decisions

### D1 — two optional built-in fields

- `scope` has the form `"<level>::<value>"`.
  - The level matches `^[a-z][a-z0-9-]*$`.
  - The value is everything after the first `::`. It must be non-empty and at
    most 1024 UTF-8 bytes, with no whitespace or control characters.
- `key` is a slug matching `^[a-z0-9][a-z0-9._-]{0,127}$`.

A note has both fields or neither. One without the other is a validation
error. As with every built-in, a malformed value fails validation and blocks
the write. Reads stay advisory. Both fields serialize right after
`collection`, and only when set, so unscoped documents stay byte-stable.

### D2 — `vault_write` accepts `scope` + `key` in place of `path`

A write passes exactly one of `path` or `scope` + `key`. Passing both is
refused, and so is passing one of `scope` or `key` without the other. The
server derives the path itself (`deriveScopedPath` in
`src/frontmatter/scope.ts`):

```
scopes/<level>/<value>/<key>.md
```

In the value, `/` stays a directory separator. Every other character outside
`[A-Za-z0-9._-]` becomes `-`. For example, `user::alice@example.com` maps to
`scopes/user/alice-example.com/`. A Unicode lookalike of `.` or `/` also maps
to `-`. It never acts as a separator or a dot.

**Trust boundary.** Derivation is pure and runs before RBAC and before any
disk I/O. It refuses these inputs outright rather than repairing them:

- **Empty segments.** This covers a leading `/`, a trailing `/`, and `//`.
- **Any segment that starts with `.`.** This covers `.` and `..`. It also
  covers hidden names such as `.git` and `.daftari`.
- **Any segment longer than 255 bytes.** That is the usual filesystem name
  limit.

The derived path then still goes through the existing `resolveVaultPath`. That
function confines the path lexically and re-checks it with realpath against
symlinks.

The write fills `scope` and `key` into the frontmatter. It defaults
`collection` to `scopes`.

*Deviation (documented): dot-leading segments.* As drafted, D2 refused only
`.` and `..` segments. Refusing every dot-leading segment is a strict
superset. `.git` and `.daftari` segments do not escape the vault, but they
break storage in two ways:

- `git add` rejects any path containing a `.git` component, so the note could
  not be committed.
- The vault walker skips dot-directories, so the note would be invisible.

### D3 — uniqueness by construction

The address determines the path, so there is no resolver index. Every
`vault_write` and `vault_patch` checks the final frontmatter, after merging
and transforms, against three rules:

1. A document that carries `scope`/`key` lives at exactly its derived path.
2. Its `collection` is `scopes`.
3. Nothing else lives under `scopes/`. An unscoped write there is refused.
   This stops a squatter from claiming an address before its owner writes.

`vault_lint` adds a `scopedPathMismatch` check. It reports the same three
rules for hand edits and renames. Like the rest of lint, it is advisory.

*Deviation (documented): the bijection holds only up to sanitization.*
Sanitization is many-to-one, which can map two addresses to one file:

- `user::a@b.com` and `user::a-b.com` derive the same path.
- A case-insensitive filesystem, such as default APFS, folds `Acme` and `acme`
  together.

So a scoped write checks any existing file at the derived path. If that file
holds a different scope and key, the write is refused with "already holds …"
rather than taking the file over.

A related case on case-insensitive filesystems: a scope value that differs
only in case from an existing sibling directory fails the placement check,
because realpath keeps the on-disk case. The caller has to choose a distinct
address. Uniqueness is always enforced by refusal, never by silent merging.

### D4 — updating an existing scoped note requires `base_version`

When a `scope` + `key` write targets an existing note, it must carry
`base_version`. That is the `version` field returned by `vault_read`, the
SHA-256 of the file. Without it, the write fails with:

> `vault_write: scoped note <path> already exists — 'base_version' is required
> to update it. Call vault_read on <path> and pass its 'version' as base_version.`

A stale `base_version` gets the existing `stale write:` error. Creating a new
scoped note needs no `base_version`.

The existence check runs twice:

1. **Before the lock**, so the caller gets a fast, clear error.
2. **Inside the file lock** (`requireBaseVersionIfExists` in `performWrite`).
   This closes the create-vs-create race. In that race, two writers both see
   no file and the first one creates it. Without this check, the second would
   then overwrite it.

Path-addressed writes are unchanged: `base_version` stays optional and the
last write wins. The global default does not change.

### D5 — querying by scope

**Indexing.** `scope` is indexed by default. It is a built-in entry in
`BUILTIN_INDEXED_FIELDS` (`src/search/field-filters.ts`), so it is projected
into `document_fields` for every vault, with no `indexed_fields` config. The
index schema version goes from 14 to 15, so existing indexes rebuild once. The
embedding cache survives the rebuild.

**`vault_search`** gains two arguments: `scope` (exact match) and
`scope_prefix` (plain string prefix).

- Both compile to typed field filters and reuse the 2026-09-03 indexed-field
  machinery.
- They constrain every candidate path: lexical, chunk, title/tag, vector, and
  filter-only. No candidate pool can starve.
- They also gate coverage and graph-expansion additions.
- Both work without `query`.
- The prefix test is `substr(text_value, 1, length(?)) = ?`, not LIKE or GLOB,
  so `%`, `_`, `*`, and `?` in the caller's value are literal characters.
- `prefix` is an internal operator only. The public `filters` grammar still
  accepts only eq/gt/gte/lt/lte, and `filters` cannot address `scope`.

**`vault_index`** gains the same two filters, applied to its frontmatter scan.
Entries carry `scope` and `key` when they are set.

**Trailing separators matter.** `repo::github.com/acme/` matches only the acme
org. `repo::github.com/acme` (no trailing `/`) also matches `acmesoft`. Which
one to send is the caller's choice.

### D6 — RBAC is unchanged

Scoped notes live in the top-level directory `scopes/`, in collection
`scopes`. The existing gates apply unchanged: the write gate keys on the
physical directory, and read gating uses the collection. A role that should
read or write scoped memory needs `scopes` in its lists:

```yaml
roles:
  ci-bot:
    read: [scopes]
    write: [scopes]
```

A role without the grant gets the usual error before any I/O:
`access denied: role '<r>' cannot write to collection 'scopes'`. Its reads and
searches omit scoped notes. There are no per-scope ACLs.

A propose-only role's scoped write is staged at the derived path, with scope
and key in the payload. Ratification replays it through the path form, and it
passes the placement check.

### D7 — multi-machine topology

Writers on different machines all talk to one central `daftari serve`, each
with its own bearer token:

- Per-request identity gives each writer's commits and provenance a distinct
  principal.
- All writes go through the one process that holds the vault, so the file
  lease and the in-lock `base_version` check are authoritative.

`daftari sync` stays backup-only. It pushes the canonical working copy to a
dumb storage backend. It does not merge concurrent writers on separate
machines. Separate vault copies per machine are not a supported way to share
scoped memory.

## Non-goals

- **Expiry or TTL for scoped notes.** `ttl_days` keeps its existing review
  meaning.
- **A cross-level hierarchy.** `repo::` and `org::` are unrelated strings. The
  only "under" relation is a prefix match on the scope string.
- **Cross-machine merge.** See D7.
- **LoreKit export.**
- **An index-lookup resolver.** Addresses resolve only by derivation.
- **Scoped addressing in tools other than `vault_write`.** `vault_patch`,
  `vault_append`, and the lifecycle tools take the derived `path` that
  `vault_write` returns.

## Compatibility

`scope` and `key` are now built-in names, which affects existing vaults in two
ways:

- A vault that declared either one in `schema_extensions` fails config load
  loudly, because built-ins cannot be redeclared.
- A document that used an undeclared `key:` or `scope:` for some other purpose
  still reads normally. Its next tool-mediated write fails validation, and
  `vault_lint` reports it under `schemaInvalid` and `scopedPathMismatch`. The
  fix is to rename the field.

## Tests

- `test/frontmatter/scope.test.ts`: path derivation and validation, including
  `..`, `./`, `//`, leading `/`, Unicode lookalikes, and whitespace.
- `test/tools/write-scoped.test.ts`:
  - create-then-update gives one file and two commits;
  - missing and stale `base_version`;
  - an injected create-vs-create race;
  - mismatched explicit paths, squatting, and address collisions;
  - the collection rule, RBAC, and propose-only.
- `test/tools/scoped-query.test.ts`:
  - index and search filters with no config;
  - RBAC omission;
  - literal prefix wildcards;
  - the lint check.
