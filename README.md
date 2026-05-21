# Daftari

[![CI](https://github.com/mavaali/daftari/actions/workflows/ci.yml/badge.svg)](https://github.com/mavaali/daftari/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/daftari.svg)](https://www.npmjs.com/package/daftari)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**An MCP server that exposes a curated markdown vault to AI agents.**

Daftari is not RAG. It is not a chatbot. It is a *living, agent-maintained
knowledge vault* — a directory of markdown files that an AI agent reads from,
writes to, and curates over time, so that knowledge **compounds** instead of
being re-derived on every query.

> *Daftari — from دفتر (daftar): notebook, ledger, register. A word shared
> across Urdu, Hindi, Marathi, Arabic, Persian, and Turkish for the book you
> write things down in so you don't forget.*

RAG retrieves chunks and hopes the model stitches them together. Daftari takes
the other path: the agent does the stitching *once*, writes the synthesized
result back as a durable document, and every later read starts from that
compiled answer. Karpathy's framing fits — **compilation over retrieval**. The
vault gets better the more it is used.

A vault is just markdown. You can read it, `git log` it, and edit it by hand.
Daftari adds the machinery an agent needs to treat it as a shared workspace:
access control, write safety, provenance, and curation.

---

## The four-layer model

Daftari is built in four layers. The first two are table stakes. **The moat is
layers 3 and 4** — anyone can store markdown and check a permission; keeping
every write safe and attributable, and managing knowledge decay, is the hard
part.

| Layer | Concern | What Daftari provides |
|------:|---------|-----------------------|
| 1 | **Storage** | Markdown + YAML frontmatter on disk, a git history, a rebuildable SQLite index — FTS5 for lexical ranking, sqlite-vec for vector search. |
| 2 | **Multi-tenant ACL** | Config-driven RBAC. Roles and per-collection read/write/promote permissions declared in `.daftari/config.yaml`. |
| 3 | **Write safety** ⭐ | File-level write locks (SQLite-backed, 60s TTL) give single-writer-per-document safety — a competing writer fails cleanly instead of corrupting the file. This is a safety mechanism, not a coordination protocol. The ⭐ is for what is genuinely differentiated: every write auto-committed to git with a provenance log of who changed what and when. |
| 4 | **Curation decay** ⭐ | The draft → canonical → deprecated lifecycle, TTL-based staleness, tension logging for contradictions, and an advisory linter. Knowledge that stops being true is surfaced, not silently trusted. |

Layer 3 today is *safety*, not orchestration: the lock prevents file corruption
and simultaneous writers, but a writer can still overwrite another's work if it
composed its change against a since-changed version of the document. Closing
that gap — with optimistic concurrency, not queuing — is the v2 direction; see
[What's not in v1](#whats-not-in-v1).

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
| `vault_read` | Read one document: markdown body, parsed frontmatter, an advisory validation report, and an inline decay assessment. |
| `vault_index` | List documents, filterable by collection, status, domain, or tags. |
| `vault_status` | Vault health dashboard: total file count, per-collection counts, count of documents with invalid frontmatter, a staleness distribution (fresh/aging/stale), unresolved tensions, and recent write history. |

**Search**

| Tool | Description |
|------|-------------|
| `vault_search` | Hybrid BM25 + vector search across the vault, with tunable ranking weights; each hit carries an inline decay assessment. |
| `vault_search_related` | Find documents thematically related to a given document. |
| `vault_reindex` | Rebuild the SQLite search index from the markdown files. |

**Write safety**

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
| `vault_lint` | Run advisory curation checks: stale-past-TTL, orphans, old drafts, stagnant low-confidence files, deprecated-but-linked, unanswered questions. |
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
      "snippet": "# Helios Consumption Pricing (Compute Credit Model) Helios is a fictional platform…",
      "decay": null
    }
  ]
}
```

---

## Search internals

`vault_search` is **hybrid**: a BM25 lexical score and a vector (semantic)
score, blended with tunable weights. Both halves are SQL-native — they
run inside SQLite, not in JavaScript.

- **Lexical half.** An FTS5 virtual table (`documents_fts`) over title,
  tags, and body. SQLite's built-in BM25 ranks every MATCH'd row.
  Triggers on the regular `documents` table keep the FTS index in sync
  on every write, so the indexer never touches the virtual table
  directly. Free-text queries are tokenised, stopword-filtered, and
  prefix-OR'd (`cirrus pricing` becomes `cirrus* OR pricing*`) so a
  partial-keystroke or stem variation still matches.

- **Vector half.** A sqlite-vec `vec0` virtual table
  (`embeddings_vec`), sized at the active provider's dim and indexed for
  KNN cosine queries. The durable `embeddings` cache (one row per
  `(content_hash, model)`) is the source of truth; `embeddings_vec`
  mirrors it for query-time access. Switching embedding providers
  triggers a drop-and-rebuild of the vec table at the new dim — the
  durable cache survives, so switching back is all cache hits.

**Prerequisite.** sqlite-vec is a loadable SQLite extension. The
`sqlite-vec` npm package ships pre-built binaries for darwin / linux /
windows on x64 and arm64; `better-sqlite3`'s npm prebuilt enables
extension loading by default. In the common case `npm install` is the
only setup step. If a custom `better-sqlite3` build with extension
loading disabled is in use, Daftari refuses to start with an actionable
error: `npm rebuild better-sqlite3 --build-from-source`.

The vector half is worth being explicit about, because a local-first
tool should never leave you guessing whether a query leaves your
machine.

### Embedding providers

Daftari ships with two embedding backends. Pick one in
`.daftari/config.yaml`:

```yaml
embeddings:
  provider: local-minilm   # default. Other values: openai-3-small.
