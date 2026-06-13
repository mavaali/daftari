# Build brief — §11.6: agent principal in RBAC

**Branch:** `mihir/agent-principal`
**PR title:** `feat(rbac): ratify grant + authenticated principal attribution (§11.6)`
**Base off `origin/main`** (post #130; substrate item 6 of 6 — the last one before
the consolidation-loop spec).

## Why

§11.6: "A first-class agent identity (`agent:curation-loop` or similar) declared in
`.daftari/config.yaml` with `read | write | promote | ratify` grants. Provenance log
attributes loop actions to this principal. Cheap — config-only — but blocks any
auto-write action without it."

Roles are already config-declared, so an agent principal is just a role — what's
missing is (a) the **`ratify` grant** the design names (RoleConfig has only
read/write/promote; today ANY role with any read grant may ratify), and (b)
**authenticated attribution**: the `agent` argument every write tool takes is a
free-text claim, so provenance attributes actions to whatever the caller typed, not
to the identity the server actually runs as.

## What this builds

1. **`ratify: boolean` on RoleConfig** (default false) + `canRatify` in rbac.ts +
   config parsing (loud non-boolean rejection, the `promote` pattern).
2. **Gate `vault_ratify` on `canRatify`** (was: any read grant). Deliberate
   tightening, fail-safe per the house model: ratify is the human gate for
   destructive staged actions, and the design names it as a distinct grant. Roles
   that ratify must now declare `ratify: true` (CHANGELOG calls this out loudly).
   `vault_stage_action` (a proposal) stays at any-read.
3. **Gate `vault_edge_contest` on `canRatify`** — the flag carried from #128's
   review: contest revokes trigger-bearing edges (destructive to the future
   trigger graph) and had no second gate. Contest is a curation *verdict*, the
   same trust tier as ratify — one grant, not a fifth dimension.
4. **Authenticated principal attribution** — when the server runs with an
   AccessContext, every write's provenance entry (and shadow record) gains
   `principal: <access.user>` alongside the caller-claimed `agent`. The claim and
   the authenticated identity are now distinguishable in the audit trail; loop
   actions attribute to the principal the server was started as. No enforcement of
   agent == principal in v1 (the `--user` flag and the `agent:`/`human:` argument
   conventions differ; reconciling formats is loop territory) — recording ground
   truth is the §11.6 ask.
5. **Fixtures + docs** — `ratify: true` on the sample-vault admin and the
   reviewer-vault role that ratifies; architecture.md RBAC section documents the
   grant and shows an agent-principal declaration:

   ```yaml
   roles:
     curation-loop:        # started as: daftari --user agent:curation-loop --role curation-loop
       read: ["*"]
       write: ["*"]
       ratify: false       # the loop proposes; humans ratify
   ```

## Out of scope

- Enforcing `agent` == authenticated principal (format reconciliation + breaking
  for free-text callers; revisit with the loop).
- The loop's auto-write tier itself and the §10.5 charter amendment.
- Per-principal shadow filtering (noted in §11.5's brief).

## Known gaps accepted in v1 (from review — written down, not hidden)

- **Pure-verdict outcomes carry no authenticated principal yet.** A *reject*
  dispatches no write, and a *contest* writes no provenance entry, so the two
  verdict outcomes this PR gates record only the free-text `ratifiedBy` /
  `contested_by` claim (the approve path gets ground truth via the dispatched
  write's provenance). Adding a `decided_by_principal` to the staged-action
  decision record and the contest tension is deferred to the loop's session
  format work.
- **The verdict gates no longer require a read grant.** A corner config
  `{read: [], ratify: true}` may ratify (the old hasAnyRead gate would have
  denied it). Deliberate: the config author granted the verdict tier
  explicitly, and the dispatched write tools still re-check canWrite /
  canPromote.
- **Resolving a tension stays at any-read** while contest (which *creates* the
  tension) is ratify-gated — a contest's loud surface can be resolved away one
  trust tier down. Carried as a design note for the loop spec's envelope
  section.

## Test plan

- canRatify: false for null role / role without grant; true with grant.
- vault_ratify: denied for a read+write+promote role WITHOUT ratify; allowed with.
- vault_edge_contest: denied without ratify grant; allowed with; observe/edges
  unaffected (any-read).
- Provenance: a write with an AccessContext records `principal`; without one, no
  field (unchanged shape).
- Shadow record carries `principal` when access present.
- Config: malformed `ratify` rejected loudly.
