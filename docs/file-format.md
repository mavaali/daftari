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
| `tier` | enum or `null` | `null` | Write-protection tier: `source`, `compiled`, or `manual`. Unset means no enforcement. See [below](#tier--write-protection). |
| `sources` | list of strings | `[]` | Source identifiers the document was built from. |
| `superseded_by` | string or `null` | `null` | Vault-relative path of the document that replaces this one. Set by `vault_deprecate`. |
| `ttl_days` | number or `null` | `null` | Review horizon. After `ttl_days` past `updated`, the document is flagged stale by `vault_lint`. `null` means it never goes stale. |
| `tags` | list of strings | `[]` | Free-form tags. `vault_index` can filter by them conjunctively. |
| `describes` | list of strings | `[]` | Code paths this document documents — doc-to-code bindings. See [below](#describes--doc-to-code-bindings). |
| `questions_answered` | list of strings | `[]` | Questions this document settles. The tool-queryable form of the `## Questions Answered` body section — see [below](#the-questions-answered--questions-raised-pattern). |
| `questions_raised` | list of strings | `[]` | Open questions this document leaves. `vault_index` filters on it via `has_unanswered`; `vault_lint` flags any entry no document answers. |

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

### `tier` — write-protection

Opt-in, per document. Unset (`null`) means no enforcement — the behavior every
document had before the field existed.

| Value | Meaning |
|-------|---------|
| `source` | Raw ingested material. The body is immutable to **every** writer; `vault_write` and `vault_merge` refuse body changes. `vault_append` still works. |
| `compiled` | Agent-maintained synthesis. No enforcement — named so a compilation pass can assert what it is allowed to regenerate. |
| `manual` | Human-authored canon. Body rewrites require a `human:*` identity; agents can still `vault_append`. |

The escape hatch is **demote-then-write**, not a force flag: change the tier
first with `vault_set_tier` (a reason is required; the change lands in the
provenance log and `vault_lint` surfaces every demotion off `source` under
`tierDemotions`), then write. Two asymmetries are deliberate:

- Moving a document **away from `manual`** requires a `human:*` identity —
  `manual` is a consent boundary only a human may lift. Moving away from
  `source` is open to any identity, loudly.
- On a document currently tiered `source` or `manual`, the tier can only be
  changed via `vault_set_tier` — `vault_write` refuses frontmatter payloads
  that touch it, so the reason requirement cannot be dodged.

`tier` is orthogonal to `provenance`: provenance describes how content was
obtained (self-reported, advisory); tier controls who may rewrite it
(enforced at the write path).

### `domain` — accumulation vs. generative

- `accumulation` — knowledge that *compounds*. Each write builds on the last;
  the document is meant to become more complete and trustworthy. Going stale is
  a problem to fix.
- `generative` — knowledge that is *speculative or single-shot*. A moonshot
  sketch, a brainstorm. Going stale is expected, not a defect.

The curation layer holds the two domains to different standards. See
[architecture.md](architecture.md#accumulation-vs-generative-domains).

### `describes` — doc-to-code bindings

`describes` declares which code paths a document documents. It is the
machine-traversable edge the coherence audit walks from a doc to the code it
describes — so the audit can flag a binding when the code file is gone, and
(with `--semantic`) check whether the doc's claims still match the code.

```yaml
describes:
  - auth-service/src/login.ts
  - auth-service/src/login.ts::validateCredentials
```

Each entry is one of:

| Form | Meaning |
|------|---------|
| `repo:path` | A file in a repo registered with the audit. `repo` is matched against the audit's configured repo names. |
| `path` | A bare path with no `repo:` prefix resolves against the document's **own** repo. |
| `repo:path::symbol` | A specific symbol within the file. **v1 resolves at the file level** — the `::symbol` suffix is retained but not yet resolved (reserved for v2). |

`describes` is advisory metadata, not a write-time constraint: a binding to a
file that does not exist is never an error at write time. The coherence audit is
what surfaces broken or drifted bindings. The relationship is one-directional —
docs describe code; code carries no Daftari frontmatter.

## Markdown body conventions

The body is ordinary markdown. Two conventions make a vault more useful to the
agents maintaining it.

### The Questions Answered / Questions Raised pattern

A document can make its epistemic boundary explicit: what it *settles*, and what
it leaves *open*. `Questions Answered` is what a later agent can take as known;
`Questions Raised` is the open edges worth a future write. This lets the next
agent know where to build rather than re-deriving what is already settled.

The pattern has two forms, and they are kept in sync:

**1. Frontmatter fields — the source of truth for tooling.** The optional
`questions_answered` and `questions_raised` arrays make the pattern structured
and queryable:

```yaml
questions_answered:
  - "What is Helios's unit of consumption billing?"
  - "Why do workload tiers carry different credit rates?"
questions_raised:
  - "How predictable is monthly spend for spiky, agent-driven workloads?"
```

Because they are structured metadata, tools can act on them:

- `vault_index` returns each document's questions, and its `has_unanswered`
  filter selects documents that do (or do not) carry open questions.
- `vault_lint`'s `unansweredQuestions` check flags any question in a document's
  `questions_raised` that no document in the vault lists under
  `questions_answered` — turning the epistemic surface into a coverage map.
  Matching is by normalized text (trimmed, lower-cased, whitespace collapsed),
  so a question counts as answered only when phrased the same way.

**2. Body sections — a human-readable mirror.** The same questions may also
appear as `## Questions Answered` / `## Questions Raised` markdown sections so a
person reading the file sees them in context:

```markdown
## Questions Answered
- What is Helios's unit of consumption billing?

## Questions Raised
- How predictable is monthly spend for spiky, agent-driven workloads?
```

Both forms are optional. When both are present, keep them consistent — the
frontmatter is what tooling reads.

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
questions_answered:
  - "Where does each product draw the ingestion/transformation boundary?"
questions_raised:
  - "How does Helios Connect pricing behave past 10 TB/day of ingestion?"
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
