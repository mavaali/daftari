# Privacy & retention — the distill boundary

This document states, honestly, what Daftari's `distill` (compile-on-ingest)
path does and does not retain. It covers the retention boundary only; it is not
a legal privacy policy and makes no claims about any third-party service.

## Distill-and-discard: what Daftari keeps

`daftari distill` reads a raw source (a chat transcript), sends it to a
synthesis LLM to extract discrete claims, and stages those claims as **draft
proposals** (`status: draft`, `confidence: low`, `provenance: synthesized`).
The raw source is held in memory for the duration of the run and then
discarded. **Daftari never persists raw source material under the vault.**

Two invariants keep that honest:

- **No raw landing (R8).** The distill output fence refuses any proposal whose
  target is under a top-level `raw/` path or carries `tier: source` — the
  raw/source tier is reserved for `daftari import` of content you already own
  in git, never for distilled output. Distill emits compiled belief, not source.
- **Verbatim-quote budget (R9).** Extraction paraphrases by default. Any exact
  quote is capped (`distill.max_verbatim_chars`) and must be attributed to a
  `sources[]` pointer; the advisory `verbatim_quote_overrun` lint flags a
  compiled note that carries more verbatim text than the budget allows. This
  bounds how much raw wording can survive into a compiled note.

Nothing distilled becomes trusted automatically: **distill proposes, ratify
disposes.** A human (or a reviewer with the `ratify` capability) approves each
proposal through `vault_ratify` before it lands. Ingestion never mints trust.

## The boundary is Daftari's, not the provider's

Distill-and-discard bounds **Daftari's** retention — not the synthesis
provider's. To extract claims, the raw source **transits an external LLM
provider** (Anthropic, or an OpenRouter-routed model, depending on the
configured transport). That provider's own retention and zero-data-retention
(ZDR) terms govern the raw on that leg. Daftari cannot enforce or verify them
and does not claim to.

What Daftari records instead is a per-run **receipt** naming the `provider` and
a caller-asserted `zdr` flag. That flag is **asserted, never inferred**: Daftari
will not guess a provider's ZDR status, because a false "zero retention" claim
is worse than no claim. If you need ZDR, configure a provider/endpoint that
contractually offers it and assert it explicitly — the receipt records your
assertion, not a guarantee.

## The provenance pointer is a breadcrumb, not a source

Every compiled claim carries a pointer of the form:

```yaml
sources:
  - "distill:<source-id>#<claim-key>"
```

This is an **audit breadcrumb** — it records *which source and which claim*
produced a note, for lineage and review. It is **not a re-derivation source**:
the raw is gone, so the pointer may **dangle**, and that is acceptable by
design. Daftari never silently re-fetches raw material. Re-derivation always
means *you* re-presenting the source to a fresh distill run — an explicit,
observable act, never an implicit one.

The pointer is keyed on the **stable source-id**, not the run-id, so
re-distilling the same source in a later run points at the same lineage.

## What this does not cover

- **Accidental sensitive commits.** Distill-and-discard prevents raw from
  *landing*; it does not retroactively remove content that some other path
  committed to the vault's git history. Scrubbing an accidental sensitive commit
  from history is a separate, deliberate operation — a path/source-keyed history
  scrub (`vault_erase`) plus, for a shared git-pushed vault, a coordinated
  multi-clone rewrite. If a committed value was a secret, rotate it first: a
  history rewrite cannot un-disclose what was already pushed.
- **Third-party PII / subject-keyed erasure.** The full subject-keyed erasure
  subsystem is deferred until a vault actually begins holding third-party
  personal data. An internal-knowledge vault holds no erasable third-party PII,
  so that cascade is designed but not built — it would be a subsystem that never
  fires. See the design record before enabling it.
