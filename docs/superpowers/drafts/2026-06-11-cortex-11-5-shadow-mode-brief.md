# Build brief — §11.5: shadow-mode execution path

**Branch:** `mihir/shadow-mode`
**PR title:** `feat(write): shadow-mode execution path (§11.5)`
**Base off `origin/main`** (post v1.20.0, which shipped §11.3 + §11.4).

## Why this is next

§10.4 (Decision 3) requires **calibrating the I-table from day one, before acting in
production** — without shadow mode, calibration data only exists once the loop is
already doing live writes, which inverts the risk posture. §11.5 is the
"compute-but-don't-write" mode: the pass computes the `do()`, its `I`, and the
proposed diff; logs them to a shadow-action store; **writes nothing**. Surfaced via a
new lint section ("Would-have-gated actions").

Source: §11.5 + §10.4 + §3.7 (trust budget) in the design-direction doc.

## What this builds

1. **Config switch** — `shadow_mode: true|false` in `.daftari/config.yaml`
   (default false). Vault-level: when on, every doc-write tool shadows.
2. **Shadow store** — append-only `.daftari/shadow-actions.jsonl` (the
   staged-actions/edges posture; git-ignored). One record per intercepted write:
   `{at, tool, action, target_path, agent, i_base, blast, impact, budget,
   spent_before, would_gate, frontmatter_diff, commit_message}`.
3. **I computation (§10.4, all constants provisional/exported):**
   - `I = min(i_base + K_BLAST · (blast − 1)^1.5, 1)` — the convex blast scaling,
     α = 1.5, `K_BLAST = 0.05`.
   - `i_base` per write action (create 0.1, update 0.2, append 0.15,
     confidence-set 0.2, promote 0.3, deprecate 0.4, supersede 0.4, merge 0.6) —
     a starting table to calibrate against, not a claim. This table
     intentionally supersedes §4's illustrative I-table for calibration
     purposes (§10.4's "full action-type table" decision postdates §4); every
     record stores its own `i_base` and `blast`, so impacts are re-derivable
     offline when the table is recalibrated.
   - `blast` = 1 + downstream docs reachable from the target via the existing
     reverse-link/reverse-source maps (`computeBlast`, the tension-blast engine).
     Merge seeds all three paths. (derives_from edges join the blast graph when
     the §11.3 store is wired into traversal — loop territory, not this PR.)
4. **Budget B₀ as a vault-state function (§10.4):**
   `B₀ = min(B0_BASE + B0_PER_PENDING · pendingStagedActions, max(1, ln(docCount)))`
   with `B0_BASE = 0.5`, `B0_PER_PENDING = 0.25` — proportional to queue depth
   with a log(N) ceiling, per the doc's suggested form. Provisional. The queue
   depth counts only LIVE pending actions (TTL-dead entries between lint sweeps
   would inflate B₀).
5. **Session accumulator** — a per-process, per-vault spent-I counter (the §3.7
   monotonic budget, shadow-only). `would_gate = spent_before + I > B₀`; spent
   accumulates regardless (the record shows where exhaustion WOULD have hit).
   Reset on process start; exported reset for tests. **Known v1 limitation:**
   "session" = process lifetime; under a long-lived server the gated fraction
   saturates over a long calibration window. Every record stores `spent_before`
   and `budget`, so sessions can be re-segmented offline; a real session
   boundary (idle-gap / loop-session reset) lands with the loop.
6. **Write-path interception** — in `performWrite` (the single choke point for
   vault_write/append/promote/deprecate/supersede/set_confidence): when shadow
   mode is on, AFTER validation/RBAC (we shadow only writes that would have
   executed), compute blast + I, append the shadow record, and return a
   `WriteResult` with `shadow: true`, `commit: null`, `committed: false`,
   `indexUpdated: false`. No locks, no file I/O, no git, no provenance entry
   (the provenance log records writes that happened; the shadow store is its own
   audit). `vault_merge` gets the same branch before its lock block (one record,
   three-path blast seed).
7. **`vault_ratify` guard** — a shadowed dispatch returns `shadow: true`; ratify
   must NOT record a `ratified` decision over a write that didn't land. It
   returns `{applied: false, shadow: true}` and leaves the action pending.
8. **Lint surface** — new `shadowActions` section on the lint report:
   would-have-gated count + recent gated items + totals (the doc's "weekly"
   cadence is the operator's reading rhythm, not an automation requirement in v1).

## Out of scope

- Live gating/enforcement — shadow mode never blocks anything; that is the loop's
  envelope (§4), built later.
- `daftari backfill` (its own human-ratified per-folder flow, §11.1) and the edge
  tools (advisory store appends, not doc writes; their I entries land with the loop).
- Calibration itself — this PR produces the data, not the tuned table.
- Weekly cadence automation (cron/loop-driven reporting — §12).

## Architecture constraints (CLAUDE.md)

No classes; `Result<T,Error>`; never throw from handlers; tests mirror src/. The
jsonl is local advisory state, git-ignored.

## Test plan

- Shadow on: vault_write returns `shadow: true`, file NOT on disk, no commit, no
  provenance entry; shadow record carries diff + I + verdict.
- I math: blast=1 → I = i_base; convexity (blast 3 vs 2); cap at 1.
- Budget: B₀ floor with empty queue; grows with pending staged actions; ln(N)
  ceiling. Accumulator: successive writes flip `would_gate` once spent crosses B₀.
- vault_merge shadow: no files touched, one record, three-path blast.
- Ratify over shadowed promote: action stays pending, `applied:false, shadow:true`,
  no decision record.
- Lint: gated items surface in `shadowActions`.
- Shadow off (default): everything behaves exactly as before (regression = the
  existing 969-test suite).

## Open questions resolved here (surface, don't guess)

1. **Validation/RBAC still run in shadow** — we log the do() that WOULD have
   executed; an invalid or denied write errs exactly as live. (Calibration data
   must not include writes that could never happen.)
2. **base_version (optimistic concurrency) is skipped in shadow** — there is no
   lock and no mutation; a stale-write rejection is a live-path concern.
3. **No provenance entry for shadowed writes** — one audit trail per store.
4. **Humans' writes shadow too** when the vault flag is on — shadow_mode is a
   vault posture (calibration window), not a per-principal filter; per-principal
   shadowing arrives with §11.6's agent identity.
