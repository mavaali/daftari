# Cortex Loop Stage 3 — Envelope Enforcement + §8 Closures — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the two-gate envelope (invariants + trust budget) live-but-shadowed into Component A, and close the two §8 audit-trail gaps (`decided_by_principal`; gate `vault_tension_resolve` on `canRatify` for loop tensions).

**Architecture:** A new pure `src/consolidate/envelope.ts` decides admit/refuse from a pre-assembled context (no I/O). The CLI builds an `admit()` function that owns a per-run session-spend scalar (deduct-on-admit), assembles the context, journals every loop decision (admitted **and** gated) to `.daftari/shadow-actions.jsonl` with a gate verdict, and is injected into birth/revision (which consult it once per edge-action and skip the write on refuse). Loop journaling moves OUT of `edge-write.ts` so the loop never advances the shared `spentByVault` module global (per decision D6). Pieces 2 and 3 are localized field/guard additions.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, better-sqlite3 (unaffected here), biome. `Result<T,Error>` everywhere; functions + types, no classes.

**Source brief (read first):** `docs/superpowers/drafts/2026-06-17-cortex-stage-3-envelope-brief.md`
**Spec:** `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md` §5, §5.4, §8, §12.3.

**Locked decisions:** D1 deduct-on-admit · D2 all three runtime invariants + never-delete assert · D3 gated → shadow journal + lint section · D4 loop tension = exact `loggedBy === "agent:curation-loop"` · D5 envelope is a consolidate concern (not the shared `recordShadowAction`) · D6 separate envelope-owned session-spend scalar.

---

## Conventions for every task

- **Run one test file:** `npx vitest run test/<path>.test.ts`
- **Run one test by name:** `npx vitest run test/<path>.test.ts -t "<name>"`
- **Build (tsc):** `npm run build`  ·  **Lint:** `npm run lint`  ·  **Full suite:** `npm test`
- Tests mirror `src/` under `test/`. Every new module gets a test file.
- **Re-baseline first:** run `npm test` at branch creation and record the green count (the 1125/3 snapshot has aged). Use ask-permissions for commit-bearing work (uatu hook). CI Node-20 has a known MiniLM flake — re-run, don't assume regression.

---

## Task 0: Branch + baseline

- [ ] **Step 1:** Create the branch.
  ```bash
  git checkout main && git pull --ff-only
  git checkout -b feat/cortex-loop-stage3
  ```
- [ ] **Step 2:** Baseline green.
  Run: `npm test`
  Expected: all pass (record the count, e.g. "NNNN pass / 3 skip"). If the only failures are the known MiniLM/onnxruntime flake on one job, re-run `npx vitest run --failed`.
- [ ] **Step 3:** `npm run build` and `npm run lint` — both clean.

---

## Task 1: Piece 3 — gate `vault_tension_resolve` on `canRatify` for loop tensions

Smallest, fully independent. Closes the asymmetry where a `ratify`-gated contest's tension is any-read-resolvable.

**Files:**
- Modify: `src/tools/curation.ts` (`vaultTensionResolve`, ~line 115-177)
- Test: `test/tools/curation.test.ts` (or the existing tension-resolve test file — locate with `rg -l "vaultTensionResolve" test`)

**Design:** Before resolving, fetch the target tension and read `loggedBy`. If `loggedBy === CONSOLIDATE_AGENT` (`"agent:curation-loop"`) and an `access` context is present without ratify, deny — mirroring the existing `if (access && !canRatify(access.role))` guard in `vault_edge_contest` / `vault_ratify`. No-access (direct/test) calls bypass, as elsewhere. Human-logged tensions stay any-read-resolvable.

- [ ] **Step 1: Write the failing tests.**
  Add to the tension-resolve test file:
  ```ts
  import { CONSOLIDATE_AGENT } from "../../src/consolidate/constants.js";
  // role helpers: a read-only role (ratify:false) and a ratify role (ratify:true).

  it("denies resolving a loop-authored tension to a non-ratify role", async () => {
    // Arrange: log a tension with loggedBy = CONSOLIDATE_AGENT in a temp vault.
    // (use addTension directly, kind:"interpretive")
    const res = await vaultTensionResolve(vault, { id, kind: "accepted" }, readOnlyAccess);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/cannot resolve/i);
  });

  it("allows a ratify role to resolve a loop-authored tension", async () => {
    const res = await vaultTensionResolve(vault, { id, kind: "accepted" }, ratifyAccess);
    expect(res.ok).toBe(true);
  });

  it("allows any-read to resolve a human-authored tension", async () => {
    // loggedBy = "human:mihir"
    const res = await vaultTensionResolve(vault, { id, kind: "accepted" }, readOnlyAccess);
    expect(res.ok).toBe(true);
  });

  it("bypasses the ratify gate when no access context is supplied", async () => {
    // loggedBy = CONSOLIDATE_AGENT, access undefined
    const res = await vaultTensionResolve(vault, { id, kind: "accepted" });
    expect(res.ok).toBe(true);
  });
  ```
- [ ] **Step 2: Run — verify they fail.**
  Run: `npx vitest run test/tools/curation.test.ts -t "loop-authored"`
  Expected: the first test FAILS (resolve currently succeeds for any read).
