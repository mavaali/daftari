# Vault Board — finding-centric curation workflow with bounded agent verification

**Readiness:** requirements-only
**Date:** 2026-08-18
**Issue:** mavaali/daftari#455
**Related:** #365 (delegation lane), #381/#388/#389 (viewer shell/graph/dashboard, all merged)
**Target home:** `daftari/docs/superpowers/specs/2026-08-18-vault-board-finding-curation-design.md`

> This is the requirements-only spine. `writing-plans` enriches it to implementation-ready; its
> Implementation Units cite the R-IDs below.

---

## Problem

Daftari has strong detection surfaces — lint, staleness, tensions/blast, staged actions +
ratification, tier-2 review queues — but no durable curation loop over their findings. Each run
produces a snapshot; a human re-triages the same items nightly and loses *why* something was
deferred or dismissed. `docs/curation-workflow.md` already named this ("a linter without a loop is
a smoke detector with no fire department"). The Vault Board is that fire department: a vault-native
action surface where findings gain durable identity, history, and human disposition.

## Why a second surface (vs. #365's GitHub issues)

#365 already turns findings into dispositioned work as GitHub issues (`agent-found` → human applies
`delegate` → agent implements → merge). The board earns its existence over that surface on exactly
three axes it cannot cover, and **is only worth building if all three hold**:

1. **Dedup on finding identity.** A reappearing staleness finding files a fresh GitHub issue unless
   an agent hand-manages it. The board reopens the *same* card with history intact.
2. **RBAC alignment with vault collections.** GitHub has no notion of who may read which collection;
   the board's visibility is the vault's own access model.
3. **Verification predicate co-located with the finding.** "Agent resolves only when the originating
   deterministic check no longer reproduces" is native to the board, convention on GitHub.

The two are complementary, not competing: a board finding could still feed #365 (disposition →
`delegate`). The board does not replace the GitHub delegation lane.

## Scope

Full #455: engine (identity + ledger + reconciliation), source adapters, agent trust boundary, and
the `/board` viewer route. Chosen over engine-only because the RBAC no-existence-disclosure
acceptance criterion is **untestable single-operator** — proving "hidden targets produce no cards"
requires an actively-filtered, multi-role build from day one (see D2).

---

## What already exists (grounded, file:line)

- **Detection surfaces, all deterministic:**
  - Lint: `runLint()` `src/curation/lint.ts:255`; 15 named checks `lint.ts:56-74`; each emits
    `LintFinding {path, detail}` `lint.ts:77-80` — **no finding-level ID**.
  - Staleness: `computeStaleness()` `src/curation/staleness.ts:31` → `{score, ageDays, ttlDays,
    expired}` — no ID. Edge staleness: `upstreamStaleness()` `src/curation/edge-staleness.ts:249` →
    `UpstreamStaleness[]` keyed implicitly by `(artifact, unit, edge_class)`.
  - Tensions: `TensionEntry` `src/curation/tension.ts:104-127` with **stable `tension-NNN`**
    (`addTension` `tension.ts:253`), stored `.daftari/tensions.md`. Blast: `tension-blast.ts:80-89`
    (derived counts, no ID). Visibility gate `canSeeTension()` `src/curation/tension-access.ts:24-32`.
  - Staged actions: `StagedAction` `src/curation/staged-actions.ts:82-117` with **stable
    `stage-NNN`**, append-only `.daftari/staged-actions.jsonl`.
  - Tier-2 queue: `Tier2WorkItem` `src/tools/tier2.ts:43-58`, computed on demand (no ID);
    verdicts persisted `.daftari/tier2-verdicts.jsonl` `src/curation/tier2.ts`.
- **Operational-ledger precedent under `.daftari/`:** `curation-log.jsonl` provenance
  (`src/curation/provenance.ts:72-98`, `appendFile(JSON.stringify+"\n")`), `staged-actions.jsonl`
  (sync append), `tier2-verdicts.jsonl`; and the spec'd `.daftari/runs.jsonl`
  (`docs/superpowers/specs/2026-08-13-legibility-observability-surface-design.md`).
