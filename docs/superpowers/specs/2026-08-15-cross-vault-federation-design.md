# Read-only cross-vault federation — design

2026-08-15. Status: **proposed — awaiting Mihir's review; implementation not
started.**
Issue: #297 (read-only cross-vault federation). Strategy pass run against the
2026-07-14 existence-disclosure spec, the 2026-07-20 server-mode spec
(Decisions 2–4), the 2026-08-08 slice-3 lock verdict, and the 2026-07-26
retrieval-fusion spec.

## Why

A daftari vault is an isolated brain: it can never reference another vault.
This is a named complaint against Obsidian MCP servers generally, and Basic
Memory — the closest competitor — already ships multi-project workflows with
cross-project reads.

The direction from #297, which this spec keeps intact: one canonical
**writable** vault per process (the per-vault process lock and
one-identity-per-process model unchanged), plus N **referenced** vaults
mounted read-only. Reads and search may span referenced vaults, labeled by
vault; writes, locks, the index, and git auto-commit apply only to the local
canonical vault. No cross-vault edges in v1; no sync between vaults —
federation is read composition, not replication.

Nothing here contradicts a standing invariant, but three places need explicit
composition work rather than silent extension:

1. The 2026-07-14 per-surface dispositions do **not** transfer wholesale to
   referenced vaults. Disposition C — unfiltered vault-global lint
   aggregates — was justified as *the operator's own vault's* health view and
   must not be extended to a vault the caller is a guest in (Decisions 2
   and 7).
2. `src/hooks/` loads vault-supplied executable modules. Mounts must
   explicitly exclude it or federation becomes a code-execution vector
   (Decision 1).
3. `docs/architecture.md`'s "started against one vault directory" sentence
   needs amending. The invariant that survives is *one writable vault, one
   process lock, one identity* — not one directory (Decision 8).

The organizing principle, used throughout: **federation is read composition
over sovereign vaults.** Each vault keeps its own policy; its derived state
stays private; the canonical process pays the full cost of its own view — its
own index, its own embeddings, its own staleness — rather than borrowing the
referenced vault's.

## Decision 1 — configuration and mounting: config-only, fail-loud, non-transitive

Mounts are declared in the **canonical** vault's `.daftari/config.yaml`:

```yaml
federation:
  mounts:
    - alias: research          # ^[a-z][a-z0-9_-]{1,31}$ — min 2 chars (Decision 5); "local" reserved
      path: ../research-vault  # relative to vault root or absolute; realpath'd at load
      index: full              # full | lexical (lexical skips embeddings); default full
      optional: false          # default false
```

**Config-only; no `--mount` CLI flag.** RBAC is config-driven by house rule,
and the mount set *is* policy — it determines what the identity can see and
what gets indexed. An ephemeral flag invites per-session mount drift and a
cold-index cost per invocation, and would need serve parity later. Rejected:
`--mount alias=path` for ad-hoc exploration — revisit only if a real
"peek at a vault once" workflow shows up; the workaround (add the mount,
remove it) is one config edit.

**Startup validation fails loud** (the malformed-RBAC precedent). All of the
following are startup errors: duplicate or reserved aliases; a mount path
that realpath-resolves into the canonical vault, or vice versa — nesting in
either direction; the same real path mounted twice; a mount directory with no
`.daftari/config.yaml`. That last one matters: a directory without a config
is not a daftari vault, there is no policy to govern reads of it, and
deny-all-guest would make the mount silently useless. Error copy:

> `mount "research": /path is not a daftari vault (no .daftari/config.yaml) — run daftari --init there, or remove the mount`

**Missing path: error by default; `optional: true` to degrade.** A required
mount whose path is absent refuses startup. `optional: true` is the explicit
operator acknowledgment — the `shadow_mode` / `transport_security` precedent:
a consequential degrade must be chosen, never backed into. An unavailable
optional mount reports `state: "unavailable"` in `vault_status` and
contributes nothing.

