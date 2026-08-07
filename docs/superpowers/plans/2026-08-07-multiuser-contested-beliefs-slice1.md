# Multi-User Contested Beliefs — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **This plan spans two files.** This file: header, locked decisions, file structure, Tasks 1–3. **Tasks 4–9 and the Verification gate: `./2026-08-07-multiuser-contested-beliefs-slice1-tasks4-9.md`** (same plan, split for tooling limits only — execute continuously across both).

**Goal:** Multiple authenticated principals hold independently attributed, graded, supersedable positions on one claim doc, with auto-logged binary `positional` tensions, an honest CONTESTED read annotation, and a foreign-position write guard — no lock changes; principals take turns.

**Architecture:** Field extension of the existing frontmatter schema (new built-in fields `positions[]`, `org_position` (typed only, written in Slice 2), `contested`), a new pure module `src/curation/positions.ts`, a new system-generated tension kind `positional` mirroring `inter-proposal`, and two new tools (`vault_assert`, `vault_positions`) in `src/tools/positions.ts` registered in the existing static registry. No new subsystem, no index migration, no lock changes.

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes), gray-matter/js-yaml frontmatter, better-sqlite3 index (untouched), vitest, Biome.

**Spec:** `.plan-inputs/fable-daftari-spec-OUT.md` (Slice 1 = U-1..U-9 + U-6). Audit: `.plan-inputs/fury-daftari-review-OUT.md`. Design doc: `.plan-inputs/fable-daftari-input.md`.

**Base:** branch `feat/multiuser-contested-beliefs` off origin/main e665078. Every primitive the spec cites was re-verified in THIS worktree this run [DATA]: `inter-proposal` kind (src/curation/tension.ts:40), `LOGGABLE_TENSION_KINDS` excluding it (tension.ts:50), self-tension shape enforcement (tension.ts:174–181), `STALE_TIER_LINT_COPY` total record (tension.ts:469–480), `isProposeOnly` (src/access/rbac.ts:72), `canRatify` (rbac.ts:64), `stageActionWithConflictCheck` (src/curation/staged-actions.ts:388), required `outputSchema` on ToolDefinition (src/tools/read.ts:65), `registeredToolNames()` (src/server.ts:68). There is NO in-flight anchor work on this base — ignore every "coordinate with anchor work" note in the spec.

---

## Locked decisions (implementer never re-decides)

Mandated set:

