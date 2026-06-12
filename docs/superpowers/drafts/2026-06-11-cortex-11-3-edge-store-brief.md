# Build brief — §11.3: `derives_from` edge store with strength column

**Branch:** `mihir/derives-from-edge-store`
**PR title:** `feat(curation): derives_from edge store with earned strength (§11.3)`
**Base off `origin/main`** (after §11.4 / PR #127 merges; independent of it in code, sequenced after it in the build-list).

## Why this is next

§11.3 is the keystone substrate: the "earned, not declared" re-derivation graph the
whole strength model rests on (design doc §3.5, §5.2). It unblocks Decision 2 (typed
edges, strength-attenuated reach), Decision 3 (I for `derives_from` ops), and
Decision 4's `link` auto-write. Without it the scheduler (Component C) has no
strength to scale intervals by and the loop has no trust ledger.

Source of truth: §11.3 + §5.2 (strength model Q1–Q4) + §5.3.1 (aging revision) +
§10.3/§10.5 in `docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md`.

## What this builds (and what it does not)

**In scope — the store only:**
- An append-only canonical log `.daftari/edges.jsonl` (observe + contest records).
- A derived `derives_from_edges` table in `.daftari/index.db` with exactly the §11.3
  schema: `(from_path, to_path, strength, k_survived, first_observed, last_rederived,
  last_age_decay, status: candidate|trigger-bearing|revoked)`. Rebuilt on reindex,
  materialized at startup — the staged-actions posture (jsonl is truth; sqlite exists
  for the future loop's concurrent traversal reads).
- Store mechanics encoding the locked decisions (below).
- Three MCP tools: `vault_edge_observe` (producer — the future matcher/loop, exposed
  for testing like `vault_stage_action`), `vault_edge_contest` (Q4 contest-and-revoke
  + tension), `vault_edges` (read, with live aged strength).

**Out of scope (explicitly):**
- The matcher / seeding pipeline (§10.2) — nothing in this PR creates edges by itself.
- Scheduler C: intervals, event-blast, priority tiers, budgets.
- Per-class propagation floors and blast integration (§10.3) — C consumes strength;
  this PR only stores it.
- PageRank-style weighting — schema is weight-ready (Q2), nothing computes weights.
- Shadow mode (§11.5), agent principal in RBAC (§11.6).
- Case-1 handling (re-derivation fails *because* an endpoint changed) — that is C's
  trigger, not a store event. The store only knows observe and contest (case-2).

## Mechanics (locked decisions → code)

**Record shapes (`.daftari/edges.jsonl`, one JSON object per line):**
- Observe: `{kind:"observe", from, to, at, by, blind:boolean, axis:"prompt"|"input-neighborhood"|"model"|null, note?}`
- Contest: `{kind:"contest", from, to, at, by, reason}`

**Collapse rules (Q2: strength is recomputed from the trail, never a mutable counter):**
- The first observe in a cycle *seeds* the edge: `k_survived = 0`, `first_observed = at`,
  `last_rederived = at`, status `candidate`. Birth is not a survival — the graph is
  earned into existence, not free (§3.5). The seed's own (observer, axis) attestation
  is registered, so the seeder repeating the identical claim moments later is a
  replay, not an instant first vote.
- A subsequent observe is a **qualifying vote** iff `blind === true` AND `axis` is one
  of the three Q3 axes (varied axis recorded per vote) AND it clears the **replay
  guard**: a (observer, axis) pair that already voted this cycle counts again only
  after `REPLAY_GAP_DAYS = 1` since the last counted vote (C-Q4 made mechanical: the
  inter-session gap is what makes a repeat re-derivation independent; a same-sitting
  replay is cramming). A *new* (observer, axis) pair counts immediately — two
  different models voting in one sitting ARE independent. Qualifying:
  `k_survived += 1` (cap `K_CAP = 5`), `last_rederived = at`. A counted vote at cap
  still refreshes `last_rederived`.
- Blindness and axis-variation are **unverifiable attestations** — the store cannot
  check them. Enforcement of genuine independence (and §10.5's multi-pass agreement
  for contests) is the loop's job; the replay guard is the store's mechanical floor
  against single-caller k-pumping, while still letting the quarterly loop's repeat
  re-derivations restore aged strength (§5.3.1 reversibility).
- A non-qualifying observe (not blind, no varied axis, or a same-sitting replay) is
  recorded in the trail but moves neither `k_survived` nor `last_rederived`.
- A contest revokes: status `revoked`, and a `tension` is logged (Q4: surface, don't
  silently decrement). Counters freeze for display.
- An observe *after* a contest re-seeds a fresh cycle (`k_survived = 0`, new
  `first_observed`) — revocation is reversible by re-derivation only (§5.3.1).
- A record whose `at` does not parse as a real instant is treated as corrupt and
  skipped (an unparseable timestamp would otherwise poison strength with NaN).

**Strength (§5.3.1(b) aging, calibration-pending):**
`strength(now) = min(k_survived, K_CAP) × 0.5^(daysSince(last_rederived) / HALF_LIFE_DAYS)`
with `HALF_LIFE_DAYS = 90`. Aging asserts nothing about correctness — only that the
last test is old; it is reversible by a survived re-derivation. Constants are exported
and documented as provisional (compute-budget calibration is open decision §12/#8).

**Status (derived at collapse/read, never stored in the jsonl):**
- `revoked` — contested and not re-seeded since.
- `trigger-bearing` — aged strength ≥ `TRIGGER_STRENGTH = 0.5`. With the defaults a
  k=1 edge bears triggers for one half-life (~90d) without re-test; k=5 for ~300d —
  nothing stays trusted forever without re-derivation (the max-interval backstop's
  spirit, mechanically).
- `candidate` — everything else (including a fresh edge at k=0 and an aged-out one).

**Sqlite row:** the 8 §11.3 columns, PK `(from_path, to_path)`. `strength`, `status`
are materialized at rebuild time; `last_age_decay` records that materialization
instant (the row's strength is exact as-of that timestamp). Live readers
(`vault_edges`) recompute aged strength from the jsonl at now — v1 hot paths read the
jsonl directly, same as staged actions.

## Tools

All caller-supplied paths are **canonicalized** (trimmed, resolved against the vault
root — rejecting traversal out of it — and re-relativized) before touching the store,
so `./a.md`, `b/../a.md`, and `a.md` key one edge: aliased inputs can neither split an
edge's votes across phantom twins nor slip a self-edge past the guard (the same
aliasing class `vault_merge` guards against).

- `vault_edge_observe(from_path, to_path, observed_by, blind, varied_axis?, note?)` —
  validates both docs exist (fail-fast, like `vault_stage_action`), rejects
  self-edges on the canonical paths. RBAC: any read grant (curation-surface posture).
- `vault_edge_contest(from_path, to_path, contested_by, reason)` — requires the edge
  to exist and not already be revoked; logs a tension FIRST (kind `factual`,
  sourceA = the deriving doc, sourceB = the premise doc), then appends the contest
  record. Tension-first is the safe ordering (a tension over a still-live edge is
  advisory noise; a silent revoke is the failure mode the design forbids); an
  unresolved tension with the same title is reused so a failed-revoke retry never
  stacks duplicates. No doc-existence check — an edge whose endpoint doc was deleted
  is still contestable.
- `vault_edges(from_path?, to_path?, status?)` — collapsed edges with live aged
  strength, strongest first.

RBAC note for §11.6: contest is destructive to the future trigger graph and has no
second gate (unlike ratify, whose inner write tools re-check `canWrite`) — when the
agent principal lands, contest belongs on its grant list.

## Files

- `src/curation/edges.ts` — store: jsonl read/append, collapse, strength math, constants.
- `src/storage/index-db.ts` — `derives_from_edges` DDL + row type + upsert/clear/getters.
- `src/search/reindex.ts` + `src/index.ts` — rebuild/materialize wiring (mirror staged actions).
- `src/tools/edges.ts` — the three MCP tools; register in `src/server.ts`.
- `test/curation/edges.test.ts`, `test/tools/edges.test.ts`.

## Test plan

- Collapse: seed → candidate k=0; blind+axis votes increment to cap; non-blind /
  axis-less observes don't count and don't refresh; vote-at-cap refreshes clock.
- Aging: strength halves per half-life (inject `at` timestamps); trigger-bearing
  flips to candidate when aged below 0.5.
- Contest: revokes + appends tension (assert via listTensions); contest of unknown or
  already-revoked edge errors; re-observe after contest re-seeds k=0 candidate.
- Tools: doc-existence fail-fast, self-edge rejection, RBAC (guest denied), filters
  on `vault_edges`.
- Rebuild: jsonl → sqlite rows carry the 8 columns; reindex repopulates; corrupt
  jsonl lines skipped.

## Architecture constraints (CLAUDE.md)

- No classes; `Result<T,Error>`; never throw from handlers; tests mirror `src/`.
- The jsonl is local advisory curation state, git-ignored like the provenance log
  (this PR adds `**/.daftari/edges.jsonl` AND the previously-missed
  `**/.daftari/staged-actions.jsonl` to `.gitignore`) — the index stays rebuildable
  *from the jsonl*, and the jsonl is the durable record the strength is recomputed
  from.

## Open questions resolved here (surface, don't guess — flagged for review)

1. **k at birth = 0** (birth is not a survival). Trigger-bearing therefore requires ≥1
   independent replication — the strictest faithful reading of §3.5.
2. **Aging clock = last *qualifying* vote**, not last sighting — correlated observes
   must not keep an edge warm.
3. **Constants (K=5, half-life 90d, threshold 0.5)** are provisional defaults pending
   §12/#8 calibration; exported, single-sourced, documented.
4. **Contest does not require multi-pass agreement in the store** — §10.5's
   "multi-pass failure agreement" is loop policy; the store records what it is told.
   The tension entry is the audit trail either way.
