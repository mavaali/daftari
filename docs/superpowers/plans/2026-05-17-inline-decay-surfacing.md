# Inline Decay Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface temporal document decay (past-TTL, old draft, stagnant low-confidence, deprecated) inline in `vault_read` and `vault_search` responses, so an agent cannot silently trust decayed knowledge.

**Architecture:** One pure function `computeDecay` derives a decay state from a document's frontmatter. `vault_read` attaches it as a response field; `vault_search` attaches it per hit. The banner is never written into document `body`. The search index gains `ttl_days`/`created`/`superseded_by` columns so search hits compute decay without re-reading files.

**Tech Stack:** TypeScript (NodeNext, no classes — functions and types), `better-sqlite3`, vitest. Tool handlers return `Result<T, Error>`, never throw. Tests mirror `src/`.

Design source: `docs/plans/2026-05-17-inline-decay-surfacing-design.md`. Issue: [#2](https://github.com/mavaali/daftari/issues/2).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/curation/decay.ts` | `computeDecay`, `DecayState`/`DecayInput` types, shared threshold constants, banner rendering | **Create** |
| `test/curation/decay.test.ts` | Unit tests for `computeDecay` | **Create** |
| `src/storage/index-db.ts` | Add `ttl_days`/`created`/`superseded_by` columns + schema versioning | Modify |
| `test/storage/index-db.test.ts` | Cover the new columns round-trip | Modify |
| `src/search/reindex.ts` | `stageOne` populates the new index fields | Modify |
| `test/search/reindex.test.ts` | Cover new fields surviving a reindex | Modify |
| `src/tools/read.ts` | `VaultReadResult.decay`; `vaultRead` computes it | Modify |
| `test/tools/read.test.ts` | Cover `decay` on read | Modify |
| `src/search/hybrid.ts` | `HybridHit.decay`; `rankDocuments` computes it | Modify |
| `test/search/hybrid.test.ts` | Cover `decay` on hits | Modify |
| `src/curation/lint.ts` | Import shared threshold constants from `decay.ts` (anti-drift) | Modify |

**Note on `vault_search`:** `src/tools/search.ts` needs no change — `vaultSearch` returns the `HybridSearchResult` whose `hits` are `HybridHit`s; once `HybridHit` carries `decay`, it flows through the existing RBAC re-wrap untouched. A test is still added for it.

---

## Task 1: `computeDecay` — the decay function

**Files:**
- Create: `src/curation/decay.ts`
- Test: `test/curation/decay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/curation/decay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeDecay, type DecayInput } from "../../src/curation/decay.js";

const NOW = new Date("2026-05-17T00:00:00Z");

// A healthy, recently-updated document with a long TTL.
function healthy(): DecayInput {
  return {
    status: "canonical",
    confidence: "high",
    updated: "2026-05-10",
    created: "2026-05-01",
    ttl_days: 120,
    superseded_by: null,
  };
}

describe("computeDecay", () => {
  it("returns null for a healthy document", () => {
    expect(computeDecay(healthy(), NOW)).toBeNull();
  });

  it("flags a document past its TTL as warn with a banner", () => {
    const d = computeDecay({ ...healthy(), updated: "2026-01-01", ttl_days: 30 }, NOW);
    expect(d?.level).toBe("warn");
    expect(d?.banner).toContain("STALE");
    expect(d?.reasons.join(" ")).toContain("past its 30d TTL");
  });

  it("flags an aging document but emits no banner (scarcity rule)", () => {
    // 70 days since update against a 120d TTL => score ~0.58, not expired.
    const d = computeDecay({ ...healthy(), updated: "2026-03-08", ttl_days: 120 }, NOW);
    expect(d?.level).toBe("aging");
    expect(d?.banner).toBeNull();
  });

  it("flags a deprecated document with the loudest banner", () => {
    const d = computeDecay({ ...healthy(), status: "deprecated" }, NOW);
    expect(d?.level).toBe("deprecated");
    expect(d?.banner).toContain("DEPRECATED");
  });

  it("flags an old draft", () => {
    const d = computeDecay(
      { ...healthy(), status: "draft", created: "2026-01-01", ttl_days: null },
      NOW,
    );
    expect(d?.level).toBe("warn");
    expect(d?.reasons.join(" ")).toContain("draft");
  });

  it("flags stagnant low-confidence", () => {
    const d = computeDecay(
      { ...healthy(), confidence: "low", updated: "2026-01-01", ttl_days: null },
      NOW,
    );
    expect(d?.level).toBe("warn");
    expect(d?.reasons.join(" ")).toContain("low confidence");
  });

  it("is total: empty updated and null ttl_days yield null, never throws", () => {
    expect(computeDecay({ ...healthy(), updated: "", ttl_days: null }, NOW)).toBeNull();
  });

  it("deprecated outranks an also-stale document", () => {
    const d = computeDecay(
      { ...healthy(), status: "deprecated", updated: "2026-01-01", ttl_days: 30 },
      NOW,
    );
    expect(d?.level).toBe("deprecated");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/curation/decay.test.ts`
Expected: FAIL — `Cannot find module '../../src/curation/decay.js'`.

- [ ] **Step 3: Write `src/curation/decay.ts`**

```ts
// computeDecay — per-document temporal decay, for inline surfacing.
//
// Reports whether a single document has decayed, derived from its own
// frontmatter: past TTL, an old draft, stagnant-low-confidence, or deprecated.
// Pure and total — never throws. A document with absent or unparseable temporal
// fields simply reads as not-decayed (ageInDays is NaN-safe; computeStaleness
// treats a null ttl_days as "never stale"). A null return means healthy —
// nothing to surface. This is the silent baseline.

import { ageInDays, computeStaleness } from "./staleness.js";

// A draft older than this is flagged; a low-confidence document untouched this
// long is flagged. Exported so runLint shares the exact same thresholds.
export const DRAFT_MAX_DAYS = 30;
export const LOW_CONFIDENCE_MAX_DAYS = 30;

export type DecayLevel = "deprecated" | "warn" | "aging";

// The frontmatter subset computeDecay needs. A full Frontmatter is structurally
// assignable to this, and so is the indexed-document projection used by search.
export interface DecayInput {
  status: string;
  confidence: string;
  updated: string;
  created: string;
  ttl_days: number | null;
  superseded_by: string | null;
}

export interface DecayState {
  level: DecayLevel;
  reasons: string[];
  banner: string | null; // null for `aging` (scarcity rule); text for warn/deprecated
}

export function computeDecay(input: DecayInput, now: Date = new Date()): DecayState | null {
  const reasons: string[] = [];
  let level: DecayLevel | null = null;

  // Deprecated — formally retired knowledge. Highest precedence.
  if (input.status === "deprecated") {
    level = "deprecated";
    reasons.push("status is deprecated — this document has been retired");
    if (input.superseded_by) reasons.push(`superseded by: ${input.superseded_by}`);
  }

  // Past TTL.
  const staleness = computeStaleness({ updated: input.updated, ttl_days: input.ttl_days }, now);
  if (staleness.expired && staleness.ttlDays !== null) {
    if (level === null) level = "warn";
    reasons.push(`${staleness.ageDays}d since last update, past its ${staleness.ttlDays}d TTL`);
  }

  // Old draft.
  if (input.status === "draft") {
    const draftAge = ageInDays(input.created || input.updated, now);
    if (draftAge > DRAFT_MAX_DAYS) {
      if (level === null) level = "warn";
      reasons.push(`a draft for ${draftAge}d (limit ${DRAFT_MAX_DAYS}d)`);
    }
  }

  // Stagnant low-confidence.
  if (input.confidence === "low") {
    const idleDays = ageInDays(input.updated, now);
    if (idleDays >= LOW_CONFIDENCE_MAX_DAYS) {
      if (level === null) level = "warn";
      reasons.push(
        `low confidence and untouched for ${idleDays}d (limit ${LOW_CONFIDENCE_MAX_DAYS}d)`,
      );
    }
  }

  // Aging — past half its TTL but below every `warn` threshold. No banner.
  if (level === null && !staleness.expired && staleness.score >= 0.5) {
    level = "aging";
    reasons.push(
      `${staleness.ageDays}d since last update, ` +
        `${Math.round(staleness.score * 100)}% of its ${staleness.ttlDays}d TTL`,
    );
  }

  if (level === null) return null; // healthy — silent baseline

  return { level, reasons, banner: renderBanner(level, reasons) };
}

// The banner is null for `aging` (scarcity rule). For warn/deprecated it is a
// Daftari-authored, action-stating warning. The reason lines may include a
// `superseded_by` path; that is the only document-supplied text, and it rides
// as a quoted list item, never interpolated into the directive sentence.
function renderBanner(level: DecayLevel, reasons: string[]): string | null {
  if (level === "aging") return null;
  const head =
    level === "deprecated"
      ? "⚠ DEPRECATED — this document has been retired. Do not rely on it; find the current source."
      : "⚠ STALE — this document may no longer be accurate. Verify against a current source before relying on it.";
  return `${head}\n${reasons.map((r) => `  - ${r}`).join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/curation/decay.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/curation/decay.ts test/curation/decay.test.ts
git commit -m "feat: add computeDecay for per-document temporal decay"
```

---

## Task 2: Index schema — add decay columns + schema versioning

**Files:**
- Modify: `src/storage/index-db.ts`
- Test: `test/storage/index-db.test.ts`

The `documents` table must carry `ttl_days`, `created`, `superseded_by` so search hits compute decay without re-reading files. Because `.daftari/index.db` is ephemeral, a stored-vs-current schema-version mismatch drops and recreates the tables (reindex repopulates).

- [ ] **Step 1: Write the failing test**

Add to `test/storage/index-db.test.ts` a test that inserts an `IndexedDocument` with `ttlDays`, `created`, `supersededBy` set and reads it back via `getDocument`, asserting the three fields round-trip. (Follow the existing test file's setup patterns for opening a temp DB.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/storage/index-db.test.ts`
Expected: FAIL — `IndexedDocument` has no `ttlDays`/`created`/`supersededBy`.

- [ ] **Step 3: Modify `src/storage/index-db.ts`**

1. Add a schema version constant near the top: `const SCHEMA_VERSION = "2";`
2. In `SCHEMA`, add to the `documents` table: `ttl_days INTEGER`, `created TEXT NOT NULL DEFAULT ''`, `superseded_by TEXT`.
3. Extend `IndexedDocument` with `ttlDays: number | null; created: string; supersededBy: string | null;`.
4. In `openIndexDb`, after `db.exec(SCHEMA)`, read `meta` key `schema_version`; if it is not `SCHEMA_VERSION`, run `DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS chunks;`, re-run `db.exec(SCHEMA)`, then write `schema_version`. (A fresh DB has no `schema_version` row — treat absent as mismatch.) Drop only `documents` and `chunks` — never `meta`, which holds `schema_version` itself.
5. Update `insertDocument` to bind the three new columns.
6. Extend `DocumentRow` and `rowToDocument` with the three new fields (`ttl_days` reads as `number | null`, `superseded_by` as `string | null`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/storage/index-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/index-db.ts test/storage/index-db.test.ts
git commit -m "feat: index ttl_days/created/superseded_by with schema versioning"
```

---

## Task 3: Reindex populates the new fields

**Files:**
- Modify: `src/search/reindex.ts`
- Test: `test/search/reindex.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test to `test/search/reindex.test.ts`: reindex a temp vault containing a document with a known `ttl_days` and `created`, then open the index and assert `getDocument` returns those values. Reuse the file's existing `makeTempVault()` helper — safe here because this task asserts field *values*, not a document *count*, so the Task 4/5 `sample-vault` warning does not apply.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search/reindex.test.ts`
Expected: FAIL — staged document omits the new fields.

- [ ] **Step 3: Modify `src/search/reindex.ts`**

In `stageOne`, extend the returned `doc` object with:
```ts
ttlDays: fm.ttl_days,
created: fm.created,
supersededBy: fm.superseded_by,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/search/reindex.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/reindex.ts test/search/reindex.test.ts
git commit -m "feat: stage ttl_days/created/superseded_by into the index"
```

---

## Task 4: `vault_read` returns the decay state

**Files:**
- Modify: `src/tools/read.ts`
- Test: `test/tools/read.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests to `test/tools/read.test.ts`. **Do not add files to `test/fixtures/sample-vault`** — its document count is hard-asserted (`10`) across multiple test files (`local.test.ts`, `reindex.test.ts`, `rbac.test.ts`, `search.test.ts`, `read.test.ts`); adding a file there breaks all of them. Instead build a dedicated temp directory for these tests: `mkdtemp` a fresh dir, write hand-crafted markdown files into it, and call `vaultRead(tempDir, relPath)` — `vault_read` only needs the target file to exist under the given root.

`vaultRead` computes decay with the real wall clock (`computeDecay` defaults `now` to `new Date()`), so use frontmatter dates whose decay state is unambiguous regardless of when the test runs:
- **healthy** → `status: canonical`, `confidence: high`, `ttl_days: null` (no TTL = never stale) → expect `decay: null`.
- **warn** → `status: canonical`, `updated: 2020-01-01`, `ttl_days: 1` (years past TTL) → expect `decay.level === "warn"`, non-null `banner`.
- **content integrity** → assert the returned `content` is byte-identical to the body written to the file — the banner is never inside `body`.

Do not assert `aging` here (it is wall-clock-sensitive); `aging` is covered by the `computeDecay` unit tests in Task 1.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/read.test.ts`
Expected: FAIL — `VaultReadResult` has no `decay`.

- [ ] **Step 3: Modify `src/tools/read.ts`**

1. Import: `import { computeDecay, type DecayState } from "../curation/decay.js";`
2. Add `decay: DecayState | null;` to `VaultReadResult`.
3. In `vaultRead`, after the parse succeeds, add `decay` to the returned object:
   ```ts
   decay: computeDecay(parsed.value.frontmatter),
   ```
   `Frontmatter` is structurally assignable to `DecayInput`. The banner stays inside the `decay` object — `content` is never modified.
4. Update the `vault_read` tool `description` to mention it returns a decay assessment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tools/read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts test/tools/read.test.ts
git commit -m "feat: vault_read surfaces inline decay state"
```

---

## Task 5: `vault_search` hits carry the decay state

**Files:**
- Modify: `src/search/hybrid.ts`
- Test: `test/search/hybrid.test.ts`, `test/tools/search.test.ts`

**Note:** `rankDocuments` is shared by `hybridSearch` and `relatedSearch`, so `vault_search_related` hits gain `decay` for free — no extra work, and harmless. Optionally add a one-line assertion for it.

- [ ] **Step 1: Write the failing test**

Add a test to `test/search/hybrid.test.ts`: build a **dedicated** small temp vault and search it — do **not** use `makeTempVault()` (it copies the shared `sample-vault`; see the count-assertion warning in Task 4). Build it exactly as Task 4 builds its temp dir: `mkdtempSync` a fresh directory, write 3–4 hand-crafted markdown files into it (one `canonical` with `updated: 2020-01-01`, `created: 2020-01-01`, `ttl_days: 1` so it is unambiguously past-TTL), then call `reindexVault(tempDir)`. Run `hybridSearch` for a query matching that document and assert its hit carries `decay.level === "warn"`. (The `mkdtempSync` + write-markdown pattern is in `test/curation/tension.test.ts` and `test/tools/curation.test.ts` if you need a reference — `test/search/reindex.test.ts` is *not* a reference here, it copies the shared fixture.)

Add a test to `test/tools/search.test.ts` asserting `decay` is present on `vaultSearch` hits (it flows through the RBAC re-wrap unchanged).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search/hybrid.test.ts`
Expected: FAIL — `HybridHit` has no `decay`.

- [ ] **Step 3: Modify `src/search/hybrid.ts`**

1. Import: `import { computeDecay, type DecayState } from "../curation/decay.js";`
2. Add `decay: DecayState | null;` to `HybridHit`.
3. In `rankDocuments`, where each `HybridHit` is built, add:
   ```ts
   decay: computeDecay({
     status: doc.status,
     confidence: doc.confidence,
     updated: doc.updated,
     created: doc.created,
     ttl_days: doc.ttlDays,
     superseded_by: doc.supersededBy,
   }),
   ```
   These fields are all present on `IndexedDocument` after Tasks 2–3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/search/hybrid.test.ts test/tools/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search/hybrid.ts test/search/hybrid.test.ts test/tools/search.test.ts
git commit -m "feat: vault_search hits carry inline decay state"
```

---

## Task 6: Share the threshold constants with `runLint` (anti-drift)

**Files:**
- Modify: `src/curation/lint.ts`
- Test: `test/curation/lint.test.ts` (existing tests must still pass — no behavior change)

`runLint` hardcodes `draftMaxDays = 30` / `lowConfidenceMaxDays = 30` defaults. Import them from `decay.ts` so the limits cannot drift between `vault_lint` and inline surfacing. (Scoped per adversarial-review finding F6: share the constants, not the whole function — `runLint`'s per-check bucketing differs from `computeDecay`'s grouped output.)

- [ ] **Step 1: Modify `src/curation/lint.ts`**

Import `DRAFT_MAX_DAYS`, `LOW_CONFIDENCE_MAX_DAYS` from `./decay.js`; use them as the defaults in `runLint` for `draftMaxDays` / `lowConfidenceMaxDays`.

- [ ] **Step 2: Run the existing lint tests to verify no regression**

Run: `npx vitest run test/curation/lint.test.ts`
Expected: PASS — behavior unchanged (the constants are still 30).

- [ ] **Step 3: Commit**

```bash
git add src/curation/lint.ts
git commit -m "refactor: share decay thresholds between runLint and computeDecay"
```

---

## Final verification

- [ ] `npm run build` — passes.
- [ ] `npm run lint` — exits 0.
- [ ] `npm test` — all tests pass (160 existing + new).

## NOT in scope

- **Structural decay** (orphan, deprecated-still-linked, tensions) — issue #8.
- **`vault_index` decay signal** — deliberately deferred.
- **Refactoring `runLint`'s per-check logic to call `computeDecay` wholesale** — only the threshold constants are shared (F6); the bucketed-vs-grouped output formats differ.
- **A scarcity cap** on banner frequency — tracked as a residual risk in the design doc.

## What already exists

- `computeStaleness` / `ageInDays` — `src/curation/staleness.ts`. NaN-safe TTL math; `computeDecay` builds on it.
- Temporal checks (`staleFiles`, `oldDrafts`, `stagnantLowConfidence`) — in `runLint` (`src/curation/lint.ts`); kept, with shared constants.
- `documents` index table — `src/storage/index-db.ts`; has `status`/`confidence`/`updated`, gains three columns here.
- Advisory validation report — already on `VaultReadResult`; `decay` sits beside it.
