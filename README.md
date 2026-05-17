# Daftari

**An MCP server that exposes a curated markdown vault to AI agents.**

Daftari is not RAG. It is not a chatbot. It is a *living, agent-maintained
knowledge vault* — a directory of markdown files that an AI agent reads from,
writes to, and curates over time, so that knowledge **compounds** instead of
being re-derived on every query.

RAG retrieves chunks and hopes the model stitches them together. Daftari takes
the other path: the agent does the stitching *once*, writes the synthesized
result back as a durable document, and every later read starts from that
compiled answer. Karpathy's framing fits — **compilation over retrieval**. The
vault gets better the more it is used.

A vault is just markdown. You can read it, `git log` it, and edit it by hand.
Daftari adds the machinery an agent needs to treat it as a shared workspace:
access control, write arbitration, provenance, and curation.

---

## The four-layer model

Daftari is built in four layers. The first two are table stakes. **The moat is
layers 3 and 4** — anyone can store markdown and check a permission; arbitrating
concurrent agent writes and managing knowledge decay is the hard part.

| Layer | Concern | What Daftari provides |
|------:|---------|-----------------------|
| 1 | **Storage** | Markdown + YAML frontmatter on disk, a git history, a rebuildable SQLite index for hybrid BM25 + vector search. |
| 2 | **Multi-tenant ACL** | Config-driven RBAC. Roles and per-collection read/write/promote permissions declared in `.daftari/config.yaml`. |
| 3 | **Write arbitration** ⭐ | File-level write locks (SQLite-backed, 60s TTL), every write auto-committed to git, a provenance log of who wrote what and when. |
| 4 | **Curation decay** ⭐ | The draft → canonical → deprecated lifecycle, TTL-based staleness, tension logging for contradictions, and an advisory linter. Knowledge that stops being true is surfaced, not silently trusted. |

Layers 1–2 keep the vault *stored and scoped*. Layers 3–4 keep it *coherent as
it grows* — which is the entire point of a vault that compounds.

---

## Quickstart

```bash
# 1. Scaffold a new vault (collections, config, example documents, git, index)
npx daftari --init ./my-vault

# 2. Start the MCP server against it, as an identity with a role
npx daftari --vault ./my-vault --user me --role admin
```

The server speaks the Model Context Protocol over stdio. Point any MCP client
(Claude Desktop, an agent SDK, your own harness) at it. See
[docs/getting-started.md](docs/getting-started.md) for the full walkthrough,
including a `claude_desktop_config.json` snippet.

---

## The MCP tools

Daftari exposes 13 tools, grouped by layer.

**Read path**

| Tool | Description |
|------|-------------|
| `vault_read` | Read one document: markdown body, parsed frontmatter, and an advisory validation report. |
| `vault_index` | List documents, filterable by collection, status, domain, or tags. |
| `vault_status` | Vault summary: total files, per-collection counts, count of documents with invalid frontmatter. |

**Search**

| Tool | Description |
|------|-------------|
| `vault_search` | Hybrid BM25 + vector search across the vault, with tunable ranking weights. |
| `vault_search_related` | Find documents thematically related to a given document. |
| `vault_reindex` | Rebuild the SQLite search index from the markdown files. |

**Write arbitration**

| Tool | Description |
|------|-------------|
| `vault_write` | Create or overwrite a document. Stamps `updated`/`updated_by`, preserves `created`, auto-commits. |
| `vault_append` | Append a markdown section to a document. Re-stamps metadata, auto-commits. |
| `vault_promote` | Promote a draft to canonical — refuses unless the draft's frontmatter is complete. |
| `vault_deprecate` | Mark a document deprecated with a required reason and an optional `superseded_by`. |

**Curation**

| Tool | Description |
|------|-------------|
| `vault_tension_log` | Record a contradiction between two documents to the advisory tension log. Records; does not resolve. |
| `vault_lint` | Run advisory curation checks: stale-past-TTL, orphans, old drafts, stagnant low-confidence files, deprecated-but-linked. |
| `vault_provenance` | Return a single document's full write history from the provenance log. |

The curation engine is **advisory**: `vault_lint` reports problems and
`vault_tension_log` records contradictions — neither auto-fixes anything. A
human or a deliberate agent decision drives every change.

---

## RBAC

Access is config-driven. There is no user-management system — roles and their
per-collection permissions live in `.daftari/config.yaml`, and the server is
started with `--role <name>` to select one:

```yaml
version: 1
vault_name: my-vault

roles:
  analyst:
    read: [competitive-intel, pricing]
    write: [competitive-intel, _drafts]
  researcher:
    read: ["*"]            # "*" matches every collection
    write: [moonshot, _drafts]
  admin:
    read: ["*"]
    write: ["*"]
    promote: true          # only this role may promote drafts to canonical
```

- `read` — collections the role may read and search
- `write` — collections the role may create, append to, or deprecate in
- `promote` — whether the role may promote a draft to canonical (default `false`)

Starting the server with no `--role`, or with a name not in the config, falls
back to a deny-all **guest**: every tool is denied.

---

## File format

Every document is a markdown file with a YAML frontmatter block. Frontmatter
*is* the metadata layer — there is no separate database of record.

```markdown
---
title: "Aurora Pipelines — Positioning Overview"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: medium
created: 2026-05-17
updated: 2026-05-17
updated_by: agent:claude-code
provenance: direct
sources:
  - aurora-product-page
superseded_by: null
ttl_days: 120
tags: [aurora, ingestion, competitive]
---

# Aurora Pipelines — Positioning Overview

Aurora Pipelines treats ingestion as an authored, version-controlled artifact
rather than a managed black box.

## Questions Answered
- How does Aurora frame the ingestion-vs-transformation boundary?

## Questions Raised
- Does an authored-pipeline model slow teams down at small scale?
```

The `## Questions Answered` / `## Questions Raised` pattern is a convention,
not a requirement: it makes a document's epistemic edges explicit so the next
agent knows what is settled and what is still open. Full field reference in
[docs/file-format.md](docs/file-format.md).

---

## Documentation

- [docs/getting-started.md](docs/getting-started.md) — end-to-end walkthrough: scaffold, write, search, lint, promote, deprecate, and connect from Claude Desktop.
- [docs/architecture.md](docs/architecture.md) — the layered architecture, the request path, and the accumulation-vs-generative domain split.
- [docs/file-format.md](docs/file-format.md) — the complete frontmatter reference and markdown body conventions.

---

## Development

```bash
npm install
npm run build      # compile TypeScript to dist/
npm test           # run the vitest suite
npm run dev        # run the server in watch mode against the sample vault
```

Design tenets: functions and types, no classes; tool handlers return
`Result<T, Error>` rather than throwing; tests mirror the `src/` structure.

## License

MIT. Open source — `daftari` on npm, [`mavaali/daftari`](https://github.com/mavaali/daftari) on GitHub.
