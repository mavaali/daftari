# Supersede → Downstream Propagation — Design Spec

**Status:** PARKED (2026-08-04) — the premise is largely false. Verified against code (thor review + direct read of `tier0.ts`/`structural.ts`): (1) the **superseded** half CONTRADICTS a deliberate design decision — `tier0.ts:25-30,48-52` excludes `superseded` from conflicts because "citing a superseded doc is aged, not broken; the current-source layer forwards readers to the successor." (2) the **deprecated/archived**-cited-source case is ALREADY detected — `tier0Findings.lifecycleConflicts` (lint) + `structural.deprecated_still_linked` (read). So detection ships on two surfaces already. The genuine residual gap is thin: route those existing findings into the nightly sleep wake-queue + an eager notice at the deprecate event — a QoL enhancement over existing detection, NOT a new capability or differentiator. Recommendation: do NOT build as specced; the on-thesis residual (surface existing tier0/structural findings in the sleep report) is a small optional enhancement, not a feature. My earlier grounding check missed tier0/structural — recorded as a lesson.

**Status (historical):** draft — awaiting Mihir approval
**Origin:** feature-research shortlist #2 (TMS revision-propagation), ground-checked 2026-08-04 → verdict "partially-shipped, narrow gap." See `mavaali-vault/projects/daftari-feature-research-2026-08.md` ("Grounding-check: TMS revision-propagation").
**Disclosure:** not moat-sensitive (generic epistemic-integrity; v0/criticality are already public). Keep the spec uncommitted until approved, then it can land normally.

---

## 1. Problem

When a source document is superseded or deprecated, its **downstream dependents** — documents that cite it in frontmatter `sources` or link to it — are left resting on a retracted foundation. Today nothing tells them. The detection machinery all exists, but supersession is not wired to it:

- `vault_supersede`/`vault_deprecate` (`src/tools/write.ts:1544`, `:1300`) set `status` + `superseded_by` on the *retracted* doc and return. Dependents are untouched.
- The sleep cycle (`src/sleep/cycle.ts`) wakes a stale *upstream* doc for re-verification — but **deliberately excludes superseded docs** (`cycle.ts:107-124`: "the handoff was recorded, so there is nothing to ask") and keys waking on the doc's *own* TTL/validity, never on "this doc cites a retracted source." So a dependent that still points at a superseded doc is only caught **lazily**, if and when someone `vault_read`s it (the `upstream_staleness` banner in `src/tools/read.ts`), or incidentally if it also ages out on its own TTL.
- `computeBlast` (`src/curation/tension-blast.ts`) already computes the downstream dependent set, but nothing triggers it on supersession (`superseded_by` is explicitly excluded as a blast edge — correct; the successor is a replacement, not an inheritor).

**Gap:** a depended-upon-but-unread dependent can silently cite a retracted source indefinitely. That is an epistemic-integrity hole squarely in Daftari's thesis (retractions must not go silent).

## 2. What this is NOT (the trap, rejected up front)

The "full TMS" version — a **persisted `grounding-weakened` flag** on each dependent, or auto-logged tensions per dependent — is **rejected**. `edge-staleness.ts` states the governing principle: *"there is no verdict store that can itself go stale"* (`cycle.ts` and edge-staleness both recompute at query time by design). A persisted eager flag reintroduces exactly that stale-able store. This is the same failure mode as the parked learned ranker (fighting a stated design principle). **No persisted state. No auto-write to dependents. No auto-tension. No resolution.** Advisory + recompute only.

## 3. Decisions (recommended — flag any you reject)

- **D1 — Two halves, both advisory, both reuse existing primitives.**
  - *Eager (immediate feedback):* on a successful `vault_supersede`/`vault_deprecate`, attach the downstream dependent set to the tool result — "N documents still cite this now-{superseded→SUCCESSOR|deprecated} doc: […]." No write to those docs.
  - *Deferred (coordinated re-review):* add a **third wake reason** to the sleep cycle — a canonical/accumulation doc whose `sources` cite a `deprecated`/`superseded` doc wakes for re-pointing. Self-terminating: once its `sources` are updated off the retracted doc, it stops waking. This lets the existing nightly wake-queue own the re-review, rather than eagerly writing (and clobbering) the queue at supersede time.
- **D2 — Edges = the existing blast edges** (`computeBlast`: reverse-`sources` frontmatter + reverse-markdown-links). Consistent with the wake-queue and docket. The separate `derives_from` edge graph (edge-staleness) is a richer signal but a different subsystem — defer to a later iteration.
- **D3 — Sleep trigger honors existing domain rules** (`cycle.ts:120-124`): only canonical, accumulation-domain dependents wake; generative/non-canonical are counted/skipped as today. Only vault-path `sources` can be "retracted" (URL/identifier sources cannot).
- **D4 — Eager advisory respects RBAC hidden-downstream coarsening** (reuse `bucketHiddenDownstream`, as the triage card and blast already do): dependents the actor cannot see are reported as a coarse "N hidden," never named.

## 4. Design