- [ ] **Step 3: Implement the guard.** In `vaultTensionResolve`, after the existing `requireReadAccess` check and after validating `id`, fetch the tension and gate:
  ```ts
  import { canRatify } from "../access/rbac.js";
  import { CONSOLIDATE_AGENT } from "../consolidate/constants.js";
  import { listTensions } from "../curation/tension.js";
  // ...
  // Loop-authored tensions are gated at the ratify tier (spec §5.4): a contest is
  // ratify-gated, so resolving the tension it raised must be too. Human-logged
  // tensions stay any-read-resolvable. No-access (direct/test) calls bypass.
  const all = await listTensions(vaultRoot);
  if (!all.ok) return all;
  const target = all.value.find((t) => t.id === id.trim());
  if (target && target.loggedBy === CONSOLIDATE_AGENT && access && !canRatify(access.role)) {
    return err(
      new Error(`access denied: role '${access.roleName}' cannot resolve a loop-authored tension`),
    );
  }
  ```
  (Place this before building the `resolution` object. If `target` is undefined, let `resolveTension` produce the existing "unknown id" error.)
- [ ] **Step 4: Run the tests.**
  Run: `npx vitest run test/tools/curation.test.ts`
  Expected: PASS.
- [ ] **Step 5:** `npm run build && npm run lint` clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/tools/curation.ts test/tools/curation.test.ts
  git commit -m "feat(consolidate): gate vault_tension_resolve on canRatify for loop tensions (Stage 3, §5.4)"
  ```

**Note for reviewers:** the discriminator (`loggedBy === agent:curation-loop`) is a value convention, not a structural guarantee — a human contesting while passing `contested_by: agent:curation-loop` would also be ratify-gated on resolve. That is the desired behavior.

---

## Task 2: Piece 2a — `decided_by_principal` on the staged-action decision record

Authenticated identity (`access.user`) recorded on the pure-verdict reject path (and approve, for consistency).

**Files:**
- Modify: `src/curation/staged-actions.ts` (`DecisionInput`, `RawRecord`, `collapse`, `StagedAction`, `recordDecision`)
- Modify: `src/storage/index-db.ts` (`StagedActionRow` — add `decided_by_principal: string | null`; the column is optional for the index but the row type is shared by `collapse`)
- Modify: `src/tools/staged-actions.ts` (`vaultRatify` — pass `decidedByPrincipal: access?.user` on both reject and approve)
- Test: `test/curation/staged-actions.test.ts`, `test/tools/staged-actions.test.ts`

**Design:** Add an optional `decidedByPrincipal` to `DecisionInput`; write `decided_by_principal` into the decision `RawRecord`; carry it through `collapse` onto the row and `rowToStagedAction`. Source it from `access?.user` in `vaultRatify`. The lint sweep (`sweepExpiredActions`) records `SWEEP_PRINCIPAL`. Field is optional everywhere → omitted when no access. **The sqlite `StagedActionRow` gains a nullable column; bump nothing if the table is reindex-materialized — but check `SCHEMA_VERSION`:** if `staged_actions` DDL changes, bump `SCHEMA_VERSION` and add the table to the drop list (see `src/storage/index-db.ts`). If you only add it to the JSONL + in-memory row and NOT the DDL, no schema bump is needed — **prefer JSONL-only** (the v1 read paths read JSONL directly; the sqlite column is unused by Stage 3 and adding it forces a schema bump). Decision: **JSONL + in-memory `StagedAction` only; do NOT touch the sqlite DDL.** Add `decidedByPrincipal` to the parsed `StagedAction` interface and have `collapse` keep it on a local field, not on `StagedActionRow`.

  > Implementation detail: `collapse` currently returns `Map<string, StagedActionRow>`. To avoid a DDL change, either (a) extend `StagedActionRow` with an optional `decided_by_principal?` that the sqlite upsert ignores, or (b) change `collapse`/`currentRows` to a local augmented type. Prefer (a) with the column NOT added to the DDL — confirm `upsertStagedAction` only reads the columns it knows (it does; it lists them explicitly). Keep `decided_by_principal?: string | null` optional on `StagedActionRow`.

- [ ] **Step 1: Write failing tests** in `test/curation/staged-actions.test.ts`:
  ```ts
  it("records decided_by_principal on a reject decision and round-trips it", async () => {
    const { id } = (await stageAction(vault, validProposal())).value!;
    await recordDecision(vault, id, {
      status: "rejected", ratifiedAt: nowISO(), ratifiedBy: "agent:curation-loop",
      decidedByPrincipal: "agent:curation-loop",
    });
    const got = (await getStagedActionById(vault, id)).value!;
    expect(got.decidedByPrincipal).toBe("agent:curation-loop");
  });

  it("omits decided_by_principal when not supplied", async () => {
    const { id } = (await stageAction(vault, validProposal())).value!;
    await recordDecision(vault, id, { status: "rejected", ratifiedAt: nowISO(), ratifiedBy: "x" });
    const got = (await getStagedActionById(vault, id)).value!;
    expect(got.decidedByPrincipal).toBeNull();
  });
  ```
  And in `test/tools/staged-actions.test.ts`:
  ```ts
  it("vault_ratify reject stamps the authenticated principal", async () => {
    // stage an action; reject via vaultRatify with access {user:"agent:curation-loop", role:ratify}
    const got = (await getStagedActionById(vault, id)).value!;
    expect(got.decidedByPrincipal).toBe("agent:curation-loop");
  });
  ```
- [ ] **Step 2: Run — verify fail.** `npx vitest run test/curation/staged-actions.test.ts -t "decided_by_principal"` → FAIL (property undefined).
- [ ] **Step 3: Implement.**
  - `DecisionInput`: add `decidedByPrincipal?: string;`
  - `StagedAction`: add `decidedByPrincipal: string | null;`
  - `StagedActionRow` (index-db.ts): add `decided_by_principal?: string | null;` (NOT in the DDL/upsert).
  - `RawRecord`: add `decided_by_principal?: string | null;`
  - `recordDecision`: include `...(decision.decidedByPrincipal ? { decided_by_principal: decision.decidedByPrincipal } : {})` in the appended record.
  - `collapse` (decision branch): `existing.decided_by_principal = rec.decided_by_principal ?? null;`
  - Proposal branch in `collapse`: initialize `decided_by_principal: null`.
  - `rowToStagedAction`: `decidedByPrincipal: row.decided_by_principal ?? null,`
  - `vaultRatify` (reject + approve `recordDecision` calls): add `decidedByPrincipal: access?.user`.
- [ ] **Step 4: Run.** `npx vitest run test/curation/staged-actions.test.ts test/tools/staged-actions.test.ts` → PASS.
- [ ] **Step 5:** `npm run build && npm run lint` clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/curation/staged-actions.ts src/storage/index-db.ts src/tools/staged-actions.ts test/curation/staged-actions.test.ts test/tools/staged-actions.test.ts
  git commit -m "feat(consolidate): record decided_by_principal on staged-action decisions (Stage 3, §8)"
  ```

