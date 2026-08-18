# Vault Board — finding-centric curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan Implementation-Unit by Implementation-Unit. The execution skill owns the per-unit test-first cycle.

**Readiness:** implementation-ready
**Goal:** A vault-native, access-scoped curation board that turns daftari's detection findings into durable, dispositionable cards with bounded agent authority.
**Architecture:** Findings are derived on demand from the 5 existing detection surfaces through a per-source adapter interface, given stable identity (native ID or synthesized key + evidence-fingerprint), and LEFT-JOINed at read time against an append-only disposition ledger under `.daftari/`. Human disposition and agent resolution are two separate access-native MCP tools; the `/board` HTTP route runs behind serve's existing `authenticate()`. No materialization, no background job.
**Tech Stack:** TypeScript, `node:http`, existing daftari `src/curation/*` engines, `src/access/rbac.ts`, `src/serve` auth, vitest.
**Source spec:** `docs/superpowers/specs/2026-08-18-vault-board-finding-curation-design.md` (32 R-IDs)

---

## Requirements

Traced from the source spec (R1–R32). Not restated here — each Implementation Unit cites the R-IDs it advances. See the spec for full text.

---

## File structure

**New module `src/board/`:**
- `types.ts` — `Finding`, `LedgerEvent`, `BoardColumn`, `Disposition`, `FindingSource` interface. Single responsibility: shared types.
- `identity.ts` — deterministic identity-key derivation (native passthrough vs synthesized hash + discriminator rule) and evidence-fingerprint hashing; `IDENTITY_SCHEME_VERSION` const.
- `ledger.ts` — append-only read/write of `.daftari/board-dispositions.jsonl`; replay-by-identity → current disposition + full history.
- `reconcile.ts` — pure LEFT-JOIN of live findings × ledger → per-finding column + emitted system events (`reopened`, verified `resolved`).
- `principals.ts` — configured-principal resolution + validation (owner/reassign gate).
- `sources/index.ts` — `FindingSource` registry (source-agnostic core).
- `sources/lint.ts`, `sources/staleness.ts`, `sources/staged.ts`, `sources/tier2.ts`, `sources/tension.ts` — the 5 adapters.
- `board.ts` — engine: `listBoard(vaultRoot, access)` runs registry → RBAC filter → reconcile → columns.

**Modified:**
- `src/tools/board.ts` (new) — MCP tools `vault_board_list`, `vault_board_dispose`, `vault_board_resolve`; registered in the tool factory.
- `src/serve/index.ts` — mount `/board` + `/api/board` route handlers behind the existing `authenticate()` before the `/mcp` 404 gate.
- `src/view/board-page.ts` (new) — server-rendered board HTML (columns + filters).
- `src/view/server.ts` + `src/view/pages.ts` — doc-page "open findings" links (admin-loopback convenience).
- `src/utils/config.ts` — extend for a configured-principal list (or derive from `server.auth.tokens[].user`).
- `.gitignore` — add `.daftari/board-dispositions.jsonl`.

---

## Implementation Units

### U1. Board core types
**Goal:** Define the shared type surface the whole module builds on.
**Requirements:** R3, R21, R24.
**Dependencies:** none.
**Files:** `src/board/types.ts`.
**Approach:**
- `Finding` fields per R24 (identity_key, source, check, target, discriminator?, fingerprint, certainty, evidence, suggested_action, verify_predicate, owner, first_seen, last_seen, disposition, history).
- `LedgerEvent` per the spec data model (finding_id, event, by, principal_type, at, rationale?, expiry?, against_fingerprint, owner?, identity_scheme_version).
- `FindingSource` interface: `list(vaultRoot, access) → Promise<Finding[]>`, `identityOf(raw) → string`, `fingerprintOf(raw) → string`, `reproduces(identity_key, vaultRoot, access) → Promise<boolean>`.
- `BoardColumn = "new" | "accepted" | "waiting" | "resolved" | "dismissed"`.
**Test scenarios:** Test expectation: none — types only.
**Patterns to follow:** existing `src/curation/*` type-first module layout.
**Verification:** `tsc` clean; types imported by later units without shape churn.

