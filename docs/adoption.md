# Adopting existing notes

Daftari works on the markdown you already have. Adoption is an in-place
metadata migration, not an export into a proprietary store.

The safe sequence is: inspect, compare, plan, apply one scope, then verify.

## Choose an adoption path

| Starting point | Path |
|---|---|
| Obsidian vault | `daftari import obsidian` |
| Other markdown wiki | `daftari backfill` |
| Open Knowledge Format bundle | `daftari okf import` |
| Need to understand custom frontmatter first | `daftari schema infer` and `schema diff` |
| Vault lives in iCloud, Dropbox, or another sync folder | Use `--external-git-dir` during import |

## 1. Inspect the existing schema

Both schema commands are read-only:

```bash
daftari schema infer --vault ~/my-vault
daftari schema diff --vault ~/my-vault
```

`infer` reports what exists: field frequency and prevalence, observed types,
bounded examples, distinct-value cardinality, and whether values resemble an
enum.

`diff` compares those observations with Daftari's built-in fields and any
`schema_extensions` in `.daftari/config.yaml`. It reports:

- widely used undeclared fields;
- declared extensions that are never used;
- observed values that violate their declaration; and
- near-miss names such as `state` versus `status`.

A custom field must appear at least twice before `diff` treats it as schema
evidence. Change that gate when the corpus requires it:

```bash
daftari schema diff --vault ~/my-vault --min-occurrences 3
```

Limit inspection to one folder when the wiki contains several conventions:

```bash
daftari schema infer --vault ~/my-vault --scope notes
daftari schema diff --vault ~/my-vault --scope notes --json
```

Nested folders are included. A named scope that does not exist fails; an
existing empty folder returns an empty report. Real-path confinement prevents
symlink aliases from escaping the scope or double-counting a document.

Malformed or unreadable documents are listed as skipped evidence. Problem
categories and examples are bounded so one noisy corpus cannot produce an
unusable report.

## 2. Plan an Obsidian import

```bash
daftari import obsidian ~/my-vault --plan
```

The plan shows which files would receive missing Daftari frontmatter. Existing
body text and existing frontmatter fields are preserved.

The importer derives:

- `collection` from the folder;
- dates from Git history, falling back to file modification time;
- conservative lifecycle and confidence defaults;
- Obsidian inline tags into `tags`; and
- a Web Clipper `source` value into `sources`.

Wikilinks remain as written; Daftari resolves them without rewriting the body.

## 3. Apply one scope

Start with a folder whose contents you understand:

```bash
daftari import obsidian ~/my-vault --apply --scope notes
```

The default workflow asks for ratification per folder. `--yes` skips that
prompt and should be reserved for a reviewed plan or automation with an
equivalent gate.

Import fills only missing Daftari fields. It does not continuously watch the
vault; rerun the importer when newly added files need metadata.

After applying, inspect the Git diff before allowing an agent to write:

```bash
git -C ~/my-vault status --short
git -C ~/my-vault diff --stat
daftari schema diff --vault ~/my-vault
```

## Cloud-synced folders

A live `.git/` directory contains frequently changing databases and lock files.
Copying it through iCloud, Dropbox, or another folder-sync product risks
corruption.

Keep Git's data outside the synchronized tree:

```bash
daftari import obsidian \
  "$HOME/Library/Mobile Documents/.../my-vault" \
  --apply \
  --scope notes \
  --external-git-dir
```

This writes `git_dir: external` to `.daftari/config.yaml` and uses Git's
separate-directory layout. The vault contains only a small static `.git` file;
repository data lives under `~/.local/share/daftari/git/` unless an explicit
path is supplied:

```bash
daftari import obsidian ~/my-vault \
  --apply \
  --external-git-dir=/path/to/git-data
```

Notes can continue syncing across devices. Git history remains device-local
unless you separately configure a Git remote or Daftari storage backing.

## Generic markdown with `backfill`

The Obsidian importer wraps the lower-level Git-driven migration used for any
markdown tree:

```bash
daftari backfill --vault ~/my-wiki --plan
daftari backfill --vault ~/my-wiki --apply --scope specs
```

Use `backfill` when no Obsidian-specific tag or Web Clipper mapping is needed.
The same plan-first, scope-first review sequence applies.

## Open Knowledge Format

[Open Knowledge Format (OKF)](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing/)
describes a portable markdown-and-frontmatter knowledge bundle. Daftari can
export a vault to OKF or adopt an OKF bundle.

### Export

```bash
daftari okf export ./my-vault --out ./okf-bundle
daftari okf export ./my-vault --out ./okf-bundle --collection pricing
```

Every document becomes an OKF concept document. A Daftari sidecar preserves
native fields for lossless round trips; generated `index.md` and `log.md` files
provide discovery and history. Trust signals map conservatively from native
metadata. Daftari never invents a `verified` claim from authorship alone.

### Import

```bash
daftari okf import ./okf-bundle --into ./my-vault --dry-run
daftari okf import ./okf-bundle --into ./my-vault
```

A Daftari-produced bundle round-trips through its sidecar. Foreign bundles
land conservatively as draft accumulation documents unless explicit trust
signals justify a stronger mapping. Deprecated source material remains
deprecated; `stale_after` maps to `ttl_days`; fields without a lossless native
slot remain under `okf_*` keys.

An imported `Attested Computation` does not automatically receive `tier:
source`. Source-tier immutability is an enforcement boundary and must be
granted deliberately with `vault_set_tier`, including a reason in provenance.

## Adoption checklist

- Back up the original folder before the first apply.
- Run `schema infer` before declaring extensions.
- Treat malformed documents as missing evidence, not as ignorable noise.
- Run an import plan and review the diff.
- Apply one representative scope first.
- Use an external Git directory for every cloud-synced folder.
- Re-run schema diff after adoption.
- Connect an MCP client only after the files and config match the intended
  access boundary.

## Related guides

- [Schema extensions](schema-extensions.md) — declare project-specific fields.
- [Getting started](getting-started.md) — connect an MCP client after adoption.
- [Deployment and access](deployment.md) — roles, federation, and backups.
- [File format](file-format.md) — built-in metadata fields.