---

## Task 3: Piece 2b — `decided_by_principal` on the contest tension

**Files:**
- Modify: `src/curation/tension.ts` (`TensionEntry`, `TensionInput`, `addTension`, `renderEntry`, `parseBlock`)
- Modify: `src/tools/edges.ts` (`vaultEdgeContest` — pass `decidedByPrincipal: access?.user` into `addTension`)
- Test: `test/curation/tension.test.ts`, `test/tools/edges.test.ts`

**Design:** New optional `decidedByPrincipal?: string` on `TensionEntry`/`TensionInput`. Render `- **Decided by principal:** …` in `renderEntry` only when set; parse `decided by principal` back in `parseBlock`. `vaultEdgeContest` sources it from `access?.user`.

- [ ] **Step 1: Write failing tests** in `test/curation/tension.test.ts`:
  ```ts
  it("renders and parses decided_by_principal round-trip", async () => {
    await addTension(vault, {
      title: "t", kind: "factual", sourceA: "a.md", claimA: "x",
      sourceB: "b.md", claimB: "y", loggedBy: "agent:curation-loop",
      decidedByPrincipal: "agent:curation-loop",
    });
    const got = (await listTensions(vault)).value!;
    expect(got[0].decidedByPrincipal).toBe("agent:curation-loop");
  });

  it("omits the line when decidedByPrincipal is absent", async () => {
    await addTension(vault, { /* no decidedByPrincipal */ });
    const raw = readFileSync(tensionsPath(vault), "utf8");
    expect(raw).not.toMatch(/Decided by principal/);
  });
  ```
- [ ] **Step 2: Run — verify fail.** `npx vitest run test/curation/tension.test.ts -t "decided_by_principal"` → FAIL.
- [ ] **Step 3: Implement.**
  - `TensionEntry`: add `decidedByPrincipal?: string;`
  - `TensionInput`: it's `Omit<TensionEntry, ...>` — `decidedByPrincipal` flows through automatically (verify it isn't in the Omit list; it isn't).
  - `addTension`: copy `...(input.decidedByPrincipal ? { decidedByPrincipal: input.decidedByPrincipal.trim() } : {})` onto the `entry`.
  - `renderEntry`: after the `Logged by` line, `if (entry.decidedByPrincipal) lines.push(\`- **Decided by principal:** ${entry.decidedByPrincipal}\`);`
  - `parseBlock`: add an `else if (label === "decided by principal") entry.decidedByPrincipal = value.trim();` branch.
  - `vaultEdgeContest` (edges.ts, the `addTension` call ~line 228): add `decidedByPrincipal: access?.user`.
- [ ] **Step 4: Run.** `npx vitest run test/curation/tension.test.ts test/tools/edges.test.ts` → PASS.
- [ ] **Step 5:** `npm run build && npm run lint` clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/curation/tension.ts src/tools/edges.ts test/curation/tension.test.ts test/tools/edges.test.ts
  git commit -m "feat(consolidate): record decided_by_principal on contest tensions (Stage 3, §8)"
  ```

---

## Task 4: Piece 1 — `evaluateEnvelope` (pure decision function)

The heart of the envelope. **No I/O** — takes a pre-assembled context, returns the verdict. Unit-tested in isolation.

**Files:**
- Create: `src/consolidate/envelope.ts`
- Test: `test/consolidate/envelope.test.ts`

**Design / types:**
```ts
// src/consolidate/envelope.ts
// The two-gate envelope (spec §5). PURE: callers assemble the context (I/O lives
// in the CLI's makeAdmit, Task 7). An action is admitted iff BOTH the invariants
// gate AND the trust-budget gate pass. Gated actions surface (Task 5/7); they do
// NOT spend (D1 deduct-on-admit).

