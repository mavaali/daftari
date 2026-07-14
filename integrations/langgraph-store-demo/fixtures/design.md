# Fixture design — planted facts and experiment variants

Fictional company: **Meridian Labs**, product **Relay** (an API gateway).
Four simulated agent sessions, processed in chronological order:

| session | domain  | simulated date |
|---------|---------|----------------|
| pricing | sales/pricing agent  | T-90d |
| ops     | SRE/platform agent   | T-60d |
| support | support agent        | T-30d |
| docs    | tech-writer agent    | T-7d  |

(Dates applied to `created_at` via SQL after insert, mirroring the
`demo_research_agent.py` date-shift pattern so temporal reasoning is real.)

## Why three variants

LangMem's `create_memory_store_manager` consolidates only what vector search
retrieves (`query_limit=5`) **within one namespace**. So "did LangMem catch it?"
depends on deployment shape. We run all three and report all three — nobody
gets to claim we handicapped their stack:

- **V1 realistic** — one namespace per session (LangMem's documented pattern:
  namespace by user/agent). Near-dups planted *within* a session so their
  consolidation gets its control-group win. Session provenance comes free from
  the namespace prefix.
- **V2 charitable** — all four sessions into ONE shared namespace, processed
  sequentially with `enable_deletes=True`. LangMem gets every retrieval-scoped
  chance to consolidate across sessions. This is the headline variant: what
  survives here survived their pipeline's best realistic shot. Session
  attribution recorded by diffing store keys after each session (their store
  does not record provenance — itself a finding).
- **V3 aggressive** — one global `create_memory_manager` call with V2's entire
  surviving memory set in a single context window, instructions to consolidate
  and remove inconsistencies. Not scalable, not their default, but the
  strongest possible steelman. Report what survives even this.

## Planted facts

### Category 1 — near-duplicate pairs (control; LangMem SHOULD merge these)

Both halves in the SAME session, spaced apart, phrased differently.

| id  | session | fact (phrasing A / phrasing B) | detection tokens |
|-----|---------|-------------------------------|------------------|
| ND1 | pricing | Relay's default API timeout is 30 seconds / API calls time out at 30s unless overridden | `30\s*s`, `time\s*out` |
| ND2 | ops     | Telemetry lands in ClickHouse / Relay telemetry is stored in a ClickHouse cluster | `clickhouse` |
| ND3 | ops     | Staging refreshes nightly at 02:00 UTC / staging data reload happens 2am UTC nightly | `staging`, `2\s*(am\|:00)` |
| ND4 | support | Enterprise SLA is 4-hour first response / enterprise tickets get first touch within four hours | `enterprise`, `(4\|four).{0,15}hour` |
| ND5 | docs    | Acme Corp is the largest Relay customer / biggest account on Relay is Acme Corp | `acme` |

### Category 2 — pairwise contradictions (different sessions, phrasing distant, shared entity)

| id  | side A (session) | side B (session) | detection tokens A / B |
|-----|------------------|------------------|------------------------|
| PC1 | "Primary deploy region for Relay is us-east-1" (ops) | "All Relay production workloads run out of eu-west-2" (docs) | `us-east-1` / `eu-west-2` |
| PC2 | "Relay log retention is 90 days" (pricing) | "We purge Relay logs after two weeks" (support) | `90\s*day` / `two\s*week\|14\s*day` |
| PC3 | "On-call for Relay is owned by the platform team" (ops) | "Incident response for Relay is the application team's job" (support) | `platform team` / `application team` |

### Category 3 — the n-way set (n=4, the centerpiece)

Capacity limits stated incompatibly across all four sessions. No pair is a
near-duplicate; each adjacent pair contradicts; only connected-component
traversal shows the four-way inconsistency.

| node | session | fact | token |
|------|---------|------|-------|
| NW-A | pricing | Pro tier is sold with a guaranteed 500 requests/sec per workspace | `500` + `req` |
| NW-B | ops     | Gateway capacity is hard-capped at 350 requests/sec per workspace; raising it requires a re-shard | `350` + `req` |
| NW-C | support | For enterprise escalations, support grants temporary bursts to 800 requests/sec without ops involvement | `800` + `req` |
| NW-D | docs    | Public docs state every plan is throttled to 200 requests/sec unless a custom contract overrides | `200` + `req` |

