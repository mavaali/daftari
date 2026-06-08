# Pre-release audit — staged-action queue + vault_ratify (§11.2)

1. **Input validation parity** — Boundaries (`vault_stage_action`,
   `vault_ratify`) and the durable layer (`stageAction`, `recordDecision`) both
   validate: action_type ∈ enum, non-empty target/principal/rationale,
   proposed_diff present, ttl_days a positive number, decision ∈ {approve,reject}.
   `vault_stage_action` now also validates that `target_path` resolves to an
   existing vault document, so a target that could never be ratified is rejected
   at stage time instead of sitting in the queue for 14 days (FIX). A circular or
   huge `proposed_diff` makes `JSON.stringify` throw — caught and returned as
   `err`, not a crash. No size cap on proposed_diff: **accept** — consistent with
   the codebase (no size caps on `vault_write` body/frontmatter either).

2. **Environment delta** — Startup order verified: `materializeStagedActions`
   in the fresh-index branch runs *after* `setProvider` (index.ts L98), so
   `getProvider().dim` is correct and `embeddings_vec` is never rebuilt at the
   wrong dim. No import cycle (reindex→staged-actions→vector; vector imports
   neither back; `npm run build` clean). If sqlite-vec fails to load, the
   startup/reindex rebuild returns `err` and is ignored (best-effort) — the
   server still starts and reads still work (jsonl is the source of truth).
   Monotonic-id allocation is guaranteed only *within* a process (synchronous
   critical section, no intervening await); this is sufficient because Daftari
   enforces one process per vault via `.daftari/process.lock` (CLAUDE.md), so no
   second writer can race. Documented in the module docstring. **accept.**

3. **Scale delta** — Every op (`stage`/`list`/`ratify`/`sweep`/lint) does a
   `readFileSync` + parse + collapse of the whole append-only jsonl: O(n) per
   call, n = lifetime record count (never compacted in v1). Budget: ~300 B/record
   → 10k records ≈ 3 MB transient RSS, sub-10 ms parse; 100k ≈ tens of ms.
   Fine for a human-ratified queue (realistic n: dozens–hundreds). **accept for
   v1; ticket:** jsonl compaction/archival + sqlite-backed reads when the loop
   lands (§11.3+). Aligns with brief open-question #3 (archive expired after 30d).

4. **Doc-vs-code delta** — `vault_lint` was annotated `readOnlyHint: true` but
   the handler now sweeps (writes expiry records). **Fixed now:** annotation set
   to `readOnlyHint: false` with a comment, and the description updated to state
   it expires TTL-past staged actions while still never editing vault content.
   Tool descriptions for stage/ratify cross-checked against code (default ttl 14,
   deferred §11.4 set, dispatch table, pending-only validation) — all accurate.

5. **Silence audit** — `vault_stage_action`/`vault_ratify` return structured
   results; dispatch failures surface the underlying write-tool error (e.g.
   "only draft documents can be promoted"). Ratify decisions are themselves
   recorded as jsonl records (the audit trail). The lint sweep's failure is no
   longer swallowed: `vault_lint` propagates a `sweepExpiredActions` error
   instead of silently reporting a stale queue (FIX). One remaining silence:
   corrupt jsonl lines are skipped without feedback — a deliberate match of the
   `provenance.ts` / `tension.ts` convention, because failing the whole read on
   one bad line would make the entire queue inaccessible (strictly worse).
   **accept; ticket:** surface a skipped-corrupt-record count via the lint
   surface.

Decisions (no-hedge dispositions):
- **Fixed now:** `vault_lint` `readOnlyHint` + description; startup
  index-materialization failure logged; defensive `mkdirSync` in sweep;
  single-process monotonicity invariant documented; `target_path` existence
  validated at stage time; lint sweep failure propagated (not swallowed).
- **Ticket (with trigger):** jsonl compaction/archival and sqlite-backed reads
  — do this when the §11.3 loop becomes a high-frequency producer, not before;
  surface corrupt-record count in lint output.
- **Accept (evidence-backed):**
  - *No proposed_diff size cap* — no size caps exist anywhere in Daftari; a cap
    would diverge from `vault_write`. A pathological input throws and is caught.
  - *O(n) jsonl read per op* — this is a human-ratified queue (realistic max:
    hundreds). At ~300 B/record, 10k records = ~3 MB transient / sub-10 ms; an
    extreme 100k = ~30 MB / ~30 ms — within budget. The sqlite index (built +
    rebuilt) is the documented escalation path when the loop arrives. No fix now.
  - *Best-effort index materialization* — the jsonl is the source of truth and
    v1 reads use it; a materialization miss degrades nothing and is now logged.
  - *Zero-padded id ordering* — breaks lexicographically at ≥1000 actions, the
    identical known limitation as `tension-NNN`. Out of v1 range; consistent.
  - *Rejected as incorrect:* a `stageAction` "concurrency race" — the critical
    section uses synchronous `readFileSync`/`appendFileSync` with no `await`, so
    JS async-function semantics serialize concurrent calls; a `SCHEMA_VERSION`
    bump — additive `CREATE TABLE IF NOT EXISTS` migrates in place, a bump would
    force a destructive re-embed on every deployed vault.