**Mounts are not transitive.** A referenced vault's own `federation` block is
ignored. Chained mounts multiply every question in this spec — identity
mapping through two hops, index cost, cycles — for no named need.

**From the referenced vault's config, the mounting process reads exactly two
things:** the policy surface (`roles` plus the new `federation.principals`
block, Decision 2) and `schema_extensions` (for Decision 5's validation
report). Everything else — `hooks`, `server`, `embeddings`, `lint_voice`,
`watch` — is ignored. The hooks exclusion is load-bearing security, not
tidiness: loading vault-supplied modules from a mounted vault would execute
foreign code in the canonical process. This is a MUST NOT with a test.

## Decision 2 — identity and RBAC: the referenced vault grants by principal, deny-all-guest default

The process runs as one `--user` / `--role` (`AccessContext`,
`src/access/rbac.ts`). The referenced vault's **own** config decides what
that identity sees of it:

```yaml
# in the REFERENCED vault's .daftari/config.yaml
federation:
  principals:
    "human:mihir":         { role: researcher }   # a role defined in THIS vault's roles
    "agent:curation-loop": { role: guest }        # explicit deny also expressible
```

Grants are keyed on the authenticated `user` string and resolve to a role
named in the referenced vault's own `roles`. This is exactly the shape of the
serve-mode token/OAuth subject mapping (`OAuthSubjectConfig`,
2026-07-20 Decision 2): identity is declared, the local policy file maps it,
no user-management system appears.

