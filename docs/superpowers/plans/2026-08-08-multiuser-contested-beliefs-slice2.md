# Multi-User Contested Beliefs — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The execution skill owns the per-task RED/GREEN/REFACTOR cycle.

**Readiness:** implementation-ready

**Goal:** Consolidation on top of the merged Slice 1: `vault_consolidate` writes a ratify-gated `org_position` with dissent carried (U-10), `vault_read` returns the ratified view as the org's belief with a mandatory dissent annotation (R-17 / compile case 1), downstream consumers of contested-unratified inputs get an advisory read-time confidence-cap annotation (U-11, DN-5), and the first assert on a legacy doc snapshots the prior belief as system-authored `pos-000` (U-12, DN-2).

**Architecture:** Everything extends Slice-1 surfaces already merged to main: the third tool joins `positionsTools` in `src/tools/positions.ts` (registration is automatic via the existing spread, src/server.ts:60), the case-1 read block is a sibling of Slice 1's `contested_positions` key in `src/tools/read.ts`, the downstream cap rides the #234 compiled-upstream machinery already computed per read, and `pos-000` is one pure function in `src/curation/positions.ts` called from `vault_assert`. No new subsystem, no index migration, no lock changes (U-13 is Slice 3).

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes), gray-matter/js-yaml frontmatter, better-sqlite3 index (untouched), vitest, Biome.

**Spec:** `.plan-inputs/fable-daftari-spec-OUT.md` (Slice 2 = U-10, U-11, U-12; R-16, R-17; DN-2/DN-4/DN-5; C-1/C-2). Audit: `.plan-inputs/fury-daftari-review-OUT.md` (C-1, C-2, C-3 findings). Design doc: `.plan-inputs/fable-daftari-input.md` (§2 org_position, §4 compile cases, §6 pos-000). Slice-1 record: `docs/superpowers/plans/2026-08-07-multiuser-contested-beliefs-slice1.md` + `...-slice1-tasks4-9.md` (locked LD-7..LD-16) and `.plan-inputs/IMPL-REPORT.md`.

