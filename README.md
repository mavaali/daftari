# Daftari

[![CI](https://github.com/mavaali/daftari/actions/workflows/ci.yml/badge.svg)](https://github.com/mavaali/daftari/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/daftari.svg)](https://www.npmjs.com/package/daftari) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Daftari* (دفتری) is the Urdu word for a ledger-keeper: the person in a
trading house who maintained the *daftar*, the bound register where every
transaction was recorded, cross-referenced, and preserved. The daftar was not a
filing cabinet. It was a living document. Entries referenced earlier entries.
Corrections were noted, not erased. The ledger got more valuable the longer it
was kept, because the accumulated record revealed patterns no single entry
could.

Daftari is an MCP server that gives AI agents the same thing: a persistent,
structured knowledge vault they can read, write, and curate over time. A
cortex, not a clipboard.

## The problem

Every agent conversation starts from zero. RAG retrieves chunks and hopes the
model stitches them together. AGENTS.md gives static context that nobody
updates. The knowledge an agent builds during a session evaporates when the
session ends.

Daftari takes the other path: **compilation over retrieval.** The agent
synthesizes an answer once, writes it back as a durable document, and every
later read starts from that compiled result. The vault gets better the more it
is used.

A human cortex doesn’t re-derive everything from sensory input each time it
thinks. It consolidates: experiences become memories, memories become
structure, structure shapes future thought. Daftari gives agents the same
loop. Drafts consolidate into canonical knowledge. Contradictions surface as
tensions. Stale knowledge decays on a schedule. The vault is a living system,
not a filing cabinet.

## What it is

A directory of markdown files with YAML frontmatter, exposed to agents as 14
MCP tools over stdio. The vault is plain text: you can read it in any editor,
`git log` it, grep it. Daftari adds the machinery agents need to treat it as a
shared workspace.

```
npx daftari --init ./my-vault
npx daftari --vault ./my-vault --user me --role admin
```

Point any MCP client (Claude Desktop, Claude Code, an agent SDK) at it.

## The four layers

Storage and access control are table stakes. The moat is layers 3 and 4.

|Layer                |What it does                                                                                          |Why it matters                                                         |
|---------------------|------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------|
|**Storage**          |Markdown + frontmatter on disk, git history, rebuildable SQLite index for hybrid BM25 + vector search.|Plain text is the source of truth. Delete every `.db` file and rebuild.|
|**Access control**   |Config-driven RBAC. Roles and per-collection read/write/promote permissions in `.daftari/config.yaml`.|Multiple agents, scoped access, no user-management system.             |
|**Write arbitration**|File-level locks (60s TTL), auto-commit to git, structured provenance log.                            |Concurrent agents write safely. Every mutation is attributable.        |
|**Curation**         |Draft-to-canonical lifecycle, TTL-based staleness, tension logging, advisory linter.                  |Knowledge that stops being true gets surfaced, not silently trusted.   |

## The tools

**Read:** `vault_read`, `vault_index`, `vault_status`

**Search:** `vault_search` (hybrid BM25 + vector), `vault_search_related`, `vault_themes` (thematic clustering), `vault_reindex`

**Write:** `vault_write`, `vault_append`, `vault_promote`, `vault_deprecate`

**Curate:** `vault_tension_log`, `vault_lint`, `vault_provenance`

The curation engine is advisory: `vault_lint` reports problems and
`vault_tension_log` records contradictions. Neither auto-fixes anything. Every
change is a deliberate, attributable act.

## Two kinds of knowledge

Every document declares a `domain`. The distinction drives how the curation
layer treats it.

**Accumulation** documents compile and compound. A competitive-intel note, a
pricing breakdown, a researched comparison. Each write builds on the last.
Going stale is a problem to fix.

**Generative** documents speculate. A moonshot sketch, a brainstorm, a “what
if.” Going stale is expected, not a defect.

The same curation rules applied uniformly would either nag about every
brainstorm or quietly trust every stale fact. The domain split lets the system
hold each to the right standard.

## Access control

No user-management system. Roles live in config, the server starts with one:

```yaml
roles:
  analyst:
    read: [competitive-intel, pricing]
    write: [competitive-intel, _drafts]
  researcher:
    read: ["*"]
    write: [moonshot, _drafts]
  admin:
    read: ["*"]
    write: ["*"]
    promote: true
```

No `--role` or an unknown name falls back to deny-all.

## File format

Markdown with YAML frontmatter. Frontmatter is the metadata layer; there is no
separate database.

```yaml
---
title: "Aurora Pipelines — Positioning Overview"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: medium
created: 2026-05-17
updated: 2026-05-17
updated_by: agent:claude-code
provenance: synthesized
sources:
  - aurora-product-page
ttl_days: 120
tags: [aurora, ingestion, competitive]
questions_answered:
  - "How does Aurora frame the ingestion/transformation boundary?"
questions_raised:
  - "Does an authored-pipeline model slow teams down at small scale?"
---
```

Documents can make their epistemic edges explicit: `questions_answered` is what
later agents can take as settled, `questions_raised` is where to build next.
`vault_lint` turns the open questions across the vault into a coverage map.

Full field reference in <docs/file-format.md>.

## How it compares

|                    |AGENTS.md        |RAG                          |Daftari                              |
|--------------------|-----------------|-----------------------------|-------------------------------------|
|Who writes?         |Humans           |Nobody (retrieval only)      |Agents + humans                      |
|Scales?             |One file, doesn’t|Scales storage, not coherence|Structured collections with lifecycle|
|Knowledge compounds?|No               |No                           |Yes, draft → canonical → deprecated  |
|Contradictions?     |Invisible        |Invisible                    |Tension log surfaces them            |
|Staleness?          |Silent           |Silent                       |TTL-based decay with advisory lint   |

## What’s not in v1

Deliberately deferred to keep the surface tight:

- **Cloud-hosted multi-tenant server** with S3/GCS backend and token auth
- **Remote MCP transport** for claude.ai web, mobile, and Cowork (v1 is a local desktop extension for Claude Desktop and Claude Code)
- **Conflict resolution beyond file-level locks** (CRDTs, semantic merge)
- **Background curation agent** running lint on a cadence
- **LLM reranking** of search results
- **Enforced domain separation** (v1 documents the convention; v2 enforces it)

Each is a clean increment on a surface that already works.

## Development

```
npm install
npm run build
npm test
```

Design tenets: functions and types, no classes; tool handlers return
`Result<T, Error>` rather than throwing; tests mirror the `src/` structure.

## Documentation

- <docs/getting-started.md> — scaffold, write, search, lint, promote, deprecate
- <docs/architecture.md> — layered design, request path, accumulation vs. generative domains
- <docs/file-format.md> — complete frontmatter reference

## Privacy

Daftari is a local MCP server. It runs on your machine, against vault files on
your machine. The default configuration makes no network calls — vault content
stays on your local filesystem and is read or written only through tools the
MCP client invokes. The only optional egress is the OpenAI embedding provider,
which the user must explicitly opt into per vault.

Full policy: [PRIVACY.md](./PRIVACY.md) — covers data collection (none),
storage (local-only), the OpenAI opt-in, third-party integrations (none),
retention, and contact.

## License

MIT.