```

- **`local-minilm`** (default). `all-MiniLM-L6-v2` (the
  `Xenova/all-MiniLM-L6-v2` build), a 384-dimension sentence-transformer.
  Runs entirely **local**: embeddings are computed in-process by
  [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers)
  (Transformers.js). No external embedding API — nothing is sent to
  Hugging Face, OpenAI, or anyone else at index or query time. Just
  `npm install` — no Python, no API key. The **first** reindex downloads
  the model weights (~25 MB) from the Hugging Face hub and caches them on
  disk; every run after that is fully offline. Slow on cold start
  (~25 min CPU on a 44k-chunk vault), but free.

- **`openai-3-small`**. OpenAI's `text-embedding-3-small`, a 1536-dimension
  hosted embedding. **Sends chunk text to OpenAI** at reindex time —
  enable this only if you're comfortable with that. Requires
  `OPENAI_API_KEY` in the server's environment (it is never read from
  config files). ~10x faster than `local-minilm` on large vaults; on the
  44k-chunk benchmark above, ~2 minutes and ~$0.10. Because Daftari's
  embedding cache is content-addressed by `(content_hash, model)`, the
  paid cost is a **one-time event per chunk text** — re-running
  `vault_reindex` on an unchanged vault embeds zero new chunks. Switching
  providers between server runs is safe: the cache keeps both providers'
  rows, so switching back to the other later re-uses what was previously
  embedded.

- **Graceful degradation.** Whichever provider is active, if it cannot
  reach the model (no network on the very first `local-minilm` run, before
  the weights are cached; or OpenAI unreachable), `vault_reindex` still
  builds the FTS5 lexical index. The vector column is left empty,
  `vectorUsed` reports `false`, and search transparently falls back to
  lexical-only ranking.

- **Quality tradeoff.** MiniLM is small and fast, which keeps Daftari
  dependency-light and snappy, but its recall/precision is below larger
  hosted embedding models. `openai-3-small` is the obvious next step.
  Pairing either with FTS5 BM25 covers the common case where a small
  model misses an exact-term match.

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
questions_answered:
  - "How does Aurora frame the ingestion-vs-transformation boundary?"
questions_raised:
  - "Does an authored-pipeline model slow teams down at small scale?"
---

# Aurora Pipelines — Positioning Overview

Aurora Pipelines treats ingestion as an authored, version-controlled artifact
rather than a managed black box.

## Questions Answered
- How does Aurora frame the ingestion-vs-transformation boundary?

## Questions Raised
- Does an authored-pipeline model slow teams down at small scale?
```

The optional `questions_answered` / `questions_raised` frontmatter fields make
a document's epistemic edges explicit and **queryable**: `vault_index` can
filter on open questions and `vault_lint` flags questions no document answers.
The matching `## Questions Answered` / `## Questions Raised` body sections are
an optional human-readable mirror. Full field reference in
[docs/file-format.md](docs/file-format.md).

Daftari's built-in frontmatter covers most vaults out of the box. For
domain-specific fields, add a `schema_extensions` block to
`.daftari/config.yaml` — typed extension fields that participate in validation
and serialize in a stable order, with no core schema change. See
[docs/schema-extensions.md](docs/schema-extensions.md).

---

## Vault hooks

Hooks are vault-owner-supplied functions that run **before every write** to
this vault. They let an organisation enforce conventions the built-in
frontmatter validator does not know about — naming rules, status-transition
guards, business-specific cross-field invariants, refusal lists — without
forking daftari or wrapping the MCP server. A hook is a plain ES module that
exports a default function and returns a list of `ValidationIssue` objects.
Any issue blocks the write, exactly the way a built-in schema violation does.

Hooks are declared in `.daftari/config.yaml`:

```yaml
hooks:
  pre_write:
    - path: .daftari/hooks/forbid-status-skip.mjs
    - path: .daftari/hooks/require-decision-id.mjs
```

The `path` is vault-root-relative. Hooks run in declared order. Every hook
runs on every write, even if an earlier hook produced issues — the caller
gets one consolidated list back, not the first failure.

A hook looks like this:

```ts
// .daftari/hooks/forbid-status-skip.mjs
//
// ValidationIssue = { field: string; message: string }
// context         = { path: string; operation: 'create' | 'update' | 'append' }
export default function forbidStatusSkip(frontmatter, context) {
  if (context.operation !== "update") return [];
  if (frontmatter.status === "canonical" && frontmatter.previous_status === "draft") {
    return [
      {
        field: "status",
        message: "draft → canonical is not allowed; promote via the dedicated tool",
      },
    ];
  }
  return [];
}
```

