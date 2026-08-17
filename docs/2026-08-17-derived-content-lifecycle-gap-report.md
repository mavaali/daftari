# Derived-Content Lifecycle & Source-Expiry Semantics — Gap Report

**Date:** 2026-08-17 · **Audited at:** `8fb0298` · **Assessment:** 2026-08-16 derived-content lifecycle assessment (claude-home-base)

**Question under audit.** M365 Copilot meeting summaries outlive their source transcripts (90-day retention), leaving derived artifacts nobody can verify. Daftari's compilation-over-retrieval thesis has the identical failure mode unless provenance machinery closes it. The assessment frames three epistemic states — **Fresh** (upstream unchanged), **Stale** (upstream changed, re-derivable), **Unverifiable** (upstream deleted, can never be re-derived; flag permanently, degrade trust) — and hypothesizes daftari models the first two but not the third.

**Verdict in one line.** The hypothesis is confirmed, and the failure is worse than "missing state": a deleted upstream currently classifies as **maximally fresh** (`current`, "unchanged since baseline"), deletion makes audit findings *disappear*, and the never-delete charter means no surface ever observes the deletion event. Meanwhile the kill-condition check (task 4) passed — provenance IS consumed on the agent-facing read path — so the missing state has a live consumer waiting for it and is worth building.

Method note: findings labeled **CONFIRMED** (verified present), **ABSENT** (verified missing), **PARTIAL** (present with load-bearing gaps). All file:line references verified at `8fb0298`.

---

## 0. The four dependency graphs (do not conflate)

`derives_from` is **not** a frontmatter key — it is a log-only earned graph. The in-tree vocabulary is **compiled** (`consumes`) / **declared** (`sources`) / **earned** (`derives_from`) — see `src/curation/consumes.ts:1-6`, `src/curation/tier1.ts:14`.

| # | Graph | Declared | Stored | Endpoint existence checked? | On target deletion |
|---|---|---|---|---|---|
| 1 | `derives_from` (earned) | minted by `vault_edge_observe` (`src/tools/edges.ts:80`) + consolidation birth loop | `.daftari/edges.jsonl` (canonical) + `derives_from_edges` table (cache) | at birth only (`src/tools/edges.ts:59-74`) | edge survives at full strength forever; re-materialized on every reindex (`src/search/reindex.ts:537-539`) |
| 2 | `consumes` (compiled) | minted from run correlation (`src/curation/consumes.ts:58-86`) | `.daftari/consumes.jsonl`; no SQLite table by design | never | edge survives forever ("never deleted or rewritten", `consumes.ts:16-19`); reports `current` |
| 3 | `sources` / `superseded_by` (declared) | frontmatter (`src/frontmatter/types.ts:91-92`) | re-derived from frontmatter per query | at lint time via `resolveLink` (`src/curation/tier0.ts:104-107`); `superseded_by` also at runtime (`src/search/current-source.ts:47-48`) | `brokenSourceRefs` lint finding — path-like entries only; `superseded_by` gets the one real runtime `dangling` state |
| 4 | body links / backlinks | markdown wikilinks | `doc_links` table | implicitly — unresolvable targets dropped | edge silently disappears; no finding, ever (`tier0.ts:20-23` scopes it out deliberately) |

(Adjacent fifth graph: `describes` code pins, which DO have a runtime `missing` state — `src/tools/anchors.ts:39-45` — but target code files, not vault docs, and explicitly never cascade.)

---

## 1. Task 1 — Source-deletion semantics: ABSENT, and inverted

**1a. There is no deletion concept anywhere in the write path.** No delete tool (MCP registry `src/server.ts:55-72`; `vault_erase` exists but is unregistered — CHANGELOG:63 "MCP/CLI exposure is deferred"), no delete staged action (`src/curation/staged-actions.ts:49-58`), and — load-bearing — **no delete action in the provenance vocabulary** (`src/curation/provenance.ts:22-24`). Deletion is an out-of-band filesystem event by charter ("Never-delete. Deprecate/supersede/annotate only", `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md:277`); the watcher's `unlink` handler evicts index rows and does nothing else (`src/search/watcher.ts:93-114`).

**1b. CONFIRMED (the inversion): a deleted upstream classifies as `current`.** Edge staleness is computed by counting provenance-log writes to the unit since the compile baseline (`src/curation/edge-staleness.ts:96-109`). Deletion writes no provenance entry, so `writes === 0` and the classifier returns `staleness: "current", reason: "unchanged since baseline"` (`edge-staleness.ts:167-174`). There is no `existsSync`, no index lookup, anywhere in `classifyEdge` — the unit path is a pure string key into the log. **A vault whose upstream was deleted yesterday reports its dependents as maximally fresh**, and this propagates live into `vault_read`'s banner, `vault_search` annotations, and `vault_staleness`.

**1c. CONFIRMED: deletion *improves* the audit score.** The `daftari audit` transitive-staleness BFS drops edges whose target is absent (`src/audit/checks/staleness.ts:50` — "dangling edge — broken_refs handles it"), so deleting a stale upstream makes downstream transitive-staleness findings disappear. The handoff target (`broken_refs`) is a body-link integrity check with no epistemic weight.