Edges expected: A–B (500 sold > 350 cap), B–C (800 burst > 350 hard cap),
C–D (docs 200 vs support 800), A–D (500 guaranteed vs 200 published).

### Category 4 — temporal traps (stale fact + correction scoped to a different context)

| id  | stale (session) | correction (later session) | trap |
|-----|-----------------|---------------------------|------|
| TT1 | "Control plane runs Postgres 13" (pricing, T-90d) | "The EU control-plane cluster migrated to Postgres 16 in Q3" (docs, T-7d) | Recency-only wrongly retires the PG13 fact; correction is EU-scoped, US cluster unstated |
| TT2 | "Webhook signatures use SHA-1 HMAC" (ops, T-60d) | "Workspaces created after May use SHA-256 webhook signing" (support, T-30d) | Correction scoped to new workspaces; old workspaces still SHA-1 |

### Category 5 — benign filler (~30, consistent, must NOT be flagged)

Founded 2019; HQ Portland; ~120 employees; CEO Dana Okafor; CTO Priya Shen;
Go + TypeScript stack; Kafka event bus; control plane on Postgres (no version
stated — reserved for TT1); SOC 2 Type II; Free/Pro/Enterprise tiers; RelayConf
each October; Docusaurus docs; Argo CD deploys; Linear for tracking; ~4k-member
Slack community; NPS 44; no on-prem offering; quarterly planning; design-partner
program; EU data-residency on roadmap; etc. Distributed ~7-8 per session.
False positives on these count against us in RESULTS.md.

## Extraction instructions (decision record)

First raw-extraction run used LangMem's DEFAULT instructions and dropped 4 of
20 plants: the default prompt is user-profile-oriented, and gpt-5.2 responded
by storing meta-notes ("the prior AI supplied facts... treat as unverified")
instead of the org facts themselves, and by bundling multiple facts per row.

Decision: pass LangMem's documented `instructions` parameter redirecting
extraction to the org-fleet-memory use case, while quoting their consolidation
directives VERBATIM ("Consolidate and compress redundant memories...; Remove
incorrect or redundant memories while maintaining internal consistency") so
the behavior under test is unchanged. Same instructions in every variant.
Reviewer-facing point: we tuned WHAT to extract (their supported use-case
customization), not HOW they consolidate.

Side-finding for the writeup: out of the box, LangMem's extractor distrusts
assistant-stated facts — reasonable for user-profile memory, but it means the
"agent fleet shared memory" story requires prompt surgery before their own
pipeline even sees the facts.

## Embedding-distance honesty check

Before committing fixtures: cosine similarity (text-embedding-3-small) for
every ND pair and every contradiction pair. Required: every contradiction
pair's similarity is BELOW every ND pair's similarity, with clear margin.
Numbers written to `fixtures/distances.json` and reported in RESULTS.md.

## Acceptance (revised after run 1 — decision by Mihir 2026-07-13)

Run 1 finding: in V2 LangMem did not *detect* the planted conflicts — it
silently destroyed one side of three of them (us-east-1, platform-team
on-call, and the 500 rps Pro guarantee all erased; recency won each time,
no flag, no audit trail) and harmonized the surviving n-way nodes into a
composite policy nobody ever stated. V1 (per-agent namespaces, their
documented pattern) preserved all 14 contradiction plants because
consolidation cannot see across namespaces.

Revised acceptance:
1. Post-LangMem **V1** snapshot (the Phase 2 import source) contains all
   planted contradictions. V2/V3 survival is *reported* in RESULTS.md as the
   destruction-rate finding, not required.
2. Near-duplicate pairs merged in V1 at >=80% (>=4 of 5 pairs).
3. Snapshots committed: `store-raw.sql`, `store-post-langmem.sql`.