### 4a. Eager advisory (write path)
`WriteResult` (`src/tools/write.ts`) already carries an optional advisory field (`hint?`). Add a parallel optional field, e.g. `downstream_notice?: { retracted: string; successor: string | null; dependents: string[]; dependentsTotal: number; hidden: HiddenDownstream }`.

In `vaultSupersede` (after `written.ok`, near `:1635`) and `vaultDeprecate` (after `written.ok`, near `:1365`):
1. Load documents + build `reverseSource`/`reverseLink` maps (mirror `cycle.ts:83-87` / the triage loader — one helper, not duplicated).
2. `computeBlast({ seeds: [retractedPath], reverseSource, reverseLink })`.
3. If `downstream.length > 0`, attach `downstream_notice` (successor = `newPath`/`superseded_by`, or null for a bare deprecate). Cap the listed `dependents` (e.g. 20) with a total count; coarsen hidden ones by RBAC.
4. Advisory only — the write already committed; this is a read-after-write annotation and must never fail the write (best-effort; on any error, omit the notice, mirror the read-path advisory's null-when-silent pattern).

The MCP tool output schemas for `vault_supersede`/`vault_deprecate` gain the optional `downstream_notice` (declared, not required — mind any `additionalProperties: false`, the lesson from the criticality MCP schema).

### 4b. Deferred wake trigger (sleep cycle)
In `runSleepCycle` (`src/sleep/cycle.ts`), build a `Map<path, doc>` from `docs.value` (status lookup). Add a third wake reason alongside `s.expired` and `validityEnded`:

```
citesRetractedSource = doc.frontmatter.sources
  .filter(isVaultPath)
  .some(src => statusOf(map, src) === "deprecated" || statusOf(map, src) === "superseded")
```

- Change the early-continue guard (`cycle.ts:119`) to `if (!s.expired && !validityEnded && !citesRetractedSource) continue;`.
- Keep the existing domain/canonical guards (`:120-124`) — same rules.
- A dependent woken for this reason gets a distinct `reason` string naming the retracted source(s) and the successor(s): "cites {src} which is now {superseded by SUCC | deprecated}; re-point to the successor and stage the diff for ratification."
- `WakeTask` may need a small addition (e.g. `retractedSources?: string[]`) or the reason string alone suffices — decide in planning (prefer the reason string; avoid schema churn).
- A doc that wakes for multiple reasons wakes **once** (the loop is per-doc); compose the reason.

### 4c. What stays untouched
- The retracted doc itself: still NOT woken (its handoff is recorded — the existing exclusion is correct; this feature wakes the *dependents*, a distinct set).
- The lazy read-time `upstream_staleness` banner (`read.ts`): unchanged — it remains the on-read surface; this feature adds the eager + nightly surfaces it lacked.

## 5. Thesis-safety invariants

1. **Advisory only.** No write to dependents, no auto-tension, no auto-resolution. The eager notice and the wake entry are surfaces; a human/agent acts.
2. **No persisted verdict store.** Everything recomputes (eager blast at supersede time; the sleep trigger reads live status each night). Consistent with edge-staleness's stated principle.
3. **Self-terminating.** A dependent stops waking once its `sources` no longer cite a retracted doc — no flag to clear, no store to reconcile.
4. **Best-effort, never blocks a write.** The eager advisory is computed after the commit; any failure omits the notice silently (null-when-silent, like the read-path advisories).
5. **RBAC-respecting.** Hidden dependents are coarsened, never named.

## 6. Open questions (resolve in planning)

- **Q1 — Deprecate without a successor** (`superseded_by = null`): still surface/wake dependents? Recommend YES — a retired source with no forward pointer is arguably *more* urgent for its dependents. Include both supersede and no-successor deprecate.
- **Q2 — Wake-list volume.** The sleep trigger wakes every dependent of every still-cited retracted doc each night until re-pointed. That can enlarge the nightly wake list. Acceptable (it's the signal), but confirm: rank retracted-source wakes among the others by blast (default), or a separate report section? Recommend: same ranked list, reason names the cause.
- **Q3 — `vault_merge`** also supersedes its sources (`:1654`). Should the eager notice fire there too? Recommend: out of scope for v1 (merge is a deliberate 3-file op with its own semantics); revisit.
- **Q4 — Feature flag / config?** The sleep-trigger changes nightly wake volume. Gate behind config, or on by default? Recommend on by default (it's advisory), but confirm.

## 7. Test scenarios (for the plan phase)

- Supersede X (cited by A, B) → tool result `downstream_notice` names A, B, successor; no change to A/B on disk.
- Deprecate X with no successor → notice fires, successor null.
- Supersede X cited by nobody → no notice (best-effort, absent).
- RBAC: dependent in an unreadable collection → coarsened as hidden, not named.
- Advisory failure path: force the post-write blast to error → the write still succeeds, notice omitted.
- Sleep: dependent D (canonical/accumulation) cites superseded X → D appears in wake with a retracted-source reason.
- Sleep termination: re-point D's sources off X → next sleep does NOT wake D for this reason.
- Sleep domain rules: generative/non-canonical dependent citing X → not woken (counted/skipped as today).
- Sleep: the retracted doc X itself is still NOT woken (exclusion preserved).
- MCP output schema declares `downstream_notice` (optional; `additionalProperties: false` compliant).
