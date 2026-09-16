# Coordinated erasure protocol (shared, git-pushed vaults)

`vault_erase` rewrites the LOCAL git history of a vault (see `src/tools/erase.ts`
and PRIVACY.md). For a vault that is only ever a single local clone, that is the
whole story. But once a vault has been **pushed to a remote** and **cloned by
more than one person or machine**, a local rewrite is not enough: every other
clone still holds the old objects, and the remote keeps them until its host runs
a garbage-collect. This is the human protocol for that case (R14). It is a
coordinated operation, not a single command.

## Pre-scrub dependents plan

Erasure has a two-phase internal contract. `vaultErasePlan` resolves the target
to its current path set, then computes the transitive source and link dependents
before any history mutation. The plan reports:

- caller-visible target paths and downstream paths;
- visible source/link blast counts;
- `hidden_targets` and `hidden_downstream` as `none` / `some` / `many`, never an
  exact hidden count;
- the vault's full git `HEAD`; and
- a deterministic `plan_hash` bound to the target, resolved paths, full
  dependency graph, caller identity and read scope, and `HEAD`.

If the downstream blast is nonzero, `vault_erase` requires both the existing
exact `confirm` echo and that exact `plan_hash`. An arbitrary, missing, or stale
plan is rejected; fetch a fresh plan and retry after reviewing the new scope.
Execution recomputes the plan at the last reversible point before
`git filter-repo`, so a source/link edit, source-ref target change, permission
change, or new commit invalidates the acknowledgment instead of widening it.

A zero-blast target keeps the existing confirmation-only internal behavior.
Supplying a hash opts into exact validation even for a zero-blast target.

This is an exposure gate, not a new exposure: `vault_erase` and
`vaultErasePlan` are not registered with MCP or CLI today. Any future exposure
must expose the plan and execution phases together; it must not wire the
history rewrite alone.

## Why a rewrite alone is not enough

A history rewrite makes the erased content unreachable in *your* clone. It does
**not**:

- reach any other clone (each holds its own copy of the old objects);
- force the remote host to drop the old objects — GitHub, Azure DevOps and
  similar keep unreachable objects until an operator-triggered GC/purge;
- un-disclose anything already fetched, cloned, cached, or logged elsewhere.

`vault_erase` is honest about this: its result carries an `incomplete[]` list,
and a configured remote always contributes an entry saying the remote-side GC is
not self-serve. Read that list — it names exactly what still has to happen.

## The protocol

Run these in order. Steps 1–3 are yours; steps 4–6 need coordination.

1. **Rotate first if the content was a secret.** A history rewrite cannot
   un-disclose what was already pushed or cloned. If the erased value was a
   credential, key, or token, treat it as compromised and rotate it **before**
   or in parallel with the rewrite. (`vault_erase` returns rotate-first guidance
   for a secret-shaped target — heed it.)

2. **Review the pre-scrub plan.** Request `vaultErasePlan` for exactly one
   `path` or `source_ref`. Read every visible downstream entry and treat a
   `hidden_*: some|many` bucket as additional blast you cannot inspect from
   this role. If the blast is nonzero, carry the returned `plan_hash` into the
   execution request. A stale-plan rejection means the scope changed: fetch a
   new plan, review it, and retry; do not recycle the old hash.

3. **Erase locally, then force-push.** Run `vault_erase` on the clone that is
   your source of truth. It rewrites history, expires the reflog, and GCs the
   local object store, then force-pushes the rewritten refs to the configured
   remote. Confirm the rewrite landed (the erased marker is absent from
   `git log -p --all`).

4. **Freeze and notify every other clone.** Tell every collaborator and every
   machine holding a clone to STOP pushing and to expect a forced update. A push
   from a stale clone re-introduces the erased objects — that is the one action
   that silently undoes the whole operation.

5. **Re-clone or hard-reset every other clone.** Each other clone must discard
   its local history and take the rewritten one. The safe default is a fresh
   `git clone`. A `git fetch` + `git reset --hard origin/<branch>` works only if
   the clone then also expires its reflog and GCs (`git reflog expire
   --expire=now --all && git gc --prune=now`); a fresh clone avoids that
   footgun. Any clone that is not re-clone/reset still holds the content.

6. **Request a remote GC / purge from the host.** Force-pushing rewritten refs
   does not remove the old objects from the remote. Ask the host to garbage
   collect or purge them (GitHub: contact Support to expunge unreachable objects
   / cached views; Azure DevOps: run the repository's cleanup, and be aware of
   pull-request and build caches that may still reference the old commit). Until
   the host confirms, assume the content is still retrievable from the remote.

## When it is done

The erasure is complete only when **all** of the following hold:

- the local rewrite landed and its reflog/objects are gone;
- every other clone has been re-cloned or hard-reset + GC'd (no stale clone can
  push the objects back);
- the remote host has confirmed a GC/purge of the unreachable objects;
- any exposed secret has been rotated and the old value treated as compromised.

Anything short of all four leaves the content retrievable somewhere. `vault_erase`
can guarantee only the first; the rest is this protocol, and it is a human one.