export type EnvelopeActionType = "edge-observe" | "edge-contest";

// Actions A is allowed to take that do NOT delete (never-delete invariant, D2).
const NON_DELETING_ACTIONS: ReadonlySet<EnvelopeActionType> = new Set([
  "edge-observe",
  "edge-contest",
]);

export interface EndpointState {
  path: string;
  // provenance-required: false ⇒ unknown/broken metadata ⇒ refuse.
  provenanceKnown: boolean;
  // premise-freshness: true ⇒ computeDecay level is warn|deprecated ⇒ refuse
  // (aging does NOT block — scarcity rule, decay.ts renderBanner returns null).
  decayBlocking: boolean;
  // tension-respect: true ⇒ an unresolved tension touches this endpoint ⇒ refuse.
  hasUnresolvedTension: boolean;
}

export interface EnvelopeCtx {
  action: EnvelopeActionType;
  endpoints: EndpointState[]; // [from, to]
  impact: number; // I, precomputed via shadowImpact
  budget: number; // B0, precomputed via shadowBudget
}

export interface EnvelopeVerdict {
  admit: boolean;
  gate: "invariants" | "budget" | null; // which gate refused; null when admitted
  reason: string;
  impact: number; // echoed so the caller deducts the right amount on admit
}

export function evaluateEnvelope(ctx: EnvelopeCtx, spent: number): EnvelopeVerdict {
  // --- Invariants gate (first; §5.1) ---
  // never-delete (defensive assert).
  if (!NON_DELETING_ACTIONS.has(ctx.action)) {
    return { admit: false, gate: "invariants", reason: `never-delete: action '${ctx.action}' is not permitted`, impact: ctx.impact };
  }
  for (const ep of ctx.endpoints) {
    if (ep.hasUnresolvedTension) {
      return { admit: false, gate: "invariants", reason: `tension-respect: ${ep.path} has an unresolved tension`, impact: ctx.impact };
    }
    if (!ep.provenanceKnown) {
      return { admit: false, gate: "invariants", reason: `provenance-required: ${ep.path} has unknown/broken provenance`, impact: ctx.impact };
    }
    if (ep.decayBlocking) {
      return { admit: false, gate: "invariants", reason: `premise-freshness: ${ep.path} is stale/deprecated`, impact: ctx.impact };
    }
  }
  // --- Trust-budget gate (§5.2; strict > matches shadow.ts would_gate) ---
  if (spent + ctx.impact > ctx.budget) {
    return { admit: false, gate: "budget", reason: `trust-budget exhausted: spent ${spent.toFixed(3)} + I ${ctx.impact.toFixed(3)} > B0 ${ctx.budget.toFixed(3)}`, impact: ctx.impact };
  }
  return { admit: true, gate: null, reason: "admitted", impact: ctx.impact };
}
```

- [ ] **Step 1: Write failing tests** in `test/consolidate/envelope.test.ts`. Cover: admit on a clean action with budget headroom; each invariant fires independently (unresolved tension on `from`; unknown provenance on `to`; decayBlocking on either; never-delete via a bogus action cast); budget boundary (admit at `spent + I == budget` since strict `>`; refuse just past it); invariants take precedence over budget (a tension-bearing endpoint refused with `gate:"invariants"` even when the budget is also blown).
  ```ts
  const clean: EndpointState = { path: "a.md", provenanceKnown: true, decayBlocking: false, hasUnresolvedTension: false };
  const base = (over: Partial<EnvelopeCtx> = {}): EnvelopeCtx => ({
    action: "edge-observe", endpoints: [clean, { ...clean, path: "b.md" }], impact: 0.1, budget: 1, ...over,
  });

  it("admits a clean action with budget headroom", () => {
    expect(evaluateEnvelope(base(), 0).admit).toBe(true);
  });
  it("refuses on an unresolved tension (invariants)", () => {
    const v = evaluateEnvelope(base({ endpoints: [{ ...clean, hasUnresolvedTension: true }, clean] }), 0);
    expect(v).toMatchObject({ admit: false, gate: "invariants" });
  });
  it("refuses on unknown provenance (invariants)", () => {
    const v = evaluateEnvelope(base({ endpoints: [clean, { ...clean, provenanceKnown: false }] }), 0);
    expect(v).toMatchObject({ admit: false, gate: "invariants" });
  });
  it("refuses on a stale endpoint (invariants)", () => {
    const v = evaluateEnvelope(base({ endpoints: [clean, { ...clean, decayBlocking: true }] }), 0);
    expect(v).toMatchObject({ admit: false, gate: "invariants" });
  });
  it("admits at the budget boundary, refuses just past it", () => {
    expect(evaluateEnvelope(base({ impact: 0.5, budget: 1 }), 0.5).admit).toBe(true);   // 1.0 > 1 is false
    expect(evaluateEnvelope(base({ impact: 0.5, budget: 1 }), 0.6).admit).toBe(false);  // 1.1 > 1
  });
  it("invariants take precedence over a blown budget", () => {
    const v = evaluateEnvelope(base({ endpoints: [{ ...clean, hasUnresolvedTension: true }, clean], impact: 5, budget: 1 }), 0.9);
    expect(v.gate).toBe("invariants");
  });
  ```
- [ ] **Step 2: Run — verify fail.** `npx vitest run test/consolidate/envelope.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `src/consolidate/envelope.ts` exactly as above.
- [ ] **Step 4: Run.** `npx vitest run test/consolidate/envelope.test.ts` → PASS.
- [ ] **Step 5:** `npm run build && npm run lint` clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/consolidate/envelope.ts test/consolidate/envelope.test.ts
  git commit -m "feat(consolidate): pure two-gate envelope decision (Stage 3, §5)"
  ```

---

## Task 5: Piece 1 — journal loop decisions + DRY the shadow metrics + lint "gated" section

Move the impact/budget/blast math into a reusable helper, add a journaling function that records admitted/gated loop decisions to `shadow-actions.jsonl` with a gate verdict, and surface gated rows in `vault_lint`. **Does not yet wire birth/revision** (Task 6) or the CLI (Task 7).

**Files:**
- Modify: `src/curation/shadow.ts` (extract `computeShadowMetrics`; add gate fields to `ShadowActionRecord`; add `recordEnvelopeDecision`; extend `shadowLintSummary` with a gated view)
- Modify: `src/curation/lint.ts` (carry the gated summary through `LintReport`)
- Modify: `src/tools/curation.ts` (`vault_lint` output type — surface the gated summary)
- Test: `test/curation/shadow.test.ts`, `test/curation/lint.test.ts`

**Design:**
1. **Extract metrics** so the envelope and `recordShadowAction` share one source:
   ```ts
   export interface ShadowMetrics { blast: number; impact: number; budget: number; livePending: number; docCount: number; }
   export async function computeShadowMetrics(
     vaultRoot: string, action: string, seeds: string[],
   ): Promise<Result<ShadowMetrics, Error>> { /* loadDocuments + shadowBlastFromDocs + listStagedActions(live) + shadowImpact + shadowBudget */ }
   ```
   Refactor `recordShadowAction` to call it (behavior unchanged — verify existing shadow tests stay green).
2. **Gate fields on `ShadowActionRecord`** (all optional, only set by loop rows):
   ```ts
   decision?: "admitted" | "gated"; // present on envelope-journaled loop rows
   gate?: "invariants" | "budget";  // which gate refused (gated rows only)
   gate_reason?: string;
   ```
3. **`recordEnvelopeDecision`** — journals one loop decision. Takes the authoritative `spentBefore` (envelope-owned, NOT the module global) and the verdict; computes metrics for the record; appends to the SAME `shadow-actions.jsonl`; **never touches `spentByVault`**.
   ```ts
   export interface EnvelopeJournalInput {
     tool: "vault_edge_observe" | "vault_edge_contest";
     action: "edge-observe" | "edge-contest";
     targetPath: string; touchedPaths: string[];
     agent: string; principal?: string;
     decision: "admitted" | "gated";
     gate?: "invariants" | "budget"; gateReason?: string;
     impact: number; budget: number; blast: number; spentBefore: number;
     commitMessage: string;
   }
   export async function recordEnvelopeDecision(vaultRoot: string, input: EnvelopeJournalInput): Promise<Result<ShadowActionRecord, Error>> { /* build record incl. would_gate=(decision==="gated"), append; return it */ }
   ```
   (The caller passes precomputed metrics so this function is a thin journaler; or it may recompute via `computeShadowMetrics` if you prefer one I/O point — pick one and keep it DRY. Recommendation: the CLI computes metrics once for the verdict AND passes them here, avoiding a second `loadDocuments`.)
4. **Lint gated view:** extend `ShadowLintSummary` with `gatedSurfaced: ShadowLintItem[]` (most-recent-first, rows with `decision === "gated"`), and a `gatedCount`. **Keep this distinct from the existing `gated`/`recentGated` fields**, which are derived from the doc-write `would_gate` boolean — the envelope `decision === "gated"` view and the `would_gate` calibration view are different concepts that legitimately coexist; do NOT reuse/overwrite `recentGated`. Thread through `lint.ts` `LintReport.shadowActions` (already carried) — the field is nested and the same type re-surfaces in `src/tools/curation.ts:248`, so new fields flow automatically; the only edit is in `shadowLintSummary`.

- [ ] **Step 1: Write failing tests** in `test/curation/shadow.test.ts`:
  ```ts
  it("recordEnvelopeDecision journals an admitted row with decision='admitted'", async () => { /* ... assert appended record has decision:"admitted", would_gate:false */ });
  it("recordEnvelopeDecision journals a gated row with gate + gate_reason and does NOT advance spentByVault", async () => {
    resetShadowSession(vault);
    await recordEnvelopeDecision(vault, gatedInput());
    expect(shadowSpent(vault)).toBe(0); // envelope owns spend; module global untouched
    const rows = (await listShadowActions(vault)).value!;
    expect(rows.at(-1)).toMatchObject({ decision: "gated", gate: "budget" });
  });
  it("shadowLintSummary surfaces gated rows in gatedSurfaced", async () => { /* ... */ });
  ```
  Plus a regression test asserting `computeShadowMetrics` returns the same impact/budget that the current `recordShadowAction` records for a known fixture (lock the refactor).
- [ ] **Step 2: Run — verify fail.** `npx vitest run test/curation/shadow.test.ts -t "recordEnvelopeDecision"` → FAIL.
- [ ] **Step 3: Implement** the extraction, fields, `recordEnvelopeDecision`, and the lint gated view.
- [ ] **Step 4: Run.** `npx vitest run test/curation/shadow.test.ts test/curation/lint.test.ts` → PASS. Then `npm test -t shadow` to confirm no regression in existing shadow assertions.
- [ ] **Step 5:** `npm run build && npm run lint` clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/curation/shadow.ts src/curation/lint.ts src/tools/curation.ts test/curation/shadow.test.ts test/curation/lint.test.ts
  git commit -m "feat(consolidate): journal envelope decisions + lint gated section (Stage 3, §5/D3)"
  ```