Rejected: **same-role-name lookup in the remote config** — role names are
vault-local vocabulary; vault B's `analyst` granting vault A's `analyst` by
name collision is access by coincidence. Rejected: **grants declared in the
canonical vault's config** — that inverts sovereignty and violates #297's own
constraint ("a referenced vault's config governs what this process's role may
see of it").

**Unmapped principal ⇒ guest ⇒ deny-all** (the standing `resolveAccess`
semantics: unknown is denied, never granted). The mount then contributes
nothing to any result — which, under omission, is indistinguishable from an
empty vault. That indistinguishability is *correct* (it is the
no-existence-leak property working), but it is also the misconfiguration
trap, so startup emits an **operator-facing stderr notice** — never tool
output:

> `mount "research" resolved to guest (deny-all): add a federation.principals entry for "human:mihir" in ../research-vault/.daftari/config.yaml`

The operator's own stderr is not a disclosure surface; tool results are.

This is deliberately the **opposite** posture from the serve-mode precedent
this section otherwise borrows, and the difference must be stated, not
assumed. 2026-07-20 Decision 2 (Phase 2 OAuth) rejects an
authenticated-but-unmapped subject with a 403 — "never a guest session and
never an implicit default role" — because there the mapping gap sits on a
**live auth surface**: a remote caller has presented credentials and is
about to receive a session whose tool list alone is a probe surface.
Federation's unmapped principal has no analogous request to reject. The
process *belongs to* the unmapped principal — the operator launched it,
declared the mount in their own config, and is not an adversary probing
someone else's server; the guest resolution exposes no session, no tool
list, and (under omission) no observable difference from an empty grant.
The 403-analog here would be refusing startup, and that is rejected on
sovereignty grounds cutting the other way: it would make the canonical
process's ability to *boot* contingent on a foreign vault's policy file,
and pressure referenced-vault owners into granting something just to
unblock a neighbor's startup. Deny-all-plus-stderr keeps the referenced
vault's policy sovereign over its content while keeping the canonical
process sovereign over its own lifecycle. A config error surfaces to the
operator; a live credential never silently downgrades — the two specs are
answering different threats.

**Only the granted role's `read` list is consulted.** `write` / `promote` /
`ratify` bits are ignored (warn at startup if set — confusing, not
dangerous). The mount is read-only structurally (Decisions 3 and 5), not by
role configuration.

**Existence-disclosure composition.** Three rulings:

1. *Vault labels do not leak.* The mount set is declared in the canonical
   config — the caller's own file. Interleaved results labeled
   `vault: research` disclose nothing the caller didn't write down
   themselves. This holds precisely because v1 is stdio-only, one identity
   per process; under serve, mounts would be shared across bearers and this
   ruling would need re-derivation. That is a stated reason for the serve
   deferral (Decision 8), not an accident.
2. *Within each vault, plain omission (2026-07-14 disposition A) under that
   vault's own policy.* Search results, index listings, and status counts
   for a referenced vault are computed over the readable subset only. No
   `visible/total` splits, no coarsened remainders — those exist only on
   blast surfaces, which are not federated (Decision 7), so **v1 introduces
   no new coarsening surface**.
3. *Disposition C does not transfer.* Vault-global unfiltered aggregates
   were accepted for `vault_lint` because lint is the operator's health view
   of their own vault. A referenced vault's "global counts" sliced for a
   guest-mapped principal are exactly the access-boundary-sliced aggregate
   the 2026-07-14 spec rejected. Hence lint stays canonical-only
   (Decision 7), and referenced-vault counts anywhere (status, index) are
   readable-subset counts.

Stated honestly: federation RBAC is **policy for agents, not a security
boundary against the operator** — anyone with filesystem access can `cat` the
mounted files. Same stance stdio RBAC has always taken.

## Decision 3 — process lock and derived state: no lock taken, nothing ever written under the referenced root

**A read-only mount takes no process lock and respects none.** The process
lock is admission control for *holding* a vault — serializing index rebuilds,
git commits, jsonl id allocation (2026-08-08 §1.3). A federated reader does
none of those to the referenced vault; it reads markdown files, which is
exactly what any editor, `grep`, or human does today without asking. A
referenced vault concurrently held live by its own daftari process (stdio or
serve) is therefore **fine and expected** — no SIGTERM, no refusal, no
interaction with the precedence matrix. 2026-07-20 Decision 4 is untouched.

**Nothing is ever created, opened-for-write, or mmap'd under the referenced
vault's directory.** This rules out more than the obvious:

- No `.daftari/index.db` build there — obviously.
- **No opening the referenced vault's existing `index.db`, even read-only.**
  Opening a WAL-mode SQLite database requires the `-shm` sidecar, so a
  "read-only" open can create or modify files in their `.daftari/` — a write
  into someone else's vault by a process that promised not to. Beyond
  mechanics: that index is another process's ephemeral private state,
  schema-versioned, possibly mid-drop-and-rebuild (the empty-index fallback
  triggers a full `reindexVault`). A layer-boundary violation and a
  corruption hazard in one. Rejected despite being the zero-cost-index
  option.

**Referenced-vault indexes live in the canonical vault's
`.daftari/federation/<alias>/index.db`** — one separate DB file per mount,
git-ignored, ephemeral, rebuilt from that mount's markdown at any time. "The
index is ephemeral" holds per vault by construction. Rejected: (a)
namespacing rows inside the canonical `index.db` — a single FTS table over
mixed corpora poisons BM25 document-frequency statistics across vaults,
complicates per-vault ACL pushdown, and makes per-mount drop-and-rebuild
impossible without table surgery; (b) a per-user cache dir — adds a
path-resolution and cleanup surface for no gain; the canonical `.daftari/` is
already the home for exactly this class of derived state, and it sits inside
the canonical process lock's admission domain.

**Embeddings: the canonical process embeds every mount with its OWN
provider.** The referenced vault's `embeddings.provider` is not honored —
their config governs *visibility*, not the format of *our* cache. This keeps
one provider and one dimension per process, and (Decision 4) dissolves the
issue's cross-provider fusion question. Cost control: `index: lexical` per
mount skips embedding entirely — search degrades to lexical for that vault
via the existing missing-embeddings degrade path; embedding stays
lazy/background as today.

[HYPOTHESIS] Cold-embed cost of large mounts is the adoption risk — the
architecture doc's own "disposability you can't afford" warning, multiplied
by N. Kill condition: if real mounts routinely take >30 minutes to first
vector search, promote a cross-mount shared content-addressed embedding cache
(the `(content_hash, model)` key already supports it) from deferred
optimization to required.

Concurrent writes to the mounted vault — by its own daftari, or a human —
while we read: accepted as eventual consistency, the same class as an editor
racing the canonical watcher. Freshness handling is Decision 6.

## Decision 4 — search: per-vault hybrid ranking, RRF across vaults, post-passes per-vault

**Run the existing hybrid pipeline per vault, unchanged,** against that
vault's own index and that vault's own readable-collection set (the ACL
vec-scan pushdown of the 2026-07-26 fusion spec becomes per-mount for free,
since each mount has its own vec table). Each vault yields an RBAC-filtered
ranked list; the lexical tiered-band invariant stays where it lives today —
inside each vault's lexical list.

**Fuse across vaults with RRF over the per-vault final rank lists**
(`k = 60`, equal per-vault weight 1.0, canonical vault wins exact ties for
determinism). Rationale: BM25 magnitudes are incomparable across corpora —
different IDF statistics — so score normalization across vaults is the exact
fragile pattern the 2026-07-26 spec killed *within* one vault. Rank fusion
consumes only orderings, and is indifferent to whether that spec's
intra-vault RRF has landed yet (it is status *proposed*): cross-vault RRF
composes with either the current normalize-and-sum or a future RRF
intra-vault ranking. And because Decision 3 fixed one embedding provider per
process, there is no cross-provider score problem left to solve — **the
issue's second open question is dissolved by construction, not answered by
fusion math.**

[HYPOTHESIS] Equal-weight RRF over vaults of very different sizes
over-represents small mounts (rank 1 in a 10-doc vault is cheap). Kill
condition: recall-bench or eval evidence that mount hits displace better
canonical hits on real queries; the remedy is per-mount RRF weights in the
`federation.mounts` entry, which the config shape can grow without breakage.

**Post-passes run per-vault, before fusion.** The coverage pass queries one
index by tag + `created`-window, so it is per-vault by construction; each
vault applies the existing caps. Current-source foregrounding walks
`superseded_by`, which is vault-local by #297's no-cross-vault-edges
constraint, so chains never cross a mount boundary; the `restricted` degrade
for an unreadable hop applies within each vault's own policy exactly as
today. No global post-pass exists in v1 because no cross-vault edge exists to
power one.

`vault_search` gains an optional `vaults: string[]` scope parameter (aliases;
`"local"` = canonical; default = local + all mounts). The router/weights
machinery is per-query, not per-vault — untouched.

## Decision 5 — tool surface: six tools federate; everything else refuses with uniform copy

**Path namespacing.** A referenced-vault document is addressed as
`<alias>:<relPath>` — e.g. `research:notes/pricing.md`. Canonical-vault paths
stay **unprefixed**: full backward compatibility, every existing agent
transcript keeps working.

Collision safety is **enforced, not assumed**. `:` is a legal filename
character on POSIX (only Windows forbids it), and `canonicalRel`
(`src/utils/paths.ts`) does no character validation — so a canonical vault
can already contain a file named `notes:pricing.md`. Dispatch is therefore
defined without any filesystem assumption: a path is parsed as federated
**only when the text before its first `:` exactly matches a declared mount
alias**; any other `:`-containing path stays a plain canonical path. That
leaves exactly one ambiguous shape — a canonical file whose name begins with
a declared alias plus `:` — and two fail-loud guards exclude it by
construction:

1. **Mount-time validation.** Startup (and reindex) fails if any
   canonical-vault path begins with `<alias>:` for a declared alias. Error
   copy: `mount "research": canonical vault contains "research:notes.md",
   which shadows the mount's path prefix — rename the file or the alias`.
   The scan is against declared aliases only, so ordinary `:`-containing
   POSIX filenames remain untouched.
2. **Write-time guard.** While federation is configured, creating a
   canonical file at a caller-chosen path refuses a path that begins with a
   declared alias plus `:`. The guard lives in the shared write-path
   resolution, not in any one tool, because `vault_write`'s create branch is
   not the only creator: `vault_merge` writes its `target_path` through its
   own multi-file write-set and falls through to *create* the target when
   it does not yet exist. Both create sites are guarded (and any future
   create-at-caller-chosen-path tool inherits the guard by construction),
   so the collision cannot be introduced after startup either.

Rejected: banning `:` in vault paths outright — a breaking change for
existing POSIX vaults with such filenames, disproportionate to a collision
that only exists against declared aliases. Rejected: a heavier URI-style
encoding (`alias://path`) — uglier in transcripts for a problem the two
guards already close. The alias grammar's 2-character minimum still rules
out `c:`-style drive-letter ambiguity on Windows.

**Round-trip property (normative): any path a federated tool returns is
directly usable as the path argument to any federated read tool.** Every
result hit additionally carries an explicit `vault: "<alias>" | "local"`
field — the label #297 asks for — so agents don't parse prefixes.

Federation-aware in v1 (six):

| Tool | Behavior |
|---|---|
| `vault_search` | Decision 4. Hits labeled by vault; referenced hits' `path` is the prefixed id. |
| `vault_search_related` | Seed may be any vault's doc; candidate pool spans scope. Coherent only because of the one-provider decision (Decision 3). Static weights, as today. |
| `vault_read` | Full read of an `alias:` path: gated on the mapped role's `canRead` for that collection under the *referenced* vault's policy; frontmatter validation report computed against the *referenced* vault's `schema_extensions` (advisory, as always); `version` token still returned (it is just a hash); `currentSource` walk stays inside that vault. |
| `vault_index` | Optional `vault` param; listings per vault, omission per that vault's policy. |
| `vault_status` | Gains a `federation` block: per mount `alias`, `state: "ok" \| "unavailable" \| "indexing"`, readable-subset doc count, last-refresh timestamp. Never unfiltered counts (Decision 2, ruling 3). |
| `vault_reindex` | Optional `vault: <alias>` rebuilds one mount's index under `.daftari/federation/`; default remains canonical-only. Also the manual freshness lever (Decision 6). |

**Everything else refuses a prefixed path.** The six tools above are a
**closed allowlist**; every other registered tool — current or future —
refuses a federated target, and each is assigned exactly one of two uniform
error strings. The classification is exhaustive and mutually exclusive at
spec time (no wildcards, no "and kin"), and it is enforced structurally: a
registry guard test walks the tool registry and fails if any tool is
neither in the federation allowlist nor assigned a refusal class, so a new
tool cannot ship with undefined federated-path behavior. The copy is
load-bearing:

- **Write-shaped tools** — anything that mutates documents, vault state, or
  records a verdict: `vault_write`, `vault_append`, `vault_promote`,
  `vault_deprecate`, `vault_supersede`, `vault_merge`,
  `vault_set_confidence`, `vault_set_tier`, `vault_assert`,
  `vault_consolidate`, `vault_stage_action`, `vault_ratify`,
  `vault_tension_log`, `vault_tension_resolve`, `vault_edge_observe`,
  `vault_edge_contest`, `vault_tier2_verdict` (it records verdicts and can
  log tensions — write-shaped despite the read-sounding name). Write locks
  and anchor/pin/repin are not separately registered tools — they are
  sub-operations of the write tools above (`src/access/locks.ts` and
  `src/tools/anchors.ts`/`pin-mint.ts`/`repin.ts` export helpers, not
  registry entries) — so they are covered because their host tools refuse
  first, and the registry guard test classifies registered tools only:

  > `federated mount is read-only: "research:notes/pricing.md" — writes apply only to the local vault`

- **Vault-state read tools** — anything that reads the referenced
  `.daftari/` state or curation/graph surfaces rather than documents:
  `vault_provenance`, `vault_edges`, `vault_tension_clusters`,
  `vault_tension_blast`, `vault_tension_triage` (the tension *reads* —
  `vault_tension_log`/`vault_tension_resolve` are write-shaped, above),
  `vault_positions`, `vault_backlinks`, `vault_themes`, `vault_lint`,
  `vault_canon`, `vault_consumes`, `vault_receipt`, `vault_staleness`,
  `vault_witness`, `vault_tier1`, `vault_tier2_queue`:

  > `vault state (tensions, edges, provenance, positions, curation and graph surfaces) is not federated in v1 — mounts expose documents only`

That second line is the crisp v1 boundary, stated as principle: **a mount
exposes documents, not vault state.** Markdown bodies and frontmatter cross
the boundary; everything under the referenced `.daftari/` — tension log,
edges.jsonl, provenance log, staged actions, positions machinery — does not,
except the two config surfaces named in Decision 1. This single rule answers
the provenance/tensions/backlinks questions uniformly instead of per-tool,
and it is what keeps v1 from re-opening the 2026-07-14 per-surface analysis
for a second vault's disclosure-sensitive state.

Forward note, not a v1 requirement: `src/fence/` (nonce-framed ingestion of
less-trusted material) has no call sites yet; referenced-vault content is the
natural first customer when it gets them — a mounted vault is by definition
material the canonical operator does not curate.

## Decision 6 — freshness: startup-only in v1; no watchers on mounts

Answering #297's first open question: **startup-only.** At startup each mount
runs the existing manifest-vs-disk freshness check — the cheap O(vault) stat
pass — against its own DB and reindexes drift. After that, the mount's index
is refreshed only by an explicit `vault_reindex {vault: <alias>}`.

Rationale, in order of weight:

1. **The damage is bounded by architecture.** `vault_read` re-reads the file
   from disk — reads are always fresh. Only search *ranking and snippets* go
   stale, and a stale snippet resolves to fresh content one `vault_read`
   later. This is the fact that makes startup-only livable.
2. A mounted vault written by another live daftari (or a human) would make a
   chokidar watcher *churn* — continuous re-embedding of someone else's
   active working set, paid by the canonical process — and N watchers on
   large vaults press fd limits and the known chokidar reliability ceiling
   (the architecture doc notes dropped events even for the single canonical
   watcher).
3. The canonical watcher's semantics (self-write suppression, debounce)
   assume the watching process is also the writing process; on a mount that
   assumption is false by definition.

[HYPOTHESIS] Startup-only is enough because mounts are mostly reference
material, not hot co-edited state. Kill condition: field reports of agents
acting on stale mount search results in actively co-written vaults — the
remedy is an opt-in per-mount `refresh: watch`, added then, not now. Do not
ship a hedged half-watcher in v1.

## Decision 7 — curation and lint: canonical-only, stated as principle

- **`vault_lint` stays canonical-only.** Two independent reasons, both worth
  writing down: (a) lint findings exist to drive repair, and every repair is
  a write the caller cannot make on a mount — a finding you cannot act on has
  no value (the same rationale as 2026-07-14's disposition A for lint
  findings); (b) lint's unfiltered global aggregates are disposition C,
  accepted only for one's own vault (Decision 2, ruling 3).
- **`vault_themes` canonical-only in v1.** Cross-vault clustering is
  technically coherent under the one-provider decision, but theme labels are
  TF-IDF over titles/tags and `skippedDocuments` is an exact count — both
  would need a fresh existence-disclosure pass over a second vault's policy.
  Defer; note it as the first candidate for v2 precisely because the vectors
  are already comparable.
- **`vault_tension_*` reads, `vault_provenance`, `vault_edges`,
  `vault_backlinks` on referenced docs: refused** — all fall under
  Decision 5's documents-not-state rule. The curation engine remains advisory
  *about the vault it can act on*.

## Decision 8 — explicit v1 deferrals

1. **Cross-vault frontmatter edges** (`superseded_by` / `sources` across
   mounts). These are frontmatter fields, so a cross-vault citation can
   coherently exist as a plain string in v1, per #297 — it travels with the
   document, consistent with Decision 5's documents-not-state rule; it just
   isn't resolved or walked. The gate for a later spec: real cross-vault
   edges immediately create cross-vault *blast*, which lands squarely in
   2026-07-14 B′ coarsening territory across two policy domains — that spec
   must be revisited first, by name.

   `derives_from` is deliberately **not** in this list: it is not a
   frontmatter field but an edge-graph relation (`.daftari/edges.jsonl`,
   created only via `vault_edge_observe` / `vault_edge_contest`), and
   Decisions 5 and 7 already refuse those tools — and `vault_edges` reads —
   against federated paths. It has no plain-string form to defer; a
   cross-vault derivation graph would be a separate loosening of the
   documents-not-state boundary itself, not an extension of the citation
   mechanism, and needs its own spec on top of the B′ revisit above.
2. **Cross-vault tension detection / logging.** A tension between a local
   and a mounted doc is written where? The local log naming a foreign doc
   unreadable to others is a disclosure problem; the foreign log is
   unwritable. Unresolved by design; deferred.
3. **Federation over `daftari serve`: v1 is stdio-only.** `daftari serve` on
   a config with a `federation` block is a startup error
   (`federation is stdio-only in v1; remove the federation block or run stdio`),
   fail-loud like every policy conflict. Reasons: per-bearer identity would
   need per-request resolution against every mount's `federation.principals`
   (mechanically fine — but Decision 2's "vault labels do not leak" ruling
   was derived for a single-identity process and must be re-derived for a
   shared mount set), and mount index lifecycle in a long-lived multi-tenant
   process interacts with Decision 6. A sequencing choice, not a wall: serve
   federation is expected in v2, and Decision 2's mapping shape was chosen
   to be per-request-resolvable on purpose.
4. **Write-through / any mutation of a mount**, including staged-action
   *proposals* targeting mount docs — the stage-time write gate would have
   nothing to check against.
5. **Transitive mounts**; per-mount RRF weights (kill-condition-gated,
   Decision 4); watch-mode freshness (kill-condition-gated, Decision 6);
   shared cross-mount embedding cache (kill-condition-gated, Decision 3);
   any exposure of a referenced vault's court/docket — the court takes no
   access context, operator-only, per standing invariant; a *mounted*
   vault's court is doubly out.
6. **Doc follow-ups on implementation:** amend `docs/architecture.md`'s
   "one vault directory" sentence, and add a CLAUDE.md key-decision line —
   mounts expose documents, not vault state; nothing is ever written under a
   referenced root; referenced-vault grants live in the referenced vault's
   config, keyed by principal, deny-all default.

## Tradeoff statement and falsifiers

The tradeoff running through every decision: federation as read composition
over sovereign vaults. That costs cold-index time and startup-only freshness.
It buys zero new cross-process coordination (the 2026-08-08 verdict's
unguarded surfaces stay single-writer), zero writes into foreign directories,
and disclosure semantics that compose per-vault instead of needing a new
global theory.

What would falsify the shape as a whole: a demonstrated need for **fresh,
curation-grade signals across vaults** — cross-vault tensions, blast, lint —
rather than document reads. At that point "documents, not state" stops being
a boundary and becomes the bottleneck, and the successor spec has to do the
2026-07-14 analysis across two policy domains that this design deliberately
avoids. The per-decision kill conditions above (Decision 3 embed cost,
Decision 4 small-vault over-representation, Decision 6 staleness incidents)
are the early-warning versions of that same failure.
