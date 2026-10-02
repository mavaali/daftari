# Daftari

[![CI](https://github.com/mavaali/daftari/actions/workflows/ci.yml/badge.svg)](https://github.com/mavaali/daftari/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/daftari.svg)](https://www.npmjs.com/package/daftari) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Rent the brain. Own the memory.**

The model is rented. The memory your agents build up — decisions, conventions,
what was tried and why — should be yours. Daftari keeps it as plain markdown in
a Git repo on your disk, and Claude Code, Claude Desktop, Cursor, or any other
MCP client reads and writes the same vault.

Recency never decides what's true. When you or your agent replace a belief,
Daftari keeps what replaced it and why. When two notes disagree and neither
replaces the other, the contradiction stays flagged until someone settles it.

    npx daftari --init ./my-vault

Then `npx daftari install claude-code --vault ./my-vault` (or `cursor`, `codex`, `claude-desktop`, …).

- **Yours.** Markdown and Git. Readable in any editor. Uninstall Daftari and
  you keep every word.
- **Shared.** One vault behind every MCP tool you use, instead of a separate
  rules file per tool. No account, no hosted service.
- **Honest.** Sources stay attached, replaced beliefs stay traceable, and
  open contradictions stay visible.

*Daftari* (دفتری) is Urdu for a ledger-keeper: a ledger records corrections
instead of erasing them.

## Choose your path

| I want to… | Start here |
|---|---|
| Create a vault and connect an MCP client | [Five-minute quickstart](#five-minute-quickstart) |
| Adopt an Obsidian vault or existing markdown wiki | [Adopt existing notes](docs/adoption.md) |
| Watch one document evolve across three writes | [Worked example](docs/worked-example.md) |
| Run the curation loop | [Curation workflow](docs/curation-workflow.md) |
| Review contradictions, stale notes, or past state | [Operator workflows](docs/operator-workflows.md) |
| Configure access, HTTP serving, federation, or storage | [Deployment and access](docs/deployment.md) |
| Keep Google Docs or Notion distilled into the vault | [Source integrations](docs/integrations.md) |
| Understand the design and its limits | [Architecture](docs/architecture.md) |
| Look up frontmatter fields | [File format](docs/file-format.md) |
| See every doc | [Documentation map](docs/README.md) |

## Five-minute quickstart

**Prerequisite:** Node.js 20 or newer.

### 1. Create a vault

```bash
npx daftari --init ./my-vault
```

You get a Git repo with a config file, four starter collections, and three
fictional example documents. The markdown is the source of truth;
`.daftari/index.db` is a search index you can delete and rebuild.

### 2. Connect an MCP client

```bash
npx daftari install claude-code --vault ./my-vault
```

Swap `claude-code` for `cursor`, `claude-desktop`, `codex`, `gemini`, or
`vscode`, then restart the client. `install` checks that the vault's config
defines the role it registers (default `admin`) — without a valid role,
Daftari starts as a guest that can read and write nothing. Add `--print` to
see the change first, or `--name` to register a second vault. Other MCP
clients: see the server definition in
[getting started](docs/getting-started.md#3-connect-your-mcp-client).

### 3. Ask the vault a question

The starter vault includes fictional products named Helios and Aurora. Try:

> Search my Daftari vault for the current Helios pricing model. Cite the source
> document and tell me whether it is stale or contested.

The agent should find the example document, cite it, and say whether it is
stale or contested — not paste back a bare snippet. Then ask for a write:

> Create a low-confidence draft that compares the Helios and Aurora examples.
> Preserve the source links and list the questions the draft cannot answer.

Every write lands in markdown with its author recorded, is re-indexed, and is
committed to Git. The [getting-started walkthrough](docs/getting-started.md)
continues through promoting, retiring, and settling contradictions.

## How it works

Each note is a markdown file with YAML frontmatter. The frontmatter records
what an agent needs to judge the note: status, confidence, sources, who last
wrote it, how long it stays fresh, and which questions it answers or raises.

```yaml
---
title: "Aurora Pipelines — Positioning Overview"
collection: competitive-intel
status: canonical
confidence: medium
updated: 2026-05-17
updated_by: agent:claude-code
provenance: synthesized
sources:
  - https://example.com/aurora-product-page
ttl_days: 120
questions_answered:
  - "How does Aurora frame the ingestion boundary?"
questions_raised:
  - "Does an authored pipeline slow small teams down?"
---
```

Daftari keeps three judgments apart:

- **What is current.** A note is replaced only when someone writes an explicit
  link from the old note to its successor (a *supersession*). A newer date
  alone changes nothing.
- **What is grounded.** Sources and *provenance* (taken from a primary source,
  synthesized, or inferred) stay on the note, and Git records who wrote what.
  Daftari never invents evidence.
- **What is contested.** When two live notes disagree and neither replaces the
  other, the disagreement is logged as a *tension* and both notes stay visible
  until someone resolves it.

One rule follows: **a tension may never masquerade as a supersession.**

Daftari has no LLM of its own. Your agent, or you, spots the contradiction and
logs it; Daftari stores it, keeps it open, and re-queues notes for review when
a note they depend on changes.

The working loop: search before writing, write a draft with its confidence and
sources, run lint to find stale notes, weak grounding, abandoned drafts, and
broken links (lint reports, it never fixes), then promote, retire, or supersede
on purpose. An agent that writes its conclusion back leaves the next agent a
finished answer instead of the same pile of fragments. The
[worked example](docs/worked-example.md) shows this across three writes.

Underneath: config-defined roles and per-collection permissions (no user
database), process and file locks for concurrent writes, and an automatic Git
commit for every change. Locks prevent clobbered files; they do not settle
disagreements.

### Tools

Expose the MCP tools in `core`, `standard`, or `full` tiers. The tier changes
what clients see in `tools/list`, not the data.

| To… | Use |
|---|---|
| Find notes | `vault_search` (keyword + vector), `vault_search_related`, `vault_themes` |
| Read with context | `vault_read`, `vault_backlinks`, `vault_consumes` |
| Write | `vault_write`, `vault_append`, `vault_merge`, `vault_supersede` |
| Move notes through draft → canonical → retired | `vault_promote`, `vault_deprecate`, `vault_set_confidence`, `vault_set_tier` |
| Track disagreements | `vault_tension_log`, `vault_tension_triage`, `vault_positions`, `vault_canon` |
| Require a human sign-off | `vault_stage_action`, `vault_ratify`, `vault_consolidate` |
| Audit history | `vault_receipt`, `vault_provenance`, `vault_witness`, `daftari asof` |
| Run review jobs | `daftari sleep` (build a review queue), `court` (rule on open contradictions), `interview` (collect evidence from a person), `view` (read-only web portal), `audit` (broken references, staleness) |

`daftari --help` lists the CLI. MCP clients read the full tool list and schemas
from `tools/list`. The [file-format reference](docs/file-format.md) covers every
frontmatter field.

## Run it where the work happens

**Local (default).** One stdio process, one writable vault. This is the setup
for Claude Desktop, Claude Code, and local agent SDKs:

```bash
npx daftari --vault ./my-vault --user me --role admin
```

**Shared server.** `daftari serve` exposes the same vault over Streamable HTTP
for multiple clients. Bound to anything but loopback, it refuses to start
without authentication and an explicit acknowledgment that TLS is terminated
upstream. See
[deployment and access](docs/deployment.md) for bearer tokens, OAuth 2.1,
federation, and storage.

```bash
daftari serve --vault ./my-vault
```

**Existing notes.** Daftari adopts an Obsidian vault or markdown wiki in place.
`schema infer` and `schema diff` only read; `import` fills in missing
frontmatter and leaves your content alone.

```bash
daftari schema infer --vault ~/my-vault
daftari schema diff --vault ~/my-vault
daftari import obsidian ~/my-vault --plan
```

A vault inside Dropbox, iCloud, or similar needs its `.git` directory kept
outside the synced folder. Read [adopting existing notes](docs/adoption.md)
before you import.

## What Daftari does not do

- Detect contradictions with its own model. Agents judge; Daftari records.
- Generate a compromise when notes contradict each other.
- Auto-fix lint findings or promote agent output on its own.
- Hide your files behind a proprietary database.
- Host your data. Server mode is self-hosted.
- Replace your model or agent framework.

For how Daftari compares with other memory tools, see
[positioning](docs/positioning-2026-07.md). It lives outside this README
because competitor claims age faster than the product.

## More

- [Documentation map](docs/README.md) — every doc, by task
- [Manifesto](docs/manifesto.md) — why memory should outlive the model
- [`integrations/langchain/`](integrations/langchain/) — Daftari tools as
  LangChain `BaseTool`s for LangGraph and `create_react_agent`
- [`packages/router/`](packages/router/) — one MCP connection across several
  writable vaults

## Development

```bash
npm install
npm run build
npm test
```

TypeScript on Node.js. Functions and types over classes; tool handlers return
`Result<T, Error>` instead of throwing; tests mirror `src/`.

## Privacy and license

Daftari runs locally and makes no network calls unless a vault opts into an
external provider or integration. See the [privacy policy](PRIVACY.md).
MIT [license](LICENSE).