**1d. CONFIRMED: the consolidation loop errors forever, silently.** A committed deletion does make dependents event-due (git diff includes deleted paths), but `loadDoc` fails against the live doc set and the loop logs to stderr and continues (`src/consolidate/index.ts:632-669`); the decay backstop re-queues the edge every cycle (`src/consolidate/clocks.ts:33-55`). The edge is never revoked, never contested, never flagged.

**1e. CONFIRMED (the sharpest contrast): retire-by-status has full machinery; retire-by-deletion bypasses all of it.** `vault_deprecate`/`vault_supersede` ship a downstream-dependents advisory (`src/tools/write.ts:1558-1600`), a ratify gate refusing to strand canonical dependents (`src/curation/tier0.ts:233-255`), and a nightly wake queue ranked by blast radius (`src/sleep/cycle.ts:146-153`). All three are keyed on *live docs whose status changed* — a doc citing a **deleted** source never wakes, while a doc citing a merely **deprecated** source wakes every night. And `vault_erase` — the only genuinely irreversible operation (git filter-repo history rewrite, `src/utils/git-erase.ts:171-241`) — has zero downstream-dependents checking (`src/tools/erase.ts:79-169`: RBAC, one-target, confirm-echo; nothing graph-aware).

**1f. PARTIAL: the one existing detector has three holes.** `brokenSourceRefs` (`tier0.ts:102-137`) covers `sources[]` + `superseded_by` only, is advisory, and: (i) gated on `isPathLike` (`tier0.ts:60-62`) so `distill:<source-id>#<claim-key>` — the exact form the distill pipeline emits — is **never checked at all**; (ii) the basename fallback (`src/curation/vault-docs.ts:199-200`) silently re-points a dangling ref to any surviving doc sharing the deleted doc's basename — no finding, wrong edge; (iii) nothing triggers lint on deletion.

**1g. Three strengths of "deleted".** (1) index-evicted — rebuildable; (2) worktree-deleted — recoverable via git (`daftari asof` reconstructs deleted docs from history, `src/asof/snapshot.ts:333-357`); (3) history-erased (`vault_erase`) or external-source (`distill:*`) — permanently unverifiable. Only (3) matches the M365 pathology exactly; today daftari distinguishes none of them.

---

## 2. Task 2 — The "unverifiable" state: ABSENT (six vocabularies, none encode it)

The complete state inventory:

| Vocabulary | Values | Where |
|---|---|---|
| `EdgeStalenessClass` | `current \| pending-unchecked \| pending-compatible \| pending-broken` | `src/curation/edge-staleness.ts:67-71` |
| Tier-1 verdict | `unaffected \| affected \| possibly-affected \| semantic-review` | `src/curation/tier1.ts:37-38` |
| `DecayLevel` | `deprecated \| warn \| aging` (+ null = healthy) | `src/curation/decay.ts:17` |
| `ValidityState` | `in-window \| expired \| not-yet \| unknown` | `src/curation/validity.ts:30` |
| `EdgeStatus` | `candidate \| trigger-bearing \| revoked` | `src/curation/edges.ts:98-99` |
| Doc status | `draft \| canonical \| deprecated \| superseded \| archived` | `src/frontmatter/types.ts:13` |

None means "source is gone / cannot re-verify." The two near-misses: `CurrentSource {kind:"dangling"}` (`src/search/current-source.ts:27,47-48`) — the only runtime gone-state, scoped to `superseded_by` chains only, per-query, never persisted; and `brokenSourceRefs` — advisory lint, holes per §1f.

Two design decisions in the tree bear directly on any fix:

- **RBAC merges "gone" and "hidden" on purpose.** `tier0.ts:83-85`: "a source the caller cannot read is indistinguishable from one that does not exist." Any unverifiable state must preserve this — it must not become an existence oracle for hidden docs.
- **Unverifiability-by-design already ships.** The distill retention spec (2026-08-12, R10) declares the `distill:*` provenance pointer "an audit breadcrumb, not a re-derivation source — **dangling is acceptable**." Daftari deliberately reproduces the M365 shape at ingest (raw discarded at t=0) — mitigated by artifacts being born `draft`/`confidence: low`/`provenance: synthesized` and needing ratification, but the pointer is not re-derivable and nothing labels that.

### Design direction (reviewed by strategist)

<!-- STRATEGIST-DESIGN -->

---

## 3. Task 3 — Model-vintage stamping: ABSENT on artifacts, PARTIAL in sidecars