---

## Task 6: Piece 1 — consult `admit` in birth + revision; stop journaling in edge-write

Wire the injected `admit` dep into Component A so it consults the envelope once per edge-action and skips the write on refuse, and remove loop journaling from `edge-write.ts` (per D6, the loop must not advance `spentByVault`).

**Files:**
- Modify: `src/consolidate/edge-write.ts` (drop the `recordShadowAction` branch; shadow mode returns the stub with NO journal)
- Modify: `src/consolidate/birth.ts` (`BirthDeps.admit`; consult before each directed/symmetric observe; gated counters in `BirthOutcome`/`BirthTraceRow`/verdicts)
- Modify: `src/consolidate/revision.ts` (`RevisionDeps.admit`; consult ONCE per panel decision before applying observes/contest; `RevisionDecision` gains `"gated"`; gated counters)
- Test: `test/consolidate/edge-write.test.ts`, `test/consolidate/birth.test.ts`, `test/consolidate/revision.test.ts`

**Design — the `admit` dep (shared type):**
```ts
// import from envelope.ts
export interface EnvelopeAction { action: EnvelopeActionType; fromPath: string; toPath: string; }
export type Admit = (a: EnvelopeAction) => Promise<EnvelopeVerdict>;
```
Add `admit: Admit` to `BirthDeps` and `RevisionDeps`.

