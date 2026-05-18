# Worked example — compilation over retrieval

Daftari's thesis is that knowledge should **compile**: an agent synthesizes an
answer once, writes it back as a durable document, and every later read starts
from that compiled answer instead of re-deriving it. The README argues this.
This document *shows* it — one document, three writes, getting better each
time.

The example uses the fictional **Helios** domain from the scaffold template, so
you can follow along against a fresh vault:

```bash
npx daftari --init ./helios-vault
npx daftari --vault ./helios-vault --user me --role admin
```

The scaffolded `pricing/helios-consumption-pricing.md` already raises an open
question:

> ## Questions Raised
> - How predictable is monthly spend for spiky, agent-driven workloads?

We will answer it — not in one shot, but by accumulation.

---

## Write 1 — an agent drafts an answer

An agent does some research and creates a first-pass document. It does not yet
know much, so it is honest about that: `status: draft`, `confidence: low`.

**`vault_write` call:**

```jsonc
{
  "path": "pricing/helios-spend-predictability.md",
  "agent": "agent:claude-code",
  "frontmatter": {
    "title": "Helios Spend Predictability for Agent Workloads",
    "domain": "accumulation",
    "collection": "pricing",
    "status": "draft",
    "confidence": "low",
    "created": "2026-05-17",
    "provenance": "inferred",
    "sources": ["helios-pricing-page"],
    "ttl_days": 45,
    "tags": ["helios", "pricing", "predictability"]
  },
  "body": "# Helios Spend Predictability for Agent Workloads\n\nHelios bills in compute credits. Agent-driven workloads are spiky, so monthly spend is hard to forecast from a single month's usage.\n\n## Questions Answered\n- Why is agent-driven Helios spend hard to forecast?\n\n## Questions Raised\n- Do Helios committed-use discounts smooth the spikes?\n- What does a representative agent workload's credit burn actually look like?\n"
}
```

**Resulting file** — `pricing/helios-spend-predictability.md`:

```markdown
---
title: Helios Spend Predictability for Agent Workloads
domain: accumulation
collection: pricing
status: draft
confidence: low
created: 2026-05-17
updated: 2026-05-17
updated_by: agent:claude-code
provenance: inferred
sources:
  - helios-pricing-page
superseded_by: null
ttl_days: 45
tags: [helios, pricing, predictability]
---

# Helios Spend Predictability for Agent Workloads

Helios bills in compute credits. Agent-driven workloads are spiky, so monthly
spend is hard to forecast from a single month's usage.

## Questions Answered
- Why is agent-driven Helios spend hard to forecast?

## Questions Raised
- Do Helios committed-use discounts smooth the spikes?
- What does a representative agent workload's credit burn actually look like?
```

**Tool response** — `vault_write` returns:

```jsonc
{
  "path": "pricing/helios-spend-predictability.md",
  "action": "create",
  "commit": "a1b2c3d",
  "status": "draft",
  "updated": "2026-05-17",
  "validation": { "valid": true, "issues": [] },
  "indexUpdated": true
}
```

The write auto-committed to git (`a1b2c3d`) and appended a provenance entry. A
fresh, honestly-hedged draft now exists.

---

## Write 2 — a later agent builds on it

A week later, a different agent picks up the two open questions. It does **not**
start from scratch — it reads the existing draft, answers what it can, and
overwrites the document with `vault_write`, bumping `confidence` to `medium`.

**`vault_write` call** (same `path`; `created` is preserved by the server):

```jsonc
{
  "path": "pricing/helios-spend-predictability.md",
  "agent": "agent:research-bot",
  "frontmatter": {
    "title": "Helios Spend Predictability for Agent Workloads",
    "domain": "accumulation",
    "collection": "pricing",
    "status": "draft",
    "confidence": "medium",
    "created": "2026-05-17",
    "provenance": "direct",
    "sources": ["helios-pricing-page", "helios-committed-use-docs"],
    "ttl_days": 45,
    "tags": ["helios", "pricing", "predictability"]
  },
  "body": "# Helios Spend Predictability for Agent Workloads\n\nHelios bills in compute credits. Agent-driven workloads are spiky, so monthly spend is hard to forecast from a single month's usage.\n\nHelios committed-use discounts let you pre-purchase a credit floor at a ~30% discount; spikes above the floor bill at on-demand rate. A workload that is 60%+ steady is well-served by committing the steady portion and absorbing spikes on-demand. A representative agent workload in our sample burned 70% of its credits in steady background indexing and 30% in bursty query handling.\n\n## Questions Answered\n- Why is agent-driven Helios spend hard to forecast?\n- Do Helios committed-use discounts smooth the spikes? Yes, for the steady portion.\n- What does a representative agent workload's credit burn look like? ~70% steady / 30% bursty.\n\n## Questions Raised\n- Does the 70/30 split hold across workload types, or is it sample-specific?\n"
}
```

