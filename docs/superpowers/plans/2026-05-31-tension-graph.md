# Tension Graph: Composable Contradiction Tracking for Daftari

**Status:** locked spec — baseline for implementation
**Author:** Mihir Wagle
**Date:** 2026-05-31
**Baseline supersedes:** original draft of 2026-05-31; folds in eight design-review resolutions (Gaps 1–8)
**Target:** Daftari v2 (phased)

-----

## Problem

Tensions in v1 are pairwise and flat. Two documents disagree, you log it, done. This works when a vault has a handful of contradictions. It stops working when the vault grows and tensions accumulate — because contradictions compose. Doc A contradicts doc B, but docs C, D, and E all cite A as a source. The downstream epistemic risk is invisible. Unresolved tensions age silently. And not all contradictions are the same kind of disagreement, but the log treats them identically.

The tension log is Daftari's most distinctive feature. It deserves a richer data model.

-----

## Design Principles

1. **Advisory posture preserved.** Nothing in this plan auto-resolves tensions. The system surfaces structure; humans and deliberate agent decisions drive changes.
2. **Frontmatter is still the source of truth.** Tension metadata lives in the tension log and the search index, not in document frontmatter. Documents don't need to know they're contested.
3. **Incremental delivery.** Each phase ships a useful capability. No phase depends on a later one (except the final cross-feature integration, which depends on the prior phases by design).
4. **Schema changes carry a migration story.** Legacy tension entries must continue to read cleanly through the new tooling without producing spurious warnings.

-----

## Phase 1 — Taxonomy and Resolution

The single largest piece. Phase 1 adds two surfaces at once because they're two halves of the same schema change: classification (`kind`) and closure (`resolution`).

### Tension kinds

A tension entry now carries a `kind`:

| Kind | Definition | Typical resolution pattern | Default lint treatment |
|---|---|---|---|
| `temporal` | A was true, B is true now. Succession, not conflict. | Deprecate the older document. Straightforward. | Action item — flag as resolvable. |
| `factual` | A and B claim different things about the same observable. One is wrong. | Investigation required. Someone needs to check. | Warning — flag as needing triage. |
| `interpretive` | A and B agree on facts, draw different conclusions. | May never resolve. Both can coexist explicitly. | Informational — not a defect *if explicitly accepted*. |
| `unspecified` | Legacy entries logged before Phase 1, or entries logged without a kind. | None — can be reclassified later via re-log. | Counted but generates no warnings or action items. |

### Backward compatibility (Gap 1)

- Existing tension log entries without a `kind` field read as `unspecified`. They are counted in tension totals but generate **no lint warnings or action items** until someone classifies them.
- New entries logged through `vault_tension_log` REQUIRE the `kind` parameter. No default — the agent or human must decide. This prevents lazy logging that bypasses the taxonomy's value.
- No migration tool. Legacy entries can be reclassified by editing the tension log directly or by re-logging.

### Resolution model (Gap 2)

A tension entry can carry a `resolution` block recording who closed it, when, how, and (optionally) why and with what references.

```yaml
id: tension-007
kind: factual
doc_a: pricing/helios-consumption-pricing.md
doc_b: competitive-intel/helios-pricing-update.md
description: "Helios credit multiplier: doc A says 1.5x for GPU, doc B says 2.0x"
logged_by: agent:claude-code
logged_at: 2026-05-31T14:00:00Z
resolved: true
resolution:
  resolved_at: 2026-06-15T09:30:00Z
  resolved_by: human:mihir
  kind: corrected           # superseded | corrected | accepted | invalid
  rationale: "Helios doc confirmed via vendor portal — multiplier is 1.5x; competitive-intel doc was based on stale Q1 data."
  references: ["pricing/helios-consumption-pricing.md"]
```

#### Resolution kinds

- `superseded` — typical for temporal tensions; an older doc has been deprecated/superseded by a newer one. References should point at the superseding doc.
- `corrected` — typical for factual; one side was determined wrong and edits applied. References should point at the surviving / corrected doc.
- `accepted` — for interpretive; both views stand, recorded as deliberately persistent. Resolves Gap 4 (see below). Does NOT mean the tension is gone — it means the disagreement is an acknowledged, stable feature of the vault.
- `invalid` — the tension shouldn't have been logged (false alarm, mis-classification).