**Birth:** one `do()` per neighbor that yields a directed OR symmetric edge. Before the `observe`, call `admit({ action: "edge-observe", fromPath: from, toPath: to })`. If `!verdict.admit`: push a gated verdict entry (`{ neighbor, related: true, direction, premise, reason, gated: true, gate: verdict.gate }`), increment a `gatedCount`, and `continue` — do **not** observe, do **not** push to `observations`, do **not** record the direction-pending tension (the gate already surfaced it via the journal). If admit: proceed exactly as today.

> Symmetric note: the direction-pending tension is the SURFACE for genuinely-symmetric edges, so it is logged only on the admit path. A gated symmetric edge is surfaced by the journal/lint, not a tension (D3 — avoid flood). Keep that ordering.

**Revision:** the panel produces ONE aggregate decision (`survives`/`fails`/`tie`/`no-vote`). Consult `admit` ONCE, after aggregation, for the cases that write:
- `decision === "fails"` → `admit({ action: "edge-contest", fromPath, toPath })`; on refuse set `decision = "gated"`, write nothing.
- `decision === "survives"` → `admit({ action: "edge-observe", fromPath, toPath })`; on refuse set `decision = "gated"`, apply NO observes.
- `tie`/`no-vote` → unchanged (already write nothing; no admit needed).
Add `"gated"` to `RevisionDecision`; carry a `gate?`/`gateReason?` onto `RevisionOutcome`/`RevisionTraceRow`. On admit, apply the observes/contest exactly as today (the per-vote observe loop is the mechanical strength accrual of the ONE admitted action — admit is consulted once, not per observe).

**edge-write.ts:** delete the `recordShadowAction(...)` calls in `makeObserve`/`makeContest`; in shadow mode return `stubEdge(...)` directly (no journal). Keep the live path (`observeEdge`/`contestEdge`). The `principal`/journaling responsibility moves to the CLI's `makeAdmit` (Task 7). Update `EdgeWriteConfig` if `principal` is now unused here (it is — remove it or leave it unused; prefer removing and let Task 7 own principal).

- [ ] **Step 1: Write failing tests.**
  - `edge-write.test.ts`: replace the "shadow mode writes a shadow record" assertions with "shadow mode returns a stub and writes NO shadow record" (assert `listShadowActions` is empty after a shadow observe).
  - `birth.test.ts`: with a stub `admit` that refuses, `birthOne` produces zero `observations`, a gated verdict entry, and records no tension; with an admitting stub, behaves as today.
  - `revision.test.ts`: with a refusing `admit`, a majority-survives panel yields `decision === "gated"` and `observedCount === 0`; a majority-fails panel yields `decision === "gated"` and `contestedCount === 0`; with an admitting stub, unchanged.
