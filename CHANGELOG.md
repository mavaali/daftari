# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.25.0] - 2026-06-19

### Added

- Cortex loop **Stage 4 — coverage/equity instrumentation** (spec §6.2). `vault_lint`
  now reports a `coverageEquity` summary surfacing the budget-drift ratchets before
  any auto-write graduates: **strength-distribution drift** (edges split into core
  vs periphery by blast==0, with per-group strength quantiles/variance and the
  core−periphery median gap, plus a below-trigger-strength count), **standing
  backstop-overdue** count (edges past the 90-day max interval, computed without a
  consolidate run), **action-mix drift** (the cheap-link fraction over edge-op +
  live pending/ratified staged actions, excluding doc-write calibration rows and
  dead expired/rejected proposals), and **direction-resolution**
  (directed vs symmetric, with the unresolved fraction). Read-only — a monitor, never
  a target: a guard test forbids any `src/consolidate/` module from importing it.

## [1.24.0] - 2026-06-19

### Added

- `daftari import obsidian <vault>` — adopt an Obsidian vault in place. An
  Obsidian-aware wrapper over `backfill`: harvests inline `#tags`, maps Web
  Clipper `source` → `sources[]`, normalizes ISO-datetime `created`/`updated`
  (as Obsidian/plugins write them) to the schema's `YYYY-MM-DD`, preserves all
  other existing/custom frontmatter, and leaves wikilinks untouched (Daftari
  already resolves them). On a non-git vault it announces it will initialize
  git, and scaffolds the `.daftari/*` gitignore rules on apply.
- `git_dir` config key (and `daftari import … --external-git-dir[=path]`) — keep a
  vault's git data outside the vault via `git init --separate-git-dir`, so a
  cloud-synced (iCloud/Dropbox/…) vault gets version history without a churning
  `.git/` inside the sync folder. `external` derives a per-vault path under the
  data home; an explicit path is also accepted. History is per-device.

## [1.23.0] - 2026-06-19

### Added

- **Cortex consolidation loop — Stage 3 (two-gate envelope).** `daftari
  consolidate` now consults a two-gate envelope — an **invariants** gate (it
  refuses to act on an edge whose endpoint carries an unresolved tension) and a
  **trust-budget** gate — before each edge `do()`. The envelope is enforced
  **live but shadowed**: every decision is computed and journaled to
  `.daftari/shadow-actions.jsonl` as `decision: "admitted"` or
  `decision: "gated"` (with gate + reason), but never enacted. `vault_lint`
  surfaces the gated/surfaced envelope decisions as a view distinct from the
  existing would-gate calibration section.
- **§8 closures.** A loop decision records `decided_by_principal` (the
  authenticated identity) on the staged action and contest tension it produces;
  `vault_tension_resolve` is gated on `canRatify` for loop-authored tensions, so
  the loop cannot close its own tensions.

## [1.22.0] - 2026-06-17

### Added

- **Cortex consolidation loop — Stage 2 (Component A).** The loop's read-side
  curation engine, running `shadow_mode` + `ratify:false` by default (it proposes;
  humans ratify), driven by `daftari consolidate --mode scan|birth|revision|both`.
  - **Birth mode** — for an unprocessed doc, retrieve its top-K embedding
    neighbors, judge whether a load-bearing derivation exists and in which
    direction, and seed `k=0` candidate `derives_from` edges. The full top-K and
    per-neighbor verdicts are logged to `.daftari/birth-trace.jsonl` for recall@K
    evaluation.
  - **Revision mode** — cast a panel of M independent votes on a due edge and
    decide once by **majority**: majority-survives accrues strength (each
    surviving vote observes on a distinct axis); majority-fails contests once
    (revoke + tension); a tie surfaces without churning edge state.
  - **Shadow mode** — edge writes route through `.daftari/shadow-actions.jsonl`
    (calibration) with the durable `edges.jsonl` untouched; impact/blast/budget
    are recorded per the §11.5 model.
  - **Axis-decorrelation report** — `--report decorrelation --fixture <path>`
    measures the elicitation prompt's direction-recovery accuracy on a
    ground-truth fixture (PASS gate ≥ 85%).

- **Reliable `derives_from` edge direction (foundational-ordering).** Replaces the
  brittle derives/depends token with a temperature-0 foundational-ordering
  judgment (`{related, premise}`): which document is the load-bearing premise that
  must be established first. Birth loads the neighbor's content and elicits the
  direction in **both presentation orders**, committing a directed edge only when
  the orders agree; genuinely-mutual or order-contested pairs become
  direction-unconfirmed **pending edges** that stay visible as undirected
  relationships but do not propagate triggers, plus an interpretive
  direction-pending tension for human adjudication. Edge keys are canonical, so a
  post-edit direction flip collapses to one symmetric edge rather than forking a
  contradictory twin. Validated at 96–100% on curated clear-direction real-prose
  pairs and 97.4% on the contamination-free decorrelation fixture.

### Changed

- **SQLite index schema bumped to v6** — adds `direction_verdict` to
  `derives_from_edges`. The `.daftari/index.db` is ephemeral and rebuilds from the
  markdown/JSONL on first open; no data migration.
- `daftari consolidate` gains exit code **7** (event-clock baseline unreachable —
  the gap is re-baselined to HEAD and left to the backstop clock, surfaced as a
  cron-alertable signal rather than a silent success).

## [1.21.0] - 2026-06-12

### Added

- **Cortex §11.6: agent principal in RBAC.** The last substrate item before the
  consolidation-loop spec. An agent principal is just a role — e.g. start the
  server as `--user agent:curation-loop --role curation-loop` against a role
  that writes but does not ratify.
  - **`ratify` role grant** — gates the curation-verdict tier: `vault_ratify`
    (approve/reject staged actions) and `vault_edge_contest` (revoke a
    derives_from edge, closing the gap flagged in the §11.3 review). Declared
    per role in `.daftari/config.yaml`, default false.
  - **Authenticated principal attribution** — when the server runs with an
    access context, every write's provenance entry and shadow record carries
    `principal: <user>` (the identity the server was started as) alongside the
    caller-supplied free-text `agent` claim.

- **Cortex §11.5: shadow-mode execution path.** `shadow_mode: true` in
  `.daftari/config.yaml` turns every doc-write tool into compute-but-don't-write:
  validation, RBAC, and the proposed diff run exactly as live, then the would-be
  `do()` is logged to an append-only `.daftari/shadow-actions.jsonl` (git-ignored)
  with its impact and budget verdict — and nothing is written (no file, no commit,
  no index update, no provenance entry). The calibration posture Decision 3
  requires before the consolidation loop ever acts in production.
  - **Impact** `I = min(i_base + 0.05·(blast−1)^1.5, 1)` — convex blast scaling
    over the reverse-link/source reach of the touched paths; per-action `i_base`
    starting table (create 0.1 … merge 0.6). All constants provisional and
    exported — they are the thing being calibrated.
  - **Budget** `B₀ = min(0.5 + 0.25·pendingStagedActions, max(1, ln(N)))` — a
    vault-state function, proportional to ratification-queue depth with a log(N)
    ceiling. A per-process session spend accumulates and `would_gate` marks every
    action past the would-be checkpoint.
  - **`vault_ratify`** detects a shadowed dispatch and leaves the action pending
    (`applied: false, shadow: true`) instead of recording a false `ratified`.
  - **`vault_lint`** gains a `shadowActions` section: totals plus the most recent
    would-have-gated actions.

