# Reviewer Guide

Daftari is an MCP server that exposes a curated markdown vault to AI agents, with built-in search, advisory curation checks, and config-driven RBAC.

This guide walks a reviewer through every tool the server exposes, using the bundled `templates/reviewer-vault/` fixture. It is meant for a 15-minute hands-on review, not a deep tour.

## 1. Connect

The reviewer vault writes to git on every write-path tool call, so copy it somewhere writable outside this repo first:

```bash
cp -R templates/reviewer-vault ~/daftari-reviewer-vault
cd ~/daftari-reviewer-vault && git init && git add . && git commit -m "init"
```

Add the server to your `claude_desktop_config.json` (on macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "daftari": {
      "command": "npx",
      "args": [
        "daftari",
        "--vault",
        "/absolute/path/to/daftari-reviewer-vault",
        "--user",
        "reviewer",
        "--role",
        "admin"
      ]
    }
  }
}
```

The `admin` role is declared in `.daftari/config.yaml` with wildcard read/write and promote enabled, so every tool below works without bumping into RBAC. Restart Claude Desktop; the `daftari` server should appear in the MCP list.

Optional: do a one-shot index build before connecting:

```bash
npx daftari --vault /absolute/path/to/daftari-reviewer-vault --reindex
```

## 2. Walkthrough — exercising all 14 tools

The vault ships with eleven documents across three collections, one logged tension, and one intentionally-incomplete draft. Each step below pairs a concrete prompt with the result you should see.

### 2.1 `vault_status` — vault summary

> "Show me the daftari vault status."

Returns file count (11), collections (`_drafts`, `competitive-intel`, `pricing`), and an `invalidCount` of 1 — the deliberate incomplete draft.

### 2.2 `vault_index` — list documents in a collection

> "List the documents in the competitive-intel collection."

Returns five entries: two canonical positioning docs (Aurora, Helios), a deprecated preview note (Cirrus Realtime preview), its GA replacement, and the Northwind governance snapshot.

### 2.3 `vault_read` — read one document

> "Read competitive-intel/aurora-pipelines-positioning.md."

Returns frontmatter, body, validation report, and `version` (the optimistic-concurrency token you'd pass back on a write).

### 2.4 `vault_search` — hybrid search

> "Search the vault for managed connectors."

Returns ranked hits across collections; `helios-connect-overview.md` is at the top, with `aurora-pipelines-positioning.md` close behind because the two are intentionally cross-referenced. Hits carry both BM25 and vector scores.

### 2.5 `vault_search_related` — find documents like this one

> "Find documents related to competitive-intel/aurora-pipelines-positioning.md."

Returns the rest of the competitive-intel docs ranked by similarity, with Aurora's pricing-model note appearing in the related pricing cluster.

### 2.6 `vault_themes` — thematic clusters

> "Show me the themes in the vault. Use k=3."

Returns three labelled clusters with representative documents. Pass `k: 3` explicitly: this vault has only eleven documents, well under the default k-sweep range. `vault_themes` is designed for larger vaults where the sweep can discover a natural cluster count; on a small corpus pin `k` to a value you can read.

### 2.7 `vault_reindex` — rebuild the search index

> "Rebuild the daftari search index from scratch."

Returns `{ documentCount: 11, chunkCount: 11, vectorEnabled: true }` and any orphan chunks removed. Fast on this vault; on a real one it embeds every changed chunk.

### 2.8 `vault_tension_log` — record a tension between two docs

> "Log a tension between pricing/helios-credits-model.md (credits map cleanly to workload classes) and pricing/cirrus-capacity-tiers.md (reserved capacity is the simpler primitive at any scale)."

Appends a new entry to `.daftari/tensions.md` with status `unresolved`. The vault ships with one tension already logged between the Helios/Aurora positioning docs; this command adds a second.

### 2.9 `vault_lint` — advisory curation checks

> "Run vault_lint."

Reports findings across six checks. On this vault expect:

- **staleFiles**: `helios-credits-model.md` (past its TTL by months) and `cirrus-realtime-preview.md` (past TTL, but kept as a deprecated provenance note).
- **deprecatedStillLinked**: `cirrus-realtime-preview.md` is still linked from the canonical GA write-up.
- **unansweredQuestions**: `cirrus-capacity-tiers.md` raises a workload-mix breakeven question no other doc answers; several other docs have similarly orphaned questions.
- **orphanFiles**: a handful of docs with no inbound links (expected on a small vault).
- **stagnantLowConfidence**: `cirrus-realtime-preview.md` is low-confidence and old.

The lint report is advisory: nothing is auto-fixed.

### 2.10 `vault_provenance` — write history of one document

> "Show the provenance log for competitive-intel/aurora-pipelines-positioning.md."

On a freshly-copied vault the log is empty — provenance is recorded on writes through the tools. The write-path tools below populate it.

### 2.11 `vault_write` — create a new document

> "Create competitive-intel/reviewer-sample.md with title 'Reviewer Sample', domain accumulation, collection competitive-intel, status draft, confidence low, created today, updated today, updated_by agent:reviewer, provenance direct, ttl_days 30, tags ['reviewer'], and the body '# Reviewer Sample\n\nDemonstrates the write path.'"

Returns `{ action: "create", commit: "<short hash>", committed: true }`. The vault now has a new draft and a new git commit.

### 2.12 `vault_append` — append a section to an existing document

> "Append a section to competitive-intel/reviewer-sample.md titled 'Followup' with body 'A second pass added by vault_append.'"

Returns `{ action: "append", commit: "<hash>" }`. Frontmatter is preserved; `updated` and `updated_by` are re-stamped.

### 2.13 `vault_promote` — promote a draft to canonical

> "Promote competitive-intel/reviewer-sample.md."

Returns `{ action: "promote", status: "canonical" }`. Now try the same on the deliberately-incomplete draft:

> "Promote _drafts/scratch-incomplete.md."

Refused with an error like `vault_promote: frontmatter is incomplete: confidence: missing required field; created: missing required field; updated: missing required field`. This is the worked example for the promotion gate.

### 2.14 `vault_deprecate` — retire a document

> "Deprecate competitive-intel/reviewer-sample.md with reason 'reviewer cleanup'."

Returns `{ action: "deprecate", status: "deprecated" }`. Re-run `vault_provenance` on this file to see the full create → append → promote → deprecate trail in one log.

That's all 14 tools. Optional next step: re-run `vault_status` and `vault_lint` to see how the vault state has shifted.