### U2. Identity + fingerprint core
**Goal:** Deterministic identity keys and evidence fingerprints — the make-or-break data model.
**Requirements:** R1, R2, R3, R4, R11.
**Dependencies:** U1.
**Files:** `src/board/identity.ts`, `src/board/identity.test.ts`.
**Approach:**
1. `deriveIdentity(source, check, target, discriminator?)` → for tensions/staged actions the caller passes the native ID as `target` and identity is `source:nativeId`; otherwise a stable hash over the ordered tuple.
2. Discriminator is an explicit parameter the *adapter* supplies (R2) — `identity.ts` only guarantees it participates in the hash when present, never derived from volatile fields here.
3. `fingerprint(evidence)` → stable hash of a canonicalized evidence object (sorted keys).
4. Export `IDENTITY_SCHEME_VERSION` const stamped onto every ledger event (R11).
**Test scenarios:**
- Same `(source, check, target)` twice → identical key (Covers R4).
- Two findings same `(source, check, target)` different discriminator → distinct keys.
- Native-ID source (`tension-007`) → key stable and independent of evidence text.
- `fingerprint` changes when a volatile field (score) changes but identity key does not (input: same target, drifted score; expected: same key, different fingerprint) (Covers R3).
- Canonicalization: evidence objects with reordered keys → identical fingerprint.
**Patterns to follow:** any existing hashing helper in `src/` (reuse, don't add a crypto dep).
**Verification:** property-style determinism holds across repeated calls.

### U3. Disposition ledger
**Goal:** Durable append-only event store + replay to current disposition with history.
**Requirements:** R5, R8, R9, R10, R11, R12, R30.
**Dependencies:** U1.
**Files:** `src/board/ledger.ts`, `src/board/ledger.test.ts`.
**Files touched at runtime:** `.daftari/board-dispositions.jsonl`.
**Approach:**
1. `appendEvent(vaultRoot, event)` — mirror `src/curation/provenance.ts:72-98` (`mkdirSync` `.daftari`, `appendFile(JSON.stringify+"\n")`); stamp `identity_scheme_version`.
2. `loadLedger(vaultRoot)` — parse all lines, group by `finding_id`, preserve order = history.
3. `currentDisposition(events)` — fold history to the latest human/system state, exposing `against_fingerprint`, `expiry`, `owner`.
4. Corrupt line → skip that line, keep the rest (failure isolation), never throw the whole load.
**Test scenarios:**
- Append then load → event round-trips with scheme version stamped.
- Replay: accept → defer → dismiss folds to `dismissed` with full ordered history (Covers R30 across restart: reload from disk yields same state).
- `dismiss` with past-dated `expiry` → `currentDisposition` flags expiry-elapsed (feeds R9 in U4).
- Disposition carries `against_fingerprint` from the event (feeds R10).
- One malformed JSONL line → other events still load.
- `first_seen`/`last_seen` derivable from event timestamps (R12).
**Patterns to follow:** `src/curation/provenance.ts`, `src/curation/staged-actions.ts` append path.
**Verification:** ledger survives process restart (write, new load call, identical state).

### U4. Reconciliation engine
**Goal:** Pure join of live findings × ledger → columns + system-emitted transitions.
**Requirements:** R6, R7, R8, R9, R10, R25.
**Dependencies:** U2, U3.
**Files:** `src/board/reconcile.ts`, `src/board/reconcile.test.ts`.
**Approach:**
- `reconcile(liveFindings, ledgerByIdentity, now)` → `{ findings: Finding[] (with column+disposition+history), emit: LedgerEvent[] }`. Pure: it *returns* events to append rather than writing (caller persists).
- Column rules per spec §D4: no ledger → `new`; `accept` → `accepted`; `dismiss` fingerprint-match & unexpired → `dismissed`; prior `resolved` but present in live set → emit system `reopened`, column = pre-resolution; `accept`/authorized-fix & absent from live set → emit verified `resolved` (the *engine* only proposes; the check re-run gate lives in the resolve tool, U11 — here "absent from live set" is the signal).
- Expired `dismiss` or drifted fingerprint → surface as `new`/re-triage, no duplicate (R9, R10).
**Test scenarios:**
- Live finding, empty ledger → `new`, no emit (Covers R7: unused board emits nothing when there are zero dispositions... note: pure fn emits only on resolved/reopened transitions).
- Live finding + `accept` → `accepted`.
- Resolved finding reappears in live set → one `reopened` emitted, column back to prior, history intact (Covers R8).
- Dismissed, fingerprint still matches, unexpired → stays `dismissed`; same finding with drifted fingerprint → `new` re-triage, no second card (Covers R10).
- Dismissed with elapsed expiry → `new` (Covers R9).
- Accepted finding absent from live set → one `resolved` emitted.
- Two runs, unchanged inputs → identical output, zero duplicate findings (Covers R6).
**Patterns to follow:** pure-engine + async-loader split used in `src/curation/tension-triage.ts`.
**Verification:** reconciliation is deterministic and side-effect-free.

### U5. Source adapter registry + lint adapter
**Goal:** Establish the `FindingSource` pattern with the first (path-target) adapter.
**Requirements:** R17, R18, R21, R22, R23.
**Dependencies:** U1, U2.
**Files:** `src/board/sources/index.ts`, `src/board/sources/lint.ts`, `src/board/sources/lint.test.ts`.
**Approach:**
1. `index.ts` exports an ordered registry array of `FindingSource`; the engine iterates it (source-agnostic, R22).
2. Lint adapter wraps `runLint` (`src/curation/lint.ts:255`); maps each `LintFinding {path, detail}` to a `Finding` with identity `(lint, checkName, path, discriminator?)`. Discriminator supplied only for checks that emit multiple findings per path (e.g. `brokenSourceRefs` → the specific ref), drawn from stable evidence (R2).
3. RBAC: filter findings by `canRead(access.role, collectionForPath(path))` — reuse the exact predicate from `src/tools/search.ts:600` (R17, R18).
4. `reproduces(identity)` re-runs the specific check for that path and asks whether the same identity reappears.
**Test scenarios:**
- Vault with a stale/orphan doc → lint adapter emits a `Finding` with correct identity + fingerprint.
- A denied-collection lint finding → omitted for a scoped role; total count unchanged, zero card (Covers R18).
- A check emitting 2 findings on one path → 2 distinct identities via stable discriminator (Covers R2 at adapter level).
- `reproduces` true while the condition holds, false after the doc is fixed (mock/fixture).
- Registry iteration yields the lint source (R22 shape).
**Patterns to follow:** `src/tools/curation.ts` lint invocation; `src/tools/search.ts:600-602` filter.
**Verification:** lint findings appear on the board and RBAC-filter correctly.

### U6. Staleness + edge-staleness adapters
**Goal:** Path-target and `(artifact,unit,edge_class)`-target staleness findings.
**Requirements:** R17, R21, R22, R23.
**Dependencies:** U5.
**Files:** `src/board/sources/staleness.ts`, `src/board/sources/staleness.test.ts`.
**Approach:**
- TTL staleness: wrap `computeStaleness` (`src/curation/staleness.ts:31`) over expired docs; target = path; fingerprint = `{score, ageDays}` (volatile, not in identity).
- Edge staleness: wrap `upstreamStaleness` (`src/curation/edge-staleness.ts:249`); target = `(artifact, unit, edge_class)`; RBAC-filter by the artifact's collection.
- `reproduces` re-computes staleness for the target.
**Test scenarios:**
- Expired-TTL doc → staleness finding; identity stable across runs while score drifts (fingerprint changes, identity does not).
- Edge staleness `pending-broken` row → finding with tuple identity.
- Denied artifact collection → omitted (R17).
- `reproduces` false once the doc is refreshed within TTL.
**Patterns to follow:** U5 adapter shape.
**Verification:** both staleness kinds surface with stable identity.

### U7. Staged-actions + tier-2 adapters (native + tuple IDs)
**Goal:** Adapters over the two surfaces with native/derived identity.
**Requirements:** R17, R21, R22, R23.
**Dependencies:** U5.
**Files:** `src/board/sources/staged.ts`, `src/board/sources/tier2.ts`, `src/board/sources/staged.test.ts`, `src/board/sources/tier2.test.ts`.
**Approach:**
- Staged: wrap the pending `StagedAction` list (`src/curation/staged-actions.ts`); identity = native `stage-NNN`; target = `targetPath`; RBAC by target collection; `reproduces` = action still pending.
- Tier-2: wrap the computed queue (`src/tools/tier2.ts:105` `residualRows`); identity synthesized from `(tier2, artifact, unit, edge_class)`; RBAC by artifact collection; `reproduces` = row still `pending-unchecked` with no covering verdict.
**Test scenarios:**
- Pending staged action → finding keyed on `stage-NNN`; identity stable after unrelated ledger appends.
- Ratified staged action → `reproduces` false.
- Tier-2 residual row → tuple identity; disappears from live set once a covering verdict exists.
- Denied collection on either → omitted.
**Patterns to follow:** U5.
**Verification:** native-ID reuse works; tier-2 tuple identity stable.

### U8. Tension adapter (both-sides RBAC)
**Goal:** Tension findings with the strict both-sides visibility rule.
**Requirements:** R17, R19, R21, R23.
**Dependencies:** U5.
**Files:** `src/board/sources/tension.ts`, `src/board/sources/tension.test.ts`.
**Approach:**
- Wrap `listTensions` (`src/curation/tension.ts:487`) filtered to unresolved; identity = native `tension-NNN`; target = the tension entry.
- Visibility gate: include only when `canSeeTension` (`src/curation/tension-access.ts:24-32`) is true — caller must read *both* sides' collections; otherwise omit entirely, never redact (R19).
- Fingerprint from claim text + status (so an edited claim drifts the fingerprint → re-triage, not a new card).
- `reproduces` = tension still unresolved.
**Test scenarios:**
- Unresolved tension both sides readable → visible finding on `tension-NNN`.
- Tension with one side in a denied collection → omitted entirely; no count, no existence signal (Covers R19).
- Resolving the tension → `reproduces` false.
- Editing one claim → fingerprint drift, same identity.
- Legacy tension with no native ID → excluded (cannot be dispositioned safely) — documented behavior.
**Patterns to follow:** `src/curation/tension-access.ts` visibility usage.
**Verification:** both-sides rule holds under role fixtures.

### U9. Board engine
**Goal:** Assemble registry → RBAC → reconcile → columns behind one call.
**Requirements:** R6, R7, R17, R18, R22, R23.
**Dependencies:** U4, U5, U6, U7, U8.
**Files:** `src/board/board.ts`, `src/board/board.test.ts`.
**Approach:**
1. `listBoard(vaultRoot, access, filters?)` — run each registered source's `list`, concat, load ledger, `reconcile`, persist any emitted system events, apply filters (R26 filter set), return findings grouped by column.
2. Emitted `reopened`/`resolved` events from reconcile are appended here (the one write path for system events).
3. When no findings have dispositions and reconcile emits nothing, zero writes occur (R7).
**Test scenarios:**
- Mixed vault (lint + staleness + tension + staged) → all surface, correct columns.
- ≥2 role fixtures: scoped role sees strict subset; a hidden collection yields zero cards and unchanged totals for the admin (Covers R18).
- Board unused (no dispositions, nothing resolvable) → no ledger writes (Covers R7).
- Filter by collection/check/certainty/owner/age/document narrows correctly (feeds R26).
- Reopen transition persists exactly one event across two `listBoard` calls (no duplicate emits).
**Patterns to follow:** async-loader composition in `src/curation/tension-triage.ts`.
**Verification:** end-to-end board state correct for multiple sources + roles.

### U10. Configured principals + human-disposition capability
**Goal:** Owner/reassign constrained to configured principals, and a declared role capability that gates human disposition (the grounded mechanism for R13/R16, since `AccessContext` carries no `principal_type` and daftari has no runtime agent-detection).
**Requirements:** R31, R13 (config mechanism), R16 (config mechanism).
**Dependencies:** U1.
**Files:** `src/board/principals.ts`, `src/board/principals.test.ts`, `src/utils/config.ts` (extend `RoleConfig`).
**Approach:**
1. Resolve the principal set from `server.auth.tokens[].user` plus an optional explicit `principals:` list in config; `isConfiguredPrincipal(config, name) → boolean` (used by the reassign path in U11).
2. Add a `dispose?: boolean` capability to `RoleConfig` (default `false`), parsed alongside the existing `promote`/`ratify`/`erase` flags. A human operator's role is provisioned with `dispose: true`; an agent's role omits it. This is *how an agent is distinguished from a human* — by the capability its role was granted in config, not by inspecting the caller at runtime.
3. `canDispose(role) → boolean` helper in `src/access/rbac.ts` mirroring `canRead`/existing capability predicates.
**Test scenarios:**
- `owner` in token users → valid; reassign to an unknown name → invalid; empty/whitespace owner → invalid.
- Role with `dispose: true` → `canDispose` true; role without it (agent) → false; unknown/guest role (`null`) → false.
- Config round-trips the new `dispose` flag without disturbing existing role parsing.
**Patterns to follow:** `src/utils/config.ts` role/token parsing; `src/access/rbac.ts` capability predicates (`canRead:46`, `readableCollections:100`).
**Verification:** principal validation and the dispose capability both resolve from config.

### U11. Board MCP tools
**Goal:** The two-tool trust boundary, access-native.
**Requirements:** R13, R14, R15, R16, R20, R31.
**Dependencies:** U9, U10, U3.
**Files:** `src/tools/board.ts`, `src/tools/board.test.ts`; registration in the tool factory (`src/server.ts`).
**Approach:**
1. `vault_board_list(access, filters)` → `listBoard`.
2. `vault_board_dispose(access, finding_id, event ∈ {accept,defer,dismiss,reassign}, rationale?, expiry?, owner?)` — **require `canDispose(access.role)` (U10); reject otherwise** (R13, R16) — this is the human/agent gate, enforced via the declared role capability, not runtime agent-detection; RBAC-check the target is readable (R20); reassign validates `isConfiguredPrincipal` (R31); stamp `principal_type: human` and append.
3. `vault_board_resolve(access, finding_id)` — callable by any role; look up the source adapter, call `reproduces(identity)`; append `resolved` **only if it returns false** (no longer reproduces) (R14). Assertion alone never resolves.
4. `reopened` is never a tool entry point — only reconcile emits it (R15).
**Test scenarios:**
- Caller whose role lacks the `dispose` capability (how agents are provisioned) → rejected for all four events (Covers R13, R16).
- Caller with `dispose: true` → `accept`/`defer`/`dismiss`/`reassign` event appended with `principal_type: human`.
- Reassign to unconfigured principal → rejected (Covers R31).
- Dispose targeting a finding the caller can't read → rejected, no existence signal (Covers R20).
- `vault_board_resolve` when check still reproduces → no `resolved` written; when it no longer reproduces → exactly one `resolved` (Covers R14).
- No tool path can emit `reopened` (Covers R15).
**Patterns to follow:** `src/tools/staged-actions.ts` (capability + RBAC gating via `canRatify`/`isProposeOnly`), `src/tools/tier2.ts`.
**Verification:** authority is enforced by a config-declared capability check, not convention.

### U12. Board HTTP route behind authenticate()
**Goal:** Serve `/api/board` (+ dispose/resolve POST) and `/board` behind real auth.
**Requirements:** R25, R26, R29, R30, R32.
**Dependencies:** U11, U13.
**Files:** `src/serve/index.ts` (route wiring), `src/serve/board-route.test.ts`.
**Approach:**
1. **Route-hosting decision (resolves the spec's open plan-level choice): mount the board routes directly in the serve `handle()` in `src/serve/index.ts`**, not on the no-auth view server. Rationale: serve already runs `authenticate()` → dispatch (`:359-507`); adding routes there is additive, whereas threading auth into the view server crosses a boundary designed to be no-auth. The view-server doc-page finding links (U13) stay a separate, admin-loopback convenience.
2. Add `/api/board` (GET → `vault_board_list`) and POST endpoints routing to dispose/resolve into the serve `handle()` before the `/mcp` 404 gate — after `authenticate()` runs (R32) so every request carries a real `AccessContext`.
3. `/board` GET serves the rendered page (U13) — also behind `authenticate()`.
4. Loopback DNS-rebinding guard already precedes routing — inherited automatically.
**Test scenarios:**
- Request with a valid bearer → `AccessContext` resolved, board returned scoped to that role (Covers R32).
- Request with an invalid/unmatched bearer → 401 (existing auth path). **Note the real serve behavior:** when `authConfigured` is false the request resolves as deny-all `guest` (empty board), not 401 — write the no-auth case to expect an empty guest board, the invalid-token case to expect 401.
- Scoped-role bearer → RBAC-narrowed board (integration with U9).
- POST dispose as a `dispose`-capable bearer → event persisted, survives restart (Covers R30).
- Cross-origin browser request → blocked by existing Origin guard.
**Patterns to follow:** `src/serve/index.ts:359-450` (`authenticate` + route dispatch).
**Verification:** board is reachable only with a valid credential and is role-scoped.
**Execution note:** integration-heavy — prefer a route-level test exercising `authenticate()`→handler over pure unit mocks.

### U13. Board page + doc-page finding links
**Goal:** Server-rendered board UI and back-links.
**Requirements:** R25, R26, R27, R28, R29.
**Dependencies:** U9.
**Files:** `src/view/board-page.ts`, `src/view/board-page.test.ts`, `src/view/pages.ts` (doc-page links), `src/view/server.ts` (doc-page wiring).
**Approach:**
1. `renderBoardPage(boardState, filters)` — 5 columns New/Accepted/**Waiting (single)**/Resolved/Dismissed (R25); filter controls for collection/check/certainty/owner/age/document (R26); cards link back to target/tension/staged action (R28).
2. A document with multiple findings renders them as independent cards; disposing one never hides another (R27) — presentation reads per-finding column, never rolls a doc up destructively.
3. Doc pages gain an "open findings" section linking into `/board` filtered to that document (R28). (Admin-loopback convenience; the authenticated board in U12 is the RBAC-correct surface.)
4. Content editing stays out (R29).
**Test scenarios:**
- Board state with 5 columns → each renders; Waiting is one column carrying deferred+blocked+awaiting via rationale (Covers R25).
- Doc with 3 findings, one resolved → other two still shown (Covers R27).
- Filter param narrows rendered cards (Covers R26).
- Card links resolve to the target doc/tension/staged action (Covers R28).
- No mutation/edit control for document body (R29).
**Patterns to follow:** `src/view/pages.ts` string-template rendering + inlined CSS.
**Verification:** board renders correctly; multi-finding docs behave independently.

### U14. Ledger gitignore + wiring hygiene
**Goal:** Operational-state hygiene and registration completeness.
**Requirements:** R5, R7.
**Dependencies:** U3, U11.
**Files:** `.gitignore`, plus a smoke check that the board module is dormant when unused.
**Approach:**
- Add `.daftari/board-dispositions.jsonl` to `.gitignore` (git-ignored operational state, R5).
- Confirm no board code runs on existing viewer/MCP/CLI paths unless a board tool/route is invoked (R7).
**Test scenarios:**
- Existing MCP/CLI/viewer test suites unchanged and green with the board module present but unused (Covers R7).
- Ledger file path is git-ignored.
**Test expectation:** mostly hygiene — prefer a dormancy smoke test over new unit coverage.
**Verification:** board is fully additive; nothing changes when it's not used.

---

## Deferred to Implementation

- Exact helper/method names in `src/curation/*` for the `reproduces` re-run per source (resolved when touching each engine).
- The staged-actions `list()` in U7 must navigate the two-layer pattern (SQLite storage index → tool layer in `src/tools/staged-actions.ts`); the exact listing entry point is resolved when touching that module.
- Whether the `principals:` config key is added or the principal set is derived purely from `server.auth.tokens[].user` (decide against real config shape in U10).
- Final filter query semantics for `age` (relative window vs absolute) — settle in U9/U13 against real card data.
- Whether reconcile's emitted-event persistence belongs in U9 (`listBoard`) or is threaded through the resolve tool for the resolved case — resolve when U4's `emit` contract meets U11.

## Deferred to Follow-Up Work

- **Ledger compaction / snapshot** (replay + checkpoint) — only when growth warrants.
- **Browser-facing auth UX polish** (login page, session) — bearer works now; UX is separate.
- **Derived-set caching** keyed on vault version — only if board load is measured slow.
- **Autonomous prioritization / severity ranking** — deliberately excluded (killed learned-ranker precedent).
- **Federating findings across mounted vaults** — out of v1 scope.