- [ ] **Step 2: Run — verify fail.** `npx vitest run test/consolidate/birth.test.ts test/consolidate/revision.test.ts test/consolidate/edge-write.test.ts` → FAIL.
- [ ] **Step 3: Implement** the `admit` dep + gated branches in birth/revision and the journaling removal in edge-write. Update existing birth/revision tests that construct `deps` to pass an admitting `admit: async () => ({ admit: true, gate: null, reason: "ok", impact: 0 })`.
- [ ] **Step 4: Run.** Same three files → PASS.
- [ ] **Step 5:** `npm run build && npm run lint` clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/consolidate/edge-write.ts src/consolidate/birth.ts src/consolidate/revision.ts test/consolidate/edge-write.test.ts test/consolidate/birth.test.ts test/consolidate/revision.test.ts
  git commit -m "feat(consolidate): consult envelope admit in birth/revision; move journaling to the loop (Stage 3, §5/D6)"
  ```

---

## Task 7: Piece 1 — CLI `makeAdmit`: assemble context, own session-spend, journal

Build the real `admit` in the consolidate CLI: it owns the per-run session-spend scalar, assembles the envelope context from in-process docs + tensions, computes metrics once, calls `evaluateEnvelope`, journals the decision, and deducts on admit. Inject it into both loops.

**Files:**
- Modify: `src/consolidate/index.ts` (`makeAdmit`; thread `admit` into `runBirthLoop`/`runRevisionLoop`; report gated counts; remove the now-stale "edge writes journaled to shadow-actions.jsonl" line ownership from edge-write)
- Create (optional): keep `makeAdmit` in `index.ts` next to `makeObserve` wiring, OR a small `src/consolidate/admit.ts` if `index.ts` is already large — **check `index.ts` length; if it's already big, put `makeAdmit` in `src/consolidate/admit.ts`** (one responsibility per file). Default: new file `src/consolidate/admit.ts`.
- Test: `test/consolidate/admit.test.ts`, extend `test/consolidate/index-stage2.test.ts`

**Design — `makeAdmit`:**
```ts
// src/consolidate/admit.ts
export interface AdmitConfig {
  vaultRoot: string;
  principal: string;             // CONSOLIDATE_AGENT
  docByPath: Map<string, { relPath: string; content: string }>;
  // Pre-loaded once per run so the loop's own just-logged tensions don't
  // self-gate later edges in the same session.
  unresolvedTensionPaths: Set<string>; // canonicalized endpoint paths
}
export function makeAdmit(cfg: AdmitConfig): Admit {
  let spent = 0; // the §3.7 per-session scalar, ENVELOPE-owned (D6)
  return async ({ action, fromPath, toPath }) => {
    const from = canon(fromPath), to = canon(toPath);
    // 1. assemble endpoint states
    const endpoints = [from, to].map((p) => endpointState(cfg, p));
    // 2. metrics (impact/budget/blast) — ONE loadDocuments via computeShadowMetrics, seed = from
    const m = await computeShadowMetrics(cfg.vaultRoot, action, [from, to]);
    if (!m.ok) /* fail open? NO — fail closed: refuse with reason, journal nothing */ return { admit: false, gate: "invariants", reason: `cannot assess: ${m.error.message}`, impact: 0 };
    // 3. decide
    const verdict = evaluateEnvelope({ action, endpoints, impact: m.value.impact, budget: m.value.budget }, spent);
    // 4. journal (admitted or gated)
    await recordEnvelopeDecision(cfg.vaultRoot, {
      tool: action === "edge-observe" ? "vault_edge_observe" : "vault_edge_contest",
      action, targetPath: from, touchedPaths: [from, to],
      agent: cfg.principal, principal: cfg.principal,
      decision: verdict.admit ? "admitted" : "gated",
      ...(verdict.gate ? { gate: verdict.gate, gateReason: verdict.reason } : {}),
      impact: verdict.impact, budget: m.value.budget, blast: m.value.blast, spentBefore: spent,
      commitMessage: `[envelope:${verdict.admit ? "admit" : "gate"}] ${action} ${from} ← ${to}`,
    });
    // 5. deduct on admit (D1)
    if (verdict.admit) spent += verdict.impact;
    return verdict;
  };
}
```
`endpointState(cfg, path)`:
- `provenanceKnown`: parse the doc (`parseDocument(content)`); `provenanceKnown = parsed.ok && parsed.value.validation.valid`. Doc not in `docByPath` ⇒ `false` (unknown). (v1: broken/unknown = invalid frontmatter or missing doc. Dangling-source detection deferred — note in code.)
- `decayBlocking`: `const d = computeDecay(frontmatter); decayBlocking = d !== null && d.level !== "aging";` (warn|deprecated block; aging does not).
- `hasUnresolvedTension`: `cfg.unresolvedTensionPaths.has(path)`.

**Wiring in `index.ts`:**
- Build `unresolvedTensionPaths` once: `listTensions(vaultRoot)` → filter `!resolved` → add canon(`sourceA`), canon(`sourceB`) for each.
- `const admit = makeAdmit({ vaultRoot, principal: CONSOLIDATE_AGENT, docByPath, unresolvedTensionPaths });`
- Pass `admit` into `runBirthLoop`/`runRevisionLoop` **as a new positional parameter** (these runners take positional args, not a `deps` object — the `BirthDeps`/`RevisionDeps` objects are constructed *inside* the runners at the injection points, birth.ts wiring ~index.ts:459 and revision.ts wiring ~index.ts:524). Add `admit` to the `deps` object built there (`{ ..., admit }`).
- Report: add `gated: <count>` to the Component-A report block (sum birth `gatedCount` + revision `gated` decisions; thread through `Stage2Result`).
- The "shadow_mode: true — edge writes journaled…" report line stays accurate (journaling now happens in `makeAdmit`, still to `shadow-actions.jsonl`).

> **Fail-closed choice:** if metrics can't be computed (e.g. `loadDocuments` fails), `makeAdmit` REFUSES (surfaces) rather than admits — the envelope must never auto-write on incomplete information (spec §5.1 spirit). Test this.

> **Note:** `makeAdmit` runs even when `shadowMode` is false (the envelope decision is identical shadow-on/off; only the store write differs — that's `makeObserve`'s live branch). Stage 3 ships with shadow ON by default, but the gate is not conditional on shadow.

- [ ] **Step 1: Write failing tests** in `test/consolidate/admit.test.ts`:
  ```ts
  it("admits a clean edge and deducts impact across calls (deduct-on-admit)", async () => {
    const admit = makeAdmit(cfgWith(/* two clean docs, no tensions */));
    const v1 = await admit({ action: "edge-observe", fromPath: "a.md", toPath: "b.md" });
    expect(v1.admit).toBe(true);
    // second call sees the deducted spend; with a tiny budget it should now gate on budget
    // (construct a fixture where B0 is small enough that the 2nd action exceeds it)
  });
  it("gates an edge whose endpoint has an unresolved tension and journals a gated row", async () => { /* unresolvedTensionPaths has "a.md" */ });
  it("gates a stale endpoint", async () => { /* doc b.md past TTL */ });
  it("refuses (fail-closed) when metrics cannot be computed", async () => { /* point at a bad vaultRoot */ });
  it("a gated action does not deduct (next clean action still admits)", async () => { /* ... */ });
  ```
  Extend `index-stage2.test.ts` with an end-to-end shadow run where one endpoint carries an unresolved tension → the run reports `gated: 1`, the edge is NOT observed, and `shadow-actions.jsonl` has a `decision:"gated"` row.
- [ ] **Step 2: Run — verify fail.** `npx vitest run test/consolidate/admit.test.ts` → FAIL.
- [ ] **Step 3: Implement** `makeAdmit` + the `index.ts` wiring + the report counter.
- [ ] **Step 4: Run.** `npx vitest run test/consolidate/admit.test.ts test/consolidate/index-stage2.test.ts` → PASS.
- [ ] **Step 5:** `npm run build && npm run lint` clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/consolidate/admit.ts src/consolidate/index.ts test/consolidate/admit.test.ts test/consolidate/index-stage2.test.ts
  git commit -m "feat(consolidate): wire envelope admit into the loop (Stage 3, §5/D1/D5/D6)"
  ```

