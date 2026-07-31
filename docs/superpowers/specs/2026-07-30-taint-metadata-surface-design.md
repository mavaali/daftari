---
title: "Provenance taint as a machine-readable surface — design STUB"
date: 2026-07-30
status: draft
motivated_by: "#314 read-path fence kill accepted; successor to prose fencing"
---

# Provenance taint as a machine-readable surface (STUB)

> **Status: stub, not a buildable design.** It records the direction chosen when
> the read-path fence's kill condition 1 was accepted (#314), so the reasoning
> isn't lost. It is not scoped, has open questions, and must go through
> brainstorming → a full design → writing-plans before any code.

## Why this exists

The read-path **prose fence** (wrap untrusted retrieved bodies in a preamble
that asks the consuming model to distrust them) did not clear its pre-registered
kill condition 1 — the 2026-07-29 canary showed no positive evidence that
framing changes consumer behaviour (−13.3pp, 95% CI [−40.0pp, 0.0pp], n=6, one
item of six carrying it). See `2026-07-27-memory-poisoning-read-path-fence-design.md`
and #314. Two things the run made clear:

1. Even under the *optimistic* reading, the fence left **4 of 5 items with
   headroom at 100% injection compliance** — prose framing is porous across most
   attack classes, and [TRAINING] prose-level delimiting/spotlighting is a
   mitigation, never a boundary, dominated by structural defenses (taint
   tracking, tool-gating, capability confinement).
2. The failure mode is *model non-compliance* — the consuming model ignores the
   preamble. Any defense that depends on the model choosing to obey inherits
   this.

## The direction

Do not persuade the consuming model. **Expose the provenance taint as
machine-readable metadata** so the consuming *harness* can enforce policy
without the model's cooperation.

- PR 1 of the fence work already built the detector (`src/fence/`: the trigger,
  the detector, corpus-precision test). That detector is a **taint tracker**;
  keep it, drop the prose preamble as its consumer.
- Surface the taint as structured data on the read path: a frontmatter field
  and/or a structured annotation on the `vault_read` / `vault_search` tool
  result (the three-channel result bridge already carries structured content
  alongside the model-facing summary — `src/server.ts`). The consuming harness
  reads the flag and applies policy: strip, tool-gate, quarantine, or require
  human confirmation before the tainted body can influence a privileged action.

This is on-thesis: daftari's whole posture is machine-readable structure over
relying on a model's goodwill. It is robust to exactly the failure the canary
found.

## The load-bearing open question (this is the kill condition)

**Does any consuming harness actually read and act on the flag?** A taint field
nothing enforces is decoration — the same trap the fence's own kill condition
guards against, moved one layer out. This has a real adoption dependency: the
value is created on the *consumer* side, which daftari does not control.

Kill condition (to pre-register before building): if no consuming harness reads
the taint annotation and changes behaviour on it within a defined window/pilot,
the surface is inert and should not be maintained.

## Open questions (for brainstorming, not answered here)

- Where does taint live — frontmatter (travels with the doc, git-visible) vs a
  derived index field vs tool-result-only annotation? What are the write-path
  and supersession semantics?
- What is the taint *vocabulary*? Binary (foreign/native) or graded by source
  kind (fetched-web / imported-store / pr-body / …)?
- Who sets it and when — at write time (proposer-declared, itself untrusted?),
  at import (`daftari import`), or derived by the detector on read?
- What is the reference consumer? A thin policy in daftari's own MCP surface, or
  purely a documented contract for external harnesses? Without at least one
  real consumer the kill condition fires by construction.
- Relationship to RBAC/existence-disclosure and to the `vault_ratify` rationale
  issue (#319) — is the approval-surface case a special consumer of the same
  taint?

## Not in scope

- Reviving the prose fence. A redesigned per-attack-class canary (stratified
  classes, per-class CI, "fence never *increases* success" check) is only worth
  it if someone proposes shipping prose fencing again; it is not this.
- Any write-path trust *tier* — that axis was killed in the predecessor design.
