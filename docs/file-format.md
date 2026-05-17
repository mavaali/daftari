# File Format

Every Daftari document is a single markdown file with a YAML frontmatter block.
Frontmatter is the metadata layer — Daftari keeps no metadata anywhere else.

```markdown
---
title: "Helios Consumption Pricing (Compute Credit Model)"
domain: accumulation
collection: pricing
status: canonical
confidence: high
created: 2026-01-20
updated: 2026-05-10
updated_by: human:mihir
provenance: direct
sources:
  - helios-pricing-page-2026-05
superseded_by: null
ttl_days: 45
tags: [helios, pricing, consumption]
---

# Helios Consumption Pricing (Compute Credit Model)

Body markdown follows the frontmatter block...
```

## Frontmatter reference

Validation is **advisory**: a document with a malformed or missing field still
reads successfully, but `vault_read` returns a validation report listing every
problem, and `vault_status` counts invalid documents. `vault_promote` is the
one place validity is enforced — an incomplete draft cannot be promoted.

### Required fields

| Field | Type | Allowed values | Notes |
|-------|------|----------------|-------|
| `title` | string | any non-empty string | Human-readable document title. |
| `domain` | enum | `accumulation`, `generative` | Knowledge that compounds vs. knowledge that is speculative. See [architecture.md](architecture.md). |
| `collection` | string | any non-empty string | The collection (directory) the document belongs to. Drives RBAC. |
| `status` | enum | `draft`, `canonical`, `deprecated`, `superseded`, `archived` | Lifecycle stage. See below. |
| `confidence` | enum | `low`, `medium`, `high` | How much the vault trusts this document. |
| `created` | date | `YYYY-MM-DD` | Set once, on creation. `vault_write` preserves it across updates. |
| `updated` | date | `YYYY-MM-DD` | **Server-stamped** on every write — do not author by hand. |
| `updated_by` | string | `agent:<id>` or `human:<username>` | **Server-stamped** on every write from the acting identity. |
| `provenance` | enum | `direct`, `synthesized`, `inferred` | How the content was obtained (see below). |

When calling `vault_write` you supply `title`, `domain`, `collection`,
`status`, `confidence`, `created`, `provenance` (plus any optional fields). The
server fills `updated` and `updated_by` itself, so a freshly written file is
always valid even though you never typed those two fields.

### Optional fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `sources` | list of strings | `[]` | Source identifiers the document was built from. |
| `superseded_by` | string or `null` | `null` | Vault-relative path of the document that replaces this one. Set by `vault_deprecate`. |
| `ttl_days` | number or `null` | `null` | Review horizon. After `ttl_days` past `updated`, the document is flagged stale by `vault_lint`. `null` means it never goes stale. |
| `tags` | list of strings | `[]` | Free-form tags. `vault_index` can filter by them conjunctively. |

### `status` — the lifecycle

| Status | Meaning |
|--------|---------|
| `draft` | In progress. Where new knowledge starts. Lives anywhere, often in `_drafts/`. |
| `canonical` | Vetted and trusted. Reached only via `vault_promote`, which requires complete frontmatter. |
| `deprecated` | No longer current. Set by `vault_deprecate` with a required reason. Kept, not deleted. |
| `superseded` | Replaced by a specific newer document. Typically paired with `superseded_by`. |
| `archived` | Retired from active curation but retained for the record. |

### `provenance` — how the content was obtained

| Value | Meaning |
|-------|---------|
| `direct` | Taken directly from a primary source. |
| `synthesized` | Combined and compiled from multiple sources by an agent. |
| `inferred` | Reasoned or guessed, not directly sourced. The weakest provenance. |

### `domain` — accumulation vs. generative

- `accumulation` — knowledge that *compounds*. Each write builds on the last;
  the document is meant to become more complete and trustworthy. Going stale is
  a problem to fix.
- `generative` — knowledge that is *speculative or single-shot*. A moonshot
  sketch, a brainstorm. Going stale is expected, not a defect.

The curation layer holds the two domains to different standards. See
[architecture.md](architecture.md#accumulation-vs-generative-domains).

## Markdown body conventions

The body is ordinary markdown. Two conventions make a vault more useful to the
agents maintaining it.

### The Questions Answered / Questions Raised pattern

End a document with two sections:

```markdown
## Questions Answered
- What is Helios's unit of consumption billing?
- Why do workload tiers carry different credit rates?

## Questions Raised
- How predictable is monthly spend for spiky, agent-driven workloads?
```

`Questions Answered` states what the document *settles* — what a later agent can
take as known. `Questions Raised` states the open edges — what is still
unresolved and worth a future write. This makes a document's epistemic boundary
explicit, so the next agent knows where to build rather than re-deriving what is
already settled. It is a convention, not a schema requirement.

### Links: wikilinks vs. markdown links

Daftari parses **both** internal link styles when it builds the inter-document
link graph for `vault_lint`'s orphan and deprecated-still-linked checks:

| Style | Example | Resolved by |
|-------|---------|-------------|
| Wikilink | `[[helios-consumption-pricing]]` | Bare basename match against any document in the vault. |
| Wikilink with alias / anchor | `[[helios-consumption-pricing\|Helios pricing]]`, `[[helios-consumption-pricing#tiers]]` | The `\|display` alias and `#heading` anchor are stripped before resolving. |
| Markdown link | `[Helios pricing](../pricing/helios-consumption-pricing.md)` | Resolved relative to the linking file's directory. |

External URLs and pure `#anchor` links are ignored — they do not create graph
edges. Prefer wikilinks for cross-references within the vault: they survive a
document being moved between collections, since they resolve by basename.

A document that no other document links to is reported as an **orphan** by
`vault_lint` — not an error, but a signal that a piece of knowledge is
disconnected from the rest of the vault.

## A complete example

```markdown
---
title: "Aurora Pipelines vs Helios Connect"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: high
created: 2026-03-12
updated: 2026-05-14
updated_by: agent:claude-code
provenance: synthesized
sources:
  - helios-blog-2026-03-connect-launch
  - internal-aurora-comparison-doc
superseded_by: null
ttl_days: 90
tags: [aurora, helios, ingestion, competitive]
---

# Aurora Pipelines vs Helios Connect

Helios Connect bundles managed ingestion connectors into the control plane.
Aurora Pipelines keeps ingestion as a separate, authored pipeline artifact.
See also [[helios-consumption-pricing]].

## Questions Answered
- Where does each product draw the ingestion/transformation boundary?

## Questions Raised
- How does Helios Connect pricing behave past 10 TB/day of ingestion?
```

All product and company names in Daftari's examples — Aurora, Helios, Northwind,
Cirrus, Vega — are fictional.