- **DN-1 Principal string = bare `AccessContext.user`.** [DATA] Provenance records `principal: access?.user` (src/tools/write.ts:1083, performWrite param write.ts:396–399, provenance.ts:25–29); the `agent:`/`human:` format at types.ts:54 is a comment on a free-text field, never validated. `positions[].principal` stores the bare user string.
- **R-1 (Fury's blocker) "conflicting stance" is stance-enum-only.** contested ⇔ the unsuperseded set contains ≥1 `assert` AND ≥1 `dispute`. `qualify` conflicts with nothing. NO statement-text semantic comparison — daftari does none anywhere. This makes `contested` and auto-tensioning fully deterministic.
- **C-1 Confidence precedence:** on a contested doc with no `org_position`, `vault_assert` stamps doc `confidence: low` at WRITE time (a write-tool stamp exactly like the `updated`/`updated_by` re-stamp, write.ts:1051–1056 — never a curation auto-fix). There is NO `org_position` writer in Slice 1, so no precedence conflict can exist yet; Slice 2 (`vault_consolidate`, U-10) owns the mirror and the cap clear. `vault_assert` never raises confidence and never touches it on an uncontested doc.
- **C-2 No `pos-000` legacy snapshot in Slice 1.** The first assert on a legacy doc simply starts the position set; `contested` stays false until a genuine second live stance exists. The snapshot is Slice 2 (U-12). Do NOT add it here.
- **R-3 Tension cardinality: BINARY.** One `positional` tension per new conflicting *pair* (the new position × each opposing live position), deduped against OPEN (`resolved: false`) positional tensions on the same doc naming the same two position ids (order-insensitive). N-ary deferred; multiple tensions per claim accepted.
- **DN-3 `loggedBy` for auto-logged positional tensions = the asserting principal's user string.** Consequence [DATA]: the loop-authored ratify gate keys on `loggedBy === CONSOLIDATE_AGENT` (src/tools/curation.ts:226), so positional tensions stay resolvable by any-read role — "human-authored tensions remain resolvable". Flipping to a system id later is one string + one test.

Additional decisions locked by this plan (not in the mandated list — flagged in the plan summary):

- **LD-7 vault_read output key = `contested_positions`.** The spec's `contested` key COLLIDES with the existing `contested?: ContestedTension[]` field on VaultReadResult (the #211 tension-annotation channel, src/tools/read.ts:128 and outputSchema read.ts:865–883). The positional block is a sibling optional key `contested_positions`, absent-key discipline identical to `upstream_staleness` (null/absent = nothing to say).
- **LD-8 `Frontmatter` index signature widens** to `ExtensionValue | Position[] | OrgPosition` (src/frontmatter/types.ts:121–123). `Position[]` is not assignable to `ExtensionValue` (types.ts:41), and an object literal typed `Frontmatter` must satisfy every intersection member — without the widening, schema.ts:255's literal stops compiling. Config-declared extensions are still constrained to `ExtensionValue` at the config layer; this widening is type-plumbing only.
- **LD-9 Write plumbing reuse (resolves spec "Deferred to Implementation" #1):** add `export` to five existing write.ts declarations — `requireIndexReady` (:155), `requireWriteAccess` (:586), `targetCollection` (:185), `loadTargetDocument` (:611, and its `TargetDocument` interface :604), `performFrontmatterWrite` (:643) — and extend `WriteResult["action"]` (:292–302) with `"assert"`, plus an optional `runId?: string` passthrough on `performFrontmatterWrite`. `vault_assert` never duplicates lock/write/index/commit/provenance plumbing.
- **LD-10 `vault_positions` by-principal scans via `loadDocuments`** (src/curation/vault-docs.ts — the lint loader with the incremental stat cache, #357), filtered per-doc with `canRead(access.role, collectionOf(path, fm))`. No index schema change (resolves spec deferred #4).
- **LD-11 Position ordering** = confidence desc (high→medium→low), then `created` desc (string compare on YYYY-MM-DD), then id asc (resolves spec deferred #3).
- **LD-12 `vault_assert` returns `tension_ids: string[]`** (plural), not the spec's singular `tension_id`: under R-3 binary pairing, one assert against two live opposing positions legitimately mints two tensions.
- **LD-13 Foreign-position guard scope (R-12, exact rule):** on an update, reject when an existing on-disk position whose `principal !== access.user` is **removed** or **altered** — with ONE carve-out: a change whose only delta is `superseded_by: null → "pos-N"` where `pos-N` names an incoming position held by the SAME principal as the altered entry. That carve-out is what lets `vault_ratify` replay a staged self-supersession under the ratifier's identity. **Appending** a position for another principal is NOT rejected (R-12 scopes to mutate/remove; ratify dispatch appends the proposer's new entry under the ratifier's access). No-AccessContext servers bypass entirely.
- **LD-14 Lint check name = `positionIntegrity`**, appended to the END of `LINT_CHECKS` (src/curation/lint.ts:47–62 — append-only per the comment at :59). vault_lint's input/output schemas and summary iterate `LINT_CHECKS` generically (src/tools/curation.ts:780–783, :831, :1083), so no tool-schema edit is needed.
- **LD-15 Two spec test scenarios dropped as impossible on this base:** (a) "caller who cannot see the tension → `open_tension_ids` empty": positional tensions are self-tensions on the doc being read, and the caller already passed vault_read's `canRead` gate, so visibility is implied — no `canSeeTension` call needed (comment this in code); (b) "summarize output contains the CONTESTED line": vault_read has no `summarize` (read.ts:763–904) — the JSON fallback already carries the structured flag.
- **LD-16 Position-element validation severity:** `report.valid === false` hard-blocks writes (schema.ts:224–232 comment), and that is CORRECT here for type-shape errors — a payload with a malformed positions array must not land. Missing/invalid `id`/`principal`/`stance`/`confidence`/`created` on an element ⇒ issue + element dropped from the typed value (coerce-and-report). Invalid `provenance`/`statement`/`valid_from`/`superseded_by`/`sources` types flag but coerce (default `direct` / null / null / null / []). Semantic problems (dangling `superseded_by`, duplicate live position per principal, contested drift) never flag in schema — they are lint's job (U-9), the `optionalDate`/`validityConflicts` precedent.

### Line-number drift vs the spec (verified this run, all primitives present)

| Spec citation | Actual in this worktree |
|---|---|
| write.ts:1062 principal | write.ts:1083 (`principal: access?.user`); performWrite provenance :498 |
| write.ts:991–1001 re-stamp | write.ts:1012–1023 (fill), :1051–1056 (stamp) |
| write.ts:827–857 staged coercion | write.ts:848–905 |
| write.ts:220–278 serializeDocument | write.ts:229–288 |
| types.ts:34 ExtensionValue | types.ts:41 |
| types.ts:86–106 BUILTIN_FRONTMATTER_FIELDS | types.ts:94–115 |
| schema.ts:121–283 / 197–212 / 222–232 | schema.ts:123–286 / 203–214 / 224–245 |
| read.ts:196–257 upstream_staleness | read.ts:164–240 (compute), :96–103 (type), :818–843 (schema) |
| read.ts:888–960 output schema | read.ts:805–898 |
| read.ts:58–73 ToolDefinition outputSchema | read.ts:55–83 (outputSchema :61–65) |
| curation.ts:104–113 kind check | curation.ts:107–114 |
| curation.ts:203–205 ratify gate | curation.ts:204–230 (loop-authored check :226) |
| curation.ts:531–534 resolve any kind | curation.ts:172–176 (RESOLUTION_KINDS check; kind-agnostic) |
| tension.ts:36 / 45–51 / 57 / 60 / 139–150 / 174–181 / 469 / 485–493 | exact match — no drift |
| staged-actions.ts:388 | exact match |
| rbac.ts:51–53 / 64–66 / 68–74 / 99–104 | exact match |

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/frontmatter/types.ts` | modify | `STANCES`/`Stance`, `Position`, `OrgPosition`; three new built-in fields; widened index signature (LD-8) |
| `src/frontmatter/schema.ts` | modify | `optionalPositions` / `optionalOrgPosition` / `optionalBoolean` validators (type-shape only, LD-16) |
| `src/tools/write.ts` | modify | serializeDocument emits the three fields when non-null; export five helpers + `"assert"` action + `runId` passthrough (LD-9); U-8 foreign-position guard call sites |
| `src/curation/positions.ts` | create | Pure position logic: `nextPositionId`, `unsuperseded`, `isContested`, `conflictPairs`, `applyAssert`, `comparePositions`, `foreignPositionViolation` — no fs/db imports |
| `src/curation/tension.ts` | modify | `positional` kind (TENSION_KINDS + ADDABLE, not LOGGABLE); `positionA`/`positionB` render+parse; self-tension shape; STALE_TIER_LINT_COPY entry |
| `src/tools/positions.ts` | create | `vault_assert` + `vault_positions` ToolDefinitions (`positionsTools`) |
| `src/tools/read.ts` | modify | `contested_positions` block on VaultReadResult + outputSchema (LD-7) |
| `src/curation/lint.ts` | modify | `positionIntegrity` check (LD-14) |
| `src/server.ts` | modify | register `...positionsTools` |
| `src/access/rbac.ts` | modify | `isProposeOnly` comment update only |
| `docs/architecture.md` | modify | one positions-concept paragraph |
| `test/frontmatter/positions-schema.test.ts` | create | U-1 validation tests |
| `test/tools/serialize-positions.test.ts` | create | U-1 serialization round-trip / byte-stability tests |
| `test/curation/positions.test.ts` | create | U-2 pure-logic tests + LD-13 guard-function tests |
| `test/curation/tension.test.ts` | modify | U-3 positional-kind tests |
| `test/tools/positions.test.ts` | create | U-4/U-5 tool tests + registry assertion |
| `test/tools/read-positions.test.ts` | create | U-7 tests |
| `test/tools/write.test.ts` | modify | U-8 vault_write guard tests |
| `test/curation/lint.test.ts` | modify | U-9 tests |

Slice 2 (`vault_consolidate`/org_position writer U-10, downstream cap U-11, pos-000 snapshot U-12) and Slice 3 (per-mutation write lease U-13) are follow-ups only — named here so nobody reaches for them.

Conventions every task follows: functions + types, no classes; `Result<T, Error>` returns, never throw from handlers; canonicalize caller paths at the tool boundary (#127/#128); tests mirror src/; commit after each green step. Test harness: `makeTempVault`/`cleanupVault` from `test/helpers/temp-vault.js` (copies `test/fixtures/sample-vault`; the `pricing` collection exists there). AccessContext literals follow `test/tools/write-propose-only.test.ts:12–22`.

---

## Task 1 (U-1): Position schema — types, validation, serialization

**Maps to:** R-1, R-2, R-8 (field shape only). **Depends on:** nothing.

**Files:**
- Modify: `src/frontmatter/types.ts` (after PROVENANCES :19–20; BuiltinFrontmatter :46–89; BUILTIN_FRONTMATTER_FIELDS :94–115; Frontmatter :121–123)
- Modify: `src/frontmatter/schema.ts` (helpers near :203–253; literal :255–276)
- Modify: `src/tools/write.ts` (serializeDocument ordered map :235–261)
- Create: `test/frontmatter/positions-schema.test.ts`, `test/tools/serialize-positions.test.ts`

- [ ] **Step 1.1: Write the failing validation tests**

Create `test/frontmatter/positions-schema.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";

// Complete valid base; tests override only the fields under test.
function data(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Retry storms claim",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-08-01",
    updated: "2026-08-01",
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  };
}

const alicePos = {
  id: "pos-001",
  principal: "alice",
  stance: "assert",
  statement: "Retry storms are caused by the 250ms floor",
  confidence: "high",
  provenance: "direct",
  valid_from: "2026-08-01",
  superseded_by: null,
  created: "2026-08-01",
  sources: ["experiments/retry-floor.md"],
};

const bobPos = {
  id: "pos-002",
  principal: "bob",
  stance: "dispute",
  statement: null,
  confidence: "medium",
  provenance: "direct",
  valid_from: null,
  superseded_by: null,
  created: "2026-08-02",
  sources: [],
};

describe("positions frontmatter validation (U-1)", () => {
  it("legacy doc: positions/org_position/contested are null, report unchanged", () => {
    const r = validateFrontmatter(data());
    expect(r.frontmatter.positions).toBeNull();
    expect(r.frontmatter.org_position).toBeNull();
    expect(r.frontmatter.contested).toBeNull();
    expect(r.report.valid).toBe(true);
  });

  it("parses two well-formed positions with all fields typed", () => {
    const r = validateFrontmatter(data({ positions: [alicePos, bobPos], contested: true }));
    expect(r.report.valid).toBe(true);
    expect(r.frontmatter.positions).toHaveLength(2);
    expect(r.frontmatter.positions?.[0]).toEqual(alicePos);
    expect(r.frontmatter.positions?.[1]).toEqual(bobPos);
    expect(r.frontmatter.contested).toBe(true);
  });

  it("drops an element missing 'stance' with an issue; the other survives", () => {
    const { stance: _stance, ...noStance } = alicePos;
    const r = validateFrontmatter(data({ positions: [noStance, bobPos] }));
    expect(r.report.issues.filter((i) => i.field === "positions")).toHaveLength(1);
    expect(r.frontmatter.positions).toHaveLength(1);
    expect(r.frontmatter.positions?.[0]?.id).toBe("pos-002");
  });

  it("flags a non-array positions value and types it null", () => {
    const r = validateFrontmatter(data({ positions: "yes" }));
    expect(r.frontmatter.positions).toBeNull();
    expect(
      r.report.issues.some((i) => i.field === "positions" && i.message.includes("expected array")),
    ).toBe(true);
  });

  it("dangling superseded_by is NOT a validation issue (semantic → lint)", () => {
    const r = validateFrontmatter(
      data({ positions: [{ ...alicePos, superseded_by: "pos-999" }] }),
    );
    expect(r.report.issues.filter((i) => i.field === "positions")).toEqual([]);
    expect(r.frontmatter.positions?.[0]?.superseded_by).toBe("pos-999");
  });

  it("flags a non-boolean contested and types it null", () => {
    const r = validateFrontmatter(data({ contested: "maybe" }));
    expect(r.frontmatter.contested).toBeNull();
    expect(r.report.issues.some((i) => i.field === "contested")).toBe(true);
  });

  it("defaults element provenance to 'direct' when absent, flags when invalid", () => {
    const { provenance: _p, ...noProv } = alicePos;
    const ok = validateFrontmatter(data({ positions: [noProv] }));
    expect(ok.frontmatter.positions?.[0]?.provenance).toBe("direct");
    expect(ok.report.issues.filter((i) => i.field === "positions")).toEqual([]);
    const bad = validateFrontmatter(data({ positions: [{ ...alicePos, provenance: "psychic" }] }));
    expect(bad.frontmatter.positions?.[0]?.provenance).toBe("direct");
    expect(bad.report.issues.filter((i) => i.field === "positions")).toHaveLength(1);
  });
});
```

- [ ] **Step 1.2: Run it — expected FAIL**

Run: `npx vitest run test/frontmatter/positions-schema.test.ts`
Expected: FAIL — `frontmatter.positions` is `undefined` (property does not exist on `Frontmatter`), first test's `toBeNull()` fails with `undefined`.

- [ ] **Step 1.3: Implement types.ts**

In `src/frontmatter/types.ts`, insert after the PROVENANCES block (:19–20):

```typescript
// A principal's stance on the claim a doc carries. `qualify` refines without
// contesting: it conflicts with nothing (R-1 rule — contested requires a live
// assert AND a live dispute; stance-enum-only, no text comparison).
export const STANCES = ["assert", "dispute", "qualify"] as const;
export type Stance = (typeof STANCES)[number];

// One principal's attributed, graded, supersedable position on a claim doc.
// `principal` is the bare AccessContext.user string — the same ground truth
// the provenance log records (DN-1); never the free-text `agent` claim.
// `superseded_by` targets a position id WITHIN the same doc, or null (live).
export interface Position {
  id: string; // pos-NNN, unique within the doc
  principal: string;
  stance: Stance;
  statement: string | null;
  confidence: Confidence;
  provenance: Provenance;
  valid_from: string | null; // YYYY-MM-DD
  superseded_by: string | null;
  created: string; // YYYY-MM-DD
  sources: string[];
}

// The RATIFIED consolidated stance. Typed in Slice 1 so reads and the schema
// round-trip it; the only writer (vault_consolidate) is Slice 2.
export interface OrgPosition {
  stance: Stance;
  confidence: Confidence;
  ratified_by: string;
  ratified_at: string; // YYYY-MM-DD
  dissent: string[]; // surviving minority position ids
}
```

(`Confidence`/`Provenance` are declared above the insertion point — the references resolve.)

In `BuiltinFrontmatter` (:46–89), append after `questions_raised: string[];`:

```typescript
  // Multi-principal contested beliefs (Slice 1). Null = legacy consolidated
  // doc — principal unknown, never retroactively attributed from updated_by.
  positions: Position[] | null;
  org_position: OrgPosition | null;
  // Derived: ≥2 unsuperseded positions with conflicting stances (assert vs
  // dispute). Recomputed by every vault_assert; lint flags hand-set drift.
  contested: boolean | null;
```

Append `"positions", "org_position", "contested",` to `BUILTIN_FRONTMATTER_FIELDS` (:94–115, before `] as const;`).

Replace the `Frontmatter` type (:121–123):

```typescript
export type Frontmatter = BuiltinFrontmatter & {
  // Widened beyond ExtensionValue because Position[]/OrgPosition are built-in
  // object shapes an intersection literal must satisfy (LD-8). Config-declared
  // extensions are still constrained to ExtensionValue at the config layer.
  [extensionKey: string]: ExtensionValue | Position[] | OrgPosition;
};
```

- [ ] **Step 1.4: Implement schema.ts validators**

In `src/frontmatter/schema.ts`: extend the `./types.js` import with `STANCES`, `type Stance`, `type Position`, `type OrgPosition`. Insert after `optionalNumber` (:247–253):

```typescript
  const optionalBoolean = (field: string): boolean | null => {
    const v = data[field];
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v;
    issues.push({ field, message: `expected boolean or null, got ${JSON.stringify(v)}` });
    return null;
  };

  // Position elements: TYPE-SHAPE errors flag (report.valid === false blocks
  // writes — a malformed positions payload must not land). SEMANTIC problems
  // (dangling superseded_by, duplicate live position per principal, contested
  // drift) deliberately do NOT flag here — vault_lint owns them (U-9), the
  // optionalDate/validityConflicts precedent. A malformed element is dropped
  // from the typed value with one issue; well-formed siblings survive.
  const asDateString = (v: unknown): string | null =>
    v instanceof Date && !Number.isNaN(v.getTime())
      ? v.toISOString().slice(0, 10)
      : typeof v === "string"
        ? v
        : null;

  const optionalPositions = (field: string): Position[] | null => {
    const v = data[field];
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v)) {
      issues.push({ field, message: `expected array, got ${typeof v}` });
      return null;
    }
    const out: Position[] = [];
    v.forEach((item, i) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        issues.push({ field, message: `element ${i} is not an object` });
        return;
      }
      const p = item as Record<string, unknown>;
      const id = typeof p.id === "string" && /^pos-\d+$/.test(p.id) ? p.id : null;
      const principal =
        typeof p.principal === "string" && p.principal.length > 0 ? p.principal : null;
      const stance =
        typeof p.stance === "string" && (STANCES as readonly string[]).includes(p.stance)
          ? (p.stance as Stance)
          : null;
      const confidence =
        typeof p.confidence === "string" &&
        (CONFIDENCES as readonly string[]).includes(p.confidence)
          ? (p.confidence as Confidence)
          : null;
      const created = asDateString(p.created);
      if (!id || !principal || !stance || !confidence || !created) {
        issues.push({
          field,
          message:
            `element ${i} dropped: requires id (pos-NNN), principal, ` +
            `stance (${STANCES.join("|")}), confidence, created`,
        });
        return;
      }
      let provenance: Provenance = "direct";
      if (p.provenance !== undefined && p.provenance !== null) {
        if (
          typeof p.provenance === "string" &&
          (PROVENANCES as readonly string[]).includes(p.provenance)
        ) {
          provenance = p.provenance as Provenance;
        } else {
          issues.push({ field, message: `element ${i}: invalid provenance, coerced to direct` });
        }
      }
      out.push({
        id,
        principal,
        stance,
        confidence,
        provenance,
        statement: typeof p.statement === "string" ? p.statement : null,
        valid_from: asDateString(p.valid_from),
        superseded_by: typeof p.superseded_by === "string" ? p.superseded_by : null,
        created,
        sources: Array.isArray(p.sources)
          ? p.sources.filter((s): s is string => typeof s === "string")
          : [],
      });
    });
    return out;
  };

  const optionalOrgPosition = (field: string): OrgPosition | null => {
    const v = data[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) {
      issues.push({ field, message: `expected object or null, got ${typeof v}` });
      return null;
    }
    const o = v as Record<string, unknown>;
    const stance =
      typeof o.stance === "string" && (STANCES as readonly string[]).includes(o.stance)
        ? (o.stance as Stance)
        : null;
    const confidence =
      typeof o.confidence === "string" && (CONFIDENCES as readonly string[]).includes(o.confidence)
        ? (o.confidence as Confidence)
        : null;
    const ratifiedBy =
      typeof o.ratified_by === "string" && o.ratified_by.length > 0 ? o.ratified_by : null;
    const ratifiedAt = asDateString(o.ratified_at);
    if (!stance || !confidence || !ratifiedBy || !ratifiedAt) {
      issues.push({
        field,
        message: "dropped: requires stance, confidence, ratified_by, ratified_at",
      });
      return null;
    }
    return {
      stance,
      confidence,
      ratified_by: ratifiedBy,
      ratified_at: ratifiedAt,
      dissent: Array.isArray(o.dissent)
        ? o.dissent.filter((s): s is string => typeof s === "string")
        : [],
    };
  };
