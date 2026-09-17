# U5 — Agent-layer leak boundary

## The gap, precisely

U2 proved federation gives **structural read isolation between vaults**:
as `human:alice`, `bob-private` is unreachable by path traversal, symlink,
or search-scope — the referenced vault's own deny-all-guest
`federation.principals` policy holds regardless of what the mounting
process tries. That property lives entirely in daftari's server/config
layer and does not depend on the calling agent behaving well.

It does **not** constrain the **agent** (Mavaali, or any assistant wired to
daftari) that legitimately holds two separate read capabilities at once:
`alice-private` (canonical or mounted) and `shared` (canonical, per the U3
topology — a process with no mount into either private vault). Nothing
stops that agent from reading a private fact in one call and then issuing a
`vault_write` to `shared` whose body contains that fact — verbatim,
summarized, or paraphrased. Federation guards vault↔vault channels; it says
nothing about content moving through the agent's own context window, which
is a channel federation was never designed to see.

**This is the same shape as Mavaali's own `hooks/family_scope_gate.py`
problem** (`/Users/mihirwagle/projects/claude-home-base/hooks/family_scope_gate.py`).
That gate exists because the 1Password-style boundary between "Mavaali ops
secrets" and "Family secrets" is enforced structurally at the *credential*
layer (headless service account is blind to the Family vault by design —
no token exists that can read both). But the read→write *copy* risk one
level up — an agent that legitimately read a Family secret for an approved
task turning around and pasting it into a Slack channel — is explicitly
named in `workspace/CLAUDE.md` as a **policy** rule ("What must never leave
a private context"), enforced by instruction-following and, where
enforceable, by a hook that pattern-matches the *command surface* (which
Bash invocations are allowed), not the *content* of what's typed. Today,
daftari's private→shared write path is at the same maturity: no code stops
it, only the operator's/agent's judgment plus (if built) an allowlist-style
check.

## What's currently policy vs structural

| Property | Level | Why |
|---|---|---|
| `human:bob` cannot read `alice-private` via daftari's own tools/paths/search | **Structural** (U2) | Enforced at mount-load and dispatch, independent of caller intent |
| Agent doesn't copy an alice-private fact into a `shared` write | **Policy** (today) | No code path checks a `shared` write's content or declared provenance against private-vault origin; relies entirely on the agent choosing not to |

## Can daftari's own provenance/consumes make this structural today?

Read `src/curation/consumes.ts`, `src/curation/edges.ts`, and
`src/curation/read-log.ts` to answer this precisely, rather than guessing.

**Finding: no, not without new plumbing — the existing lineage machinery is
scoped per-vault, not cross-vault.**

- `consumes.ts` mints `consumes` edges (artifact → unit) by joining a
  landed write's `run_id` against **that same vault's own read-log**:
  `mintConsumesEdges(vaultRoot, …)` calls `readReadLog(vaultRoot)` and
  `readsForRun(log, runId)` — both keyed to `join(vaultRoot, ".daftari",
  "read-log.jsonl")` (`consumes.ts:57-59`, `read-log.ts:45`). The store is
  explicitly per-vault: `consumesPath(vaultRoot)` writes into *that vault's*
  `.daftari/` directory.
- `read-log.ts` records a served read (`recordRead`) into the **serving**
  vault's own log, stamped with the caller-supplied `run_id` if any
  (`read-log.ts:1-45`). A read served by `alice-private`'s process lands in
  `alice-private/.daftari/read-log.jsonl`; it never touches `shared`'s log.
- Given U3's decision — `shared` is canonical for its own process with **no
  mount into either private vault** — there is no code path today by which
  a read served through the `alice-private` process and a write landed
  through the `shared` process can be correlated by `run_id`, because
  `mintConsumesEdges` only ever looks at the log **of the vault it's
  running against**. Even if the agent passed the *same* `run_id` to both
  calls, `shared`'s mint step would never see `alice-private`'s read-log
  entries — they live in a different file on a different vault root.
  Cross-vault correlation of `run_id` **does not exist in the current
  code**; it would require new plumbing.
- `derives_from` edges (`edges.ts`) are even further from fitting: they are
  *earned* through independent re-derivation over time (§5.3.1), not
  minted synchronously at write time, and the store (`edges.jsonl` +
  `index-db.ts`'s `derives_from_edges` table) is likewise
  `join(vaultRoot, …)`-scoped per vault.
- The one channel that *is* available today without new plumbing is
  **declared** provenance: `frontmatter.sources` (`src/frontmatter/types.ts:42,91`,
  `schema.ts:337-338,394`) is a string array the *writer* supplies by hand.
  A write-time check in `shared`'s `vault_write` path could refuse (or
  flag) any write whose `sources` array names a path that looks like it
  belongs to a vault tagged private. But this is **declared, not earned** —
  exactly the "provenance channel, not exclusively a vault-edge channel"
  comment at `src/frontmatter/source-ref.ts:11` says out loud. It only
  catches an agent that is honest enough to cite what it copied from; it
  does nothing against an agent (or an injected instruction) that omits
  `sources` or paraphrases without citing.

**What would make it structural:** a cross-vault-aware read ledger — e.g.
one ledger keyed by `run_id` that every vault process (private and shared
alike) appends to on every served read, plus an explicit `visibility:
private` marker in a vault's own `.daftari/config.yaml` (today privacy is
*implicit* in whether `federation.principals` lists one or many principals,
not a first-class flag) — combined with a write-time hook in the canonical
`shared` write path that, before a write lands, looks up the current
`run_id`'s reads across that shared ledger and refuses any write whose
`run_id` touched a document from a vault flagged private. That is real,
buildable new plumbing (the per-vault run_id-correlation primitive already
exists as a pattern to extend — `consumes.ts` is the template), not
something daftari already does. It is out of scope for this spike unit; it
is the concrete next unit if this residual risk is worth closing.

## What stays irreducibly policy/agent-judgment

Even with the cross-vault ledger built, one class of leak is not catchable
by lineage at all: **laundering by rephrase**. If the agent reads Alice's
therapy note and writes to `shared` a paraphrase that contains the same
fact in different words with no declared `sources`, no verbatim canary
string, and (hypothetically) a `run_id` that was deliberately *not* passed
on the write call, no structural check — lineage-based or content-scanning
— can distinguish that write from an independently-authored fact. Lineage
tracks **documents read**, not **facts synthesized**; an LLM's context
window is the one hop no edge graph observes. This is the daftari-specific
form of the same limit Mavaali's own CLAUDE.md names for the Family
boundary: "the assistant paraphrasing a private fact into shared without a
traceable edge — lineage can't catch laundering-by-rephrase." That gap is
closed only by agent-layer discipline (never write private facts into
shared, full stop, regardless of phrasing) and, at best, human review —
never by a structural gate on the write path.

## Bottom line

- Federation (U1-U3): structural read isolation, vault↔vault. Proven.
- Private→shared copy via the agent's own context: currently **policy**,
  identical in kind to Mavaali's `family_scope_gate.py` posture — a
  command/declared-provenance-level check is buildable now with existing
  plumbing (`sources` frontmatter), but it is a **defense-in-depth
  backstop**, not a closed structural guarantee, because `sources` is
  self-reported.
- A structural version (cross-vault run_id ledger + explicit vault
  `visibility` flag + write-time refusal in the canonical `shared` write
  path) is feasible **but does not exist today** — new plumbing, not a
  reframing of what's already there.
- Laundering-by-rephrase is irreducibly policy/judgment; no lineage graph,
  compiled or earned, observes the LLM's own synthesis step.
