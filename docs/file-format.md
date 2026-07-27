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
valid_from: 2026-05-01
valid_until: null
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
| `valid_from` | date or `null` | `null` | First date the document's claim was true **in the world**. Valid time, not transaction time — see [below](#valid_from--valid_until--valid-time). |
| `valid_until` | date or `null` | `null` | First date the claim was **no longer** true — the window is half-open, so this day is excluded. `null` with a `valid_from` means open-ended, not unknown. |
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

### `valid_from` / `valid_until` — valid time

Daftari records **transaction time** in several places: git history, and the
`created` / `updated` fields. That axis answers "when did the vault come to
believe this?" These two fields add the other axis — **valid time** — which
answers "when was this true in the world?"

The two are genuinely different, and the difference matters. A document edited
this morning can describe a price that stopped applying in March. Nothing in
transaction time can tell you that.

```yaml
valid_from: 2026-01-01
valid_until: 2026-04-01   # first day it no longer held
```

**The window is half-open: `[valid_from, valid_until)`.** A day is in-window
iff `valid_from <= day < valid_until`. The example above covers 2026-03-31 and
does *not* cover 2026-04-01.

That reads slightly against how people speak — "valid through March" is written
`valid_until: 2026-04-01` — and it is worth the friction, because it makes a
handoff exact instead of arithmetic:

```yaml
# q1-pricing.md          # q2-pricing.md
valid_from:  2026-01-01  # valid_from:  2026-04-01
valid_until: 2026-04-01  # valid_until: null
```

The successor's `valid_from` is the predecessor's `valid_until`. Exactly one of
them covers any given day — no shared day, no gap, and no off-by-one for a tool
to get wrong. `vault_supersede`'s `predecessor_valid_until` writes that date
verbatim for the same reason.

| Shape | Meaning |
|-------|---------|
| both set | The claim held from `valid_from` up to but **not including** `valid_until`. |
| `valid_from` set, `valid_until: null` | Open-ended — still true as far as the vault knows. **Not** "unknown end". |
| `valid_from: null`, `valid_until` set | Open-start: the vault does not know when it began, but knows when it ended. |
| `valid_until <= valid_from` | A contradiction — an empty or inverted window. Read as **unknown** everywhere, never as "expired", and reported by `vault_lint`. |
| both `null` | **Valid-time-unknown.** The default, and the state of every document written before this feature existed. Never read as "always true". |

Three rules govern them.

**Authored, never inferred.** `daftari backfill` will not propose a value,
`daftari import` will not synthesize one, and no LLM pass extracts them. Dates
from git, mtime, or `created`/`updated` are transaction time; laundering them
into valid time would manufacture a claim nobody made. The one assisted path is
the `predecessor_valid_until` argument on `vault_supersede`,
`vault_deprecate`, and `vault_merge`,
and that date comes from the caller.

**Not the same as `ttl_days`.** `ttl_days: 45` is a promise to re-review in 45
days. It says nothing about how long the fact held. Collapsing the two is the
most common way to get this wrong.

**Absence is not evidence.** A document with no interval is never filtered out
of `vault_search --valid-only`, never counted as invalid, and never counted as
valid. It goes in its own `unknown` bucket everywhere.

A malformed date here will **not** block a write — these are optional fields,
and an optional field must never make a document unwritable. `vault_lint`'s
`validityConflicts` check reports malformed endpoints, inverted intervals, and
supersession overlaps and gaps.

#### Upgrading from a `valid_from` schema extension

If your `.daftari/config.yaml` declares `valid_from` or `valid_until` under
`schema_extensions`, config load will now fail with an actionable error. Remove
the declaration: existing values in your documents are read as-is by the
built-in field, which means a closed, day-granular valid-time interval. If your
field meant something else, rename the extension (for example
`effective_from`) and the vault will load.

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
valid_from: null
valid_until: null
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