- **RBAC + no-existence-disclosure (MCP tool layer):** `src/access/rbac.ts` — `canRead()` `:46`,
  `readableCollections()` `:100-104`, `filterByReadPermission()` `:108-113`. Search chokepoint
  over-fetch→filter→slice `src/tools/search.ts:600-602`; read denial indistinguishable from
  not-found `src/tools/read.ts:301-309`. `collectionForPath()` `src/storage/index-db.ts:949-955`.
- **Access-aware serve path already exists:** per-request/per-bearer `createServer(vaultRoot,
  access, config.tools)` `src/serve/index.ts:447`.
- **Viewer shell (#381/#388/#389, merged):** raw `node:http`, `handleView()`
  `src/view/server.ts:164-327`; routes `/ /docs /doc/<path> /search /graph /api/*`; server-rendered
  HTML, no framework. **No auth, loopback-only by design** (`src/view/index.ts:7-16`); the viewer
  calls `vaultRead` with **no access context** (`src/view/doc-view.ts:53`).
- **Prior art:** tension triage card shipped PR #334; `docs/curation-workflow.md`;
  learned-tension-ranker **deliberately killed** (`docs/superpowers/specs/2026-08-04-learned-
  tension-ranker-design.md`) — do not reintroduce ranking.

---

## Design decisions

- **D1 — Authority lives in the serve path; the viewer is a client.** Finding generation and
  disposition are access-native MCP tools mounted where `AccessContext` already exists
  (`serve/index.ts:447`). `/board` on the loopback viewer is the admin (full-access) client of those
  tools; a narrower role reaching the same tools gets the strict subset. Reuses every RBAC
  chokepoint instead of adding access-awareness to the no-auth view server.
- **D2 — RBAC active and multi-role from day one.** Single-operator would make the no-existence AC
  unverifiable. Finding generation runs through the same `canRead`/`readableCollections` filter as
  `vault_search`; tested with ≥2 role fixtures. **Browser auth is resolved, not deferred:** serve's
  `authenticate()` (`serve/index.ts:359-426`) is real HTTP bearer/JWT → `AccessContext`, transport-
  level with no MCP entanglement, so board routes reuse it directly (R32). No new auth code.
- **D3 — Identity = stable key + evidence fingerprint.** Identity key reuses the native ID
  (`tension-NNN`, `stage-NNN`) where one exists, else `hash(source, check, target, discriminator?)`.
  The **discriminator** is included *only* when a check emits multiple findings per
  `(source,check,target)` and is drawn **only from stable evidence** (which ref is broken), never
  volatile evidence (score/ageDays/timestamp). The **evidence fingerprint** = `hash(current
  evidence)` is a mutable attribute, never part of identity.
- **D4 — Derived findings + durable event-sourced ledger + read-time reconciliation.** One new
  persistent artifact: append-only `.daftari/board-dispositions.jsonl`. Live findings are recomputed
  on demand and LEFT-JOINed against the ledger on identity key at read time. No materialization, no
  background job.
- **D5 — Trust boundary enforced by construction (two tools).** `vault_board_dispose`
  (accept/defer/dismiss/reassign) requires a role with a declared `dispose` capability; agents are
  provisioned with roles lacking it, so they are rejected — the human/agent line is config-declared,
  not runtime-inferred (`AccessContext` has no principal-type). `vault_board_resolve` re-runs the
  originating deterministic check and writes `resolved` only if it no longer reproduces. `reopened`
  is always system-authored on reappearance.
- **D6 — Source adapters contain heterogeneity.** Each of the 5 surfaces implements one
  `FindingSource` interface; the board core is source-agnostic.

---

## Requirements

### Identity & dedup
- **R1** Finding identity is deterministic: native ID for tensions/staged actions; else
  `hash(source, check, target, discriminator?)`.
- **R2** Discriminator is present only when a check yields multiple findings per
  `(source, check, target)`, and is derived exclusively from stable evidence fields.
- **R3** The evidence fingerprint is `hash(current evidence)`, stored as a mutable finding attribute
  and never contributing to the identity key.
- **R4** Repeated runs over an unchanged vault produce byte-identical identity keys for the same
  findings (dedup; the same card, not a new one).

### Ledger & reconciliation
- **R5** Human dispositions and system transitions are persisted as an append-only, event-sourced
  ledger at `.daftari/board-dispositions.jsonl` (git-ignored operational state).
- **R6** Board state is computed at read time as `live recomputed findings LEFT JOIN ledger` on
  identity key; no separate materialized finding store exists.
- **R7** When the board is unused, no writes occur and all existing viewer/MCP/CLI behavior is
  unchanged.
- **R8** A `resolved` finding whose identity key reproduces in a later pass produces a
  system-authored `reopened` event and returns to its pre-resolution column with full prior history.
- **R9** A `dismiss` event may carry an optional expiry; an expired dismiss resurfaces the finding as
  New.
- **R10** Every disposition records the evidence fingerprint it was made against; material fingerprint
  drift resurfaces the finding for re-triage **without** minting a duplicate card.
- **R11** Every ledger event carries an identity-scheme version to permit future identity remap.
- **R12** First-seen / last-seen timestamps are derived from ledger events plus per-run observation.

### Trust boundary
- **R13** `vault_board_dispose` (accept / defer / dismiss / reassign) requires a role holding a
  declared `dispose` capability; any role lacking it is rejected. Since `AccessContext` carries no
  runtime principal-type and daftari has no agent-detection, "human vs agent" is enforced by *how the
  caller's role was provisioned in config* — human operators get `dispose: true`, agents do not.
  Agents therefore cannot append these events by any code path.
- **R14** `vault_board_resolve` re-runs the originating deterministic check for the finding and
  appends `resolved` only if it no longer reproduces; an agent assertion alone never resolves.
- **R15** `reopened` events are exclusively system-authored.
- **R16** Agents may create findings (via deterministic checks), attach evidence and proposed fixes,
  and implement an explicitly authorized fix; agents may never defer or dismiss.

### RBAC / no-existence-disclosure
- **R17** Finding generation runs through the `canRead` / `readableCollections` chokepoint, reusing
  the `vault_search` filter semantics (`search.ts:600-602`).
- **R18** RBAC-hidden targets produce no cards, no counts, and no existence signals; verified by ≥2
  role fixtures where a hidden collection yields exactly zero cards and unchanged totals.
- **R19** A tension finding is visible only when the caller can read **both** sides' collections
  (reuse `canSeeTension`); otherwise it is omitted entirely, not redacted.
- **R20** Disposition writes are themselves RBAC-checked: a caller may dispose only findings whose
  targets it can read.

### Sources & adapters
- **R21** Each of the 5 sources (lint, staleness/edge-staleness, tensions/blast, staged actions +
  ratification, tier-2 queue) implements the `FindingSource` interface
  (`list` / `identityOf` / `fingerprintOf` / `reproduces`).
- **R22** The board core is source-agnostic; adding a new source requires one adapter and zero core
  changes.
- **R23** The board functions for lint, tensions, staged actions, and staleness findings at minimum.

### Finding model & card
- **R24** Each finding carries: identity key; source + check; target (document / tension / staged
  action); certainty/severity; evidence; suggested action; verification predicate; owner;
  disposition + rationale + optional expiry; resolution/reopen history; first/last-seen.
- **R31** `owner` is constrained to a **configured principal**, not a free string. A `reassign` event
  whose target is not a configured principal is rejected. Principals are drawn from the same config
  source that defines roles/tokens (`server.auth.tokens[].user` + any explicitly configured
  principal list); an unrecognized owner never lands in the ledger. (Mihir, 2026-08-18.)

### Viewer surface
- **R25** A `/board` route renders the reconciled, access-scoped finding set in columns
  New / Accepted / Waiting / Resolved / Dismissed. **Waiting is a single column** — deferred,
  blocked, and awaiting-evidence all collapse into it, with the distinction carried in the event
  rationale, not as sub-states. (Mihir, 2026-08-18.)
- **R26** The board supports filtering by collection, check, certainty, owner, age, and document.
- **R27** A document with multiple findings displays and resolves them independently; resolving one
  finding never hides another.
- **R28** Document pages link to their open findings; finding cards link back to the affected
  document, tension, or staged action.
- **R29** `/board` is a client of the serve-path tools (D1); document-body editing is out of scope.
- **R30** Human accept/defer/dismiss decisions survive process and browser restarts (ledger-backed).
- **R32** All board routes (`/board` and its data/disposition endpoints) run **behind serve's existing
  `authenticate()`** (`src/serve/index.ts:359-426`) — bearer/JWT → `AccessContext`, reused, not
  re-implemented. A narrower-role board caller is provisioned by declaring a role + a
  `server.auth.tokens` env entry in `config.yaml`; no per-user auth code is written. Which HTTP
  server physically hosts the route (serve's `:8787` handler, or the view server with serve's
  `authenticate()` mounted as shared middleware) is a plan-level choice — the requirement is only
  that the route resolves a real `AccessContext` before applying RBAC. (Grounded 2026-08-18.)

---

## Data model (indicative, not binding)

**Ledger event** (`.daftari/board-dispositions.jsonl`, one JSON per line):
```
{ finding_id, event: new|accept|defer|dismiss|reassign|resolved|reopened,
  by, principal_type: human|agent|system, at, rationale?, expiry?,
  against_fingerprint, owner?, identity_scheme_version }
```
`accept/defer/dismiss/reassign` → `principal_type: human` only. `resolved/reopened` → `system`.

**Finding** (derived, in memory):
```
{ identity_key, source, check, target, discriminator?, fingerprint,
  certainty, evidence, suggested_action, verify_predicate, owner,
  first_seen, last_seen, disposition, history: LedgerEvent[] }
```

**FindingSource interface** (per adapter):
```
list(access): Finding[]           // RBAC-filtered live findings
identityOf(raw): string           // deterministic key (native or synthesized)
fingerprintOf(raw): string        // volatile-evidence hash
reproduces(identity_key, access): boolean   // the vault_board_resolve gate
```

---

## Failure modes

- **Scale:** recomputing 5 checks per board load is bounded for a single vault (lint is one pass).
  If measured slow, cache the derived set keyed on vault version. YAGNI until measured.
- **Data state:** append-only + event-sourced — a bad disposition is corrected by a compensating
  event, never a mutation; a corrupted line loses one event, not state.
- **6-month:** ledger grows unbounded → deferred compaction/snapshot (replay + checkpoint).
- **Identity drift:** a future change to a check's `target` shifts identity keys and detaches
  history → mitigated by `identity_scheme_version` on every event (R11) enabling a remap.

---

## NOT in scope

- **New authentication code.** None — board routes reuse serve's existing `authenticate()` (R32).
  (This was an open question; now resolved. Only the physical route-hosting choice is left to the
  plan.)
- **Ledger compaction / snapshotting** — deferred until growth warrants (append-only is correct
  now).
- **Document-body editing** in the viewer (v1 stays read-only for content; disposition controls only).
- **Autonomous prioritization / ranking / severity scoring** — deliberately excluded (killed
  learned-ranker precedent); the board orders by column + filters, not by a learned score.
- **Autonomous dismissal or defer** — structurally impossible (D5), not merely disallowed.
- **Fleet-level health monitoring / generic PM Kanban / graph or search replacement.**
- **Finding materialization / background scan job** — reconciliation is read-time (D4).

## Resolved (were open questions, closed 2026-08-18 with Mihir)

1. **Owner semantics** → constrained to configured principals; reassign to a non-principal is
   rejected (R31).
2. **Waiting column** → one column; blocked / awaiting-evidence collapse in, reason in rationale
   (R25).
3. **Browser auth substrate** → reuse serve's `authenticate()`; no new auth code; narrower role =
   config role + token env entry (R32). Only the route-hosting choice (serve `:8787` vs view server
   with shared middleware) is left to the plan.