#### Required fields on resolve

- `resolution.resolved_at` (ISO 8601 timestamp)
- `resolution.resolved_by` (agent or human identifier)
- `resolution.kind` (one of the four above)

#### Optional fields

- `resolution.rationale` — strongly recommended; the audit trail that explains the decision.
- `resolution.references` — list of doc paths central to the resolution.

#### Lint treatment after resolution

- `accepted` tensions are alive but explicitly stable. They appear in `vault_lint` under a separate "stable acknowledged disagreements" count. The aging machinery (Phase 4) does NOT apply to them.
- All other resolutions (`superseded`, `corrected`, `invalid`) close the tension fully — it leaves the active surface and shows up only in historical reports.

### Interpretive tensions and the staleness contradiction (Gap 4)

The original plan called 90-day unresolved interpretive tensions "stale" with the framing "either escalate or garbage collect." That contradicted the taxonomy's own statement that interpretive disagreement may never resolve and both can coexist.

The resolution is structural, not cosmetic:

- Interpretive disagreement that's been **explicitly accepted** (`resolution.kind: accepted`) is not aged. It's a stable epistemic feature of the vault, not a defect.
- Interpretive disagreement that's been logged but NOT explicitly accepted still ages — but the lint copy at the stale tier names the right resolution paths (`accepted` or `invalid`), not "garbage collect."

The smell is not the persistence of disagreement; it's the failure to make an explicit decision about its persistence.

Stale-tier lint messages by kind:

- `temporal`: "Unresolved temporal tension — likely just needs the older doc deprecated."
- `factual`: "Unresolved factual tension — investigation overdue."
- `interpretive`: "Unresolved interpretive tension — decide explicitly: `accepted` if both views stand, `invalid` if it was mis-logged. Long-running unacknowledged disagreement is the smell, not the disagreement itself."
- `unspecified`: no stale tier lint. Unspecified tensions don't get tier-based warnings until they're classified.

### MCP tools shipped in Phase 1

#### `vault_tension_log` — extended

Now accepts a `kind` parameter, required for new logs.

```
Arguments:
  doc_a:       string  (vault-relative path)
  doc_b:       string  (vault-relative path)
  description: string
  kind:        string  (REQUIRED — "temporal" | "factual" | "interpretive")
                       Note: "unspecified" is for legacy entries only, not loggable.
```

#### `vault_tension_resolve` — new

```
Arguments:
  id:         string  (tension id)
  kind:       string  ("superseded" | "corrected" | "accepted" | "invalid")
  rationale:  string  (optional; strongly recommended)
  references: array of string (optional; vault-relative paths)

Returns:
  resolution block as it now appears in the tension log entry.
  Errors if the tension is already resolved, or if the id doesn't exist.
```

### `vault_lint` extensions in Phase 1

The tension health section adds:

```
Tension health:
  Total:                       N
  By kind:                     temporal: N, factual: N, interpretive: N, unspecified: N
  Resolved (lifetime):         N (by resolution kind: superseded: N, corrected: N, accepted: N, invalid: N)
  Stable acknowledged:         N (resolution.kind == accepted; persistent disagreements)
  Unspecified (legacy):        N (not lint-flagged; reclassify when possible)
```

### Phase 1 effort

Small to medium. Schema additions, two tool changes (one extension, one new), lint surface additions. No graph work.

-----

## Phase 4 — Aging (basic, no cross-feature blast metric)

Phase 4 ships second per the corrected order (see Implementation Order below). It depends on Phase 1 (kind-aware copy) but ships WITHOUT the cross-feature "blast radius of stale tensions" metric — that lands in step 5 once blast exists.

### Aging tiers