### Changed

- **`vault_ratify` and `vault_edge_contest` now require the `ratify` grant** on
  vaults with RBAC roles configured (both previously allowed any role with a
  read grant). Roles that issue curation verdicts must declare `ratify: true`.
  Servers run without `--role` are unaffected.

## [1.20.0] - 2026-06-11

### Added

- **Cortex §11.3: `derives_from` edge store with earned strength.** The
  re-derivation graph the consolidation loop's strength model rests on — edges
  are earned through independent re-derivations, never declared into trust.
  - **Store** — append-only canonical log at `.daftari/edges.jsonl` (observe +
    contest records) collapsed to current edge state; a derived
    `derives_from_edges` table in the index (`from_path, to_path, strength,
    k_survived, first_observed, last_rederived, last_age_decay, status`) is
    rebuilt on reindex and materialized at startup for the future loop's
    concurrent traversal reads.
  - **Strength model** — the first observation seeds a zero-strength
    `candidate` (birth is not a survival); only blind observations that vary a
    recorded axis (prompt | input-neighborhood | model) count as independent
    votes (`k_survived`, cap 5); a replayed (observer, axis) attestation counts
    again only after a one-day gap, so a single caller cannot pump strength in
    one sitting while the loop's later re-derivations still restore it;
    strength ages by half-life (90 days) since the last qualifying
    re-derivation, so an un-retested edge drops out of `trigger-bearing`
    (floor 0.5) on its own — entrenchment is structurally impossible.
    Constants are provisional pending calibration.
  - **Tools** — `vault_edge_observe` (producer, exposed for the future loop
    and testing), `vault_edge_contest` (case-2 contest-and-revoke; logs a
    tension first so a contest can never be a silent decrement, reusing an
    unresolved same-title tension so retries never stack duplicates; a revoked
    edge is re-earned only through fresh observations), `vault_edges` (read,
    live aged strength, endpoint/status filters). All caller paths are
    canonicalized, so aliased inputs (`./a.md`, `b/../a.md`) cannot split an
    edge's votes or slip a self-edge past the guard.
  - `.daftari/edges.jsonl` and the previously-missed
    `.daftari/staged-actions.jsonl` are now git-ignored (local curation state,
    like the provenance log).

- **Cortex §11.4: `vault_supersede`, `vault_merge`, `vault_set_confidence`
  write tools, wired into `vault_ratify`.** Completes the staged-action queue's
  apply path — every action type the queue accepts (`promote`, `deprecate`,
  `supersede`, `merge`, `confidence-up`) now applies on ratification instead of
  punting to a `ratified-pending-tool` status.
  - **`vault_set_confidence`** — change only a document's `confidence` (a
    reason is required and recorded); rejects a no-op change already at the
    target.
  - **`vault_supersede`** — mark a document `superseded` by a named successor
    that must already exist. Distinct from `vault_deprecate` (which sets
    `deprecated` with an optional successor).
  - **`vault_merge`** — combine two source docs into a target and supersede
    both sources to point at it, all in one git commit (modeled on the backfill
    multi-file commit, not single-file `performWrite`). The merged body is
    supplied by the caller; the tool never synthesizes prose. `target_path` may
    equal `path_a` (fold B into A) or be a new path; the target's frontmatter
    inherits `path_a`'s with `provenance: synthesized` unless overridden.
  - **`vault_ratify` dispatch** now covers all five action types; a malformed
    `proposed_diff` leaves the action pending rather than recording a decision.

## [1.19.0] - 2026-06-10

### Added

