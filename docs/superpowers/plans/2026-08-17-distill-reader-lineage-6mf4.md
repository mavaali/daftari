# Reader-Lineage Provenance (6mf.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make distilled-belief reader provenance an append-only *lineage* that survives compilation (update-in-place, revision, merge), not a birth stamp the next writer clobbers.

**Architecture:** Lineage lives ON the doc as `reader_lineage: string[]` in raw frontmatter (entries `"<ISO-ts>|<op>|<encodeReader>"`, op ∈ ingest|update|revision). `readers[]` stays as the materialized set-projection. The clobber is fixed once at the `vaultWrite` #113 update-merge chokepoint (land-time union), which repairs every writer path at once — no writer reads the doc. The revision panel appends via an injected dep, gated on applied-writes-only. No new jsonl file (`.daftari/*.jsonl` is gitignored and would not survive `git clone` — a provenance claim must travel with the markdown tree).

**Tech Stack:** TypeScript (ESM, Result-not-throw house style), vitest, daftari `src/distill`, `src/tools/write.ts`, `src/consolidate/revision.ts`, `src/canon`.

**Spec:** `work/6mf4-fable-design-findings.md` (fable design, BUILD-WITH-CHANGES). Ground against daftari `origin/main` @ `9176ea5`.

**Execution home:** a dedicated worktree `.worktrees/reader-lineage` off `origin/main` + `npm ci` (never build/commit in the busy main checkout). Branch `feat/distill-reader-lineage`. Plan doc gets committed to `docs/superpowers/plans/` in that worktree as step 0.

**Two amendments to the bead's implied shape (Mihir signed off 2026-08-17):**
1. The reader/lineage union lands at the `vaultWrite` #113 merge chokepoint, NOT in `propose`.
2. The revision panel appends via an injected `RevisionDeps` fn, gated on `observedCount>0 || contestedCount>0`.

---

## Requirements traceability (from the fable spec)

- **R1** Lineage on doc as `reader_lineage[]` in raw; `readers[]` = dedupe(reader-part of lineage).
- **R2** Update-in-place preserves prior readers + lineage (the core fix), via land-time union at the #113 merge.
- **R3** Revision panel appends one `revision` entry to the from-doc iff a write was applied; no-op on gated/tie/no-vote/shadow.
- **R4** `vault_merge` concatenates + dedupes both lineages (no re-sort, no synthetic entry); reconciles with 6mf.1 `readers[]` union + scalar-drop.
- **R5** `supersede` appends nothing (successor keeps its own lineage; copying forward = false parentage).
- **R6** Append-only; entries unique on (op, reader-string); duplicate append declined (not mutated).
- **R7** null=delete escape hatch evaluated BEFORE the union; malformed lineage filtered-as-absent, never bricks a write.
- **R8** Migration: lazy backfill of synthetic `ingest` entries from `readers[]` at `doc.created` on first lineage-touching op; no batch pass.
- **R9** Canon projects optional `readerLineage[]` (6mf.3 extension), defensive filtering.
- **R10** No change to typed `Frontmatter`; no server-side model call (append is string-mechanical; only the CLI-wired revision appender is model-aware).

---

## File Structure