| Age | Status | Lint behavior |
|---|---|---|
| 0–30 days | Fresh | Informational. Recently logged, may still be under active investigation. |
| 31–90 days | Aging | Advisory. Flagged in `vault_lint` as "unresolved and aging." |
| 90+ days | Stale | Warning with kind-specific copy (see Phase 1's stale-tier messages). |

### Kind-specific aging

- `temporal` tensions aging past 30 days are louder — these are supposed to be easy to resolve.
- `interpretive` tensions have a longer fuse — 90 days before first stale-tier flag. The stale-tier copy for interpretive does NOT use "garbage collect" framing; see Phase 1 for the correct copy.
- `factual` tensions use the default tiers.
- `unspecified` tensions are not aged at all. They count toward totals but do not produce age-based warnings.
- `accepted` tensions (via Phase 1's `resolution.kind`) are excluded from the aging pipeline entirely.

### `vault_lint` extensions in Phase 4

```
Tension health:
  ...all Phase 1 fields above...
  Aging tiers:
    Fresh (0–30d):       N
    Aging (31–90d):      N
    Stale (90+d):        N
      ↳ temporal:        N
      ↳ factual:         N
      ↳ interpretive:    N
      ↳ unspecified:     0   (unspecified is not aged; shown for clarity)
```

### Phase 4 effort

Small. Date arithmetic, lint copy, conditional formatting.

-----

## Phase 2 — Connected Components

Tension clusters: groups of documents connected by transitive contradiction.

### Algorithm

Standard union-find over tension edges. Run on demand, triggered by the new tool or as part of `vault_lint`.

### Cluster ID stability (Gap 3)

Cluster IDs are **content-addressed**, not positional. The ID is computed as:

```
"cluster:" + first 8 hex chars of sha256(sorted-canonical member paths)
```

Example: `cluster:a3f29c10` for a cluster whose members canonical-sort to `[competitive-intel/helios-pricing-update.md, competitive-intel/helios-q2-analysis.md, moonshot/alternative-pricing-model.md, pricing/helios-consumption-pricing.md]`.

Properties:
- Same membership → identical ID across runs. Stable for external reference.
- Membership changes → ID changes. That's the correct semantic: a different membership is genuinely a different cluster. References to the old ID become self-invalidating, which is the right behavior.
- When a new tension is added that merges two clusters, the merged cluster's ID does not match either predecessor's. Also correct — it's a new cluster.

### Cluster scope

The cluster computation considers only:

- `resolved: false` tensions, AND
- `resolution.kind != accepted` tensions

In other words: clusters represent live contested regions. Resolved tensions and stable-acknowledged disagreements do not participate in cluster formation.

### New tool: `vault_tension_clusters`

```
Request:  { "method": "tools/call", "params": {
              "name": "vault_tension_clusters",
              "arguments": {} } }

Response: {
  "cluster_count": 3,
  "clusters": [
    {
      "id": "cluster:a3f29c10",
      "size": 4,
      "documents": [
        "pricing/helios-consumption-pricing.md",
        "competitive-intel/helios-pricing-update.md",
        "competitive-intel/helios-q2-analysis.md",
        "moonshot/alternative-pricing-model.md"
      ],
      "tension_count": 3,
      "kinds": { "factual": 2, "interpretive": 1 },
      "oldest_tension_age_days": 47,
      "newest_tension_age_days": 3
    }
  ]
}
```

### `vault_lint` integration in Phase 2

Adds cluster metrics to the tension health section:

```
Tension health:
  ...all earlier fields...
  Clusters:                    N (max size: M)
    Large (>5 docs):           N      (smell: investigate)
    Aged (>90d oldest tension): N     (tech debt)
```

### Phase 2 effort

Medium. Union-find over the tension log, content-addressed ID computation, lint integration.

-----

## Phase 3 — Blast Radius

Given a tension or tension cluster, compute the transitive closure of downstream documents — everything that cites or depends on a contested node.

### Edge set (Gap 5)

The dependency graph for blast traversal uses TWO edge types:

1. `sources` array in frontmatter — explicit provenance. **Primary edge.**
2. In-vault markdown links — implicit reference. **Advisory edge.**

`superseded_by` is NOT a blast edge. It's a deprecation relationship between OLD and NEW versions, not an epistemic dependency. A doc that supersedes a contested doc is the *replacement*, not an inheritor of the contested state. Walking the blast through `superseded_by` would falsely contaminate the resolution path.

"Deprecated doc still cited" is handled separately by the existing `deprecated-still-linked` lint check — a different question with a different fix.

### Primary vs. advisory channels (Gap 6)

The two edge types carry different confidence levels:

- `sources` is authoritative provenance the doc author declared explicitly.
- In-vault markdown links are advisory — they flag potential exposure but may include "see also" / "related reading" links that aren't epistemic dependencies.

The blast tool surfaces these separately in the response and `vault_lint` thresholds key off the primary channel only.

### Tool accepts document OR cluster (Gap 7)

`vault_tension_blast` accepts exactly one of `document` or `cluster_id`. Both or neither → error.

#### Document mode

```
Arguments:
  document: string  (vault-relative path)
```

Returns blast for that single document. Response also identifies which cluster (if any) the doc is in, plus the cluster's members — so the agent sees the broader region without a second call.

#### Cluster mode

```
Arguments:
  cluster_id: string  (a content-addressed cluster id from Phase 2)
```

Returns blast for the union of all documents in that cluster. Downstream set is deduplicated; a doc reached through multiple cluster members appears once with the highest-confidence dependency type (`source` beats `link`).

#### Response shape (consistent across modes)

```
{
  "contested_document": "pricing/helios-consumption-pricing.md",  // null in cluster mode
  "cluster_id": "cluster:a3f29c10",                               // present in both modes
  "cluster_documents": [...],                                     // members of the cluster
  "downstream": [
    {
      "path": "strategy/q3-pricing-recommendation.md",
      "dependency_type": "source",
      "distance": 1
    },
    {
      "path": "presentations/board-deck-q3.md",
      "dependency_type": "link",
      "distance": 2
    }
  ],
  "primary_blast": 1,        // count of docs reached via "sources" frontmatter
  "advisory_blast": 1,       // count of docs reached only via in-vault links
  "max_depth": 2
}
```

If a downstream doc is reached via BOTH a `sources` edge and a link edge, it counts as primary (higher-confidence channel wins) and its `dependency_type` is reported as `source`.

### Phase 3 effort

Medium-high. Build a dependency graph from frontmatter `sources` and markdown links, compute on demand from the search index (no separate maintained graph), implement dedup + channel-precedence logic.

-----

## Step 5 — Cross-Feature Integration

Once aging (Phase 4) and blast (Phase 3) both exist, `vault_lint` gains a final line in the tension health section:

```
Tension health:
  ...everything above...
  Blast radius of stale tensions: N downstream documents
```

### Definition

`blast radius of stale tensions` is the cardinality of the DEDUPLICATED UNION of `primary_blast` sets across all tensions where `resolved: false AND aging_tier = stale`.

In plain language: collect every contested doc from every stale unresolved tension; for each, walk the blast graph via `sources` edges only; union the resulting sets; report the size.

Why primary-blast-only: stale tensions are the ones that need attention, and the metric should not be inflated by advisory link counts. The `advisory_blast` channel exists for per-tension/per-cluster inspection; the top-level lint metric stays disciplined.

### Step 5 effort

Small. Sum of two existing computations.

-----

## Implementation Order

The corrected order resolves the plan's original inconsistency (Phase 4's example output referenced a Phase 3 metric).

| # | Ship | Depends on | Ship criterion |
|---|---|---|---|
| 1 | **Phase 1** — Taxonomy + Resolution | nothing | `kind` field on new logs (required), `vault_tension_resolve` tool with four resolution kinds, legacy entries read as `unspecified`, `vault_lint` reports counts by kind and resolution kind and stable-acknowledged count. |
| 2 | **Phase 4** — Aging (basic) | Phase 1 | Tiered stale tensions in `vault_lint` with kind-specific copy. No blast metric in initial output. `unspecified` and `accepted` excluded from aging. |
| 3 | **Phase 2** — Clusters | Phase 1 | `vault_tension_clusters` returns content-addressed cluster IDs; computed only over `resolved: false AND resolution.kind != accepted`. |
| 4 | **Phase 3** — Blast radius | Phases 1 + 2 | `vault_tension_blast` accepts `document` OR `cluster_id`, returns `primary_blast` / `advisory_blast` split, drops `superseded_by` from the edge set. |
| 5 | **Cross-feature integration** | all above | `vault_lint` tension health gains the "blast radius of stale tensions" metric. |

Each phase is independently shippable. Each ships something useful and is testable on its own.

-----

## What This Plan Does NOT Include

Carried from the original plan, plus deferred nitpicks identified in the design review.

### Out of scope by principle

- **Auto-resolution.** The advisory posture is the right call. The system surfaces structure and risk; it never acts on the vault unilaterally.
- **Cross-vault tensions.** v1 is single-vault. If Daftari grows multi-vault, tensions that span vaults are a real problem. Not in scope here.
- **Background scheduling.** A cron that runs `vault_lint` and `vault_tension_clusters` periodically would be useful but belongs in the background curation agent work, not this plan.

### Deferred for future revisits

- **Weighted tension edges.** Tensions could carry severity or confidence scores. Adds complexity without clear payoff until cluster sizes routinely exceed 10 documents. Revisit if that becomes routine.
- **Tension directionality.** Real tensions are often asymmetric — "B challenges A" is meaningfully different from "A and B are mutually inconsistent." For Phase 2 clustering, edges are symmetric (union-find requires it). Preserving directionality for prioritization-within-cluster is a v3 concern.
- **Severity score in blast response.** A composite score combining `distance` and `dependency_type` would help agents triage faster. For Phase 3 v1, the response surfaces both fields and the agent does its own weighing.
- **Reverse blast traversal.** "What does X depend on?" is the question an agent reading a downstream doc would naturally ask. The current `vault_tension_blast` answers forward only ("what depends on X?"). Reverse blast is a clean Phase 3b add-on.
- **Performance at scale beyond the trident wiki sweet spot.** Phase 2 union-find and Phase 3 transitive closure are on-demand. At the trident scale this is fine. At multi-vault scale, caching the dependency graph between calls would be necessary; this is not implemented in v1.
- **Mutability of `kind` after logging.** The taxonomy assumes a tension is one kind. In practice it's often a mix, and the right kind may only become clear later. v1 has no explicit "reclassify" tool — you re-log or edit the file. A dedicated reclassify tool is a future polish.

-----

## Connection to Broader Thesis

The tension graph turns Daftari from a knowledge vault into something closer to an epistemic ledger — a system that doesn't just store what's believed, but tracks where beliefs conflict, what kind of conflict each is, how the conflicts cluster, how far they propagate downstream, and how long they've been left unacknowledged.

The combination of bidirectional dependency tracking + tension semantics + aging is what makes the vault *compound* rather than just *accumulate*. RAG doesn't know when its chunks disagree. A filesystem doesn't know when its files contradict. A knowledge graph might track that two nodes are linked, but rarely tracks that they're in disagreement and what kind. The tension graph is the layer that no retrieval stack provides.

-----

## Locked Resolutions Index

The eight design-review resolutions folded into this baseline:

| Gap | Topic | Resolution |
|---|---|---|
| 1 | Backward compat for `kind` | Fourth state `unspecified` for legacy entries; new logs require kind. |
| 2 | Resolution event schema | `resolution` block with `resolved_at`, `resolved_by`, `kind` (4 values), optional rationale + references. New `vault_tension_resolve` tool. |
| 3 | Cluster ID stability | Content-addressed IDs: `cluster:` + first 8 hex chars of sha256 of canonical-sorted member paths. |
| 4 | Interpretive tension staleness | `resolution.kind: accepted` removes from aging; stale-tier lint copy names correct resolution paths per kind. |
| 5 | `superseded_by` as a blast edge | Dropped. Only `sources` + in-vault links are blast edges. |
| 6 | Markdown links over-reporting | Two-channel split: `primary_blast` (sources) and `advisory_blast` (links) in response and lint. |
| 7 | Blast tool argument | Accepts `document` OR `cluster_id`, exactly one. Cluster mode is the structural query. |
| 8 | Phasing inconsistency | Step 5 separates the cross-feature aging × blast metric from Phase 4's initial output. Resolution surface absorbed into Phase 1. |