---

## Task 8: Full verification + docs

- [ ] **Step 1: Full suite.** `npm test` → all green (baseline count + the new tests; 3 skips unchanged). Re-run `--failed` if the MiniLM flake hits one job.
- [ ] **Step 2:** `npm run build && npm run lint` → clean.
- [ ] **Step 3: Manual smoke** on the sample vault (shadow mode): run `node dist/cli.js consolidate --mode both` (or the dev entry) against a fixture vault with one tension-bearing edge; confirm the report shows a non-zero `gated` count and `.daftari/shadow-actions.jsonl` carries a `decision:"gated"` row, while a clean edge shows `decision:"admitted"`.
- [ ] **Step 4: Docs.** Update `docs/architecture.md` if it describes the shadow/consolidate path (grep for "shadow" / "would_gate" / "advisory"). Add a CHANGELOG `[Unreleased]` entry: "Stage 3 — envelope enforcement (live, shadowed) + decided_by_principal + tension-resolve ratify gate." **Do NOT amend the CLAUDE.md charter** (that lands with Stage 5 graduation, spec §14).
- [ ] **Step 5: Commit.**
  ```bash
  git add docs/architecture.md CHANGELOG.md
  git commit -m "docs(consolidate): Stage 3 envelope notes + CHANGELOG"
  ```

---

## After implementation (ritual, not plan steps)

1. **Two general-purpose adversarial reviewers** (NOT squad agents — broken tool bindings). Focus them on: the deduct-on-admit accounting (no double-spend, no leak), the journaling move (no `spentByVault` advance by loop actions; no double-journal), invariants precedence + fail-closed, and the resolve-gate's no-access bypass. Fix findings, re-verify.
2. **PR to main.** CI Node-20 MiniLM flake → re-run, don't assume regression.
3. **Release** per `reference_daftari_release_ritual` — bump all four version sites; npm publish is Mihir's MFA step.

## Carried items (not Stage 3)

- Shadow stuck-pending-rate metric (runtime, gates shadow-OFF) — Stage 5 input.
- B coverage/equity instrumentation — Stage 4 (the lint gated section is a down payment).
- All loop constants stay provisional pending Stage 5 calibration.
- Tightening provenance-required to dangling-source detection; case-1 vs case-2 contest split — deferred (noted in code).