- **Modify** `src/distill/reader-fingerprint.ts` — add `encodeLineageEntry`/`parseLineageEntry`, `encodeRevisionReader`, `unionLineage`, `readersFromLineage`. Single source of truth for the entry format (mirrors the existing `encodeReader` note).
- **Modify** `src/tools/write.ts` (#113 update-merge, ~1096-1114; 6mf.1 merge fusion, ~2140-2186) — field-aware union for `readers` + `reader_lineage`; migration backfill; scalar-drop reconciliation.
- **Modify** `src/distill/propose.ts` (~205-245) — stamp the lineage entry op (`ingest` on create, `update` when `kind:"update"` threaded from state.ts).
- **Modify** `src/distill/state.ts` — thread the update/ingest signal into the proposal (it already carries `pathOverrides` for updates).
- **Modify** `src/consolidate/revision.ts` (RevisionDeps ~33-45; panel apply ~314-346) — inject `appendReaderLineage`; call once per applied panel.
- **Modify** consolidate CLI wiring (`src/consolidate/index.ts` ~98) — wire the real appender live, no-op in shadow.
- **Modify** `src/canon/types.ts` + `src/canon/index.ts` (`toCanonDoc` ~50-67) — optional `readerLineage?: string[]` projection.
- **Tests** alongside each: `test/distill/reader-lineage.test.ts`, `test/tools/write-reader-lineage.test.ts`, `test/consolidate/revision-lineage.test.ts`, `test/canon/reader-lineage.test.ts`.

---

## Task 0: Worktree + plan commit

- [ ] **Step 1:** `git -C /Users/mihirwagle/projects/daftari worktree add .worktrees/reader-lineage -b feat/distill-reader-lineage origin/main`
- [ ] **Step 2:** `cd .worktrees/reader-lineage && npm ci` (worktrees do NOT share node_modules; never symlink).
- [ ] **Step 3:** Verify baseline green in-scope: `npx vitest run test/distill/ test/tools/ test/consolidate/ test/canon/ && npx tsc --noEmit`. Expected: PASS (this is the clean baseline all later tasks must preserve).
- [ ] **Step 4:** Copy the spec + this plan into `docs/superpowers/plans/2026-08-17-distill-reader-lineage-6mf4.md`, commit: `git commit -m "docs(plan): reader-lineage provenance (6mf.4)"`.

---

## Task 1: Lineage entry codec + set-projection (R1, R6)

**Files:** Modify `src/distill/reader-fingerprint.ts`; Test `test/distill/reader-lineage.test.ts`

- [ ] **Step 1: Write failing tests.**

```typescript
import { describe, it, expect } from "vitest";
import { encodeLineageEntry, parseLineageEntry, unionLineage, readersFromLineage } from "../../src/distill/reader-fingerprint.js";

describe("reader lineage codec", () => {
  it("round-trips ts|op|encodeReader (encodeReader may itself contain pipes)", () => {
    const reader = "anthropic/claude-haiku-4.5|unreported|0.2|false|ab12cd34|4000|8000";
    const e = encodeLineageEntry("2026-08-17T00:00:00Z", "ingest", reader);
    expect(e).toBe(`2026-08-17T00:00:00Z|ingest|${reader}`);
    const p = parseLineageEntry(e);
    expect(p).toEqual({ ts: "2026-08-17T00:00:00Z", op: "ingest", reader });
  });

  it("readersFromLineage dedupes the reader-part preserving first-seen order", () => {
    const r1 = "m1|x", r2 = "m2|y";
    const lin = [encodeLineageEntry("t1","ingest",r1), encodeLineageEntry("t2","update",r2), encodeLineageEntry("t3","revision",r1)];
    expect(readersFromLineage(lin)).toEqual([r1, r2]);
  });

  it("unionLineage appends only entries not already present (op,reader unique), never reorders", () => {
    const a = [encodeLineageEntry("t1","ingest","r1")];
    const b = [encodeLineageEntry("t1","ingest","r1"), encodeLineageEntry("t2","update","r2")];
    expect(unionLineage(a, b)).toEqual([encodeLineageEntry("t1","ingest","r1"), encodeLineageEntry("t2","update","r2")]);
  });

  it("unionLineage dedup key is (op,reader), ignoring ts — a same-(op,reader) re-append is declined", () => {
    const a = [encodeLineageEntry("t1","update","r2")];
    const b = [encodeLineageEntry("t9","update","r2")];
    expect(unionLineage(a, b)).toEqual(a); // ts differs, (op,reader) same → declined
  });

  it("parseLineageEntry returns null for malformed input (fewer than 2 pipes / empty)", () => {
    expect(parseLineageEntry("garbage")).toBeNull();
    expect(parseLineageEntry("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run test/distill/reader-lineage.test.ts` → FAIL (exports not defined).
- [ ] **Step 3: Implement** in `reader-fingerprint.ts`. `encodeLineageEntry(ts,op,reader) => \`${ts}|${op}|${reader}\``. `parseLineageEntry`: split on first two `|` only (reader keeps its pipes); return null if <2 separators. `readersFromLineage`: map parse → reader, dedupe first-seen. `unionLineage(existing, incoming)`: start from existing (never reordered); for each incoming entry, append iff no existing entry shares `(op,reader)`. Keep the `LineageOp` type = `"ingest"|"update"|"revision"`.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** `feat(distill): reader-lineage entry codec + set-projection (6mf.4 R1/R6)`.

---

## Task 2: Land-time union at the #113 update-merge chokepoint (R2, R6, R7) — THE FIX

**Files:** Modify `src/tools/write.ts` (~1096-1114); Test `test/tools/write-reader-lineage.test.ts`

Context: on an update to an existing doc, the #113 merge inherits omitted keys but lets explicit payload keys WIN. Today propose supplies `readers`/`reader_*` explicitly → they overwrite v1. Fix: make the merge field-aware for exactly `readers` and `reader_lineage`.

- [ ] **Step 1: Write failing tests** (unit against the merge function; use a temp vault + a real stage→ratify where practical):

```typescript
// 2a: update unions readers + appends lineage, prior preserved
it("update-in-place unions readers and appends lineage (prior preserved)", async () => {
  // doc v1: readers:[r1], reader_lineage:[ingest r1], reader_model:m1 ...
  // payload v2 (explicit): readers:[r2], reader_lineage:[update r2], reader_model:m2
  // after merge: readers = {r1,r2}; reader_lineage = [ingest r1, update r2]
  //   AND (6mf.1) >1 distinct reader ⇒ every scalar reader_* dropped
});
// 2b: explicit null still deletes (escape hatch evaluated BEFORE union)
it("explicit reader_lineage:null / readers:null deletes the field", async () => { /* ... */ });
// 2c: malformed on-disk lineage does not brick the write
it("non-array reader_lineage on disk → treated absent, write succeeds with fresh lineage", async () => { /* ... */ });
// 2d: idempotent re-land is a no-op
it("re-landing the same payload leaves readers+lineage unchanged", async () => { /* ... */ });
// 2e: a non-distill vault_write update supplying readers unions (not clobber)
it("generic vault_write update with readers payload unions with existing", async () => { /* ... */ });
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement.** In the #113 merge, BEFORE applying explicit payload keys: (1) evaluate the null-delete escape hatch first (unchanged). (2) If both existing and payload carry `readers`/`reader_lineage`, replace the payload's value with `unionLineage`/`readersFromLineage`-consistent union of `existing ∪ payload` (filter non-array/non-string as absent). (3) Recompute the 6mf.1 rule: if the unioned `readers` has >1 distinct entry, delete every scalar `reader_*` from the merged raw. Reuse helpers from Task 1; do not duplicate the union logic.
- [ ] **Step 4: Run, verify pass.** Also run the existing write suite to prove no regression: `npx vitest run test/tools/`.
- [ ] **Step 5: Commit** `feat(write): land-time union of reader provenance at #113 merge (6mf.4 R2)`.

---

## Task 3: Distill stamps ingest vs update op (R1)

**Files:** Modify `src/distill/propose.ts` (~205-245), `src/distill/state.ts`; Test in `test/distill/reader-lineage.test.ts`

- [ ] **Step 1: Failing test** — a `kind:"update"` claim produces a staged proposal whose `reader_lineage` entry op is `update`; a `kind:"new"` claim produces `ingest`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** `buildReaderFrontmatter` takes the op (default `ingest`). `distillUpsert` already distinguishes update vs new (state.ts `pathOverrides`); thread an `op` alongside the path override into `proposeAllClaims` so update proposals stamp `update`. No read of the target doc (union happens at land time in Task 2).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** `feat(distill): stamp lineage op ingest|update at propose (6mf.4)`.

---

## Task 4: Revision-panel lineage append (R3, R10)

**Files:** Modify `src/consolidate/revision.ts` (RevisionDeps ~33-45, panel apply ~300-346), `src/consolidate/index.ts` (CLI wiring — the real seam is the `RevisionDeps` assembly inside `runRevisionLoop` ~620-671 fed from the CLI ~409, NOT the help-string at ~98), `src/consolidate/edge-write.ts` (mirror the `makeObserve`/`makeContest({vaultRoot, shadowMode})` shadow-aware factory precedent ~352-360), `src/distill/reader-fingerprint.ts` (`encodeRevisionReader`); Test `test/consolidate/revision-lineage.test.ts`

- [ ] **Step 1: Failing tests.**

```typescript
it("survives with observes applied → from-doc gains ONE revision entry with panel model", async () => {
  // appendReaderLineage stub records calls; assert called once with ("revision", opts.model-derived reader)
});
it("gated/tie/no-vote → appendReaderLineage NOT called", async () => { /* three cases */ });
it("shadow wiring injects a no-op appender → panel writes no lineage", async () => { /* ... */ });
it("append failure lands in writeErrors, panel still returns ok", async () => { /* ... */ });
```

- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** Add `appendReaderLineage(path, entry): Promise<Result<void,Error>>` to `RevisionDeps`. After the aggregate decision, call it once iff `observedCount>0 || contestedCount>0`, with `encodeRevisionReader(opts.model)` = `"<model>@na|prompt=<hash8(SYSTEM_BASE+templates)>|retry=false"`. Wrap like `safeAdmit` — a throw/err → push to `writeErrors`, never fail the panel. Panel stays pure; the live CLI wires a raw-frontmatter appender via a `makeAppendReaderLineage({vaultRoot, shadowMode})` factory that mirrors the existing `makeObserve`/`makeContest` factories in `edge-write.ts` — real appender when live (goes through the standard write path so Task 2's union + scalar-drop apply), no-op when `shadowMode`. Inject it into the `RevisionDeps` assembled in `runRevisionLoop`. The appender also unions the panel model into `readers[]` via the standard write path (not a second code path).
- [ ] **Step 4: Verify pass.** Run `npx vitest run test/consolidate/`.
- [ ] **Step 5: Commit** `feat(consolidate): revision panel appends reader-lineage on applied writes (6mf.4 R3)`.

---

## Task 5: vault_merge lineage fusion (R4)

**Files:** Modify `src/tools/write.ts` (6mf.1 fusion ~2140-2186); Test `test/tools/write-reader-lineage.test.ts`

- [ ] **Step 1: Failing tests** — merge(A,B): `reader_lineage` = A's entries then B's not-already-present (exact-string per (op,reader) dedupe); NO re-sort; NO synthetic "merge" entry; `readers` union already exists; legacy-both-sides (neither has lineage) ⇒ no `reader_lineage` key at all.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** Extend the existing 6mf.1 fusion block to also fuse `reader_lineage` via `unionLineage(A,B)`. Mirror the existing legacy-both-sides "no key" guard (write.ts:2177-2179).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** `feat(merge): fuse reader-lineage across both parents (6mf.4 R4)`.

---

## Task 6: Supersede is lineage-inert (R5)

**Files:** Test only — `test/tools/write-reader-lineage.test.ts`

- [ ] **Step 1: Failing/guard test** — after `vault_supersede(pred, succ)`, both docs' `reader_lineage` are byte-unchanged; successor did NOT inherit predecessor's lineage.
- [ ] **Step 2: Run.** If it already passes (supersede is predecessor-only), keep it as a regression lock and note "no code change — locking the invariant." If it fails, the successor path is touching lineage — fix to leave it alone.
- [ ] **Step 3: Commit** `test(supersede): lock lineage-inert invariant (6mf.4 R5)`.

---

## Task 7: Migration — lazy backfill (R8)

**Files:** Modify `src/tools/write.ts` (inside the Task 2 chokepoint); Test `test/tools/write-reader-lineage.test.ts`

- [ ] **Step 1: Failing tests.**
  - `readers:[r1,r2]`, no `reader_lineage` + an `update` op ⇒ result lineage = `[ingest r1 @created, ingest r2 @created, update r_new]` (backfill precedes the op, ts = `doc.created`, set order).
  - No `readers[]`, no lineage (legacy/human doc) ⇒ lineage starts at the current op, NO fabricated ingest.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** In the chokepoint, if existing has `readers[]` but no `reader_lineage`, synthesize `ingest` entries (one per `readers` entry, ts=`doc.created`, using the already-encoded reader string) BEFORE unioning the incoming op's entry. If no `readers[]`, no synthesis.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** `feat(migrate): lazy reader-lineage backfill from readers[] (6mf.4 R8)`.

---

## Task 8: Canon projection (R9)

**Files:** Modify `src/canon/types.ts`, `src/canon/index.ts` (`toCanonDoc` ~50-67); Test `test/canon/reader-lineage.test.ts`

- [ ] **Step 1: Failing tests** — `toCanonDoc` projects optional `readerLineage?: string[]` from `raw.reader_lineage` with the same defensive filter as `readers` (non-array/non-string/malformed entries dropped, never an error); absent ⇒ `undefined`.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement.** Add the field to `CanonDoc` (NOT `Frontmatter`) and project with defensive filtering, mirroring the existing `readers`/`reader_model` projection.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** `feat(canon): project readerLineage (6mf.4 R9)`.

---

## Task 9: End-to-end acceptance + full gate

**Files:** `test/distill/reader-lineage-e2e.test.ts` (temp seeded vault)

- [ ] **Step 1:** Write the two bead-criterion e2e tests over a real temp vault:
  1. **Re-distill with edited statement (reader v2≠v1) through stage→ratify ⇒ lineage `[ingest r1, update r2]`, readers `{r1,r2}`, scalars dropped — not just the latest writer.**
  2. **Panel `survives` with observes applied ⇒ from-doc gains one `revision` entry with the panel model.**
- [ ] **Step 2:** Run the e2e. Expected PASS.
- [ ] **Step 3: Full in-scope gate:** `npx vitest run test/distill/ test/tools/ test/consolidate/ test/canon/ && npx tsc --noEmit && npx biome check src/`. Expected: all PASS/clean.
- [ ] **Step 4: Commit** `test(distill): reader-lineage acceptance e2e (6mf.4)`.
- [ ] **Step 5:** Open PR against `origin/main`, let the CI-gated self-merge run. Do NOT touch other worktrees. Unblocks 6mf.5 (re-read + diff tooling).

---

## Notes for the executor
- Reuse Task 1 helpers everywhere — never re-implement union/parse (DRY).
- `readers[]` must remain exactly `dedupe(reader-part of reader_lineage)` after every op — add an assertion helper the tests share.
- Never coerce any `reader_*`/`reader_lineage` field into typed `Frontmatter` (raw-only, 6mf.3 precedent).
- The only model-aware code is the CLI-wired revision appender; the server stays no-model.
- Watch `daftari-sigterm-reindex-hang` lesson: reproduce load-sensitive behavior inside the real vitest env, not a bash harness.
