# Getting Started

This walkthrough takes you from an empty directory to a working, agent-curated
vault: scaffold it, write a document, search, lint, promote a draft, and
deprecate something stale. Every example here uses fictional content.

## 1. Scaffold a vault

```bash
npx daftari --init ./my-vault
```

`--init` creates:

```
my-vault/
  .daftari/
    config.yaml          # RBAC roles and per-collection permissions
    index.db             # SQLite search index (rebuildable, git-ignored)
  competitive-intel/     # sample collection
  pricing/               # sample collection
  moonshot/              # sample collection
  _drafts/               # staging area for in-progress documents
  .gitignore
```

It also writes three example documents, makes the vault a git repository, and
creates an initial commit. The collection names are structural — rename them to
match your own work. Run `--init` with no path and it defaults to
`./daftari-vault`.

## 2. Start the server

```bash
npx daftari --vault ./my-vault --user me --role admin
```

The server speaks the Model Context Protocol over stdio. The `--role` must name
a role in `.daftari/config.yaml`; the scaffolded config ships with `analyst`,
`researcher`, and `admin`. With no `--role`, the server runs as a deny-all
guest and every tool is denied.

To rebuild the search index without starting the server:

```bash
npx daftari --vault ./my-vault --reindex
```

## 3. Connect from Claude Desktop

Add Daftari to your `claude_desktop_config.json` (on macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "daftari": {
      "command": "npx",
      "args": [
        "daftari",
        "--vault",
        "/absolute/path/to/my-vault",
        "--user",
        "me",
        "--role",
        "admin"
      ]
    }
  }
}
```

Use an absolute vault path. Restart Claude Desktop and the 13 `vault_*` tools
appear. The rest of this walkthrough describes those tool calls — an agent
makes them for you, but they map one-to-one to what you would ask for.

## 4. Write your first document

`vault_write` creates a document. Supply the full frontmatter and the markdown
body; the server stamps `updated` / `updated_by`, builds the index entry, and
auto-commits to git.

```jsonc
// vault_write
{
  "path": "competitive-intel/northwind-overview.md",
  "agent": "agent:claude-code",
  "frontmatter": {
    "title": "Northwind — Positioning Overview",
    "domain": "accumulation",
    "collection": "competitive-intel",
    "status": "draft",
    "confidence": "low",
    "created": "2026-05-17",
    "provenance": "direct",
    "tags": ["northwind", "competitive"]
  },
  "body": "# Northwind — Positioning Overview\n\nNorthwind pitches a single idea: data never leaves the customer's trust boundary.\n\n## Questions Answered\n- What is Northwind's core message?\n\n## Questions Raised\n- Does the boundary story hold for cross-cloud analytics?\n"
}
```

The document lands as a `draft`. New knowledge starts as a draft and earns
canonical status later (step 7).

## 5. Search the vault

`vault_search` runs a hybrid BM25 + vector query:

```jsonc
// vault_search
{ "query": "trust boundary data governance" }
```

It returns ranked hits with snippets and per-ranker scores. `vault_search_related`
takes a document path instead of a query and surfaces thematically adjacent
documents — useful before writing, to find what the vault already knows.

## 6. Lint the vault

`vault_lint` runs six advisory curation checks across the whole vault:

```jsonc
// vault_lint
{}
```

It reports — never fixes:

- **staleFiles** — past their `ttl_days` and overdue for review
- **orphanFiles** — no inbound links from any other document
- **oldDrafts** — drafts that have sat unpromoted too long
- **stagnantLowConfidence** — low-confidence documents that have not improved
- **deprecatedStillLinked** — deprecated documents still cited by canonical ones
- **unansweredQuestions** — questions in `questions_raised` that no document answers

Pass `{ "filter": "oldDrafts" }` to restrict the report to one check.

## 7. Promote a draft to canonical

Once a draft is complete and trustworthy, `vault_promote` raises it to
`canonical`:

```jsonc
// vault_promote
{ "path": "competitive-intel/northwind-overview.md", "agent": "agent:claude-code" }
```

Promotion **refuses** unless the document is currently a draft and its
frontmatter is complete. Only roles with `promote: true` may call it. This is
the gate between "an agent wrote something" and "the vault vouches for it".

## 8. Deprecate what is no longer true

When a document is superseded or simply wrong, `vault_deprecate` retires it. A
reason is required; `superseded_by` is optional:

```jsonc
// vault_deprecate
{
  "path": "pricing/cirrus-capacity-tiers.md",
  "reason": "Replaced by the 2026 capacity refresh",
  "superseded_by": "pricing/cirrus-capacity-tiers-2026.md",
  "agent": "agent:claude-code"
}
```

A deprecated document is kept — git history and provenance stay intact — but it
is flagged so no agent treats it as current.

## 9. Inspect provenance

`vault_provenance` returns a document's full write history — every create,
update, append, promote, and deprecate:

```jsonc
// vault_provenance
{ "filePath": "competitive-intel/northwind-overview.md" }
```

That is the full loop: **write → search → lint → promote → deprecate**, with
git and the provenance log recording every step. The vault now knows more than
it did, and it knows *how* it came to know it.

## Next

- [architecture.md](architecture.md) — how the layers fit together.
- [curation-workflow.md](curation-workflow.md) — the reference loop for acting on `vault_lint` output.
- [file-format.md](file-format.md) — the complete frontmatter reference.