- **ABSENT: no model/generator/prompt-version field exists in frontmatter.** Full built-in field list at `src/frontmatter/types.ts:138-163`. The `provenance` field is the 3-value enum `direct | synthesized | inferred`, not a producer id. `updated_by` carries an agent alias (`agent:distill`), never a model — and it's classified `BOOKKEEPING_FIELDS` (`src/curation/tier1.ts:35`), so **a model swap is invisible to the staleness engine by construction** (filtered out of changed-field sets → `unaffected`/`current`).
- **PARTIAL: distill stamps pipeline/claim-key/run-id/source-ref, no model.** `src/distill/propose.ts:304-327` (frontmatter) and `:205-211` (body provenance block). The source content hash is computed (`src/distill/state.ts:74`) but lives only in gitignored `distill-state.json` — never on the artifact, so an artifact cannot be checked against the source it came from.
- **PARTIAL (specced-but-not-implemented): the distill receipt records the model and is never persisted.** `DistillReceipt.model` (`src/distill/cost.ts:139`, doc-comment claims "Persisted by the CLI (U7)") — the CLI writes it to stdout only (`src/distill/cli.ts:604-620`; no file write in the module). Worse, the receipt's `runId` is an unrelated `randomUUID()` (`cost.ts:257`) while artifacts carry `makeRunId()` ids (`cli.ts:553`) — even if persisted, the receipt could not be joined back to the documents it describes. Model vintage for a distill run survives only in terminal scrollback.
- **PARTIAL: consolidation traces stamp model, durable edge records don't.** `RevisionTraceRow.model` (`src/consolidate/revision.ts:79`) and birth traces (`src/consolidate/birth.ts:404-411`) — to gitignored `.daftari/*-trace.jsonl`. The durable edge record's `by` is the constant `agent:curation-loop`. The edge axis `"model"` (`src/curation/edges.ts:95-96`) is a claim that the model was varied, not a record of which — and the replay-guard dedup key `${by}\n${axis}` (`edges.ts:370,399`) collides two genuinely different models under the hardcoded agent identity, contradicting the comment at `edges.ts:90-92` that different models "count immediately."
- **Cross-cutting: the whole provenance substrate is machine-local and gitignored** (`.gitignore:16-24`; `provenance.ts:5-6`). On a fresh clone, `loadCompiledStaleContext` returns empty and **every edge reports fresh** — the uninstrumented fast path (`edge-staleness.ts:216`) makes "no data" indistinguishable from "all current."

---

## 4. Task 4 — Is provenance consumed? Verdict: **(a), narrowly**

**Verdict paragraph.** The answer is **(a) — provenance is genuinely consumed on the agent-facing read path — but narrowly, and it degrades to (c) on an uninstrumented vault.** Every `vault_read` classifies the doc's compiled upstream edges against the provenance log and, when an input changed incompatibly, emits "N compiled upstream inputs have changed incompatibly since this document was compiled — this content may predate them" into the model-facing content channel (`src/tools/read.ts:325-386`; `vault_read` has no `summarize`, so `src/server.ts:377-379` serializes the banner into `content`; test-locked at `test/tools/edge-staleness.test.ts:142-144`). Search hits carry the same annotations (`src/tools/search.ts:208-226`), and contested compiled inputs cap read-time effective confidence to `low` (`read.ts:514-535`). Three qualifiers keep this from being a strong (a): ranking is pure `bm25 + vector` by explicit spec decision, not omission (SP-A "No re-ranking", `src/search/hybrid.ts:428-431`); only the **compiled** (`consumes`) class reaches readers — `derives_from` and `sources[]` never produce a read-path warning (they feed the consolidate scheduler, `vault_canon` scoping, tier-1 routing, and the viewer graph — surface (b)); and the whole path is **dormant unless writers pass `run_id`** (`src/tools/write.ts:546-551`), so a vault whose agents never instrument writes is exactly (c) with no visible difference. **Consequence for priority: the consumer exists and is live — the unverifiable state has somewhere real to land — so the gaps above are wrong signals being actively served, not unread bookkeeping.**

---

## 5. Task 5 — Retention/TTL posture: no expiry anywhere; the M365 shape ships at ingest, by design

- **CONFIRMED: nothing expires source material.** `ttl_days` is 100% advisory — it feeds `computeStaleness` → decay banners, lint rows, receipt flags, wake queue; nothing acts on it (`src/curation/staleness.ts:7-9`, `src/curation/decay.ts:1-8`). Sleep and consolidate never delete or archive ("no document writes", `src/sleep/cycle.ts:1-9`; never-delete charter). The only real TTL-with-expiry is staged-action proposals (14d, append-only expiry records, `src/curation/staged-actions.ts:593-605`).
- **CONFIRMED: distill is deliberate distill-and-discard.** Spec 2026-08-12 (requirements-only): raw discarded at t=0, claims survive as `draft`/`low`/`synthesized`, provenance pointer dangling-by-design (R10). Implemented: raw-landing fence, idempotency state, verbatim budget lint. ABSENT: the PRIVACY.md honesty clause (R10) — PRIVACY.md still says "no network calls in default configuration" with zero mention of distill; the subject-keyed erasure cascade (deferred; `subjects[]` field exists with zero readers).
- **CONFIRMED: git recovery vs. true erase.** Worktree deletions are recoverable (`daftari asof`); `eraseFromHistory` (filter-repo + reflog expire + gc + force-push, `src/utils/git-erase.ts:171-241`) defeats it and is the only irreversible path — currently unexposed, and the only retirement path with no dependents advisory (§1e).

---

## 6. Priority & sequencing

<!-- STRATEGIST-PRIORITY -->

---

## 7. Issue drafts

<!-- ISSUE-DRAFTS -->
