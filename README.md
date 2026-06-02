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
later read starts from that compiled result. The compiler is the agent;
Daftari is the substrate that catches and persists what the agent
consolidates. The vault gets better the more it is used.

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

**Evaluate (opt-in, requires an Anthropic API key):** `daftari eval` — scores how
well an LLM can use the curation surface to answer multi-hop questions about the
vault. See the [design spec](docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md)
for the rationale and the cortex framing.

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

## Coherence audit

`daftari audit` is a read-only, deterministic check across one or more
markdown repos for **broken cross-repo references** and **link-graph
transitive staleness**. It works against any markdown tree — daftari-managed
or not. The audit creates no `.daftari/` directory and writes nothing to the
audited repos.

### Multi-repo (the headline use case)

When two or more repos link to each other, the audit detects broken
references that neither repo's own lint could see — because each repo only
knows about itself.

```bash
daftari audit \
  --repo ~/repos/service-a \
  --repo ~/repos/service-b
```

That works for relative-path links (`../service-b/docs/api.md`). For
GitHub-style URL links between repos (`https://github.com/org/service-b/...`),
declare each repo's URL patterns in an `audit.yaml` so the resolver can map
them back to the local repo:

```yaml
# audit.yaml
repos:
  - name: service-a
    path: ~/repos/service-a
    urls: ["github.com/org/service-a"]
  - name: service-b
    path: ~/repos/service-b
    urls: ["github.com/org/service-b"]
```

```bash
daftari audit --config audit.yaml
```

### Single repo

The same command, one `--repo`:

```bash
daftari audit --repo ./docs
```

In single-repo mode the cross-repo check trivially has no work, but the
staleness check still runs over the in-repo link graph.

### What gets detected

- **Missing files.** A link from `service-a/intro.md` to `../service-b/api.md`
  or `https://github.com/org/service-b/blob/main/api.md` — flagged if `api.md`
  doesn't exist in `service-b`.
- **Missing anchors.** Same link with `#run` — flagged if `api.md` has no
  `## Run` heading.
- **Direct staleness.** Any doc whose git mtime is older than
  `staleness.threshold_days` (default 540, ~18 months).
- **Transitive staleness.** A fresh doc that links — directly or through a
  chain — to a stale doc is itself flagged, with the shortest chain reported.
  Catches the case where you keep touching an index page while the docs it
  links to are rotting.

### Sample output

```markdown
# Coherence Audit Report

## Totals
- repos scanned: **2**
- docs scanned: **47**
- broken cross-repo refs: **2**
- directly stale docs: **3**
- transitively stale docs: **5**

## Broken cross-repo references
| kind           | source                    | target                  | href |
|----------------|---------------------------|-------------------------|------|
| missing_anchor | service-a/intro.md        | service-b/api.md#run    | `https://github.com/org/service-b/blob/main/api.md#run` |
| missing_file   | service-a/architecture.md | service-b/deleted.md    | `../service-b/deleted.md` |

## Staleness
| kind       | doc                      | mtime      | chain |
|------------|--------------------------|------------|-------|
| transitive | service-a/onboarding.md  | 2026-04-01 | service-a/onboarding.md → service-b/legacy-flow.md |
```

JSON output (`--output-json` or `output.json` in config) carries the same
structure with full detail in `brokenRefs[]` and `staleness[]` arrays plus a
`totals` summary block for compact downstream rendering.

### CI integration

The audit's exit code is designed to gate CI:

```yaml
# .github/workflows/docs-audit.yml
name: Docs audit
on: [pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # full history so git mtime works
      - run: npx daftari@latest audit --config audit.yaml
```

Exit codes:

| code | meaning |
|------|---------|
| `0`  | clean run, all findings within `fail_on` thresholds |
| `1`  | clean run but a threshold was exceeded — CI fails |
| `2`  | config error (missing required fields, bad paths, malformed YAML) |
| `3`  | runtime error (IO failure during collection) |

### CLI flags

`audit.yaml` and CLI flags overlap; CLI wins. A warning is printed to stderr
when `--output` or `--output-json` displaces a value from the config.

- `--repo <path>` — add a repo. May be repeated. Anonymous CLI repos get no
  URL patterns; URL-based cross-refs into them won't be detected. Use
  `--config` for URL-aware repos.
- `--config <path>` — load an `audit.yaml`.
- `--output <md>` — markdown report destination (default: stdout).
- `--output-json <json>` — JSON report destination (default: not written).
- `--help` — full help text.

### Full `audit.yaml` schema

```yaml
repos:
  - name: service-a
    path: ~/repos/service-a
    docs_glob: "docs/**/*.md"       # default: "**/*.md"
    urls:                            # optional; enables URL-pattern matching
      - "github.com/org/service-a"

  - name: service-b
    path: ~/repos/service-b
    urls:
      - "github.com/org/service-b"

output:
  markdown: coherence-report.md      # default: stdout
  json: coherence-report.json        # default: not emitted

staleness:
  threshold_days: 540                # default: 540 (18 months)

fail_on:
  broken_refs: 1                     # default: fail on any broken ref
  transitive_staleness: 100          # default: generous; teams tune
```

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

## Integrations

- [`integrations/langchain/`](integrations/langchain/) — `langchain-daftari`, a
  Python package that exposes the 14 daftari tools as LangChain `BaseTool`s
  for use with LangGraph / `create_react_agent`. Sync + async, schemas pulled
  live from `tools/list`.
- [`packages/router`](packages/router) — multi-vault MCP router that fans out across N Daftari vaults

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
