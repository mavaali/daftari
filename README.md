# Daftari

[![CI](https://github.com/mavaali/daftari/actions/workflows/ci.yml/badge.svg)](https://github.com/mavaali/daftari/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/daftari.svg)](https://www.npmjs.com/package/daftari)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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
| `vault_status` | Vault health dashboard: total file count, per-collection counts, count of documents with invalid frontmatter, a staleness distribution (fresh/aging/stale), unresolved tensions, and recent write history. |

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

## What an agent call looks like

Daftari speaks the Model Context Protocol over stdio. An agent invokes a tool
by name with JSON arguments; the server replies with a JSON text block. Here is
`vault_search` against a freshly scaffolded vault (`npx daftari --init`):

**Request**

```json
{ "method": "tools/call", "params": {
    "name": "vault_search",
    "arguments": { "query": "consumption pricing", "limit": 1 } } }
```

**Response** — `content[0].text`, parsed:

```json
{
  "query": "consumption pricing",
  "count": 1,
  "vectorUsed": true,
  "weights": { "bm25": 0.5, "vector": 0.5 },
  "hits": [
    {
      "path": "pricing/helios-consumption-pricing.md",
      "title": "Helios Consumption Pricing (Compute Credit Model)",
      "collection": "pricing", "status": "canonical",
      "score": 1, "bm25Score": 1, "vectorScore": 1,
      "snippet": "# Helios Consumption Pricing (Compute Credit Model) Helios is a fictional platform…"
    }
  ]
}
```

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

## What's not in v1

A few capabilities were deliberately deferred so v1 ships with a tight,
defensible surface — a server that does its core job well rather than a wide
one that does many jobs partially. Not in this release:

- **Cloud-hosted multi-tenant server** — an S3/GCS storage backend with
  auth-token identity. v1 runs against a local filesystem as a single process.
- **Conflict resolution beyond file-level locks** — CRDTs or semantic merge for
  concurrent edits to the same document. v1 arbitrates with 60-second write locks.
- **Background curation agent** — a scheduler that runs `vault_lint` on a
  cadence. v1's linter is advisory and invoked on demand.
- **LLM reranking of search results** — a model pass over the BM25 + vector
  candidate set. v1 ships hybrid ranking without a rerank stage.
- **Enforced domain separation** — v1 *documents* the convention that
  generative-domain documents are not cross-referenced into accumulation pages;
  the write tools do not yet enforce it. v2 will.

Each of these is a clean increment on top of a surface that already works —
deliberately deferred, not forgotten.

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