**The diff** — what changed in the document:

```diff
 confidence: low          →  confidence: medium
 updated: 2026-05-17      →  updated: 2026-05-24
 updated_by: agent:claude-code  →  updated_by: agent:research-bot
 provenance: inferred     →  provenance: direct
 sources:
   - helios-pricing-page
+  - helios-committed-use-docs
```

plus a fuller body: a new findings paragraph, two questions moved from *Raised*
to *Answered*, one new question raised.

**The provenance entry** appended to `.daftari/curation-log.jsonl`:

```json
{
  "timestamp": "2026-05-24T14:03:11.482Z",
  "tool": "vault_write",
  "file": "pricing/helios-spend-predictability.md",
  "agent": "agent:research-bot",
  "action": "update",
  "frontmatter_diff": {
    "confidence": { "before": "low", "after": "medium" },
    "provenance": { "before": "inferred", "after": "direct" },
    "sources": {
      "before": ["helios-pricing-page"],
      "after": ["helios-pricing-page", "helios-committed-use-docs"]
    },
    "updated": { "before": "2026-05-17", "after": "2026-05-24" },
    "updated_by": { "before": "agent:claude-code", "after": "agent:research-bot" }
  }
}
```

The second agent's work *landed on top of* the first agent's. Nothing was
re-derived — the document carried the first answer forward and the second agent
only had to add what was new.

---

## Write 3 — the document matures

Another week passes. The document has been read several times, the 70/30 split
held up across workload types, and the frontmatter is complete. An agent with
the `promote` permission calls `vault_promote`.

**`vault_promote` call:**

```jsonc
{
  "path": "pricing/helios-spend-predictability.md",
  "agent": "agent:claude-code"
}
```

Promotion **refuses** unless the document is currently a draft, its frontmatter
is complete, and a confidence level has been explicitly set — which it is.

**The frontmatter change** is a single field:

```diff
 status: draft  →  status: canonical
 updated: 2026-05-24  →  updated: 2026-06-02
```

**`vault_lint` confirms a clean bill of health.** Run after the promotion:

```jsonc
// vault_lint
{}
```

```jsonc
{
  "generatedAt": "2026-06-02T09:15:00.000Z",
  "filter": null,
  "checks": {
    "staleFiles": [],
    "orphanFiles": [],
    "oldDrafts": [],
    "stagnantLowConfidence": [],
    "deprecatedStillLinked": []
  },
  "totalFindings": 0
}
```

No stale files, no orphan drafts, no stagnant low-confidence documents. The
draft that started at `confidence: low` is now canonical, and the linter
vouches for it.

---

## Contrast with RAG

In a RAG system, each of those three queries — *"why is agent spend
unpredictable?"*, *"do committed-use discounts help?"*, *"is this canonical
yet?"* — would have retrieved raw chunks from the Helios pricing pages and asked
the model to re-derive the synthesis from scratch, every time. The work of
stitching the answer together is paid again on every read, and the second
query has no idea the first one ever happened.

In Daftari, each write **built on the last**. Write 1 produced a hedged draft.
Write 2 read that draft and added findings instead of starting over. Write 3
promoted the accumulated result to canonical. The fourth read of this document
starts from a compiled, canonical, lint-clean answer — not from chunk
retrieval, and not from re-derivation.

That is the whole thesis in one file: **the vault got better the more it was
used.**

---

## Next

- [getting-started.md](getting-started.md) — the full tool tour against the sample vault.
- [architecture.md](architecture.md) — how the four layers make this safe under concurrent agents.
- [file-format.md](file-format.md) — the complete frontmatter reference.