**Base:** branch `feat/multiuser-contested-beliefs-slice2` off origin/main @ 138ca97 (Slice 1 merged, PR #359). Every Slice-1 primitive this plan extends was re-verified in THIS worktree this run [DATA]: `OrgPosition` typed (src/frontmatter/types.ts:47–53), `org_position` validated (src/frontmatter/schema.ts:345–380) and serialized when non-null (src/tools/write.ts:269), the R-9 cap condition `contested && fm.org_position == null` (src/tools/positions.ts:169), the org_position-suppresses-CONTESTED read gate (src/tools/read.ts:274), `canRatify` (src/access/rbac.ts:64–66), `resolveTension` (src/curation/tension.ts:397–466), the foreign-position guard call sites (src/tools/write.ts:896, :1090), `positionIntegrity` lint block (src/curation/lint.ts:372–405), and the compiled-upstream read surface (src/tools/read.ts:190–252, unit paths per src/curation/edge-staleness.ts:73–84).

---

## Locked decisions (implementer never re-decides)

Slice-1 locked decisions LD-7..LD-16 and DN-1/DN-3 stand unchanged. Slice 2 adds:

- **C-1 Confidence precedence on re-contest (RESOLVED):** when a ratified doc gains a new conflicting live position after `ratified_at`, `org_position` and the mirrored doc confidence **HOLD**; the R-9 low-cap does **not** re-apply. `vault_assert`'s cap condition stays exactly `contested && fm.org_position == null` (src/tools/positions.ts:169 — already-shipped Slice-1 code, kept deliberately; TRUST THE CODE). One-line justification: a single dissenting assert must never unilaterally demote a ratified org stance — demoting a ratified view is itself a consolidation act and therefore ratify-gated; the new dissent is never hidden, because the positional tension still mints as usual and the case-1 read block surfaces `open_tension_ids` plus a re-contest note (Task 3). Re-running `vault_consolidate` is the only way the mirror moves.
- **C-2 `pos-000` system-authored carve-out (RESOLVED):** `pos-000` carries `principal: "unknown"` — an explicit, documented exemption from the principal-equality invariant (R-3: principal must equal the authenticated writer). The full guard inventory, each named:
  1. **`vault_assert` identity resolution (src/tools/positions.ts:122–145):** `"unknown"` becomes a *reserved principal* — reject `access.user === "unknown"` and reject an explicit `principal: "unknown"` argument on an operator (no-access) server, so no live caller can ever write AS the snapshot principal.
  2. **`applyAssert` self-supersession (src/curation/positions.ts:100–107):** needs **no change** — given guard 1, the caller's principal never equals `"unknown"`, so `pos-000` is never auto-superseded. Regression-tested, not re-coded.
  3. **`vault_write` direct foreign-position guard (src/tools/write.ts:1090–1114):** needs **no carve-out for creation** — the guard fires only when the on-disk doc already has `positions != null`, and the snapshot is minted in the very write that first materializes `positions[]` (before-state null). Conversely it already **protects** `pos-000`: any authenticated user altering/removing it is rejected as a foreign-position mutation (`"unknown" !== access.user` always). Both directions proved by test, zero code change.
  4. **Stage-preview guard (src/tools/write.ts:896–911):** same null-gate (`existingPositions != null`), so a propose-only first assert whose staged payload includes `pos-000` passes preview and ratify replay. Test, no code.
  5. **`vault_consolidate` identity (Task 2):** the same reserved-principal rejects as guard 1 (`ratified_by` can never be `"unknown"`).
  6. **Advisory lint backstop (Task 4, check g):** a position with `principal: "unknown"` whose id is not `pos-000`, or >1 `"unknown"` position on one doc, is flagged. Residual accepted risk, stated honestly: LD-13 deliberately allows *appending* foreign entries via raw `vault_write` (the ratify-replay allowance), so a raw write can still fabricate an `"unknown"` entry — lint surfaces it; the write path does not block it, consistent with LD-13.
  - Note: `resolveTension`'s no-access fallback `resolved_by: "unknown"` (src/tools/curation.ts:235) is a different namespace (tension resolutions, not position principals) — harmless collision, no change.
- **DN-4 (locked): consolidate on an uncontested doc is ALLOWED.** A ratified org stance is meaningful without live dissent; `dissent: []` is honest. This extends to a doc whose `positions` is null entirely (an org stance on a legacy doc) — allowed, `dissent: []`. The `accepted` tension-resolution kind is the only surface that *requires* non-empty dissent.
- **DN-5 (locked): the downstream consumer cap is an ADVISORY read-time annotation ONLY.** `vault_read` of a consumer annotates; no consumer doc frontmatter is ever mutated (mutating third docs from a write to a first violates the advisory-curation invariant; the design doc's cap is [HYPOTHESIS]-labeled — ship the cheap reversible form). Fury R-2's "net-new propagation subsystem" is thereby avoided: no transitivity, no reindex recompute — one extra parse per visible compiled edge at read time.
- **DN-2 (locked): pos-000 default ON**, both direct and staged assert branches. Trigger and field sourcing in LD-22.
- **LD-17 Case-1 read key = `ratified_view`.** Sibling optional key next to Slice 1's `contested_positions` (which stays reserved for the unratified case, flag `CONTESTED`, LD-7). The two are mutually exclusive by construction: `contested_positions` requires `org_position == null` (read.ts:274), `ratified_view` requires `org_position != null`. Absent-key discipline for both (upstream_staleness precedent).
- **LD-18 Dissent derivation:** `dissent[]` = ids of **unsuperseded** positions whose stance opposes the ratified stance under the R-1 rule (`assert`↔`dispute`; `qualify` opposes nothing, so a `qualify` org stance always yields `dissent: []`), ordered by `comparePositions` (LD-11). Computed by `vault_consolidate` at ratify time — never hand-supplied.
- **LD-19 `resolve_tension` scope + ordering (answers Fury C-3):** the optional `resolve_tension: {id, kind, rationale?}` is validated **before** any write (kind ∈ `superseded|corrected|accepted`; `accepted` requires this call's computed dissent to be non-empty; the id must name an OPEN tension with `kind === "positional"` and `sourceA === ` the target's canonical relPath — consolidate is not a backdoor generic resolver). The doc write commits **first**, then `resolveTension` runs; a resolve failure after a landed write returns `resolve_error` in the result (mirror of Slice 1's `tension_error` channel, src/tools/positions.ts:72) — the write stands, the tension stays open and re-resolvable via `vault_tension_resolve`. Two files, two writes, stated ordering; no fake atomicity.
- **LD-20 No propose-only path for `vault_consolidate`.** A propose-only role is denied even if `ratify` is (mis)granted in config — a proposer is not a ratifier, and this keeps the rbac.ts:68–74 comment ("vault_write and vault_assert coerce; every other write tool denies") true verbatim. Operator servers (no access context) bypass the gate but must pass an explicit `principal` (LD-25).
- **LD-21 `contested` re-derived by consolidate too:** when `positions != null`, `vault_consolidate` stamps `contested = isContested(positions)` (heals hand-set drift on its way through, same spirit as R-8); when `positions == null` it leaves `contested` null. Consolidate never touches `positions[]` itself — resolution kind `superseded` records the org's verdict on the tension; actually superseding a position remains its holder's (or a subsequent assert's) act.
- **LD-22 pos-000 trigger + field sourcing:** fires in `vault_assert` iff the target doc's typed `fm.positions == null` (every legacy doc; an explicit empty `positions: []` means already opted in — no snapshot). Fields: `id: "pos-000"`, `principal: "unknown"`, `stance: "assert"`, `statement: null`, `confidence: fm.confidence` (the authored pre-cap value), `provenance: fm.provenance`, `valid_from: fm.valid_from`, `superseded_by: null`, `created: fm.updated` (the last edit date of the belief being snapshotted), `sources: []`. `nextPositionId` already ignores it for numbering (max stays 0 → caller gets `pos-001`, src/curation/positions.ts:20–29) — Slice-1 position-id expectations survive unchanged.
- **LD-23 U-11 output key = `contested_inputs`,** shape `{ inputs: [{ unit }], effective_confidence: "low", banner }`, emitted on the consumer read only when ≥1 **visible** compiled upstream unit is contested-unratified (`positions != null && isContested && org_position == null` — NOT merely `confidence: low`, so legacy low-confidence inputs never trigger it; and a ratified-but-still-contested upstream never triggers it, C-1 consistency). It iterates only `upstream.edges` — the already-RBAC-visibility-filtered set (read.ts:225–231) — so unreadable contested upstreams stay silent: no coarsened bucket, no new existence channel (#217 omission rule; the decision is omission, not redaction).
- **LD-24 Slice-1 test expectations updated by U-12 are sanctioned, enumerated changes** (Task 1 lists them). Under DN-2, a dispute on a formerly-legacy doc now conflicts with BOTH the snapshot and the first caller's position → **two** positional tensions (LD-12 already made `tension_ids` plural for exactly this). Any test failure outside Task 1's enumerated list is a regression, not an expectation update.
- **LD-25 Operator-mode consolidate:** with no AccessContext, `vault_consolidate` requires an explicit `principal` argument (recorded as unverified `ratified_by`), mirroring `vault_assert`'s R-3 operator rule (src/tools/positions.ts:135–145). With an AccessContext, an explicit `principal` differing from `access.user` is impersonation → reject.

### Line-number ground truth (verified this run, all [DATA])

| Primitive | Location in this worktree |
|---|---|
| R-9 cap condition (C-1 keeps it) | src/tools/positions.ts:169 |
| vault_assert identity/impersonation block | src/tools/positions.ts:122–145 |
| vault_assert staged branch / write call / tension loop | src/tools/positions.ts:184–216 / :218–229 / :236–271 (claim fallback :252–253) |
| `positionsTools` export (registration point) | src/tools/positions.ts:494; spread at src/server.ts:60 |
| vault_assert tool description ("Slice 2" copy) | src/tools/positions.ts:388–398 |
| `applyAssert` / `nextPositionId` / `comparePositions` / `isContested` / `unsuperseded` | src/curation/positions.ts:85–109 / :20–29 / :58–63 / :37–40 / :31–33 |
| `foreignPositionViolation` (LD-13 rule) | src/curation/positions.ts:123–153 |
| vault_write guard call sites (null-gated) | src/tools/write.ts:1090–1114 (direct), :871–911 (stage preview, `existingPositions` gate :896) |
| `serializeDocument` non-null emit of the three fields | src/tools/write.ts:263–270 |
| `WriteResult["action"]` union (gains `"consolidate"`) | src/tools/write.ts:300–315 |
| `performFrontmatterWrite` / `loadTargetDocument` | src/tools/write.ts:654–692 / :622–649 |
| vault_read `contested_positions` compute / result spread / outputSchema / description | src/tools/read.ts:272–290 / :306–310 / :925–963 / :805–825 |
| compiled-upstream compute + visibility split | src/tools/read.ts:190–252 (`upstream` :246–252; split :225–231); unit path field src/curation/edge-staleness.ts:73–84 |
| `FRONTMATTER_SCHEMA` (tolerant; does NOT enumerate the position fields — no edit needed) | src/tools/read.ts:631–672 |
| `RESOLUTION_KINDS` / `TensionResolution` / `resolveTension` (already-resolved err :432) | src/curation/tension.ts:68–69 / :71–78 / :397–466 |
| vault_tension_resolve resolution construction (copy to mirror) | src/tools/curation.ts:232–245 |
| ratify-denial copy to mirror | src/tools/staged-actions.ts:266 |
| `canRatify` / `isProposeOnly` comment | src/access/rbac.ts:64–66 / :68–74 |
| `positionIntegrity` lint block / `LINT_CHECKS` (name exists; NO new check name → no lint-voice ripple) | src/curation/lint.ts:372–405 / :48–64 |
| `optionalOrgPosition` validator (all four required fields + dissent coercion) | src/frontmatter/schema.ts:345–380 |
| `recordProvenance` contract | src/curation/provenance.ts:69–95 |
| Compiled-edge test recipe (run-correlation: read with `run_id`, then write with same `run_id`) | test/tools/edge-staleness.test.ts:32–57 |
| architecture.md tool-count pins (37 → 38; test in test/server.test.ts) | IMPL-REPORT deviation 6 — update BOTH prose sites in the same task that registers the tool |

Spec corrections against real code (TRUST THE CODE): the spec's U-10 seed says "consolidate on uncontested doc → err … or allow per DN-4" — DN-4's default **allow** is locked above. The spec's U-7 note "an org_position simply suppresses the CONTESTED flag" is exactly what shipped (read.ts:274); Task 3 builds case 1 on that gate rather than re-deriving it. The spec's `tension_id` singular was already superseded by LD-12 plural in Slice 1.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/curation/positions.ts` | modify | `legacySnapshot(fm)` pure fn (U-12); `dissentIds(positions, stance)` pure fn (LD-18) |
| `src/tools/positions.ts` | modify | reserved-principal rejects + pos-000 integration in `vault_assert` (U-12); new `vaultConsolidate` + ToolDefinition appended to `positionsTools` (U-10) |
| `src/tools/write.ts` | modify | `WriteResult["action"]` gains `"consolidate"` (one line) |
| `src/tools/read.ts` | modify | `ratified_view` case-1 block (R-17); `contested_inputs` advisory annotation (U-11); outputSchema + description for both |
| `src/curation/lint.ts` | modify | three new advisory `positionIntegrity` sub-checks (e/f/g) — same check name, no `LINT_CHECKS` change |
| `docs/architecture.md` | modify | tool count 37→38 (both prose sites); Slice-2 sentences in the positions paragraph |
| `test/curation/positions.test.ts` | modify | `legacySnapshot` + `dissentIds` pure tests; pos-000-never-superseded regression |
| `test/tools/positions.test.ts` | modify | U-12 integration + enumerated Slice-1 expectation updates (LD-24); U-10 `vault_consolidate` tests + registry assertion |
| `test/tools/read-positions.test.ts` | modify | R-17 `ratified_view` tests |
| `test/tools/read-consumes-positions.test.ts` | create | U-11 `contested_inputs` tests (run-correlation recipe) |
| `test/tools/write.test.ts` | modify | C-2 guard tests 3/4 (pos-000 protected; staged snapshot passes) |
| `test/curation/lint.test.ts` | modify | checks e/f/g |

Conventions (unchanged from Slice 1): functions + types, no classes; `Result<T, Error>`, never throw from handlers; canonicalize caller paths at the tool boundary (#127/#128); tests mirror src/; commit after each green task. Harness: `makeTempVault`/`cleanupVault` (`test/helpers/temp-vault.js`; the `pricing` collection exists in the fixture vault); AccessContext literals per `test/tools/write-propose-only.test.ts:12–22`; operator-mode calls pass `access === undefined` + explicit `principal`.

---

## Task 1 (U-12): Legacy snapshot `pos-000` on first assert

**Maps to:** U-12, DN-2, C-2 (guards 1–4), LD-22, LD-24. **Depends on:** nothing (do FIRST — Tasks 2–5 then write their tests against final assert behavior).

**Files:** `src/curation/positions.ts`, `src/tools/positions.ts`; tests `test/curation/positions.test.ts`, `test/tools/positions.test.ts`, `test/tools/write.test.ts`.

- [ ] **Step 1.1: RED — pure-logic tests** (`test/curation/positions.test.ts`):
1. `legacySnapshot` over a frontmatter with `confidence: high, provenance: direct, valid_from: null, updated: 2026-08-01` → exactly the LD-22 Position (`id: "pos-000"`, `principal: "unknown"`, `stance: "assert"`, `statement: null`, `created: "2026-08-01"`, `sources: []`, `superseded_by: null`).
2. `applyAssert([legacySnapshot(fm)], aliceAssert)` → new position id `pos-001` (numbering unaffected), `superseded === null`, and `pos-000.superseded_by` still null (guard 2 regression: alice's assert never supersedes the snapshot).
3. `isContested([pos-000(assert), aliceAssert-result])` → false; with a bob `dispute` appended → true (the snapshot is a live assert side).

- [ ] **Step 1.2: RED — tool-level tests** (`test/tools/positions.test.ts`), operator-mode (`access === undefined`, explicit `principal`):
1. First assert (`principal: "carol"`, stance assert) on a legacy fixture doc → resulting doc has `positions` length 2: `[pos-000 {principal: "unknown", confidence: <the doc's prior authored confidence>, created: <the doc's prior updated>}, pos-001 {principal: "carol"}]`; `contested: false`; `tension_ids: []`.
2. First assert with stance `dispute` on a legacy doc → `contested: true`, doc confidence stamped `low`, exactly ONE positional tension naming `pos-000`/`pos-001` (the snapshot is the explicit thing being contested — design §6), claim A falls back to `"<title> — assert (<confidence>)"` (statement null path, src/tools/positions.ts:252–253).
3. Assert on a doc that already has `positions: []` (explicit empty list in frontmatter) → NO `pos-000`; single `pos-001` (LD-22 trigger is typed-null only).
4. Reserved principal, operator mode: `principal: "unknown"` → err naming the reservation; nothing written.
5. Reserved principal, authenticated: AccessContext with `user: "unknown"` (writer role) → err; nothing written.
6. Second principal's assert on the now-positioned doc → NO second snapshot (positions non-null).
7. Propose-only role's first assert on a legacy doc → `action: "staged"`, file untouched, and the staged `proposedDiff.frontmatter.positions` carries BOTH `pos-000` and the proposer's `pos-001` (C-2 guard 4 half: the payload is complete).

- [ ] **Step 1.3: RED — guard tests** (`test/tools/write.test.ts`):
1. C-2 guard 3: after a first assert created `pos-000`, an authenticated writer's `vault_write` update that alters `pos-000.statement` (or drops the entry) → rejected as foreign-position mutation, provenance `rejected_foreign_position` logged — proving no code change was needed to protect the snapshot.
2. C-2 guard 4: the staged first-assert payload from Step 1.2(7), replayed via the ratify dispatch path (or, cheaper, a direct authenticated `vault_write` update carrying the same merged positions onto the still-legacy doc) → lands; guard silent because on-disk `positions` was null.

- [ ] **Step 1.4: Run — expected FAIL** — `legacySnapshot` doesn't exist; first-assert results have 1 position.

- [ ] **Step 1.5: GREEN — implement.**
1. `src/curation/positions.ts`: add `legacySnapshot(fm: Pick<Frontmatter, "confidence" | "provenance" | "valid_from" | "updated">): Position` per LD-22. Pure, no I/O.
2. `src/tools/positions.ts` identity block (:122–145): after resolving `principal`, reject when it equals `"unknown"` (both branches — one check on the resolved value covers authenticated and operator paths): `vault_assert: 'unknown' is reserved for the legacy snapshot principal (pos-000)`.
3. Same file, before `applyAssert` (:158): `const basePositions = fm.positions ?? [legacySnapshot(fm)];` and pass `basePositions` instead of `fm.positions`. Both the staged branch and the direct branch already consume `applied.positions` — snapshot flows through untouched. Comment the DN-2/C-2 decision at the call site.
4. Update the `vault_assert` tool description (:388–398) with one sentence: the first assert on a legacy doc snapshots the prior belief as `pos-000` (`principal: "unknown"`, system-authored, unforgeable).

- [ ] **Step 1.6: GREEN — update the enumerated Slice-1 expectations (LD-24)** in `test/tools/positions.test.ts` ONLY:
1. Happy-path assert-on-legacy-doc: positions length 1 → 2 (`pos-000` first); the `pos-001` id/principal assertions stand.
2. "bob disputes → …one positional tension (mandated)": tension count 1 → **2** (bob's dispute now pairs with `pos-000` AND alice's `pos-001`); confidence-cap and `contested` assertions stand.
3. "alice re-asserts → pos-003 supersedes pos-001, bob untouched": ids stand (LD-22 numbering note); any positions-length or tension-count literal adjusts (+1 for `pos-000`, plus whatever new-pair tension the existing Slice-1 dedup rule already mints — R-3 pair dedup itself is unchanged).
4. Propose-only staged test: staged payload length 1 → 2.
Any failure outside this list (and outside `test/tools/write.test.ts` additions) is a regression — stop and fix the implementation, not the test.

- [ ] **Step 1.7: Run — expected PASS** — `npx vitest run test/curation/positions.test.ts test/tools/positions.test.ts test/tools/write.test.ts test/tools/read-positions.test.ts` (read-positions fixtures are hand-written position arrays — they must pass UNCHANGED; if one fails, that's a regression).

- [ ] **Step 1.8: Commit** — `feat(positions): pos-000 legacy snapshot on first assert (U-12, C-2 carve-out)`

**REFACTOR note:** none expected; if the reserved-principal check reads awkwardly inline, extract `assertPrincipalNotReserved(principal): Result<void, Error>` locally — do not move it into curation/ (it is tool-boundary policy).

---

## Task 2 (U-10, write half): `vault_consolidate`

**Maps to:** R-16, DN-4, LD-18, LD-19, LD-20, LD-25, C-1 (mirror + cap clear). **Depends on:** Task 1 (tests written against post-U-12 assert behavior).

**Files:** `src/curation/positions.ts` (`dissentIds`), `src/tools/positions.ts` (handler + ToolDefinition), `src/tools/write.ts` (action union, one line), `docs/architecture.md` (tool count 37→38, BOTH prose sites — the test in `test/server.test.ts` pins them; IMPL-REPORT deviation 6); tests `test/curation/positions.test.ts`, `test/tools/positions.test.ts`.

- [ ] **Step 2.1: RED — pure `dissentIds` tests** (`test/curation/positions.test.ts`):
1. Live set {alice assert(high), bob dispute(medium), carol qualify} with org stance `assert` → `["<bob's id>"]`; with org stance `dispute` → alice's id only; with org stance `qualify` → `[]`.
2. A superseded dispute never appears in dissent.
3. Two live disputes → both ids, `comparePositions` order (confidence desc, created desc, id asc).

- [ ] **Step 2.2: RED — tool tests** (`test/tools/positions.test.ts`). Fixture recipe: legacy doc → assert as alice (writer access or operator+principal), dispute as bob → contested doc with `pos-000`, `pos-001`(alice assert), `pos-002`(bob dispute), confidence `low`, two open positional tensions. Ratifier AccessContext = a role with `ratify: true` (mirror the config shape used by staged-action ratify tests).
1. **Mandated — ratifier consolidates with resolve:** carol (`canRatify`) calls `vault_consolidate {path, stance: "assert", confidence: "medium", agent, resolve_tension: {id: <the pos-001×pos-002 tension>, kind: "accepted", rationale: "standing dissent"}}` → result `action: "consolidate"`; doc frontmatter `org_position === {stance: "assert", confidence: "medium", ratified_by: "carol", ratified_at: <today>, dissent: ["pos-002"]}`; doc `confidence === "medium"` (R-9 cap CLEARED by the mirror); `contested` still `true` (LD-21 — the live set is unchanged); the named tension resolved with `kind: "accepted"`, `resolved_by: "carol"`; the OTHER tension (pos-000 pair) still open; commit present; provenance entry `tool: "vault_consolidate", action: "consolidate", principal: "carol"`.
2. Dissent derivation is server-owned: the result/frontmatter `dissent` includes bob's live dispute id and, when the org stance is `assert`, NOT `pos-000` (an assert-side snapshot is not dissent); consolidating the same doc to stance `dispute` instead → dissent = the live assert ids including `pos-000`.
3. **Mandated — non-ratifier denied:** writer-role alice → err mirroring the staged-actions.ts:266 copy shape (`access denied: role '<roleName>' cannot consolidate…`), file unchanged.
4. **Mandated — `accepted` with empty dissent:** ratifier consolidates an UNCONTESTED doc (single live assert) with `resolve_tension.kind: "accepted"` → err (`'accepted' requires standing dissent`), nothing written (LD-19 validates before the write).
5. **DN-4:** ratifier consolidates an uncontested doc WITHOUT `resolve_tension` → succeeds, `dissent: []`, confidence mirrored; same on a fully legacy doc (`positions` null) → succeeds, `org_position` written, `contested` stays null.
6. `resolve_tension` scoping: id of a non-positional open tension, or of a positional tension on a DIFFERENT doc, or an already-resolved id → err, nothing written; kind `invalid` → err (not in the consolidate subset).
7. Impersonation/identity: authenticated carol passing `principal: "dave"` → err; operator mode without `principal` → err demanding it; operator mode with `principal: "carol"` → `ratified_by: "carol"`; `principal: "unknown"` → reserved err (C-2 guard 5).
8. LD-20: propose-only role (even with `ratify: true` in its config) → denied, nothing staged.
9. Re-consolidation: second `vault_consolidate` with a different stance/confidence overwrites `org_position` (new `ratified_at`), provenance diff records before/after.
10. Registry: `registeredToolNames()` includes `vault_consolidate`.
11. C-1 regression (write half): after consolidation, dave (writer) asserts a NEW dispute → doc confidence STAYS at the mirrored value (cap does not re-apply, src/tools/positions.ts:169 condition), `contested: true`, a fresh positional tension mints.

- [ ] **Step 2.3: Run — expected FAIL** — `vaultConsolidate` doesn't exist.

- [ ] **Step 2.4: GREEN — implement.**
1. `src/curation/positions.ts`: `dissentIds(positions: Position[], stance: Stance): string[]` — `unsuperseded` → opposing-stance filter (reuse the `conflictPairs` opposite mapping) → `comparePositions` sort → ids.
2. `src/tools/write.ts:302–315`: add `| "consolidate"` to the action union.
3. `src/tools/positions.ts`: `vaultConsolidate(vaultRoot, args, access)` following `vaultAssert`'s skeleton — `requireIndexReady`; parse `path`, `stance` (STANCES), `confidence` (CONFIDENCES), `agent`, optional `principal`, `run_id`, `resolve_tension` (object: required `id`/`kind` strings, optional `rationale`); identity per LD-25 + reserved-`"unknown"` reject; gates in order: `isProposeOnly` deny (LD-20), then `access && !canRatify(access.role)` deny (staged-actions.ts:266 copy shape); `loadTargetDocument` (canonicalizes, #127/#128); compute `dissent = dissentIds(fm.positions ?? [], stance)`; validate `resolve_tension` per LD-19 (needs one `listTensions` call — the same call vault_assert already makes on the mint path); build `newFrontmatter`: `org_position` (LD-18/R-16 fields, `ratified_at: todayISO()`), `confidence: <input confidence>` (the mirror — this IS the R-9 cap clear), `contested` per LD-21, `updated`/`updated_by` restamped; `performFrontmatterWrite` with `action: "consolidate"`, commit message `vault_consolidate: <stance> on <relPath> ratified by <ratifier>`; then, if requested, `resolveTension(vaultRoot, id, {resolved_at: new Date().toISOString(), resolved_by: ratifier, kind, rationale?})` (construction mirrors src/tools/curation.ts:237–245) with failure → `resolve_error`.
4. Result type `ConsolidateResult { path, action: "consolidate", org_position, confidence, dissent, contested, resolved_tension_id, resolve_error?, commit, committed }`; ToolDefinition (input/output schemas in the neighboring style, `annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }`; description states: ratify-gated, dissent computed not supplied, `accepted` requires standing dissent, resolve ordering per LD-19, DN-4 allowed-on-uncontested); append to `positionsTools` (:494) — registration is automatic (server.ts:60).
5. `docs/architecture.md`: both `NN tools` prose sites 37 → 38.

- [ ] **Step 2.5: Run — expected PASS** — `npx vitest run test/curation/positions.test.ts test/tools/positions.test.ts test/server.test.ts` (server.test proves the count pins and registry).

- [ ] **Step 2.6: Commit** — `feat(tools): vault_consolidate — ratified org_position, dissent carrying, in-call tension resolve (U-10)`

**REFACTOR note:** `vaultAssert` and `vaultConsolidate` will share arg-parsing helpers (`str`/`optStr` already exist) and the identity-resolution block; if the identity block is extracted, extract AFTER both are green, into a file-local `resolvePrincipal(args, access, tool)` — behavior-preserving, covered by the existing impersonation tests.

---

## Task 3 (U-10, read half — R-17): `ratified_view` compile case 1

**Maps to:** R-17, C-1 (read-side honesty), LD-17. **Depends on:** Task 2 (needs a consolidator to build fixtures; hand-written `org_position` fixtures also work and are used for the schema-only cases).

**Files:** `src/tools/read.ts`; tests `test/tools/read-positions.test.ts`.

- [ ] **Step 3.1: RED** (`test/tools/read-positions.test.ts`):
1. **Mandated — read after consolidation:** consolidate the Task-2 recipe doc (`accepted`, dissent `["pos-002"]`), then `vaultRead` → `ratified_view` present: `flag: "RATIFIED"`, `stance`/`confidence`/`ratified_by`/`ratified_at` echoing `org_position`; `dissent` is the RESOLVED positions (full Position objects for `pos-002`, LD-11-ordered), not bare ids; `note` names the org position AND the standing dissent (mandatory when dissent non-empty — assert the note mentions dissent); `contested_positions` key ABSENT (mutually exclusive, LD-17); frontmatter `confidence` = the mirrored value.
2. Dissent-empty ratified doc (consolidate an uncontested doc, DN-4) → `ratified_view` present, `dissent: []`, note has NO dissent clause.
3. **C-1 re-contest honesty:** after consolidation, a new dispute lands (fresh open positional tension) → `ratified_view.open_tension_ids` non-empty and the note carries the re-contest clause; doc confidence still the mirror.
4. Fully-resolved ratified doc (only tension resolved `accepted` at consolidate time) → `open_tension_ids` limited to genuinely open entries (the pos-000-pair tension from the recipe remains open unless also resolved — assert exact ids).
5. Legacy doc and unratified contested doc → NO `ratified_view` key (absent-key discipline; the existing `contested_positions` tests keep passing untouched).
6. Hand-written fixture with `org_position.dissent: ["pos-999"]` (dangling) → `ratified_view.dissent` omits the unresolvable id (raw frontmatter still carries it; lint flags it in Task 4).

- [ ] **Step 3.2: Run — expected FAIL** — no `ratified_view` key.

- [ ] **Step 3.3: GREEN — implement** in `src/tools/read.ts`:
1. Hoist the open-positional-tension-id computation out of the `contested_positions` block (:275–283) so both blocks share one `listTensions` scan (conditions are exclusive — only one block ever emits; run the scan when `posSet != null || org != null`).
2. After the `contested_positions` block: when `parsed.value.frontmatter.org_position != null`, build `ratified_view`: `{ flag: "RATIFIED", stance, confidence, ratified_by, ratified_at, dissent: <org.dissent ids resolved against (positions ?? []), missing ids omitted, comparePositions order>, open_tension_ids, note }`. Note composition: `org position: <stance> (<confidence>), ratified by <ratified_by> <ratified_at>`; append `; standing dissent: N minority position(s) remain live` when dissent non-empty; append `; re-contested: open positional tension(s) contest the ratified view` when `open_tension_ids` non-empty (this is C-1's read-side surface).
3. `VaultReadResult` gains optional `ratified_view` (typed next to `contested_positions`, read.ts:137–142); result spread (:306–310) adds it; outputSchema gains the sibling object after `contested_positions` (:925–963), reusing the position item schema; description (:805–825) gains one clause ("a ratified_view block when an org position is ratified — the org's belief at its confidence, with dissent carried").
4. No change to the LD-15 visibility stance: positional tensions are self-tensions on the doc being read; the caller passed `canRead` — ids visible by construction (keep the code comment).

- [ ] **Step 3.4: Run — expected PASS** — `npx vitest run test/tools/read-positions.test.ts test/tools/read.test.ts`.

- [ ] **Step 3.5: Commit** — `feat(read): ratified_view — compile case 1 with mandatory dissent + re-contest surface (R-17)`

**REFACTOR note:** if the hoisted tension scan makes `vaultRead` read awkwardly, extract a file-local `openPositionalTensionIds(vaultRoot, relPath)` helper — read.ts only.

---

## Task 4 (U-10 lint tail): advisory org-position integrity checks

**Maps to:** R-16 (mirror invariant surfaced), C-2 guard 6, LD-18 honesty. **Depends on:** Task 2 (semantics), independent of Task 3.

**Files:** `src/curation/lint.ts` (extend the existing `positionIntegrity` block :372–405 — same check name, so NO `LINT_CHECKS`, no tool-schema, and no lint-voice edits; the Slice-1 ripples of IMPL-REPORT deviations 4–5 cannot recur); tests `test/curation/lint.test.ts`.

- [ ] **Step 4.1: RED** (`test/curation/lint.test.ts`, extending the existing `positionIntegrity` describe with hand-written fixtures):
1. (e) mirror drift: doc with `org_position.confidence: medium` but doc `confidence: high` → finding naming both values; a consistent pair → no finding.
2. (f) dangling dissent: `org_position.dissent: ["pos-999"]` with no such position id → finding naming `pos-999`; dissent ids that exist (even superseded ones) → no finding.
3. (g) unknown-principal anomaly: a position `principal: "unknown"` with id `pos-007` → finding; two `"unknown"` positions on one doc → finding; a single well-formed `pos-000` → NO finding (the sanctioned snapshot is clean).
4. The Slice-1 clean-contested and legacy-doc no-finding tests still pass unchanged.
5. Existing check (d) regression: a ratified contested doc whose confidence matches the mirror produces NO (d) finding (`org_position != null` short-circuits it, lint.ts:399) — pin it now that ratified docs exist.

- [ ] **Step 4.2: Run — expected FAIL.**

- [ ] **Step 4.3: GREEN:** inside the `positions != null` branch, and a new sibling branch for `fm.org_position != null` (checks e/f must fire even when `positions` is null — a legacy doc consolidated under DN-4 can still hand-drift): (e) `fm.org_position != null && fm.confidence !== fm.org_position.confidence`; (f) each `org_position.dissent` id absent from the position-id set (empty set when positions null → every id dangles); (g) per-position `principal === "unknown" && id !== "pos-000"`, plus a count of `"unknown"` positions > 1. Detail strings in the existing block's register. Advisory only — report, never fix.

- [ ] **Step 4.4: Run — expected PASS** — `npx vitest run test/curation/lint.test.ts test/tools/curation.test.ts`.

- [ ] **Step 4.5: Commit** — `feat(lint): org_position mirror/dissent/unknown-principal advisory checks (U-10 tail)`

---

## Task 5 (U-11): downstream consumer advisory cap — `contested_inputs`

**Maps to:** design §4 cap ([HYPOTHESIS] in the design doc — hence the cheap reversible form), DN-5, LD-23. **Depends on:** Tasks 1–2 (fixtures assert + consolidate); read-side independent of Task 3.

**Files:** `src/tools/read.ts`; tests `test/tools/read-consumes-positions.test.ts` (create — keeps the run-correlation harness separate from the frontmatter-only read-positions tests).

- [ ] **Step 5.1: RED** (`test/tools/read-consumes-positions.test.ts`). Compiled-edge recipe [DATA]: `vaultRead(vault, upstreamPath, undefined, "run-1")` then `vaultWrite(consumer, {..., run_id: "run-1"})` (test/tools/edge-staleness.test.ts:32–57). Make the upstream contested via two operator-mode `vault_assert` calls (alice assert, bob dispute).
1. **Happy path:** consumer whose compiled input is contested-unratified → `vaultRead(consumer)` result has `contested_inputs`: `inputs` lists the upstream unit's canonical relPath, `effective_confidence: "low"`, banner states the inputs are contested without a ratified org position and the content should be treated as low-confidence until consolidated. The consumer's own frontmatter `confidence` is UNTOUCHED on disk (advisory invariant — re-read the file bytes to prove no mutation).
2. Upstream then consolidated (ratifier writes `org_position`) → re-read consumer: `contested_inputs` ABSENT (ratified-but-still-contested does not cap, C-1/LD-23).
3. Upstream legacy (no positions) or uncontested (single position) → absent.
4. Consumer with no compiled edges at all → absent (and the whole read byte-identical to today — no new key).
5. RBAC omission: reader whose role cannot read the upstream's collection reads the consumer → `contested_inputs` ABSENT entirely (the upstream edge itself is invisible per the split at read.ts:225–231); no count, no hint.
6. Two compiled inputs, one contested-unratified one clean → `inputs` lists exactly the contested one.

- [ ] **Step 5.2: Run — expected FAIL** — no `contested_inputs` key.

- [ ] **Step 5.3: GREEN — implement** in `src/tools/read.ts`:
1. After `upstream` is computed (:246–252): for each `upstream?.edges ?? []` entry, `resolveVaultPath` + `readFile` + `parseDocument` the `unit`; collect units where `positions != null && isContested(positions) && org_position == null` (LD-23 condition). Any per-unit failure → skip silently (advisory; same best-effort posture as the surrounding telemetry, read.ts:177–190 comment).
2. Non-empty → `contested_inputs = { inputs: [{ unit }], effective_confidence: "low", banner: "<N> compiled input(s) of this document are contested without a ratified org position — treat this content as low-confidence until consolidated." }`; absent otherwise.
3. `VaultReadResult` optional key + result spread + outputSchema sibling + one description clause ("an advisory contested_inputs annotation when a compiled input is contested-unratified — the annotation caps effective confidence at read time; consumer frontmatter is never mutated").
4. Comment the cost posture: one extra file parse per VISIBLE compiled edge, only on instrumented vaults; escalation path (index mirror) mirrors the :181–189 note — do not build it.

- [ ] **Step 5.4: Run — expected PASS** — `npx vitest run test/tools/read-consumes-positions.test.ts test/tools/read.test.ts test/tools/edge-staleness.test.ts`.

- [ ] **Step 5.5: Commit** — `feat(read): advisory contested_inputs cap on consumers of contested-unratified inputs (U-11)`

**REFACTOR note:** the per-unit parse loop belongs inline (it is read-path policy); if it grows past ~25 lines extract file-local `contestedUpstreamInputs(vaultRoot, edges)`.

---

## Task 6: wiring, copy, docs (last, small)

**Maps to:** surface documentation for U-10/U-11/U-12; exposure for all. **Depends on:** Tasks 1–5.

- [ ] **Step 6.1:** `docs/architecture.md` positions paragraph: extend with two Slice-2 sentences — `vault_consolidate` (ratify-gated org position, dissent carried not erased, doc confidence mirrors the ratified confidence and the low-cap clears; a later re-contest never re-caps — re-consolidation is the only mover), and pos-000 (`principal: "unknown"`, system-authored on first assert, reserved and unforgeable) + the advisory `contested_inputs` read annotation. Verify the 38-count edit from Task 2 landed in BOTH prose sites.
- [ ] **Step 6.2:** Confirm the `vault_assert` description no longer promises "(Slice 2)" for ratification (Task 1 touched the adjacent sentence; update the "until an org position is ratified (Slice 2)" clause at src/tools/positions.ts:393–394 to drop the slice marker).
- [ ] **Step 6.3:** `npm run build && npm run lint` — clean; fix Biome findings (import order, template style) without behavior change.
- [ ] **Step 6.4: Commit** — `docs: consolidation + pos-000 + contested_inputs concepts; assert copy (Slice 2 wiring)`

---

## Verification (Slice-2 done gate)

- [ ] `npm run build` — clean (proves the `WriteResult` union and the new result typings).
- [ ] `npm test` — full suite. **Known flake [DATA, memory]:** embedding/search tests can go red when MiniLM fails to load — re-run the failed files before diagnosing a regression.
- [ ] `npm run lint` — Biome (`biome check src test`) clean.
- [ ] Targeted sweep: `npx vitest run test/curation/positions.test.ts test/tools/positions.test.ts test/tools/read-positions.test.ts test/tools/read-consumes-positions.test.ts test/tools/write.test.ts test/curation/lint.test.ts test/server.test.ts`

Mandated-scenario acceptance map (every one must be green):

| Mandated scenario | Test |
|---|---|
| Ratifier consolidates → org_position + confidence mirror + tension resolved in one call | positions.test.ts Task-2 scenario 1 |
| Non-ratifier consolidate → denied | positions.test.ts Task-2 scenario 3 |
| `accepted` with empty dissent → err, nothing written | positions.test.ts Task-2 scenario 4 |
| Read after consolidation → case-1 block with mandatory dissent annotation | read-positions.test.ts Task-3 scenario 1 |
| Consolidate on uncontested doc → allowed, `dissent: []` (DN-4) | positions.test.ts Task-2 scenario 5 |
| Downstream consumer of contested-unratified input → advisory low-cap annotation, no mutation (DN-5) | read-consumes-positions.test.ts Task-5 scenarios 1–2 |
| First assert on legacy doc → pos-000 snapshot; unforgeable and protected (C-2) | positions.test.ts Task-1 scenarios 1/4/5 + write.test.ts Task-1 guard tests |
| Re-contest of a ratified doc → mirror holds, cap does not re-apply, read surfaces re-contest (C-1) | positions.test.ts Task-2 scenario 11 + read-positions.test.ts Task-3 scenario 3 |

- [ ] Manual smoke: `npm run dev` against test/fixtures/sample-vault; assert as alice, dispute as bob (take-turns restarts), read → CONTESTED + two tensions (pos-000 pair + pos-001 pair); restart as a ratify-granted user, `vault_consolidate` with `resolve_tension accepted` → read shows RATIFIED with dissent; `vault_lint` — no positionIntegrity findings on the consolidated doc.

## Deferred to Implementation

- Exact JSON Schema literals for `vault_consolidate`'s input/outputSchema and the two new read keys (shapes fixed above; literals follow the neighboring ToolDefinition style, reusing `POSITION_SCHEMA` src/tools/positions.ts:356–382).
- Exact denial/err copy strings (shapes and mirrored sources named per step; keep the #212 no-existence-leak discipline — never echo a caller path into a not-found/denial message, IMPL-REPORT deviation 3).
- Whether Task 3's shared tension scan and Task 2's `listTensions` validation reuse one helper — decide after both are green.
- Line-number drift: citations above were verified this run; re-verify on checkout before editing (the Slice-1 plans' drift-table discipline).

## Follow-ups / out of scope (do NOT build now)

- **Slice 3 = U-13 per-mutation write lease** (R-18): replaces the exclusive per-vault process lock so principals stop taking turns. Needs its own design pass against `src/lifecycle/lock.ts` — the live-holder precedence rules (stdio SIGTERM takeover, serve refusal, `--takeover`) are richer than the design doc's one-liner. Do not start from this plan or the spec alone. No file in this plan touches locking.
- N-ary tensions, quorum ratification, cryptographic identity, `on_behalf_of` delegation (design Open Q5), `vault_search` filter on `contested`, court/docket surfacing of positional tensions (blocked on the 2026-07-14 edge-graph existence-disclosure spec revisit), witness/track-record integration.
- Any promotion of `contested_inputs` from advisory annotation to stored state (index mirror) — only if the read-time cost measurably hurts.