```

Append to the `frontmatter` literal (:255–276, after `questions_raised`):

```typescript
    positions: optionalPositions("positions"),
    org_position: optionalOrgPosition("org_position"),
    contested: optionalBoolean("contested"),
```

- [ ] **Step 1.5: Build and fix the literal ripple**

Run: `npm run build`
Expected: errors listing every complete-`Frontmatter` object literal now missing the three fields. Fix each mechanically by appending `positions: null, org_position: null, contested: null,` — known site: `test/tools/serialize-order.test.ts:8–31` (`fm()` helper); fix any others tsc names (grep `: Frontmatter = {` if unsure). Do NOT add them to raw `Record<string, unknown>` test data. Re-run until clean.

- [ ] **Step 1.6: Run validation tests — expected PASS**

Run: `npx vitest run test/frontmatter/positions-schema.test.ts`
Expected: 7 passed.

- [ ] **Step 1.7: Write the failing serialization tests**

Create `test/tools/serialize-positions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import type { Frontmatter, Position } from "../../src/frontmatter/types.js";
import { serializeDocument } from "../../src/tools/write.js";

function fm(over: Partial<Frontmatter> = {}): Frontmatter {
  return {
    title: "Claim",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-08-01",
    updated: "2026-08-01",
    updated_by: "agent:test",
    provenance: "direct",
    tier: null,
    criticality: null,
    sources: [],
    superseded_by: null,
    ttl_days: null,
    valid_from: null,
    valid_until: null,
    tags: [],
    describes: [],
    questions_answered: [],
    questions_raised: [],
    positions: null,
    org_position: null,
    contested: null,
    ...over,
  };
}

const pos: Position = {
  id: "pos-001",
  principal: "alice",
  stance: "assert",
  statement: "the floor causes storms",
  confidence: "high",
  provenance: "direct",
  valid_from: null,
  superseded_by: null,
  created: "2026-08-01",
  sources: [],
};

describe("serializeDocument — positions fields (U-1)", () => {
  it("legacy doc (all three null): no positions/org_position/contested keys emitted", () => {
    const text = serializeDocument(fm(), "\nBody.\n");
    expect(text).not.toContain("positions:");
    expect(text).not.toContain("org_position:");
    expect(text).not.toContain("contested:");
  });

  it("round-trips a positions array + contested through serialize → parse", () => {
    const text = serializeDocument(fm({ positions: [pos], contested: false }), "\nBody.\n");
    const parsed = parseDocument(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.frontmatter.positions).toEqual([pos]);
    expect(parsed.value.frontmatter.contested).toBe(false);
    // Round-trip is a fixpoint: serialize(parse(serialize(x))) === serialize(x).
    const again = serializeDocument(
      parsed.value.frontmatter,
      parsed.value.content,
      [],
      parsed.value.raw,
    );
    expect(again).toBe(text);
  });

  it("a doc parsed WITHOUT the fields serializes byte-identically to before (R-2)", () => {
    const legacyText = serializeDocument(fm(), "\nBody.\n");
    const parsed = parseDocument(legacyText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    const roundTripped = serializeDocument(
      parsed.value.frontmatter,
      parsed.value.content,
      [],
      parsed.value.raw,
    );
    expect(roundTripped).toBe(legacyText);
  });
});
```

- [ ] **Step 1.8: Run it — expected FAIL**

Run: `npx vitest run test/tools/serialize-positions.test.ts`
Expected: test 2 FAILS — `positions` key is never emitted (parse returns `positions: null`), `toEqual([pos])` receives `null`. Tests 1 and 3 may already pass — the RED is test 2.

- [ ] **Step 1.9: Implement serializeDocument emission**

In `src/tools/write.ts` `serializeDocument` (:229–288), inside the `ordered` literal after `questions_raised: fm.questions_raised,` (:260):

```typescript
    // Positions (Slice 1): emitted ONLY when non-null — a deliberate exception
    // to the always-emit built-in convention so the thousands of legacy docs
    // stay byte-stable. A null typed value with surviving raw content (e.g. a
    // malformed hand-written positions block) still round-trips verbatim via
    // the raw-preservation loop below (#113).
    ...(fm.positions != null ? { positions: fm.positions } : {}),
    ...(fm.org_position != null ? { org_position: fm.org_position } : {}),
    ...(fm.contested != null ? { contested: fm.contested } : {}),
```

Leave `handled = new Set(Object.keys(ordered))` (:262) untouched — the conditional spread already yields the right behavior in both cases (non-null typed ⇒ in `ordered` ⇒ handled; null typed with raw content ⇒ raw loop preserves verbatim, #113-correct).

- [ ] **Step 1.10: Run tests + adjacent suites — expected PASS**

Run: `npx vitest run test/tools/serialize-positions.test.ts test/frontmatter test/tools/serialize-order.test.ts test/tools/write.test.ts`
Expected: all pass (existing suites untouched proves R-2). Then `npm run build` — clean.

- [ ] **Step 1.11: Commit**

```bash
git add src/frontmatter/types.ts src/frontmatter/schema.ts src/tools/write.ts test/frontmatter/positions-schema.test.ts test/tools/serialize-positions.test.ts test/tools/serialize-order.test.ts
git commit -m "feat(frontmatter): positions/org_position/contested built-in fields (U-1)"
```

---

## Task 2 (U-2): Positions core module (pure logic)

**Maps to:** R-4, R-5 (detection half), R-8, R-12 (guard function — LD-13). **Depends on:** Task 1.

**Files:**
- Create: `src/curation/positions.ts`
- Create: `test/curation/positions.test.ts`

- [ ] **Step 2.1: Write the failing tests**

Create `test/curation/positions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  applyAssert,
  comparePositions,
  conflictPairs,
  foreignPositionViolation,
  isContested,
  nextPositionId,
  unsuperseded,
} from "../../src/curation/positions.js";
import type { Position } from "../../src/frontmatter/types.js";

function pos(over: Partial<Position> & Pick<Position, "id" | "principal" | "stance">): Position {
  return {
    statement: null,
    confidence: "medium",
    provenance: "direct",
    valid_from: null,
    superseded_by: null,
    created: "2026-08-01",
    sources: [],
    ...over,
  };
}

const assertInput = {
  principal: "alice",
  stance: "assert" as const,
  statement: "the floor causes storms",
  confidence: "high" as const,
  provenance: "direct" as const,
  valid_from: null,
  sources: [],
  created: "2026-08-06",
};

describe("positions core (U-2)", () => {
  it("first assert on a null set mints pos-001, not contested", () => {
    const out = applyAssert(null, assertInput);
    expect(out.newPosition.id).toBe("pos-001");
    expect(out.newPosition.principal).toBe("alice");
    expect(out.superseded).toBeNull();
    expect(out.positions).toHaveLength(1);
    expect(isContested(out.positions)).toBe(false);
  });

  it("assert + qualify does not conflict; assert + dispute does (R-1 rule)", () => {
    const a = pos({ id: "pos-001", principal: "alice", stance: "assert" });
    const q = pos({ id: "pos-002", principal: "bob", stance: "qualify" });
    const d = pos({ id: "pos-003", principal: "bob", stance: "dispute" });
    expect(isContested([a, q])).toBe(false);
    expect(conflictPairs(q, [a, q])).toEqual([]);
    expect(isContested([a, d])).toBe(true);
    expect(conflictPairs(d, [a, d])).toEqual([{ a, b: d }]);
  });

  it("re-assert supersedes only the caller's prior live position (mandated: self-supersession)", () => {
    const a1 = pos({ id: "pos-001", principal: "alice", stance: "assert" });
    const b1 = pos({ id: "pos-002", principal: "bob", stance: "dispute" });
    const out = applyAssert([a1, b1], assertInput);
    expect(out.newPosition.id).toBe("pos-003");
    expect(out.superseded?.id).toBe("pos-001");
    expect(out.positions.find((p) => p.id === "pos-001")?.superseded_by).toBe("pos-003");
    expect(out.positions.find((p) => p.id === "pos-002")).toEqual(b1);
    expect(unsuperseded(out.positions).filter((p) => p.principal === "alice")).toHaveLength(1);
    // Inputs are never mutated.
    expect(a1.superseded_by).toBeNull();
  });

  it("superseding the only dispute un-contests the doc (conflict needs two live sides)", () => {
    const a = pos({ id: "pos-001", principal: "alice", stance: "dispute" });
    const b = pos({ id: "pos-002", principal: "bob", stance: "assert" });
    const out = applyAssert([a, b], { ...assertInput, stance: "qualify" });
    expect(isContested(out.positions)).toBe(false);
  });

  it("id allocation scans max numeric suffix over ALL entries incl. superseded (gaps ok)", () => {
    const set = [
      pos({ id: "pos-001", principal: "x", stance: "assert", superseded_by: "pos-007" }),
      pos({ id: "pos-007", principal: "x", stance: "assert" }),
    ];
    expect(nextPositionId(set)).toBe("pos-008");
    expect(nextPositionId([])).toBe("pos-001");
  });

  it("orders by confidence desc, created desc, id asc (LD-11)", () => {
    const low = pos({ id: "pos-001", principal: "a", stance: "assert", confidence: "low" });
    const highOld = pos({
      id: "pos-002",
      principal: "b",
      stance: "assert",
      confidence: "high",
      created: "2026-01-01",
    });
    const highNew = pos({
      id: "pos-003",
      principal: "c",
      stance: "assert",
      confidence: "high",
      created: "2026-08-01",
    });
    expect([low, highOld, highNew].sort(comparePositions).map((p) => p.id)).toEqual([
      "pos-003",
      "pos-002",
      "pos-001",
    ]);
  });
});

describe("foreignPositionViolation (LD-13)", () => {
  const aliceOld = pos({ id: "pos-001", principal: "alice", stance: "assert" });
  const bobOld = pos({ id: "pos-002", principal: "bob", stance: "dispute" });

  it("removing another principal's entry is a violation", () => {
    expect(foreignPositionViolation([aliceOld, bobOld], [aliceOld], "alice")).toContain("pos-002");
  });

  it("altering another principal's statement is a violation", () => {
    const tampered = { ...bobOld, statement: "reworded" };
    expect(foreignPositionViolation([aliceOld, bobOld], [aliceOld, tampered], "alice")).toContain(
      "pos-002",
    );
  });

  it("appending your own entry + superseding your own prior one is fine", () => {
    const aliceNew = pos({ id: "pos-003", principal: "alice", stance: "assert" });
    const after = [{ ...aliceOld, superseded_by: "pos-003" }, bobOld, aliceNew];
    expect(foreignPositionViolation([aliceOld, bobOld], after, "alice")).toBeNull();
  });

  it("ratify carve-out: foreign superseded_by null→same-principal successor passes; hijack fails", () => {
    const bobNew = pos({ id: "pos-003", principal: "bob", stance: "dispute" });
    const after = [aliceOld, { ...bobOld, superseded_by: "pos-003" }, bobNew];
    // Written by carol (a ratifier replaying bob's staged self-supersession).
    expect(foreignPositionViolation([aliceOld, bobOld], after, "carol")).toBeNull();
    const hijack = [aliceOld, { ...bobOld, superseded_by: "pos-001" }, bobNew];
    expect(foreignPositionViolation([aliceOld, bobOld], hijack, "carol")).toContain("pos-002");
  });

  it("dropping the whole positions key (null incoming) violates when foreign entries existed", () => {
    expect(foreignPositionViolation([bobOld], null, "alice")).toContain("pos-002");
  });
});
```

- [ ] **Step 2.2: Run it — expected FAIL**

Run: `npx vitest run test/curation/positions.test.ts`
Expected: FAIL — `Cannot find module '../../src/curation/positions.js'`.

- [ ] **Step 2.3: Implement the module**

Create `src/curation/positions.ts` (pure — imports ONLY from `../frontmatter/types.js`):

```typescript
// Pure position logic for multi-principal contested beliefs (Slice 1).
//
// One claim doc carries a positions[] set (frontmatter/types.ts). This module
// owns id allocation, supersession, the R-1 conflict rule (assert × dispute;
// qualify conflicts with nothing), the contested derivation, and the
// foreign-position guard rule (LD-13). No I/O: the tools layer feeds it
// parsed frontmatter and writes the result back.

import {
  CONFIDENCES,
  type Confidence,
  type Position,
  type Provenance,
  type Stance,
} from "../frontmatter/types.js";

// Assigns the next sequential pos-NNN id. Scans EVERY entry (live and
// superseded — ids are never reused) for the highest numeric suffix,
// mirroring nextTensionId (tension.ts:139–150).
export function nextPositionId(existing: Position[]): string {
  let max = 0;
  for (const p of existing) {
    const m = p.id.match(/^pos-(\d+)$/);
    if (!m) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `pos-${String(max + 1).padStart(3, "0")}`;
}

export function unsuperseded(positions: Position[]): Position[] {
  return positions.filter((p) => p.superseded_by == null);
}

// R-1 (locked): contested ⇔ the live set holds ≥1 assert AND ≥1 dispute.
// Stance-enum-only — no statement-text comparison anywhere in daftari.
export function isContested(positions: Position[]): boolean {
  const live = unsuperseded(positions);
  return live.some((p) => p.stance === "assert") && live.some((p) => p.stance === "dispute");
}

// The conflict pairs a (new) position forms: it against each LIVE position of
// the opposing stance. qualify opposes nothing. Pair order is (existing,
// incoming) so tension claims read chronologically.
export function conflictPairs(
  incoming: Position,
  positions: Position[],
): Array<{ a: Position; b: Position }> {
  const opposite: Stance | null =
    incoming.stance === "assert" ? "dispute" : incoming.stance === "dispute" ? "assert" : null;
  if (opposite === null) return [];
  return unsuperseded(positions)
    .filter((p) => p.id !== incoming.id && p.stance === opposite)
    .map((p) => ({ a: p, b: incoming }));
}

// LD-11 ordering: confidence desc (high first), created desc, id asc.
export function comparePositions(a: Position, b: Position): number {
  const conf = CONFIDENCES.indexOf(b.confidence) - CONFIDENCES.indexOf(a.confidence);
  if (conf !== 0) return conf;
  if (a.created !== b.created) return a.created < b.created ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface AssertInput {
  principal: string;
  stance: Stance;
  statement: string | null;
  confidence: Confidence;
  provenance: Provenance;
  valid_from: string | null;
  sources: string[];
  created: string; // YYYY-MM-DD, stamped by the calling tool
}

export interface AssertOutcome {
  positions: Position[];
  newPosition: Position;
  superseded: Position | null;
}

// R-4: append the caller's new position; set THEIR prior live position's
// superseded_by to it. Never edits or deletes any other principal's entry;
// never mutates its inputs.
export function applyAssert(positions: Position[] | null, input: AssertInput): AssertOutcome {
  const existing = positions ?? [];
  const id = nextPositionId(existing);
  const newPosition: Position = {
    id,
    principal: input.principal,
    stance: input.stance,
    statement: input.statement,
    confidence: input.confidence,
    provenance: input.provenance,
    valid_from: input.valid_from,
    superseded_by: null,
    created: input.created,
    sources: input.sources,
  };
  let superseded: Position | null = null;
  const next = existing.map((p) => {
    if (p.principal === input.principal && p.superseded_by == null) {
      superseded = { ...p, superseded_by: id };
      return superseded;
    }
    return p;
  });
  return { positions: [...next, newPosition], newPosition, superseded };
}

// LD-13 / R-12: the foreign-position guard rule, shared by vault_write's
// direct update path and its propose-only stage preview. Returns a human
// description of the first violation, or null when the update is legal.
//
// Violations: an existing entry whose principal !== user is REMOVED or
// ALTERED. One carve-out: an alteration whose ONLY delta is
// superseded_by null → the id of an incoming entry held by the SAME
// principal as the altered entry — a self-supersession replayed by a
// ratifier (vault_ratify dispatches staged writes under the ratifier's
// access). Appending entries — own or foreign — is deliberately NOT a
// violation (R-12 scopes to mutate/remove; ratify replay appends the
// proposer's new entry under the ratifier's identity).
export function foreignPositionViolation(
  before: Position[],
  after: Position[] | null,
  user: string,
): string | null {
  const incoming = after ?? [];
  const byId = new Map(incoming.map((p) => [p.id, p]));
  for (const old of before) {
    if (old.principal === user) continue;
    const next = byId.get(old.id);
    if (!next) {
      return `update removes position ${old.id} held by '${old.principal}'`;
    }
    if (samePosition(old, next)) continue;
    const onlySupersededByChanged = samePosition(old, {
      ...next,
      superseded_by: old.superseded_by,
    });
    const successor = next.superseded_by != null ? byId.get(next.superseded_by) : undefined;
    if (
      onlySupersededByChanged &&
      old.superseded_by == null &&
      successor !== undefined &&
      successor.principal === old.principal
    ) {
      continue;
    }
    return `update alters position ${old.id} held by '${old.principal}'`;
  }
  return null;
}

function samePosition(a: Position, b: Position): boolean {
  return (
    a.id === b.id &&
    a.principal === b.principal &&
    a.stance === b.stance &&
    a.statement === b.statement &&
    a.confidence === b.confidence &&
    a.provenance === b.provenance &&
    a.valid_from === b.valid_from &&
    a.superseded_by === b.superseded_by &&
    a.created === b.created &&
    a.sources.length === b.sources.length &&
    a.sources.every((s, i) => s === b.sources[i])
  );
}
```

- [ ] **Step 2.4: Run it — expected PASS**

Run: `npx vitest run test/curation/positions.test.ts`
Expected: 11 passed.

- [ ] **Step 2.5: Build + purity check + commit**

Run: `npm run build` — clean. Confirm the module's only import is `../frontmatter/types.js`.

```bash
git add src/curation/positions.ts test/curation/positions.test.ts
git commit -m "feat(curation): pure positions module — assert/supersede/contested/guard (U-2)"
```

---

## Task 3 (U-3): `positional` tension kind

**Maps to:** R-5 (log half), R-6, R-7. **Depends on:** nothing (parallel-safe with Tasks 1–2).

**Files:**
- Modify: `src/curation/tension.ts` (TENSION_KINDS :36–42, ADDABLE :57, TensionEntry :71–85, renderEntry :119–133, addTension :154–221, parseBlock :268–308, STALE_TIER_LINT_COPY :469–480)
- Modify: `test/curation/tension.test.ts` (append a describe block; add `vaultTensionLog` to imports from `../../src/tools/curation.js`)

- [ ] **Step 3.1: Write the failing tests**

Append to `test/curation/tension.test.ts` (harness at :26–35; `sampleInput` at :16–24):

```typescript
describe("positional tension kind (U-3)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tension-pos-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  const positionalInput = {
    title: "alice vs bob on retry storms",
    sourceA: "pricing/retry-storms.md",
    claimA: "the 250ms floor causes storms",
    sourceB: "pricing/retry-storms.md",
    claimB: "storms predate the floor",
    loggedBy: "alice",
    kind: "positional" as const,
    positionA: "pos-001",
    positionB: "pos-002",
  };

  it("mints a positional self-tension with position ids rendered and round-tripped", async () => {
    const added = await addTension(vault, positionalInput);
    expect(added.ok).toBe(true);
    if (!added.ok) throw added.error;
    expect(added.value.id).toMatch(/^tension-\d{3}$/);
    expect(added.value.positionA).toBe("pos-001");
    expect(added.value.positionB).toBe("pos-002");

    const raw = readFileSync(tensionsPath(vault), "utf-8");
    expect(raw).toContain("- **Position A:** pos-001");
    expect(raw).toContain("- **Position B:** pos-002");

    const listed = await listTensions(vault);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw listed.error;
    expect(listed.value[0]?.kind).toBe("positional");
    expect(listed.value[0]?.positionA).toBe("pos-001");
    expect(listed.value[0]?.positionB).toBe("pos-002");
  });

  it("rejects a positional tension that is not a self-tension", async () => {
    const r = await addTension(vault, { ...positionalInput, sourceB: "pricing/other.md" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("self-tension");
  });

  it("rejects a positional tension missing positionB", async () => {
    const { positionB: _pb, ...noB } = positionalInput;
    const r = await addTension(vault, noB);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("positionA");
  });

  it("vault_tension_log rejects kind positional (not caller-loggable, R-6)", async () => {
    const r = await vaultTensionLog(vault, {
      title: "t",
      sourceA: "a.md",
      sourceB: "a.md",
      claimA: "x",
      claimB: "y",
      agent: "agent:test",
      kind: "positional",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(LOGGABLE_TENSION_KINDS.join(", "));
  });

  it("a legacy block without position lines parses with both undefined", async () => {
    const plain = await addTension(vault, sampleInput);
    expect(plain.ok).toBe(true);
    const listed = await listTensions(vault);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw listed.error;
    expect(listed.value[0]?.positionA).toBeUndefined();
    expect(listed.value[0]?.positionB).toBeUndefined();
  });

  it("a resolved-accepted positional tension is exempt from aging (R-7 regression)", async () => {
    const added = await addTension(vault, { ...positionalInput, date: "2020-01-01" });
    expect(added.ok).toBe(true);
    if (!added.ok) throw added.error;
    expect(agingTier(added.value, new Date("2026-08-06"))).toBe("stale");
    const resolved = await resolveTension(vault, added.value.id as string, {
      resolved_at: new Date().toISOString(),
      resolved_by: "carol",
      kind: "accepted",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw resolved.error;
    expect(agingTier(resolved.value, new Date("2026-08-06"))).toBeNull();
  });
});
```

- [ ] **Step 3.2: Run it — expected FAIL**

Run: `npx vitest run test/curation/tension.test.ts`
Expected: FAIL — TypeScript: `kind: "positional"` not assignable to `AddableTensionKind`; `positionA` not a known property of `TensionInput`. (The compile error IS the red state.)

- [ ] **Step 3.3: Implement in tension.ts**

1. Extend the module doc comment (:30–35) with a mirroring paragraph: *"`positional` (Slice 1): two principals hold conflicting live positions on one claim doc. Minted only by vault_assert's conflict check as a self-tension on the doc (sourceA === sourceB), positionA/positionB naming the two position ids. Never caller-loggable, never silently resolved."*
2. `TENSION_KINDS` (:36–42): insert `"positional",` after `"inter-proposal",`. Do NOT touch `LOGGABLE_TENSION_KINDS` (:50).
3. `ADDABLE_TENSION_KINDS` (:57): `const ADDABLE_TENSION_KINDS = [...LOGGABLE_TENSION_KINDS, "inter-proposal", "positional"] as const;`
4. `TensionEntry` (:71–85), after `claimB: string;`:
   ```typescript
     // Positional tensions only: the two contesting position ids on the doc.
     positionA?: string;
     positionB?: string;
   ```
   (`TensionInput` is an Omit over TensionEntry (:87–94) — the optional fields flow through unchanged.)
5. `renderEntry` (:119–133), after the Source B push:
   ```typescript
     if (entry.positionA !== undefined) lines.push(`- **Position A:** ${entry.positionA}`);
     if (entry.positionB !== undefined) lines.push(`- **Position B:** ${entry.positionB}`);
   ```
6. `addTension` (:154–221): widen the self-tension shape check (:174–181) to
   ```typescript
     if (
       (input.kind === "inter-proposal" || input.kind === "positional") &&
       input.sourceA.trim() !== input.sourceB.trim()
     ) {
   ```
   (update the message to name the kind: `` `addTension: an '${input.kind}' tension is a self-tension — sourceA and sourceB must both be the contested target path` ``), and immediately after it add:
   ```typescript
     // A positional tension without its position ids is unmintable — the ids
     // are what make the disagreement addressable from the doc's position set.
     if (
       input.kind === "positional" &&
       (!input.positionA?.trim() || !input.positionB?.trim())
     ) {
       return err(
         new Error("addTension: a 'positional' tension requires non-empty positionA and positionB"),
       );
     }
   ```
   In the `entry` construction (:198–213), after the `decidedByPrincipal` spread:
   ```typescript
       ...(input.positionA?.trim() ? { positionA: input.positionA.trim() } : {}),
       ...(input.positionB?.trim() ? { positionB: input.positionB.trim() } : {}),
   ```
7. `parseBlock` label switch (:268–308), after the `"logged by"` branch:
   ```typescript
       } else if (label === "position a") {
         entry.positionA = value.trim();
       } else if (label === "position b") {
         entry.positionB = value.trim();
   ```
8. `STALE_TIER_LINT_COPY` (:469–480) — mandatory or the Record type stops compiling (spec Risk 7):
   ```typescript
     positional:
       "Unresolved positional tension — two principals hold conflicting live positions. " +
       "Consolidate (org position), have one side supersede, or accept as standing dissent; " +
       "an ignored disagreement is the smell, not the disagreement itself.",
   ```

- [ ] **Step 3.4: Run it — expected PASS**

Run: `npx vitest run test/curation/tension.test.ts`
Expected: all pass, including every pre-existing test (legacy render/parse untouched).

- [ ] **Step 3.5: Build + adjacent suites + commit**

Run: `npm run build` (proves the lint-copy record is total), then `npx vitest run test/tools/curation.test.ts test/curation/tension-access.test.ts test/curation/tension-triage.test.ts` — clean.

```bash
git add src/curation/tension.ts test/curation/tension.test.ts
git commit -m "feat(curation): positional tension kind — system-minted, self-tension, position ids (U-3)"
```

---

**→ Continue with Task 4 (U-4 `vault_assert`), Task 5 (U-5 `vault_positions`), Task 6 (U-7 read annotation), Task 7 (U-8 write guard), Task 8 (U-9 lint), Task 9 (U-6 wiring/docs), and the Verification gate in `./2026-08-07-multiuser-contested-beliefs-slice1-tasks4-9.md`.**
