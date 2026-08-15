# Cortex loop Stage 3 — envelope enforcement + §8 audit-trail closures (brief)

**Date:** 2026-06-17
**Spec:** `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md` (§5, §5.4, §8; build-stage §12.3)
**Handoff:** `docs/superpowers/handoffs/2026-06-17-stage3-pickup.md`
**Branch (to create):** `feat/cortex-loop-stage3`
**Status going in:** Stages 1–2 shipped (v1.22.0, main `a011ad6`); build 2/6; 1125 pass / 3 skip green.

## What Stage 3 is

Three pieces, all from the spec's envelope + audit-trail closure work. None graduates
auto-write out of shadow (that's Stage 5) — Stage 3 wires the *decision* so it is correct
and tested before it ever becomes consequential.

1. **Two-gate envelope, live but shadowed** (§5). Today shadow mode only *computes*
   `would_gate` and never acts on it; there is **no invariants gate at all**. Stage 3 adds a
   real gate Component A consults before each `do()`: an action is admitted **iff both** the
   **invariants** gate and the **trust-budget** gate pass. Enforcement is live (the gate
   decides A's control flow); writes stay shadowed (logged-not-applied) until Stage 5.
2. **`decided_by_principal`** (§5.4, §8). Pure-verdict outcomes — a *reject* (no write) and a
   *contest* (no provenance entry) — record only the free-text claim today, not the
   authenticated `principal`. Add the authenticated identity to the staged-action decision
   record and the contest tension.
3. **Gate `vault_tension_resolve` on `canRatify` for loop-authored tensions** (§5.4, §8).
   `vault_edge_contest` is `ratify`-gated but resolving the tension it raises is any-read —
   a loud contest can be resolved away a trust tier down. Close the asymmetry.

## Locked decisions (from the 2026-06-17 brainstorm)

| # | Decision | Choice |
|---|---|---|
| D1 | Budget spend under enforcement | **Deduct only on admit.** Gated actions surface and spend nothing; budget moves only when an action clears both gates. The real-loop semantic Stage 5 graduates into; "everything after exhaustion surfaces" still holds (budget stays exhausted). |
| D2 | Which invariants are live runtime checks | **All three checkable + never-delete assert.** tension-respect, provenance-required, premise-freshness as runtime gates; never-delete as defensive assert; never-optimize-the-measure stays design-level (not mechanizable). |
| D3 | How a refused edge write is surfaced (shadow posture) | **Shadow journal + lint section.** Record gate verdict + reason + which-gate-fired in `shadow-actions.jsonl`; `vault_lint` grows a "gated / surfaced" view. No tension per gated edge (avoids flooding the ambiguous tail). |
| D4 | How `vault_tension_resolve` identifies a loop tension | **Exact `loggedBy === "agent:curation-loop"`** (`CONSOLIDATE_AGENT`). Human-logged tensions stay any-read-resolvable. |
| D5 (arch) | Where enforcement lives | **A new `src/consolidate/envelope.ts`, consulted by birth/revision** — NOT inside the shared `recordShadowAction`. `recordShadowAction` is also called by the 7 doc-write tools; a human writing in shadow mode must not be refused by the loop's trust budget. The envelope is *A's* autonomy gate, not a vault-wide write gate. |
| D6 (arch) | Budget ownership | **A session-spend scalar threaded through the consolidate run**, owned by the envelope (deduct-on-admit). `recordShadowAction`'s module-global `spentByVault`/`would_gate` stay as-is for the doc-write calibration path; the loop ignores `would_gate` and trusts the envelope. The shadow journal still records every loop action (admitted or gated) so calibration data keeps flowing, now with the gate verdict attached. |

## Architecture

### Piece 1 — `src/consolidate/envelope.ts`

A pure decision function plus a small surfacing path. Component A (birth/revision) consults it
before each edge write; the CLI (`index.ts`) owns the session-spend scalar and threads it in.

```
evaluateEnvelope(action, ctx, sessionSpend) -> {
  admit: boolean,
  gate: "invariants" | "budget" | null,   // which gate refused; null when admitted
  reason: string,                          // human-readable; goes to journal + lint
  impact: number,                          // I, for the deduct-on-admit step
}
```

- **Invariants gate (evaluated first):**
  - *tension-respect* — either endpoint doc has an **unresolved** tension ⇒ refuse. Source:
    `listTensions(vaultRoot)` filtered to `!resolved` whose `sourceA`/`sourceB` touch an
    endpoint (canonicalized — [[feedback_canonicalize_path_keys]]).
  - *provenance-required* — either endpoint's provenance is unknown/broken ⇒ refuse. Source:
    the endpoint frontmatter A already holds in its in-process `docByPath` map.
  - *premise-freshness* — a stale/decayed endpoint ⇒ refuse. Source: `computeDecay(frontmatter)`
    (`src/curation/decay.ts`) + `validation.valid` on the in-process doc — **not** a re-read
    through the `vault_read` tool (the envelope runs in-process; it calls the same primitives).
  - *never-delete* — defensive assert: A's permitted `do()` set (edge_observe/contest) cannot
    delete; the assert guards against a future action type slipping a delete through.
  - *never-optimize-the-measure* — stays a design-level invariant (no runtime hook).
- **Trust-budget gate:** `B₀ = shadowBudget(livePending, docCount)`, `I = shadowImpact(action, blast)`
  (both already exported from `src/curation/shadow.ts`). Refuse when `sessionSpend + I > B₀`.
- **Admit** ⇒ A calls the injected `observe`/`contest` (which still shadow-record as today);
  the CLI deducts `I` from the session-spend scalar. **Refuse** ⇒ record a **gated entry**
  (gate + reason + I) so the journal + lint can show it; **no spend**; A does not write.

**Seam.** Birth/revision receive `observe`/`contest` by injection today (`makeObserve`/`makeContest`,
`edge-write.ts`). Stage 3 adds an injected `admit(action) -> EnvelopeVerdict` the same way, so the
unit tests for birth/revision stay hermetic. The live-vs-shadow + session-spend wiring stays in
`index.ts` / a thin factory next to `edge-write.ts`.

**Shadow journal extension (D3).** `ShadowActionRecord` (or the gated path) gains the gate verdict
fields so a gated would-be action is distinguishable from an admitted one. `vault_lint` grows a
"gated / surfaced" section alongside the existing `shadowActions` section.

**Open detail for the plan:** whether a refused action still writes a `recordShadowAction` row
(flagged gated) or a lighter dedicated gated record. Prefer reusing the existing record with added
verdict fields so one journal carries the full calibration picture; the plan settles the exact shape.

### Piece 2 — `decided_by_principal`

Authenticated identity = `access.user` (the §11.6 principal). Optional everywhere (direct/test
calls have no `AccessContext` → field omitted, matching existing patterns).

- **Staged-action decision record** (`src/curation/staged-actions.ts`): add `decidedByPrincipal?`
  to `DecisionInput`; write `decided_by_principal` into the decision `RawRecord`; carry it through
  `collapse` onto `StagedActionRow`/`StagedAction`. Set in `vault_ratify`
  (`src/tools/staged-actions.ts`) from `access?.user` on **both** reject and approve; the lint
  sweep records `SWEEP_PRINCIPAL`.
- **Contest tension** (`src/curation/tension.ts`): add `decidedByPrincipal?` to `TensionEntry` +
  `TensionInput`; render `- **Decided by principal:** …` in `tensions.md`; parse it back. Set in
  `vaultEdgeContest` (`src/tools/edges.ts`) from `access?.user`.

### Piece 3 — gate `vault_tension_resolve`

`vaultTensionResolve` (`src/tools/curation.ts`) today gates only on `requireReadAccess`. Add:
fetch the target tension first (read `loggedBy`); if `loggedBy === CONSOLIDATE_AGENT` and
`access && !canRatify(access.role)` ⇒ deny, mirroring the `vault_edge_contest` /  `vault_ratify`
guard. No-access (direct/test) calls bypass, as elsewhere.

- **Constant location:** `CONSOLIDATE_AGENT` lives in `src/consolidate/constants.ts`. Importing it
  into `src/tools/curation.ts` points tools → consolidate. The plan decides: import as-is, or
  relocate the principal string to a neutral module (e.g. `src/access/`) and re-export. Lean import;
  it's one string and the dependency is benign.

## Invariants / constraints carried in

- **Canonicalize every path key** at the envelope boundary before tension/provenance lookups —
  the alias bug class has bitten this codebase repeatedly ([[feedback_canonicalize_path_keys]]).
- **No throws from tool handlers** — `Result<T, Error>` everywhere (CLAUDE.md style).
- **Functions and types, no classes.**
- The envelope must not depend on shadow being **on**: the gate decision is identical shadow-on or
  shadow-off (Stage 5 only flips whether an admitted write applies). Stage 3 wires the decision; it
  does not graduate anything.
- **Charter (CLAUDE.md "curation engine is advisory") is NOT amended in Stage 3** — that lands with
  Stage 5 graduation (spec §14). Stage 3 stays advisory.

## Test plan (TDD)

- `evaluateEnvelope`: each invariant fires independently (unresolved-tension endpoint, broken/unknown
  provenance, stale/decayed premise) ⇒ refuse with the right `gate`/`reason`; clean action + budget
  headroom ⇒ admit. Budget boundary: admit at `sessionSpend + I == B₀`-? (settle `>` vs `>=` against
  `shadowBudget` — spec uses strict `>`), refuse just past it. **Deduct-on-admit idempotency:** an
  admit deducts `I` once; a refuse deducts nothing; a sequence exhausts then surfaces the remainder.
- Piece 2: `decided_by_principal` round-trips through the jsonl collapse (reject + approve) and the
  `tensions.md` render/parse (contest); omitted cleanly when no `access`.
- Piece 3: loop-authored tension (`loggedBy === agent:curation-loop`) denied to a non-ratify role,
  allowed to a ratify role; human-logged tension allowed to any-read; no-access call bypasses.
- Regression: existing shadow doc-write path unchanged (human write in shadow mode is NOT gated by
  the envelope); existing 1125 tests stay green.

## Ritual (per spec §12 / handoff)

brief (this doc) → plan → **TDD** → **two general-purpose adversarial reviewers** (NOT squad agents —
[[reference_squad_agents_broken_tools]]) → fix → PR to main → release (npm publish is Mihir's MFA
step — [[reference_daftari_release_ritual]]). Run commit-bearing work with **ask-permissions**
([[reference_uatu_commit_hook]]). CI Node-20 has the known onnxruntime/MiniLM flake — re-run, don't
assume regression ([[reference_ci_embedding_model_flake]]).

## Notes for the plan (from the 2026-06-17 spec review)

- **The loop discriminator (D4) is a value convention, not a structural guarantee.** A contest
  tension's `loggedBy` is set from the free-text `contested_by` arg; the loop's call path
  (`index.ts` `agent: CONSOLIDATE_AGENT` → `revision.ts` `contestedBy: opts.agent` → `addTension`)
  makes it `"agent:curation-loop"`. A human who manually contests while passing
  `contested_by: agent:curation-loop` would therefore also be `canRatify`-gated on resolve — the
  desired behavior, but state it explicitly so it isn't read as a bug.
- **The envelope's session-spend is a SEPARATE scalar, not the shadow module global.**
  `spentByVault` is module-private to `shadow.ts` (only `shadowSpent`/`resetShadowSession` exported).
  D6's deduct-on-admit scalar is owned by the envelope/CLI run and threaded through — do not try to
  reuse or rethread `spentByVault`.
- **Settle the gated-record shape before TDD.** Piece 1's "reuse `ShadowActionRecord` + verdict
  fields vs. a dedicated gated record" is the one unsettled shape; resolve it first because the test
  assertions depend on it. (Contest tension render/parse maps to the private `renderEntry`/`parseBlock`,
  not an exported `render` — cosmetic.)
- **Re-baseline the test count** against `npm test` at branch creation (date has rolled past the
  1125/3 snapshot).

## Not in scope (Stage 3)

- Auto-write graduation / shadow-OFF (Stage 5).
- B coverage/equity instrumentation (Stage 4).
- The CLAUDE.md charter amendment (Stage 5).
- A emitting always-stage-tier doc actions (promote/deprecate/…) — A still emits only edge writes;
  "surface" for a gated edge write is the journal + lint view (D3), not a `stage_action`.
- Multi-action passes; live event-hook (both spec §11, v2).
