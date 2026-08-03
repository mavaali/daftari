# Requirements: Tension Triage Card (v0)

> Status: DRAFT — local working artifact, **uncommitted by design** (disclosure held; see design note). Do not `git add`/push without an explicit call.

## Context

Daftari makes tensions first-class and, by thesis, **does not auto-resolve** them — humans own resolution. But today the entire tension surface is agent-facing MCP tools (`tension_log`, `tension_clusters`, `tension_blast`, `tension_resolve`), with no human-legible way to see which tensions matter and why. This feature builds the **legibility layer**: an enriched, read-only view of open tensions so a human (directly at the CLI, or via an agent rendering rich blocks in chat) can triage and rank them.

Design note (private, Mavaali vault): `projects/daftari-tension-resolution-design.md`. Key decisions carried in:
- **Legibility before automation** — v0 shows, it does not rank or act.
- **Metric is un-triaged, not un-closed**; `accepted` is a terminal success state.
- **No hand-tuned `blast × age` ranker** — skip it; learn the priority function from resolution behavior later (v1).

## Users

- **Human triager at the CLI** — reads a triage table in the terminal (`daftari tensions`).
- **Agent-mediated human** — an agent calls the MCP tool, renders the enriched records as rich blocks (side-by-side claims + fields + buttons) into the human's existing chat surface (Slack/Claude/Cowork). The chat *is* the GUI; Daftari does not ship its own.

Both consume the same engine (surface decision **C**: MCP tool = engine, CLI = thin renderer).

## User Stories

### Story 1: Enriched tension list (the engine)
**As an** agent or CLI, **I want** a single call that returns every open tension with its legibility fields attached **so that** a human can judge cost without assembling `clusters` + per-item `blast` by hand.

**Acceptance criteria:**
- [ ] New MCP tool (working name `vault_tension_triage`) returns all **live** tensions (unresolved; excludes resolved and `accepted`, matching `clusters` scope).
- [ ] Each record carries: tension `id`, `title`, `kind` (temporal/factual/interpretive), `age_days`, both sides (`sourceA`/`sourceB` + `claimA`/`claimB`).
- [ ] Each record carries impact: `primary_blast`, `advisory_blast`, `hidden_downstream`.
- [ ] Each record carries, **per side**: `tier` and `confidence`.
- [ ] Each record carries, **per side**: `read_heat` = `{ count, last_read }` over a configurable window (see Story 2).
- [ ] Records are grouped by tension cluster (`cluster_id` from `tension_clusters`); standalone tensions grouped separately.
- [ ] **No composite severity score** is computed or returned. Ordering is neutral: clusters by member count desc, tensions within a cluster by `age_days` desc.
- [ ] Read-only: the tool never writes, resolves, or mutates the vault.
- [ ] Respects RBAC: fields for docs the role cannot read are omitted; `hidden_downstream` still signals unseen blast.

**Edge cases:**
- A doc appears in multiple tensions → it shows in each; read-heat/tier computed once per doc, reused.
- A tension references a missing/deleted doc → record still returned; that side's tier/confidence/read-heat marked `unknown` (absent ≠ zero).
- Large N → tool accepts `limit` (default e.g. 50); grouping/order deterministic so paging is stable.

**Error handling:**
- Blast computation errors for one tension → that tension's blast fields marked `unavailable`, the rest of the list still returns.

### Story 2: Read-heat aggregator
**As** the triage engine, **I want** per-document read frequency + recency from the read log **so that** a tension on a hot doc outranks one in a dead corner.

**Acceptance criteria:**
- [ ] New aggregator over `.daftari/read-log.jsonl` (via `readReadLog()`): per file, `count` and `last_read` timestamp within a window.
- [ ] Window is configurable (default e.g. 30 days); recency exposed as raw `last_read` (no decay math baked in v0 — keep it legible, let the human/agent weigh it).
- [ ] Counts reads from **both** `vault_read` and `vault_search` serve entries (both are logged).
- [ ] A doc with zero logged reads returns `count: 0, instrumented: true`.
- [ ] A doc that could **predate instrumentation** returns `count: 0, instrumented: false`: determined by comparing the doc's earliest-known date (frontmatter `created`, else provenance) against the read log's **earliest timestamp** — if the doc existed before the log began, its zero is uninstrumented, not cold. Consumers must not read `instrumented: false` as "never read."

**Edge cases:**
- Missing log file → all docs `count: 0` (not an error; log is best-effort).
- Corrupt lines → skipped (existing `readReadLog` behavior).

**Error handling:**
- Log read failure → read-heat fields marked `unavailable` on records; the rest of the card still returns.

### Story 3: CLI renderer
**As a** human at the terminal, **I want** `daftari tensions` to print the triage card as a readable table **so that** I can triage without an agent.

**Acceptance criteria:**
- [ ] `daftari tensions` calls the same engine as Story 1 and prints grouped tables (one block per cluster).
- [ ] Each row shows: id, kind, age, blast (primary/advisory), both sides' tier/confidence, read-heat.
- [ ] Claims (`claimA`/`claimB`) shown side-by-side or stacked, readable in a terminal.
- [ ] Empty state: no live tensions → a clear "No open tensions" message, exit 0.
- [ ] Flags: `--limit`, `--window` (read-heat window) pass through to the engine.

**Edge cases:**
- Narrow terminal → truncate claim text with an indicator, keep columns aligned.

## NOT In Scope

- **Acting / resolution changes** — `tension_resolve` stays record-only. No atomic record+apply, no execute. (Deferred to v0.5, gated on verifying resolve is re-openable/reversible first.)
- **Composite severity score / ranker** — explicitly out. `blast × age` is not built. Ranking is the human's job in v0.
- **Recommended resolution kind** — no advisory "you should supersede this" in v0. (Deferred; would arrive with execute.)
- **Domain-criticality field** — deferred; deciding *where* it lives (frontmatter field vs tag vs folder) is its own design question.
- **Provenance on the card** — `vault_provenance` exists but is per-doc; deferred to keep v0 to one aggregate call.
- **Learned priority function** — v1. v0 exists partly to generate the resolution-behavior data that trains it.
- **Dedicated GUI** — Daftari renders into existing human surfaces (CLI + chat rich-blocks); no `daftari.app`.
- **Org-wide / synced read-heat** — read log is local + git-ignored, so read-heat is single-node in v0. Multi-user read-heat is a later story.

## Resolved Decisions (2026-08-01)

- **Default ordering** — clusters by member count desc, tensions within by `age_days` desc, no composite score. CONFIRMED.
- **Read-heat window** — 30 days default. CONFIRMED.
- **Tool naming** — separate tool `vault_tension_triage`; `vault_tension_clusters` stays a pure structural query. CONFIRMED.
- **Instrumentation cutover** — distinguish, via the `instrumented` flag (Story 2): compare doc's earliest-known date to the read log's earliest timestamp. CONFIRMED.

## Open Questions

- None blocking implementation. (Reversibility of `tension_resolve` remains unverified but is a v0.5 concern, not v0.)