- **Code coherence: doc-to-code bindings across the audit and eval** ([#117],
  [#118], [#119], [#120], [#121]). Vault docs can now declare which code they
  document, and the audit can verify those bindings still hold.
  - **`describes` frontmatter field** ([#117]) — a built-in optional string
    array of doc-to-code bindings, each `repo:path` or `repo:path::symbol` (a
    bare `path` resolves against the doc's own repo; the `::symbol` suffix is
    retained but resolved at file level in v1). A first-class relationship like
    `sources` / `superseded_by`; defaults to `[]`.
  - **`type: docs | code` repo discriminant for the audit** ([#118]) — code
    repos join the coherence audit as reference targets, indexed by path only
    (no frontmatter parsing, no content read) and excluded from staleness.
    Adds the `--code-repo` flag; a code repo's glob defaults to `**/*`.
  - **Doc-to-code reference integrity** ([#119]) — the audit classifies
    `describes` entries as cross-repo edges and flags any whose target file is
    missing, in a new report section with a `brokenDescribes` total and a
    `fail_on.broken_describes` threshold (default 1).
  - **`--semantic` drift check** ([#120]) — opt-in LLM pass that reads each
    resolvable binding's doc and code and judges whether the doc still
    accurately describes the code (`coherent` / `drifted` / `contradicted` /
    `skipped`). `--auto-tension` logs drift as a tension in the docs vault;
    `--max-semantic` caps LLM calls. Every non-markdown read is guarded (size
    cap, binary sniff, strict UTF-8). Advisory — does not gate the exit code,
    and the default audit needs no API key and makes no network calls.
  - **`describes` as a subgraph edge kind in eval** ([#121]) — the cortex
    quality sampler records doc-to-code edges and loads vault-resident code as
    separate, non-citable context nodes (the answerer is never asked to
    retrieve code). External-repo code-content loading in eval is deferred.

[#117]: https://github.com/mavaali/daftari/issues/117
[#118]: https://github.com/mavaali/daftari/issues/118
[#119]: https://github.com/mavaali/daftari/issues/119
[#120]: https://github.com/mavaali/daftari/issues/120
[#121]: https://github.com/mavaali/daftari/issues/121

## [1.18.0] - 2026-06-09

### Added

- **`daftari backfill` field-name collision detection + coverage reporting**
  ([#116]). A wiki that predates Daftari often reuses one of the reserved enum
  field names — `status`, `confidence`, `domain`, `provenance` — with its own
  vocabulary (`status: ACTIVE`, `domain: Architecture`). Backfill now *detects*
  these collisions (a present built-in enum field whose value is outside that
  field's enum) and surfaces them so the operator can resolve them. `--plan`
  lists every collision (`path · field: value`) and reports per-scope
  **coverage** — how many docs will catalog cleanly versus be blocked
  (collision vs. other) — so a mostly-colliding folder can't look silently
  cataloged. `--apply` skips a colliding doc whole with a rename-guidance
  message, prints an actual-coverage line (`cataloged N of M · K skipped`), and
  states projected coverage in the confirmation prompt. The resolution is the
  operator's: rename the field (`status` → `wiki_status`) and on re-run the
  value rides along as a preserved custom field while Daftari's built-in
  `status` takes its default. No auto-rename, no skip-rate threshold/abort, no
  config or schema change — detection and reporting only.

### Fixed

- **Backfill no longer launders foreign vocabulary into Daftari defaults**
  ([#116]). `daftari backfill --apply` silently overwrote a present built-in
  field whose value was outside the field's enum: `deriveProposed` preserved
  the *validator-coerced* value, and `requireEnum` returns the enum fallback for
  an out-of-enum value, so `status: ACTIVE` became `status: draft`,
  `confidence: EXPLICIT` became `low`, and `domain: Architecture` became
  `accumulation`. The fix preserves the **raw** author value (normalizing only a
  YAML `Date` to a `YYYY-MM-DD` string); the existing apply guard then skips the
  doc rather than clobbering it. This is universal across fields — a present
  malformed value of any kind is now reported, not silently coerced. A
  data-loss class sibling to [#113] (which dropped *undeclared* fields; this
  dropped the *meaning* of declared ones).

[#116]: https://github.com/mavaali/daftari/issues/116

## [1.17.1] - 2026-06-08

### Fixed

- **Frontmatter writes are now non-destructive** ([#113]). A tool-mediated write
  no longer silently drops frontmatter fields that are absent from the write
  payload. Two parts: (1) `serializeDocument` preserves any field a document
  already carries that is neither built-in nor a declared schema extension —
  undeclared custom fields now round-trip untyped instead of being stripped,
  which fixes the same loss on `vault_append` / `vault_promote` / `vault_deprecate`
  and `daftari backfill` (the path that dropped fields across 197 files in a
  single run); and (2) on the `vault_write` update path, the document's existing
  frontmatter is merged under the payload — every existing field (built-in,
  declared extension, or undeclared) is preserved, the payload wins per key, and
  an explicit `null` in the payload removes a key (opt-in deletion). The create
  path is unchanged. This makes the 1.17.0 changelog claim that existing
  frontmatter is "preserved field-by-field" actually hold. Critical-priority:
  1.17.0 shipped with this bug.

[#113]: https://github.com/mavaali/daftari/issues/113

## [1.17.0] - 2026-06-07

### Added

- **`daftari backfill` git-driven frontmatter migration** (cortex consolidation
  loop §11.1). A CLI command that adopts an existing wiki into Daftari without a
  manual migration sprint: it walks the vault, derives frontmatter defaults
  deterministically (no LLM calls) from git history and body conventions, and
  writes them per-folder on human ratification. Two-step plan/apply:
  `daftari backfill --plan [--scope <folder>]` derives proposals and stages them
  to `.daftari/backfill-plan.jsonl` (modifying no markdown), and
  `daftari backfill --apply --scope <folder> [--yes]` writes the proposals for
  one folder and commits them in a single commit (honoring the vault's
  `auto_commit` setting — with `auto_commit: false` the files are written but
  the caller owns git, matching the other write tools). `--scope` is required on
  apply so a whole-vault write can never happen by accident. Derivation: `title`
  from the first H1 (else the filename), `created`/`updated`/`updated_by` from
  git (`--diff-filter=A` first-add, last-commit, author through an optional
  `backfill.identity_map` in `.daftari/config.yaml`), `collection` from the
  parent folder, and `status: canonical` / `confidence: medium` /
  `provenance: direct` / `domain: accumulation` defaults — explicitly suggested,
  ratified by a human, never asserted. Existing frontmatter is preserved
  field-by-field; a doc whose frontmatter already validates is reported
  conformant and skipped. The plan is transient: backfill never stages or
  commits it (apply stages only the doc paths), the apply commit is the durable
  audit trail, and `.daftari/backfill-plan.jsonl` is added to the `daftari
  --init` .gitignore template (a `--plan` run also prints a reminder to gitignore
  it on wikis not scaffolded by Daftari). CLI-only for v1 — no MCP tool. See
  [docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md](docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md)
  §11.1.
- **Staged-action queue + `vault_ratify`** (cortex loop §11.2). A persistent
  queue of proposed vault changes awaiting human ratification — the foundation
  for the consolidation loop's "always-stage" tier. Two new MCP tools:
  `vault_stage_action` (producer; normally the curation loop, exposed for
  testing and future callers) records a proposed `promote` / `deprecate` /
  `supersede` / `merge` / `confidence-up` action with a rationale, a proposed
  diff, and a TTL (default 14 days); `vault_ratify` (consumer) lets a human
  `approve` or `reject` one pending action. On approve, it dispatches to the
  existing write path — `promote` → `vault_promote`, `deprecate` →
  `vault_deprecate` (both auto-commit). `supersede` / `merge` / `confidence-up`
  are staged only in v1 (their write tools are deferred to §11.4); approving
  one returns `applied: false` with `deferred_to: "§11.4"` and a
  `ratified-pending-tool` status. Storage mirrors the rest of Daftari: an
  append-only canonical log at `.daftari/staged-actions.jsonl` (the source of
  truth) plus a derived `staged_actions` table in the ephemeral
  `.daftari/index.db`, rebuilt from the jsonl on reindex and startup.
  `vault_lint` gains a "Staged actions" section listing pending actions
  soonest-to-expire first, and expires actions past their TTL as a housekeeping
  sweep on each invocation. See
  [docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md](docs/superpowers/specs/2026-06-06-cortex-consolidation-loop-design-direction.md)
  §11.2.

## [1.16.0] - 2026-06-02

### Added

- **`daftari eval` cortex quality metric** (Sleep Component B). New CLI
  subcommand that scores how well an LLM can use the Daftari MCP curation
  surface to answer multi-hop questions about the vault. Three tiers
  (retrieval, cross-reference, contradiction) with a tier-weighted aggregate
  (1×/2×/3×) plus per-tier variance and trace-efficiency. The pipeline is
  seeded subgraph sampling → LLM question generation (with tier-mix top-up
  and tension-graph augmentation) → in-process answerer over the existing
  read-only tool surface → LLM grading. Runs persist incrementally, so a
  failed run is resumable with `--resume`. Generator/answerer/grader are all
  LLM-mediated via `@anthropic-ai/sdk` (new dependency, isolated to
  `src/eval/llm.ts`); the rest of the codebase stays LLM-free. Output
  artifacts live under `.daftari/eval/` (gitignored). Components A (multi-pass
  curation) and C (dependency-triggered re-curation) are deferred to
  follow-on specs. See
  [docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md](docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md).

## [1.15.0] - 2026-05-31

### Added

- **Blast radius of stale tensions** (Step 5 of the Tension Graph plan,
  cross-feature integration). `vault_lint`'s tension health surface now
  reports `blastRadiusOfStaleTensions`: the cardinality of the
  deduplicated `primary_blast` set (sources channel only — the same
  primary set `vault_tension_blast` returns) over the union of contested
  docs from every entry where `resolved: false` AND
  `agingTier === "stale"`. Renders as "Blast radius of stale tensions: N
  downstream documents". When there are no stale unresolved tensions the
  metric is 0; the line always renders for consistency with the rest of
  the tension health section. Reuses `computeBlast` from
  `tension-blast.ts` — advisory link edges still participate in BFS
  traversal, but the published metric stays disciplined to the primary
  channel.

- **Tension blast radius** (Phase 3 of the Tension Graph plan). New
  `vault_tension_blast` tool computes the transitive closure of
  downstream documents that cite or link a contested document — or the
  union over a contested cluster. Accepts exactly one of `document` or
  `cluster_id`. Two confidence channels: `primary_blast` (via `sources`
  frontmatter) is authoritative; `advisory_blast` (via in-vault markdown
  links) is suggestive. `superseded_by` is not a blast edge — the doc
  that supersedes a contested doc is the replacement, not an inheritor.

- **Tension clusters** (Phase 2 of the Tension Graph plan). New
  `vault_tension_clusters` tool computes connected components of the
  tension graph over unresolved, non-accepted tensions. Cluster IDs are
  content-addressed (`cluster:` + first 8 hex chars of sha256 of
  canonical-sorted member paths) — stable across runs for unchanged
  membership; a different ID encodes a different membership. `vault_lint`
  reports cluster count, max size, and flags clusters that are large
  (>5 docs, smell) or aged (oldest tension >90 days, tech debt).

- **Tension aging tiers** (Phase 4 of the Tension Graph plan). Tensions
  in the tension log now report aging tiers (Fresh 0–30d / Aging 31–90d
  / Stale 90+d) in `vault_lint`, with kind-specific lint copy at the
  stale tier. Unspecified tensions and tensions resolved with kind
  `accepted` are excluded from the aging pipeline — the former because
  they predate classification, the latter because explicitly accepted
  persistent disagreements are stable epistemic features rather than
  debt.

## [1.14.0] - 2026-05-31

### Added

- **Multi-vault MCP router** (`packages/router/`, published as
  `daftari-router` v0.1.0). One MCP connection that spans N daftari
  vaults: read/write tools dispatch to the named vault; search, status,
  lint, themes, index, and reindex fan out across every child and merge
  results. Vault selection via explicit `vault:` arg or vault-prefixed
  paths (e.g. `devops:runbooks/k8s.md`). Catalog seeded from the first
  child; heterogeneous tool surfaces are warned to stderr. Phase 1 — no
  HTTP transport, no auth, no cross-vault lint, no score normalization
  across heterogeneous embedding models. See
  [docs/multi-vault-howto.md](docs/multi-vault-howto.md) for the
  task-oriented walkthrough and
  [packages/router/README.md](packages/router/README.md) for the
  reference.

- **Tension taxonomy and resolution** (Phase 1 of the Tension Graph plan).
  Tensions now carry a `kind` (temporal | factual | interpretive |
  unspecified). New tool `vault_tension_resolve` records how a tension was
  closed (superseded | corrected | accepted | invalid) with optional
  rationale and references. `vault_lint` reports tension counts by kind
  and resolution kind, and surfaces a separate "stable acknowledged"
  count for explicitly accepted persistent disagreements. Legacy entries
  without a `kind` field read as `unspecified` and produce no warnings.

### Changed

- **`vault_reindex` coalesces with an in-flight indexing pass** instead
  of returning a busy error. When a reindex is already running (e.g. the
  startup-time background pass kicked off when daftari boots a fresh
  vault), `vault_reindex` now awaits it and then runs the caller's
  requested reindex against a hot cache. Previously, an agent that
  asked for a reindex during that startup window got a "still indexing"
  refusal — a footgun the router stress-tested into a real test failure.

### Fixed

- Test helper `temp-vault.ts` `cpSync` filter now skips `.git/` as well
  as `.daftari/`. The sample-vault fixture is itself a real git repo;
  without this, the fixture's `.git` was being copied into every temp
  vault, making `isGitRepo(vault)` return true for what was supposed to
  be a fresh directory. Three pre-existing test-helper failures in
  `test/utils/git.test.ts` and `test/tools/write.test.ts` are fixed in
  passing.

## [1.13.1] - 2026-05-30

### Changed

- Expanded README `Coherence audit` section: multi-repo case promoted to the
  headline, sample output added, transitive staleness defined in plain
  language, GitHub Actions CI snippet added, exit-code table added, CLI flags
  documented separately from `audit.yaml`. No code changes — docs only.

## [1.13.0] - 2026-05-30

### Added

- `daftari audit` CLI subcommand. Scans N markdown repos and reports broken
  cross-repo references and link-graph transitive staleness. Outputs markdown
  (default: stdout) and optional JSON. Exit code 1 if `fail_on.broken_refs` or
  `fail_on.transitive_staleness` thresholds are exceeded. Anonymous repos passed
  via `--repo` get no URL patterns — URL-based cross-refs into them aren't
  detected; use `--config` with an `urls:` block to enable them. See issue #85.

## [1.12.6] - 2026-05-27

### Changed

- **`manifest.json` `description` and `long_description` rewritten to
  lead with the cortex framing.** Brings the `.mcpb` install UI (which
  Claude Desktop shows when a user installs the extension) into sync
  with the Anthropic Connectors Directory listing copy. Previously,
  the listing leads with "an external cortex for AI agents…" while the
  install UI led with "an MCP server that exposes a curated markdown
  vault" — same facts, different framing. Same product describing
  itself two ways was a coherence cost worth paying down.

  - `description` is now the tagline ("A persistent cortex Claude
    reads, writes, and curates over time.") instead of the older
    knowledge-vault opener.
  - `long_description` is the 47-word cortex-led version used in the
    directory listing form (which caps at 50 words). Trims the
    `OPENAI_API_KEY` env-var hint and the `embeddings.provider:
    openai-3-small` config path from the long copy — both still live
    in `PRIVACY.md` and the README for anyone wiring up the OpenAI
    embedding provider.

  No functional change. The `.mcpb` artifact is repacked from this
  commit so the bundled manifest matches what's submitted to the
  directory.

## [1.12.5] - 2026-05-26

### Changed

- **Submission-ready prep for the Anthropic Connectors Directory.** Three
  changes bundled into one release in preparation for desktop-extension
  submission:

  - **Privacy Policy section added to `README.md`.** The Anthropic
    submission policy requires the privacy notice to appear in three
    places: the standalone policy file (`PRIVACY.md`, already present),
    the `manifest.json` `privacy_policies` array (already present), and a
    section in `README.md` (missing until now). The README section
    links to `PRIVACY.md` for the full text.

  - **Frontmatter enum constraints exposed in MCP input schemas (#74).**
    `vault_write`'s `frontmatter` argument was previously typed as a
    generic `object` with a prose description listing required field
    names but not allowed values. Agents discovered the `domain` /
    `status` / `confidence` / `provenance` enum constraints only by
    submitting an invalid value and parsing the rejection message, then
    retrying. The input schema now declares each field as a typed
    property with the proper `enum` constraint sourced from the
    canonical TypeScript constants in `src/frontmatter/types.ts` —
    single source of truth, no drift. MCP clients that introspect tool
    schemas (Claude Desktop does) surface the valid values to the model
    up front, killing the rejection-and-retry round trip.

  - **Tool description audit for prompt-injection patterns.** Read all
    14 tool descriptions against Anthropic's review criteria. None
    instruct Claude to call unrequested software, interfere with other
    tool invocations, pull behavioral instructions externally, contain
    hidden directives, or override system instructions. No changes
    required — sweep documented here for the record.

## [1.12.4] - 2026-05-26

### Fixed

- **MCPB now runs inside Claude Desktop's Electron runtime.** The
  v1.12.0–v1.12.3 `.mcpb`s shipped only **Node** prebuilds of
  `better-sqlite3` (ABI v127 for Node 22, ABI v137 for Node 24). Claude
  Desktop is an Electron app and spawns MCP servers inside its bundled
  Electron Node runtime, where `process.versions.modules` reflects the
  **Electron** ABI (e.g. 145 for Electron 42), not the standalone Node
  ABI. The loader couldn't find a matching binary, and `vault_write`
  / any other call into the SQLite layer failed at first use with
  "Release-win32-x64-145 not found".

  `scripts/pack-mcpb.mjs` now fetches Electron prebuilds in addition to
  Node prebuilds: v140 (Electron 39), v143 (Electron 41), v145
  (Electron 42), each for both `darwin-arm64` and `win32-x64`. Combined
  with the existing Node v127 / v137 binaries, the artifact now ships
  10 `better-sqlite3` binaries covering Node 22, Node 24, and the
  current ~3 Electron majors that Claude Desktop releases plausibly
  target. Sharp and onnxruntime-node are NAPI-based (ABI-stable across
  Node + Electron) so they don't need this treatment; sqlite-vec is a
  loadable SQLite extension, not a Node addon, so it doesn't either.

  Adding support for a future Electron version is now a one-line
  TARGETS table entry — the script fetches the right tarball straight
  from the `better-sqlite3` GitHub release.

## [1.12.3] - 2026-05-26

### Fixed

- **Slimmer MCPB — drops devDependencies from the artifact.**
  Previously, `mcpb pack` packed whatever was in `node_modules`,
  including ~75 MB of devDependencies (typescript, vitest, vite, tsx,
  biome, etc.) and their thousands of transitives. The bloat had two
  real consequences:
  - On Windows, Claude Desktop's extension-upgrade flow recursively
    deletes the prior install. Large file counts hit
    `ENOTEMPTY: directory not empty, rmdir …` races in the rmdir step
    (failure mode reproduced against `picocolors`, a transitive of
    several dev tools), leaving the install half-complete.
  - Pointless download size for every install/upgrade.

  `scripts/pack-mcpb.mjs` now runs `npm prune --omit=dev` after
  `npm run build` and before extracting the win32-specific tarballs.
  The build's TypeScript compilation still has its devDeps available;
  the runtime artifact does not. PR #66 had flagged this as
  out-of-scope at the time.

## [1.12.2] - 2026-05-26

### Fixed

- **MCPB now bundles `sqlite-vec-windows-x64`.** The v1.12.1 `.mcpb`
  shipped fine on macOS but failed on Windows during scaffold /
  reindex with `Cannot find package 'sqlite-vec-windows-x64'`. Same
  root cause as the v1.10.0 sharp / better-sqlite3 problem: `sqlite-vec`
  publishes per-platform binaries as `optionalDependencies`, so a
  darwin-arm64 pack host only installs `sqlite-vec-darwin-arm64`.
  `scripts/pack-mcpb.mjs` now also fetches the
  `sqlite-vec-windows-x64@0.1.9` tarball and extracts `vec0.dll` into
  `node_modules/sqlite-vec-windows-x64/`. No loader patch needed —
  sqlite-vec's own loader resolves the right subpackage via
  `import.meta.resolve()` based on `process.platform` /
  `process.arch`. SQLite extensions are not NAPI / not ABI-bound, so
  one binary per platform covers all Node versions.

## [1.12.1] - 2026-05-26

### Fixed

- **MCPB now runs on Node 24 hosts.** The v1.12.0 `.mcpb` only shipped
  `better-sqlite3` binaries built against Node 22 (ABI v127); on a Node
  24 host (ABI v137) the loader failed with `NODE_MODULE_VERSION`
  mismatch and the server never booted. `scripts/pack-mcpb.mjs` now
  fetches both ABIs for both platforms (4 binaries total: darwin-arm64
  × {v127, v137} + win32-x64 × {v127, v137}) and stages each under
  `build/Release-${platform}-${arch}-${modules}/`. The loader patch in
  `better-sqlite3`'s `lib/database.js` now includes
  `process.versions.modules` in the path, so the right binary is
  selected at runtime for the host's Node version. Sharp and
  onnxruntime-node are NAPI-based (ABI-stable across Node versions)
  and don't need this treatment.

## [1.12.0] - 2026-05-26

### Added

- **Cross-platform MCPB packaging (#66).** The `.mcpb` artifact now
  boots on both macOS (arm64) and Windows (x64). A single universal
  package bundles platform-tagged native binaries for `better-sqlite3`
  (under `build/Release-${platform}-${arch}/`) and `sharp`, and a
  one-line loader patch in `better-sqlite3`'s `lib/database.js`
  selects the right binary at runtime from `process.platform` /
  `process.arch`. The manifest's `compatibility.platforms` is back
  to `["darwin", "win32"]`. `npm run pack:mcpb` (new) builds the
  universal artifact from a darwin-arm64 host.

- **MCP tool annotations.** All 14 tools now carry a `title` and the
  appropriate safety hint — `readOnlyHint` for read/search/analysis
  tools, `destructiveHint` for write and curation tools. MCP clients
  use these to label tools and to decide when to prompt for
  confirmation before a call.

### Fixed

- **`vault_write` no longer rejects writes that omit `updated` /
  `updated_by`.** The server stamps both fields on every write, so requiring
  callers to also supply them was redundant — and a caller who omitted them
  (reasonably) got `invalid frontmatter: updated: missing required field;
  updated_by: missing required field`. The fields are now filled in before
  built-in schema validation runs, then re-stamped post-validation by
  `performWrite` as before. Callers that still supply them keep working — the
  server-side stamp wins, identical to the previous behavior. The MCP input
  schema description now flags both fields as server-managed.

## [1.11.0] - 2026-05-21

### Added

- **`vault_themes` thematic clustering** (#56). New MCP tool surfaces
  thematic clusters across the vault. For each document the tool mean-pools
  its chunk embeddings into one vector, L2-normalises, and clusters the
  resulting per-document set with hand-rolled k-means (k-means++ init,
  Lloyd's iterations). Default behaviour sweeps k ∈ {10, 15, 20, 25} and
  picks the k with the best mean silhouette; an explicit `k` argument
  skips the sweep. Each theme returns a heuristic label (TF-IDF over
  titles + tags — no LLM call), a coherence score (mean pairwise cosine
  inside the cluster — `null` for singleton clusters, where there are no
  pairs to average), representative documents nearest the centroid, the
  most frequent tags, and `secondaryDocs`: documents whose primary
  cluster is elsewhere but whose pooled vector also aligns with this
  theme's centroid (surfaces cross-cutting documents that the hard
  one-doc-one-theme partition would otherwise hide). Optional
  `collection` and `tags` filters scope clustering; RBAC drops documents
  the caller cannot read. Output is deterministic for the same vault
  (fixed seed). No new storage — reads the existing `chunks` /
  `embeddings` tables. v1 is one-doc-one-theme at the partition level
  (`documentCount` still partitions by primary); true multi-theme
  membership, HDBSCAN, seeded-search/coverage mode, and LLM labels are
  deferred.

## [1.10.0] - 2026-05-21

### Added

- **Per-vault process lockfile** (#52). Daftari now acquires
  `.daftari/process.lock` on startup and refuses to share a vault with
  another live daftari process. If a live instance is already holding the
  vault, the new instance sends SIGTERM to the holder, waits up to 3
  seconds for it to exit, then takes over. Stale lockfiles (dead PID, or
  PID recycled to an unrelated process) are overwritten silently. This is
  defense-in-depth against MCP clients that leak server subprocesses on
  timeout/reconnect — the reported symptom was 112 daftari processes
  accumulating against one vault. With the lock, at most one process
  holds the vault at any time.

  **Known limitation:** the takeover interrupts in-flight reindex. On
  first run against a large vault, if the MCP client is in a tight
  retry/respawn loop, the index may be repeatedly aborted before it
  completes. Workaround: run `daftari --vault <path> --reindex` once
  manually from the shell. Resumable reindex is tracked as a follow-up.

## [1.9.1] - 2026-05-21

### Fixed

- **sqlite-vec load error triage** (#46). Extension-load failures now
  surface one of three actionable messages depending on the failure mode:
  MODULE_NOT_FOUND (re-run `npm install` without `--omit=optional`),
  extension loading disabled (rebuild better-sqlite3 from source), or ABI /
  OS error (platform compatibility hint with the OS reason verbatim).

- **sqlite-vec ABI smoke-test** (#48). After `sqliteVec.load()` returns,
  `openIndexDb` now runs a 1-vector KNN roundtrip against a temp virtual
  table. A silent ABI mismatch — where the shared library dlopen'd but the
  SQLite virtual-table machinery is broken — is caught at startup and
  surfaces a `smoke-test` / `ABI mismatch` error instead of corrupting
  vectors at query time.

- **Required `expectedVecDim` in `openIndexDb`** (#47). The optional
  `expectedVecDim` parameter with a silent `?? 384` fallback has been made
  required. Callers that omit the dimension now get a compile-time error
  instead of silently creating a wrong-dimension embeddings_vec table.

- **Embedding dim-mismatch counter in `vault_status`** (#49). `vault_status`
  now includes `embeddingDimMismatches`, a count of rows in the embeddings
  cache whose recorded `dim` does not match the current provider's dimension.
  Non-zero values indicate stale cache rows from a previous provider that
  will be re-embedded on the next reindex.

- **Watcher drain after reindex** (#50). The fs.watch event handler no
  longer busy-polls during a full reindex. Events that arrive while
  `vault_reindex` is running are collected in a deferred map and dispatched
  in a single batch via `onceIndexReady()` after the reindex settles — zero
  extra timer firings per event during a long reindex.

## [1.9.0] - 2026-05-21

### Added

- **fs.watch reactive indexing** (#38, PR 3 of 5). The server now keeps the
  search index in sync with the markdown files at write time, not just at
  startup. A chokidar watcher runs over the vault root after the MCP
  transport is up and the cold-start reindex (if any) has finished;
  `add` / `change` events trigger an `indexDocument()` pass for the
  affected file, and `unlink` evicts the document and patches the
  freshness manifest so the next startup does not see a missing file as
  drift. Events are debounced per-path with a 500ms window — an
  editor's atomic-rename save burst coalesces into one indexer call —
  and `unlink` events re-stat before deleting, so FSEvents / iCloud /
  Dropbox phantom unlink+add pairs during atomic-rename saves are
  treated as a change instead of a delete. Daftari's own writes are
  suppressed from the watcher path: the write-path tools register the
  absolute path after their in-process `indexDocument()` returns, and
  the watcher silently drops the chokidar event that follows. The new
  `watch` config flag (default `true`) lets read-only or scripted
  environments disable the watcher entirely. The startup freshness
  check (manifest mtimes vs disk, see #36) remains as the reconciliation
  backstop for events the watcher drops.

- **Pluggable embedding backend** (#38, PR 4 of 5). The embedding model is
  no longer hard-coded; a new `EmbeddingProvider` interface lets the vault
  owner choose between two backends in `.daftari/config.yaml`:

  ```yaml
  embeddings:
    provider: local-minilm   # default. Other values: openai-3-small.
  ```

  - **`local-minilm`** (default, 384-dim) is the existing
    `all-MiniLM-L6-v2` path run via `@huggingface/transformers` — free,
    fully local, slow on cold-start.
  - **`openai-3-small`** (1536-dim) calls OpenAI's `text-embedding-3-small`
    endpoint. ~10x faster on large vaults but paid. Requires
    `OPENAI_API_KEY` in the server's environment; a missing key is a hard
    config error at startup, not a silent fallback. Batches at 96 inputs
    per request with exponential backoff on 429 / 5xx (up to 3 retries).

  The `embeddings` table gains a `dim` column (schema bump 3 → 4) as
  defense-in-depth against a corrupt or cross-provider mix. The schema
  bump rebuilds the index cleanly — derived from the markdown files, no
  manual migration needed. Switching providers between server runs is
  safe: the `(content_hash, model)` composite PK lets both providers'
  rows coexist, and the new provider's first reindex naturally populates
  its own row set without re-embedding under the old id.

### Changed

- **SQL-native search via FTS5 and sqlite-vec** (#38, PR 5 of 5 — closes
  the #38 unbundle). The hand-rolled BM25 ranker (a JavaScript scan over
  a JSON tokens column) and the brute-force JavaScript cosine loop are
  both gone; lexical search now runs through an FTS5 virtual table
  (`documents_fts`) and vector search through a sqlite-vec `vec0`
  virtual table (`embeddings_vec`). Both halves are one prepared
  statement; SQLite's built-in BM25 ranks FTS5 matches, sqlite-vec's
  cosine KNN ranks vector matches. AFTER INSERT / UPDATE / DELETE
  triggers on the `documents` table keep the FTS5 mirror in sync — the
  indexer never writes to the virtual table directly. Schema bumped
  4 → 5; the index is a derived cache so the bump triggers a clean
  rebuild from the markdown files. The vec table is sized at the active
  embedding provider's dim and rebuilt on provider switch (the durable
  `embeddings` cache is per-`(content_hash, model)` and survives the
  vec-table rebuild, so a switch back to the previous provider is all
  cache hits). New dependency: `sqlite-vec`. New prerequisite:
  `better-sqlite3` with extension loading enabled — the npm prebuilt
  has it on by default, so `npm install` is the only setup step in the
  common case; a custom build with it disabled is a hard startup error
  with actionable text (`npm rebuild better-sqlite3 --build-from-source`).
  This is the final follow-up in the #38 unbundle; v1.9.0 ships as a
  grouped release covering all five.

- **Lazy embedding model load with background warm-up** (#38, PR 2 of 5).
  The MiniLM embedding model no longer loads at server startup. With the
  v1.8.0 content-addressed cache, a startup whose freshness manifest matches
  disk skips the reindex pass, and a reindex whose chunk hashes are all
  cached skips `embed()` entirely — so the model load (~100MB, ~500ms cold)
  is now deferred until something actually needs to embed. A read-only role
  that only calls `vault_read` / `vault_search` against a fully-cached
  index never loads the model at all. After the MCP transport opens and the
  freshness check / background reindex begins, the server kicks off a
  `warmModel()` in a `void` background promise so the first user search
  does not pay the cold-start cost. A warm-up failure (no network on the
  first run, model download blocked) is logged to stderr but never crashes
  the server — the next `embed()` call retries. The warm-up is gated by a
  new optional `warm_embeddings` flag in `.daftari/config.yaml` (default
  `true`); set it to `false` for read-only deployments or memory-constrained
  environments. The transport-open-before-indexing ordering from v1.7.1
  is preserved — no startup hang regression. A new `modelStatus` field on
  the in-process `IndexState` (`cold` / `warming` / `ready` / `error`) lets
  tools surface "embeddings warming" context when a client retries against
  a warming model rather than misreporting an indexing pass.

## [1.8.0] - 2026-05-20

### Changed

- **Content-addressed embedding cache** (#38, PR #39). Embeddings are no
  longer keyed by `(path, chunk_index)` — they now live in a separate
  `embeddings` table keyed by `(content_hash, model)`, where
  `content_hash` is the SHA-256 of the chunk's text. `chunks` rows carry
  a `content_hash` column and join to `embeddings` for the current model.
  A reindex now hashes every chunk, asks the cache which hashes already
  have a row, and only embeds the misses — so the cost of a reindex
  scales with the number of *changed chunks*, not the size of the vault.
  An edit to one paragraph re-embeds one chunk; a rename re-embeds zero;
  a paragraph moved verbatim to another file re-embeds zero. The
  composite primary key on `(content_hash, model)` is intentional: a
  future model migration can keep both the old and new model's
  embeddings present under the same hash. After writing chunks, the
  reindex runs an internal `vault_gc` step that drops embeddings rows
  whose `content_hash` is no longer referenced by any chunk, so the
  cache does not accumulate orphans. `index.db` rebuilds cleanly on the
  schema bump (the index is a derived cache); the first reindex after
  upgrade is a one-time full embed that populates the cache, and every
  reindex after that is incremental. This is PR 1 of the #38 unbundle;
  fs.watch reactive indexing, lazy model load, FTS5, sqlite-vec, and
  pluggable embedding backends are tracked as separate follow-ups.

## [1.7.1] - 2026-05-19

### Fixed

- **MCP server hang at startup** (#35, PR #36). The server no longer re-embeds
  the entire vault on every launch and no longer waits for indexing to finish
  before opening the stdio transport. Three compounding bugs are fixed:
  (1) `main()` always called `reindexVault` even when `.daftari/index.db`
  already reflected the files on disk — every restart re-embedded the whole
  vault (~25 minutes on a 3,500-file vault); now a path→mtime manifest is
  persisted in the SQLite meta table and compared on startup, so an
  unchanged vault skips the embedding pass entirely. (2) The
  `StdioServerTransport` opened only after indexing completed, so MCP
  clients could not answer `initialize` for the whole duration; the
  transport now opens first and indexing — when required — runs as a
  background task. (3) Progress was emitted only on TTY stderr, leaving
  every real (non-TTY) MCP client with zero output during a cold start;
  progress now streams on stderr in both TTY (\\r-updated) and pipe (full
  line every ~5%) modes. A new in-process `IndexState`
  (`ready`/`indexing`/`error` + progress) gates `vault_search`,
  `vault_search_related`, `vault_reindex`, `vault_write`, `vault_append`,
  `vault_promote`, and `vault_deprecate` while indexing — those tools
  return a progress-bearing busy error so clients can retry. Read tools
  (`vault_read`, `vault_index`, `vault_status`) are unaffected because
  they go to the filesystem, not the index. `--reindex` remains the one
  synchronous mode (rebuild, exit).

## [1.7.0] - 2026-05-19

### Added

- **Pre-write transform hooks** (#32). New `pre_write_transform` hook phase
  runs before `validateFrontmatter` and can derive or override frontmatter
  fields. Returns `Partial<Frontmatter>`. Refuses via throw. Existing
  `pre_write` validators continue to run unchanged after validation. Closes
  the gap where v1.6.0 hooks could observe and reject but could not derive
  built-in fields. Declared under `hooks.pre_write_transform` in
  `.daftari/config.yaml`; the runner merges each hook's patch Object.assign
  style — shallow, last-writer-wins. Phase order is rigid:
  `pre_write_transform` (declaration order), then `validateFrontmatter`, then
  `pre_write` (declaration order), regardless of config layout. Fires for
  `vault_write` and `vault_append`; `vault_promote` and `vault_deprecate`
  bypass it, matching the `pre_write` bypass.

### Changed

- The existing `pre_write` hook surface continues to half-mutate: a mutation
  to `rawFrontmatter` inside a `pre_write` hook propagates for extension
  fields but not for built-in fields. This behavior is preserved for
  backward compatibility but is now implementation detail — new mutations
  should use `pre_write_transform`.

## [1.6.0] - 2026-05-19

### Added

- **Pre-write validation hooks** (#29, PR #30). Vault owners can register ES
  module hooks in `.daftari/config.yaml` under `hooks.pre_write`. Each hook
  exports a default function `(frontmatter, context) => ValidationIssue[]` and
  runs before the write completes; any returned issue blocks the write,
  matching the existing built-in schema-validation contract. Hooks fire for
  `vault_write` (create + update) and `vault_append`; `vault_promote` and
  `vault_deprecate` intentionally bypass them — those are narrow,
  server-controlled metadata mutations, not user-authored content. Run-all
  ordering: every declared hook runs even if an earlier one returned issues,
  and the caller gets one consolidated issue list. Loud failure mode: a hook
  throw becomes a synthetic blocking issue tagged with the hook path; a
  non-array return or a malformed issue object is also a synthetic blocking
  issue. Hooks load via ESM dynamic import with vault-root-relative paths
  only — absolute paths and `..` escapes are rejected. Unrecognised keys
  under `hooks:` are loud config errors so future surfaces (`pre_read`,
  `post_write`) can't be silently shadowed by typos. Validate-only in v1;
  mutation is a deliberate follow-up. Trust model documented in the README:
  hooks run in-process with full host capability, so vault owner is
  responsible for the contents of `.daftari/hooks/`.

### Changed

- **Hook loader busts the ESM module cache on each call** so hot-edits to a
  hook file are picked up on the next write without a server restart. The
  loader appends a `?t=<mtimeMs>` suffix to the import URL; the suffix
  changes only when the file changes, so unchanged hooks still hit the
  cache.

## [1.5.1] - 2026-05-18

### Fixed

- **Reindex no longer exhausts memory on mid-sized vaults** (#25). `reindexVault`
  embedded every chunk across the whole vault in a single model call, which
  padded the batch to its longest sequence and allocated activation tensors
  proportional to the total chunk count — so peak memory scaled with vault
  size. Past ~200 documents the allocation exceeded RAM and the process
  stalled in a GC/swap death spiral with no output. Embedding now runs in
  fixed-size sub-batches, keeping peak memory flat regardless of vault size
  (a 600-chunk embed dropped from ~3.5 GB to ~325 MB peak RSS).
- **Reindex reports progress instead of running silent.** On an interactive
  terminal, `--reindex` now prints a single-line `embedding N/M chunks`
  counter, so a large-vault reindex can be distinguished from a hang.

## [1.5.0] - 2026-05-18

### Added

- **`auto_commit` opt-out for the write path** (#22). A vault can set
  `auto_commit: false` in `.daftari/config.yaml` to suppress the auto-commit
  step on `vault_write` / `vault_append` / `vault_promote` / `vault_deprecate`.
  The file is still written, indexed, and provenance-logged; only the git
  commit is skipped, so the caller owns staging and committing. This lets a
  vault nested inside a larger repo defer to that repo's branching and PR
  workflow. `WriteResult` now reports `committed` (boolean) and `commit` is
  `null` when no commit was made. Backward compatible — `auto_commit` defaults
  to `true`, the behavior shipped today.

### Fixed

- The scaffolded `.gitignore` now excludes `.daftari/curation-log.jsonl`. The
  provenance log was always documented as local, git-ignored audit state but
  was never actually listed in the ignore file. This matters most for
  `auto_commit: false` vaults nested in a larger repo, where the unignored log
  would otherwise churn the host repo's `git status` on every write.

## [1.4.0] - 2026-05-18

### Added

- **Config-driven schema extensions for domain-specific frontmatter** (#19).
  Vaults can declare typed extension fields in a `schema_extensions` block of
  `.daftari/config.yaml` — `string` (with an optional regex `pattern`), `date`,
  `number`, `boolean`, `array<string>`, and `enum`, each optionally `required`
  or carrying a `default`. Extensions participate in `vault_write` validation
  and serialize after the built-in fields in stable config declaration order.
  Malformed extension declarations fail config load loudly, matching the RBAC
  config contract. Backward compatible — vaults with no `schema_extensions`
  block behave exactly as before. See
  [docs/schema-extensions.md](docs/schema-extensions.md).

## [1.3.0] - 2026-05-18

### Added

- **Optimistic concurrency for the write path** — `vault_read` now returns a
  `version` token (the SHA-256 of the file as read), and the write tools
  (`vault_write`, `vault_append`, `vault_promote`, `vault_deprecate`) accept an
  optional `base_version`. When supplied, the server re-hashes the file inside
  the write lock and rejects the write with a `stale write:` error if it no
  longer matches — closing the stale-write gap the file lock could not catch.
  Rejected stale writes are recorded in the provenance log with a
  `rejected_stale` action. Omitting `base_version` preserves last-write-wins
  behavior, so the change is fully backward compatible. (#14)

## [1.2.0] - 2026-05-17

### Added

- **Structured epistemic-surface fields** — `questions_answered` and
  `questions_raised` are now optional frontmatter array fields, making the
  Questions Answered / Questions Raised convention tool-queryable. `vault_index`
  gains a `has_unanswered` filter and returns each document's questions;
  `vault_lint` gains a sixth check, `unansweredQuestions`, that flags a question
  raised in one document but answered in none. Additive and optional — vaults
  and callers without the fields are unaffected, and the `--init` scaffold now
  seeds the fields in its example documents. (#15)
- **`docs/worked-example.md`** — a three-write walkthrough showing compilation
  over retrieval: one document maturing from draft to canonical, contrasted
  with RAG. (#13)
- **`docs/curation-workflow.md`** — the reference curation loop: how an agent
  should act on `vault_lint` output instead of letting it accumulate. (#17)
- **README "Search internals" section** — documents the hybrid-search embedding
  model (`all-MiniLM-L6-v2`, 384-dim, run locally with no embedding API and no
  API key) and the BM25-only fallback. (#11)
- **README etymology line** — "Daftari" glossed from دفتر. (#12)

### Changed

- **Layer 3 reframed from "write arbitration" to "write safety"** — the README
  and architecture doc now describe what is shipped (single-writer-per-file
  safety) rather than implying multi-agent write coordination. Adds a "Known
  limitations" subsection and points at optimistic concurrency (#14) as the v2
  direction. (#16)

## [1.1.1] - 2026-05-17

### Fixed

- **CLI silently no-opped when invoked via a symlink** — `npx daftari`,
  `npm i -g daftari`, and any `node_modules/.bin/daftari` shim launch the CLI
  through a symlinked launcher. The entry-point guard compared `import.meta.url`
  against `process.argv[1]` without resolving symlinks, so the check never
  matched and the installed `daftari` command exited 0 having done nothing —
  the `npx daftari --init` Quickstart included. Both sides are now resolved
  with `realpathSync` before comparing.

## [1.1.0] - 2026-05-17

### Added

- **Inline decay surfacing** — `vault_read` and `vault_search` responses now
  carry a `decay` assessment, so an agent cannot silently trust knowledge that
  has decayed. A new `computeDecay` derives a per-document decay state —
  `deprecated`, `warn`, or `aging` — from frontmatter; a warning banner is
  rendered for `warn` and `deprecated` documents and withheld for healthy or
  merely `aging` ones (the scarcity rule). The banner is never written into a
  document's body. The search index gained `ttl_days`, `created`, and
  `superseded_by` columns, with schema versioning to rebuild on a schema change.

## [1.0.0] - 2026-05-17

First public release. Daftari is an MCP server that exposes a curated markdown
vault to AI agents, exposing 13 tools over stdio.

### Added

- **Read path** — `vault_read`, `vault_index`, and `vault_status` for reading
  documents, listing them by collection/status/domain/tags, and reporting vault
  health (file counts, invalid frontmatter, staleness distribution, unresolved
  tensions, recent writes).
- **Hybrid search** — `vault_search`, `vault_search_related`, and
  `vault_reindex`. BM25 lexical ranking fused with vector semantic similarity,
  with tunable weights and graceful fallback to lexical-only when embeddings are
  unavailable.
- **Write path** — `vault_write`, `vault_append`, `vault_promote`, and
  `vault_deprecate`. File-level write locks (SQLite-backed, 60-second TTL),
  every write auto-committed to git, and a provenance log of who wrote what.
- **Curation engine** — `vault_lint`, `vault_tension_log`, and
  `vault_provenance`. Advisory TTL-based staleness detection, contradiction
  (tension) logging, lint checks, and per-document write history. Reports
  problems; does not auto-fix.
- **Config-driven RBAC** — roles and per-collection read/write/promote
  permissions declared in `.daftari/config.yaml`; enforced across every tool.
  Unknown or absent roles fall back to a deny-all guest.
- **CLI** — `daftari --init` scaffolds a new vault (collections, RBAC config,
  example documents, git history, search index); `daftari --vault` serves it.
- 160 tests covering all 13 tools and their supporting modules.

[1.5.1]: https://github.com/mavaali/daftari/releases/tag/v1.5.1
[1.4.0]: https://github.com/mavaali/daftari/releases/tag/v1.4.0
[1.1.1]: https://github.com/mavaali/daftari/releases/tag/v1.1.1
[1.1.0]: https://github.com/mavaali/daftari/releases/tag/v1.1.0
[1.0.0]: https://github.com/mavaali/daftari/releases/tag/v1.0.0