A hook is called with the already-stamped frontmatter the write is about to
land (so `updated` and `updated_by` reflect this call, not the previous
version on disk). The hook **must not mutate its inputs**; v1 is
validate-only. Returning a non-array, or an array containing malformed issue
objects, is itself reported as a blocking issue tagged with the hook path —
hook bugs surface as loud failures, not silent passes.

### Transform hooks

A `pre_write` hook can observe and reject, but it cannot *change* the
frontmatter a write lands. **Transform hooks** can. A transform hook runs in an
earlier phase — before built-in schema validation — so it can derive or
override frontmatter fields the validator would otherwise reject as missing.

Transform hooks are declared under their own key, `pre_write_transform`:

```yaml
hooks:
  pre_write_transform:
    - path: .daftari/hooks/derive-status.mjs
  pre_write:
    - path: .daftari/hooks/forbid-status-skip.mjs
```

The phase order is fixed regardless of how the config lists the blocks: every
`pre_write_transform` hook runs (in declared order), then built-in schema
validation, then every `pre_write` validator (in declared order). A transform
always runs before any validator sees the frontmatter.

A transform hook returns a `Partial<Frontmatter>` patch — *not* a list of
issues:

```ts
// .daftari/hooks/derive-status.mjs
//
// context = { path: string; operation: 'create' | 'update' | 'append' }
export default function deriveStatus(frontmatter, context) {
  if (frontmatter.decision_status === "ACTIVE") {
    return { status: "canonical" };
  }
  return {}; // no change
}
```

The runner merges each patch into the candidate frontmatter **`Object.assign`
style**: shallow, last-writer-wins. A key present in the patch replaces the
existing value outright — arrays are replaced whole, never appended to or
merged element-wise. When two transforms target the same field, the
later-declared one wins. Each transform sees the merged output of every
transform declared before it.

A transform **refuses by throwing** — it does not return issues. A throw
becomes a synthetic blocking issue tagged with the hook path, identical to the
`pre_write` throw mechanism. Returning anything that is not an object (an
array, a primitive, `null`) is likewise a blocking issue.

Because transforms run before validation, a transform that sets an invalid
value — a `status` outside the allowed set, say — is caught by the built-in
validator exactly as a bad user-supplied value would be.

### Trust model

Hooks are **trusted code**. They run in the same Node process as the daftari
server, with the same filesystem and network access. v1 does no sandboxing,
no permission prompts, no signature checking — the vault owner is responsible
for the contents of `.daftari/hooks/`. Treat hook files the way you would
treat `package.json` scripts or git hooks: review every change, never run a
vault you don't trust, and pin hook code in source control next to the
config that loads it. If you need stronger isolation than that, don't
register hooks in v1.

### Scope and limits in v1

- **Surfaces:** `pre_write` (validators) and `pre_write_transform`
  (field-deriving transforms). Future surfaces (`pre_read`, `post_write`,
  etc.) are reserved — unrecognised keys under `hooks:` are a loud config
  error, not a silent skip.
- **Operations:** both hook surfaces fire for `vault_write` (create + update)
  and `vault_append`. `vault_promote` and `vault_deprecate` deliberately
  bypass hooks — they're narrow metadata mutations the server controls
  end-to-end.
- **Two phases:** a `pre_write` hook returns a list of issues and can only
  reject. A `pre_write_transform` hook returns a `Partial<Frontmatter>` patch
  and can derive or override fields before validation — see "Transform
  hooks" above.
- **Sync:** hook bodies are synchronous functions. The loader is async
  (it has to dynamic-import the module), but each individual hook call is
  not awaited.
- **No caching across calls:** hooks are re-imported per write; expect to
  pay one ESM dynamic-import per declared hook per call. The next iteration
  may cache. Edits to a hook file are picked up on the next write — no
  server restart required.

See [issue #29](https://github.com/mavaali/daftari/issues/29) for the design
rationale and the alternatives that were rejected.

---

## What's not in v1

A few capabilities were deliberately deferred so v1 ships with a tight,
defensible surface — a server that does its core job well rather than a wide
one that does many jobs partially. Not in this release:

- **Self-hosted server mode** — a long-lived HTTP/SSE server multiple clients
  connect to, with pluggable cloud-storage backends (ADLS, S3, GCS) and OAuth
  authentication. Self-hosted by the operator, *not* a managed service. v1 runs
  against a local filesystem as a single stdio process.
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
- [docs/worked-example.md](docs/worked-example.md) — the compilation thesis shown, not argued: one document maturing across three agent writes, contrasted with RAG.
- [docs/architecture.md](docs/architecture.md) — the layered architecture, the request path, and the accumulation-vs-generative domain split.
- [docs/curation-workflow.md](docs/curation-workflow.md) — the reference curation loop: how an agent acts on `vault_lint` output instead of letting it pile up.
- [docs/file-format.md](docs/file-format.md) — the complete frontmatter reference and markdown body conventions.
- [docs/schema-extensions.md](docs/schema-extensions.md) — declaring typed, vault-specific frontmatter fields with a `schema_extensions` config block.

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
