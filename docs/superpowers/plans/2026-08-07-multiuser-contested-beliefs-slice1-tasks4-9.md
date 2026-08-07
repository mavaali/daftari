# Multi-User Contested Beliefs — Slice 1 Plan, Part 2 (Tasks 4–9 + Verification)

> Continuation of `2026-08-07-multiuser-contested-beliefs-slice1.md` (same plan — split across two files for tooling limits only). Read Part 1 first: header, locked decisions LD-7..LD-16, file structure, Tasks 1–3.

---

## Task 4 (U-4): `vault_assert` tool

**Maps to:** R-3, R-4, R-5, R-8, R-9, R-13, R-15. **Depends on:** Tasks 1, 2, 3.

**Files:**
- Modify: `src/tools/write.ts` (LD-9 exports + `"assert"` action + `runId` passthrough)
- Create: `src/tools/positions.ts`
- Modify: `src/server.ts` (:51–66 — add `...positionsTools`)
- Create: `test/tools/positions.test.ts`

- [ ] **Step 4.1: LD-9 plumbing edits in write.ts (mechanical, no behavior change)**

1. Add `export` to: `requireIndexReady` (:155), `requireWriteAccess` (:586), `targetCollection` (:185), `interface TargetDocument` (:604), `loadTargetDocument` (:611), `performFrontmatterWrite` (:643).
2. `WriteResult["action"]` union (:292–302): add `| "assert"` after `"tier-set"`.
3. `performFrontmatterWrite` opts (:643–653): add `runId?: string;` and pass `...(opts.runId !== undefined ? { runId: opts.runId } : {}),` into its `performWrite` call (:655–678).

Run: `npm run build` — clean. Run: `npx vitest run test/tools/write.test.ts` — green.

- [ ] **Step 4.2: Write the failing tests**

Create `test/tools/positions.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { getStagedActionById } from "../../src/curation/staged-actions.js";
import { listTensions } from "../../src/curation/tension.js";
import { registeredToolNames } from "../../src/server.js";
import { vaultAssert, vaultPositions } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const ALICE = {
  user: "alice",
  roleName: "writer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false },
};
const BOB = { ...ALICE, user: "bob" };
const PROPOSER = {
  user: "carol",
  roleName: "agent-proposer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false, proposeOnly: true },
};
const GUEST = { user: "eve", roleName: "guest", role: null };

const DOC = "pricing/retry-storms.md";

async function seedDoc(vault: string, path = DOC): Promise<void> {
  const r = await vaultWrite(vault, {
    path,
    body: "# Retry storms\n\nThe claim.\n",
    frontmatter: {
      title: "Retry storms",
      domain: "accumulation",
      collection: path.split("/")[0],
      status: "canonical",
      confidence: "high",
      created: "2026-08-01",
      provenance: "direct",
    },
    agent: "agent:seed",
  });
  if (!r.ok) throw r.error;
}

describe("vault_assert (U-4)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("registers vault_assert and vault_positions", () => {
    expect(registeredToolNames()).toContain("vault_assert");
    expect(registeredToolNames()).toContain("vault_positions");
  });

  it("happy path: alice asserts on a legacy doc — pos-001, provenance principal, no tension", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", statement: "floor causes storms", confidence: "high", agent: "agent:alice-cli" },
      ALICE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.action).toBe("assert");
    expect(r.value.position?.id).toBe("pos-001");
    expect(r.value.position?.principal).toBe("alice");
    expect(r.value.contested).toBe(false);
    expect(r.value.tension_ids).toEqual([]);
    expect(r.value.commit).toBeTruthy();

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions).toHaveLength(1);
    expect(read.ok && read.value.frontmatter.confidence).toBe("high"); // uncontested: untouched

    const log = await readProvenanceLog(vault);
    if (!log.ok) throw log.error;
    const entry = log.value.find((e) => e.tool === "vault_assert");
    expect(entry?.principal).toBe("alice");
    expect(entry?.action).toBe("assert");
  });

  it("bob disputes → contested, confidence capped low, one positional tension (mandated)", async () => {
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", statement: "storms predate the floor", confidence: "medium", agent: "b" },
      BOB,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.contested).toBe(true);
    expect(r.value.tension_ids).toHaveLength(1);

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.confidence).toBe("low"); // R-9 cap
    expect(read.ok && read.value.frontmatter.contested).toBe(true);

    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const t = tensions.value.filter((x) => x.kind === "positional");
    expect(t).toHaveLength(1);
    expect(t[0]?.sourceA).toBe(DOC);
    expect(t[0]?.sourceB).toBe(DOC);
    expect(t[0]?.positionA).toBe("pos-001");
    expect(t[0]?.positionB).toBe("pos-002");
    expect(t[0]?.loggedBy).toBe("bob"); // DN-3
  });

  it("alice re-asserts → pos-003 supersedes pos-001, bob untouched, no duplicate tension (mandated)", async () => {
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
    await vaultAssert(vault, { path: DOC, stance: "dispute", confidence: "medium", agent: "b" }, BOB);
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", statement: "updated wording", confidence: "medium", agent: "a" },
      ALICE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.position?.id).toBe("pos-003");
    expect(r.value.superseded_position_id).toBe("pos-001");
    // (pos-001,pos-002) already tensioned; (pos-002,pos-003) is the one NEW live pair.
    const tensions = await listTensions(vault);
    if (!tensions.ok) throw tensions.error;
    const pairs = tensions.value
      .filter((x) => x.kind === "positional")
      .map((x) => `${x.positionA}/${x.positionB}`)
      .sort();
    expect(pairs).toEqual(["pos-001/pos-002", "pos-002/pos-003"]);

    const read = await vaultRead(vault, DOC);
    if (!read.ok) throw read.error;
    const bobPos = read.value.frontmatter.positions?.find((p) => p.id === "pos-002");
    expect(bobPos?.superseded_by).toBeNull();
    expect(bobPos?.principal).toBe("bob");
  });

  it("qualify never conflicts", async () => {
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
    const r = await vaultAssert(vault, { path: DOC, stance: "qualify", confidence: "low", agent: "b" }, BOB);
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.contested).toBe(false);
    expect(r.value.tension_ids).toEqual([]);
  });

  it("propose-only role: lands as a staged write, file untouched, no tension (mandated)", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "dispute", confidence: "medium", agent: "c" },
      PROPOSER,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.action).toBe("staged");
    expect(r.value.staged_id).toMatch(/^stage-/);
    expect(r.value.commit).toBeNull();

    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions).toBeNull(); // nothing written

    const action = await getStagedActionById(vault, r.value.staged_id as string);
    if (!action.ok) throw action.error;
    expect(action.value?.actionType).toBe("write");
    const diff = action.value?.proposedDiff as { frontmatter: { positions: unknown[] } };
    expect(diff.frontmatter.positions).toHaveLength(1);

    const tensions = await listTensions(vault);
    expect(tensions.ok && tensions.value.filter((x) => x.kind === "positional")).toEqual([]);
  });

  it("impersonation: alice passing principal 'bob' is rejected, nothing written (mandated)", async () => {
    const r = await vaultAssert(
      vault,
      { path: DOC, stance: "assert", confidence: "high", agent: "a", principal: "bob" },
      ALICE,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("another principal");
    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions).toBeNull();
  });

  it("guest (null role) is denied", async () => {
    const r = await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "e" }, GUEST);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("access denied");
  });

  it("operator mode (no access): principal argument required, then recorded verbatim", async () => {
    const missing = await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "op" });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.message).toContain("principal");

    const r = await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "op", principal: "carol" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.position?.principal).toBe("carol");
  });

  it("nonexistent path errs; alias path resolves to one canonical position set (#127/#128)", async () => {
    const missing = await vaultAssert(vault, { path: "pricing/nope.md", stance: "assert", confidence: "low", agent: "a" }, ALICE);
    expect(missing.ok).toBe(false);

    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
    const aliased = await vaultAssert(
      vault,
      { path: "pricing/../pricing/retry-storms.md", stance: "assert", confidence: "medium", agent: "a" },
      ALICE,
    );
    expect(aliased.ok).toBe(true);
    if (!aliased.ok) throw aliased.error;
    expect(aliased.value.path).toBe(DOC);
    expect(aliased.value.superseded_position_id).toBe("pos-001"); // same set, not a second one
  });
});
```

(`vaultPositions` is imported now but only exercised in Task 5 — export it as a stub returning `err(new Error("not implemented"))` in Step 4.4 so this file compiles.)

- [ ] **Step 4.3: Run it — expected FAIL**

Run: `npx vitest run test/tools/positions.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/positions.js'`.

- [ ] **Step 4.4: Implement src/tools/positions.ts + register**

Create `src/tools/positions.ts`:

```typescript
// Position tools (Slice 1, U-4/U-5): vault_assert writes the calling
// principal's position on a claim doc; vault_positions queries by doc or by
// principal. Pure logic lives in curation/positions.ts; write plumbing is
// reused from write.ts (LD-9) — no duplicated lock/commit/provenance code.

import { type AccessContext, canRead, hasAnyRead, isProposeOnly } from "../access/rbac.js";
import {
  applyAssert,
  comparePositions,
  conflictPairs,
  isContested,
  unsuperseded,
} from "../curation/positions.js";
import { stageActionWithConflictCheck } from "../curation/staged-actions.js";
import { addTension, listTensions } from "../curation/tension.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import {
  CONFIDENCES,
  type Confidence,
  err,
  type Frontmatter,
  ok,
  type Position,
  PROVENANCES,
  type Provenance,
  type Result,
  STANCES,
  type Stance,
} from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { collectionOf, type ToolDefinition } from "./read.js";
import {
  loadTargetDocument,
  performFrontmatterWrite,
  requireIndexReady,
  requireWriteAccess,
  targetCollection,
  type WriteResult,
} from "./write.js";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function str(args: Record<string, unknown>, field: string, tool: string): Result<string, Error> {
  const v = args[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    return err(new Error(`${tool} requires a non-empty '${field}' argument`));
  }
  return ok(v);
}

function optStr(
  args: Record<string, unknown>,
  field: string,
  tool: string,
): Result<string | null, Error> {
  const v = args[field];
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== "string") return err(new Error(`${tool}: '${field}' must be a string`));
  return ok(v);
}

export interface AssertResult {
  path: string;
  action: "assert" | "staged";
  position: Position | null;
  superseded_position_id: string | null;
  contested: boolean;
  tension_ids: string[];
  tension_error?: string;
  commit: string | null;
  committed: boolean;
  staged_id?: string;
  expires_at?: string;
  conflicts_with?: string[];
}

export async function vaultAssert(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<AssertResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const path = str(args, "path", "vault_assert");
  if (!path.ok) return path;
  const agent = str(args, "agent", "vault_assert");
  if (!agent.ok) return agent;

  const stanceRaw = str(args, "stance", "vault_assert");
  if (!stanceRaw.ok) return stanceRaw;
  if (!(STANCES as readonly string[]).includes(stanceRaw.value)) {
    return err(new Error(`vault_assert 'stance' must be one of: ${STANCES.join(", ")}`));
  }
  const confidenceRaw = str(args, "confidence", "vault_assert");
  if (!confidenceRaw.ok) return confidenceRaw;
  if (!(CONFIDENCES as readonly string[]).includes(confidenceRaw.value)) {
    return err(new Error(`vault_assert 'confidence' must be one of: ${CONFIDENCES.join(", ")}`));
  }
  const provenanceRaw = optStr(args, "provenance", "vault_assert");
  if (!provenanceRaw.ok) return provenanceRaw;
  const provenance = (provenanceRaw.value ?? "direct") as Provenance;
  if (!(PROVENANCES as readonly string[]).includes(provenance)) {
    return err(new Error(`vault_assert 'provenance' must be one of: ${PROVENANCES.join(", ")}`));
  }
  const statement = optStr(args, "statement", "vault_assert");
  if (!statement.ok) return statement;
  const validFrom = optStr(args, "valid_from", "vault_assert");
  if (!validFrom.ok) return validFrom;
  const runIdArg = optStr(args, "run_id", "vault_assert");
  if (!runIdArg.ok) return runIdArg;
  const sources: string[] = Array.isArray(args.sources)
    ? args.sources.filter((s): s is string => typeof s === "string")
    : [];

  // R-3: the position's principal is the AUTHENTICATED user. With access, an
  // explicit differing 'principal' argument is impersonation → reject. With
  // no access context (operator server), an explicit principal is REQUIRED
  // and recorded as unverified.
  const principalArg = optStr(args, "principal", "vault_assert");
  if (!principalArg.ok) return principalArg;
  let principal: string;
  if (access) {
    if (principalArg.value !== null && principalArg.value !== access.user) {
      return err(
        new Error(
          `vault_assert: cannot assert a position for another principal ` +
            `(authenticated as '${access.user}')`,
        ),
      );
    }
    principal = access.user;
  } else {
    if (principalArg.value === null) {
      return err(
        new Error(
          "vault_assert: no access context — an explicit 'principal' argument is " +
            "required (recorded as unverified)",
        ),
      );
    }
    principal = principalArg.value;
  }

  // RBAC before any file I/O, keyed off the physical target dir (S1 rule).
  const writeGate = requireWriteAccess(access, targetCollection(vaultRoot, path.value));
  if (!writeGate.ok) return writeGate;

  // Assert targets an EXISTING claim doc; creating the doc is vault_write's
  // job. loadTargetDocument canonicalizes (#127/#128) — one lock, one
  // position set per file, however the path is spelled.
  const target = await loadTargetDocument(vaultRoot, path.value, "vault_assert");
  if (!target.ok) return target;
  const fm = target.value.parsed.frontmatter;

  const applied = applyAssert(fm.positions, {
    principal,
    stance: stanceRaw.value as Stance,
    statement: statement.value,
    confidence: confidenceRaw.value as Confidence,
    provenance,
    valid_from: validFrom.value,
    sources,
    created: todayISO(),
  });
  const contested = isContested(applied.positions);
  const capConfidence = contested && fm.org_position == null; // R-9

  const newFrontmatter: Frontmatter = {
    ...fm,
    positions: applied.positions,
    contested, // R-8: recomputed on every assert; hand-set values overwritten
    ...(capConfidence ? { confidence: "low" as Confidence } : {}),
    updated: todayISO(),
    updated_by: agent.value,
  };

  // R-13: a propose-only role's assert lands as a staged `write` proposal —
  // no file write, no positional tension yet (it fires when the ratified
  // write lands). Contention with other pending proposals is surfaced by
  // stageActionWithConflictCheck's inter-proposal tension.
  if (access && isProposeOnly(access.role)) {
    const staged = await stageActionWithConflictCheck(vaultRoot, {
      actionType: "write",
      targetPath: target.value.relPath,
      proposedBy: agent.value,
      rationale:
        `propose-only role '${access.roleName}': position ${stanceRaw.value} by ` +
        `'${principal}' staged for ratification`,
      proposedDiff: {
        frontmatter: {
          positions: applied.positions,
          contested,
          ...(capConfidence ? { confidence: "low" } : {}),
        },
        body: target.value.parsed.content,
      },
      ...(runIdArg.value !== null ? { runId: runIdArg.value } : {}),
    });
    if (!staged.ok) return staged;
    return ok({
      path: target.value.relPath,
      action: "staged" as const,
      position: applied.newPosition,
      superseded_position_id: applied.superseded?.id ?? null,
      contested,
      tension_ids: [],
      commit: null,
      committed: false,
      staged_id: staged.value.id,
      expires_at: staged.value.expires_at,
      conflicts_with: staged.value.conflicts_with,
    });
  }

  const written = await performFrontmatterWrite({
    vaultRoot,
    target: target.value,
    agent: agent.value,
    tool: "vault_assert",
    action: "assert" as WriteResult["action"],
    newFrontmatter,
    commitMessage: `vault_assert: ${stanceRaw.value} on ${target.value.relPath} by ${principal}`,
    baseVersion: undefined,
    access,
    ...(runIdArg.value !== null ? { runId: runIdArg.value } : {}),
  });
  if (!written.ok) return written;

  // R-5 + locked R-3: one binary tension per NEW conflicting pair, skipped
  // when an OPEN positional tension already names the same two ids on this
  // doc. loggedBy = the asserting principal (DN-3) — the loop-authored
  // ratify gate (CONSOLIDATE_AGENT) never fires on these.
  const tensionIds: string[] = [];
  let tensionError: string | undefined;
  const pairs = conflictPairs(applied.newPosition, applied.positions);
  if (pairs.length > 0) {
    const existing = await listTensions(vaultRoot);
    if (!existing.ok) {
      tensionError = existing.error.message;
    } else {
      const open = existing.value.filter(
        (t) => t.kind === "positional" && !t.resolved && t.sourceA === target.value.relPath,
      );
      const covered = (a: string, b: string): boolean =>
        open.some(
          (t) =>
            (t.positionA === a && t.positionB === b) || (t.positionA === b && t.positionB === a),
        );
      const claim = (p: Position): string =>
        p.statement ?? `${fm.title} — ${p.stance} (${p.confidence})`;
      for (const pair of pairs) {
        if (covered(pair.a.id, pair.b.id)) continue;
        const minted = await addTension(vaultRoot, {
          kind: "positional",
          title: `Positional: ${pair.a.principal} vs ${pair.b.principal} on ${fm.title}`,
          sourceA: target.value.relPath,
          claimA: claim(pair.a),
          sourceB: target.value.relPath,
          claimB: claim(pair.b),
          positionA: pair.a.id,
          positionB: pair.b.id,
          loggedBy: principal,
        });
        if (minted.ok) tensionIds.push(minted.value.id as string);
        else tensionError = minted.error.message;
      }
    }
  }

  return ok({
    path: target.value.relPath,
    action: "assert" as const,
    position: applied.newPosition,
    superseded_position_id: applied.superseded?.id ?? null,
    contested,
    tension_ids: tensionIds,
    ...(tensionError !== undefined ? { tension_error: tensionError } : {}),
    commit: written.value.commit,
    committed: written.value.committed,
  });
}

// Task 5 replaces this stub with the real implementation.
export async function vaultPositions(
  _vaultRoot: string,
  _args: Record<string, unknown>,
  _access?: AccessContext,
): Promise<Result<unknown, Error>> {
  return err(new Error("not implemented"));
}
```

Append the ToolDefinitions (same file):

```typescript
const POSITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    principal: { type: "string" },
    stance: { type: "string", enum: [...STANCES] },
    statement: { type: ["string", "null"] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    provenance: { type: "string", enum: [...PROVENANCES] },
    valid_from: { type: ["string", "null"] },
    superseded_by: { type: ["string", "null"] },
    created: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: [
    "id", "principal", "stance", "statement", "confidence", "provenance",
    "valid_from", "superseded_by", "created", "sources",
  ],
};

const assertToolDefinition: ToolDefinition = {
  name: "vault_assert",
  title: "Assert a position on a claim document",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  description:
    "Assert, dispute, or qualify the calling principal's position on an " +
    "existing claim document. The position's principal is the authenticated " +
    "--user; a prior live position by the same principal is superseded, never " +
    "edited. A second conflicting live stance (assert vs dispute) marks the " +
    "document contested, caps its confidence at low until an org position is " +
    "ratified (Slice 2), and auto-logs a 'positional' tension (never " +
    "caller-loggable via vault_tension_log; resolve through " +
    "vault_tension_resolve). Propose-only roles: the assert lands as a staged " +
    "'write' proposal for ratification — nothing is written and no positional " +
    "tension is logged until the ratified write lands.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path of the existing claim doc" },
      stance: { type: "string", enum: [...STANCES] },
      statement: { type: "string", description: "Optional refinement of the title claim" },
      confidence: { type: "string", enum: [...CONFIDENCES] },
      provenance: { type: "string", enum: [...PROVENANCES], description: "Default: direct" },
      valid_from: { type: "string", description: "YYYY-MM-DD" },
      sources: { type: "array", items: { type: "string" } },
      agent: { type: "string", description: "Free-text acting identity (advisory)" },
      principal: {
        type: "string",
        description:
          "Only honored (and required) when the server runs without an access " +
          "context; recorded as unverified. With an access context it must " +
          "match the authenticated user.",
      },
      run_id: { type: "string" },
    },
    required: ["path", "stance", "confidence", "agent"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      action: { type: "string", enum: ["assert", "staged"] },
      position: { ...POSITION_SCHEMA, type: ["object", "null"] },
      superseded_position_id: { type: ["string", "null"] },
      contested: { type: "boolean" },
      tension_ids: { type: "array", items: { type: "string" } },
      tension_error: { type: "string" },
      commit: { type: ["string", "null"] },
      committed: { type: "boolean" },
      staged_id: { type: "string" },
      expires_at: { type: "string" },
      conflicts_with: { type: "array", items: { type: "string" } },
    },
    required: [
      "path", "action", "position", "superseded_position_id", "contested",
      "tension_ids", "commit", "committed",
    ],
  },
  docLinks: (value) => [(value as AssertResult).path],
  handler: (vaultRoot, args, access) => vaultAssert(vaultRoot, args, access),
};

export const positionsTools: ToolDefinition[] = [assertToolDefinition];
```

Register in `src/server.ts`: add `import { positionsTools } from "./tools/positions.js";` among the tool imports (:23–36) and `...positionsTools,` inside `allTools` (:51–66, after `...writeTools,`). New tools are full-tier by default (:81–89) — do NOT touch CORE_TOOLS/STANDARD_TOOLS.

- [ ] **Step 4.5: Run — expected PASS**

Run: `npx vitest run test/tools/positions.test.ts` — all Task-4 tests pass. `npm run build` — clean.

- [ ] **Step 4.6: Regression sweep + commit**

Run: `npx vitest run test/tools/write.test.ts test/tools/write-propose-only.test.ts test/curation/staged-actions.test.ts test/tools/staged-actions.test.ts` — green.

```bash
git add src/tools/positions.ts src/tools/write.ts src/server.ts test/tools/positions.test.ts
git commit -m "feat(tools): vault_assert — attributed positions, R-9 cap, auto positional tensions (U-4)"
```

---

## Task 5 (U-5): `vault_positions` read tool

**Maps to:** R-14. **Depends on:** Tasks 1, 2, 4 (same file).

**Files:** Modify: `src/tools/positions.ts`; Modify: `test/tools/positions.test.ts`.

- [ ] **Step 5.1: Write the failing tests** — append to `test/tools/positions.test.ts`:

```typescript
describe("vault_positions (U-5)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("by path: live only by default; include_superseded returns all", async () => {
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "medium", agent: "a" }, ALICE);
    const live = await vaultPositions(vault, { path: DOC }, ALICE);
    expect(live.ok).toBe(true);
    if (!live.ok) throw live.error;
    expect(live.value.positions.map((p) => p.position.id)).toEqual(["pos-002"]);
    const all = await vaultPositions(vault, { path: DOC, include_superseded: true }, ALICE);
    if (!all.ok) throw all.error;
    expect(all.value.positions).toHaveLength(2);
    expect(all.value.positions[0]?.position.superseded_by).toBe("pos-002");
  });

  it("by path on a legacy doc: empty list, not an error", async () => {
    const r = await vaultPositions(vault, { path: DOC }, ALICE);
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.positions).toEqual([]);
  });

  it("unreadable doc is 'not found'-shaped (no existence leak)", async () => {
    const scoped = {
      user: "sam",
      roleName: "scoped",
      role: { read: ["decisions"], write: [], promote: false, ratify: false },
    };
    const denied = await vaultPositions(vault, { path: DOC }, scoped);
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.message).toContain("not found");
    expect(denied.error.message).not.toContain("pricing");
  });

  it("by principal: unreadable docs silently omitted; no read grants denied", async () => {
    await seedDoc(vault, "decisions/other-claim.md");
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "b" }, BOB);
    await vaultAssert(vault, { path: "decisions/other-claim.md", stance: "dispute", confidence: "low", agent: "b" }, BOB);

    const scoped = {
      user: "sam",
      roleName: "scoped",
      role: { read: ["decisions"], write: [], promote: false, ratify: false },
    };
    const r = await vaultPositions(vault, { principal: "bob" }, scoped);
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.value.positions.map((p) => p.path)).toEqual(["decisions/other-claim.md"]);

    const guest = await vaultPositions(vault, { principal: "bob" }, GUEST);
    expect(guest.ok).toBe(false);
  });

  it("exactly one of path|principal is required", async () => {
    expect((await vaultPositions(vault, {}, ALICE)).ok).toBe(false);
    expect((await vaultPositions(vault, { path: DOC, principal: "bob" }, ALICE)).ok).toBe(false);
  });
});
```

- [ ] **Step 5.2: Run — expected FAIL** — `npx vitest run test/tools/positions.test.ts`: the U-5 block fails with `not implemented`.

- [ ] **Step 5.3: Implement** — replace the stub in `src/tools/positions.ts`:

```typescript
export interface PositionsResult {
  count: number;
  positions: Array<{ path: string; position: Position; contested: boolean }>;
}

export async function vaultPositions(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<PositionsResult, Error>> {
  const path = optStr(args, "path", "vault_positions");
  if (!path.ok) return path;
  const principal = optStr(args, "principal", "vault_positions");
  if (!principal.ok) return principal;
  const includeSuperseded = args.include_superseded === true;
  if ((path.value === null) === (principal.value === null)) {
    return err(new Error("vault_positions requires exactly one of 'path' or 'principal'"));
  }

  if (path.value !== null) {
    const resolved = resolveVaultPath(vaultRoot, path.value);
    if (!resolved.ok) return resolved;
    const notFound = () => err(new Error(`vault_positions: document not found: ${path.value}`));
    const file = await readFile(resolved.value.absPath);
    if (!file.ok) return notFound();
    const parsed = parseDocument(file.value);
    if (!parsed.ok) return parsed;
    // #212 discipline: an unreadable doc is byte-indistinguishable from a
    // missing one — never name the collection in the denial.
    if (access && !canRead(access.role, collectionOf(resolved.value.relPath, parsed.value.frontmatter))) {
      return notFound();
    }
    const set = parsed.value.frontmatter.positions ?? [];
    const chosen = (includeSuperseded ? set : unsuperseded(set)).slice().sort(comparePositions);
    return ok({
      count: chosen.length,
      positions: chosen.map((p) => ({
        path: resolved.value.relPath,
        position: p,
        contested: isContested(set),
      })),
    });
  }

  // By principal: whole-vault scan via the lint loader (LD-10). Unreadable
  // docs are silently omitted — no count, no hint (#217 omission rule).
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_positions`));
  }
  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const out: PositionsResult["positions"] = [];
  for (const doc of loaded.value) {
    if (access && !canRead(access.role, collectionOf(doc.path, doc.frontmatter))) continue;
    const set = doc.frontmatter.positions;
    if (set == null) continue;
    const pool = includeSuperseded ? set : unsuperseded(set);
    for (const p of pool.filter((x) => x.principal === principal.value).sort(comparePositions)) {
      out.push({ path: doc.path, position: p, contested: isContested(set) });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return ok({ count: out.length, positions: out });
}
```

Append its ToolDefinition and register it in the array:

```typescript
const positionsToolDefinition: ToolDefinition = {
  name: "vault_positions",
  title: "Query principals' positions",
  annotations: { readOnlyHint: true },
  description:
    "Query positions: all positions on one doc ('path'), or all live " +
    "positions held by a principal across the vault ('principal'). Exactly " +
    "one selector. Results are limited to docs the caller can read; " +
    "include_superseded (default false) adds superseded entries.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      principal: { type: "string" },
      include_superseded: { type: "boolean" },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 0 },
      positions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            position: POSITION_SCHEMA,
            contested: { type: "boolean" },
          },
          required: ["path", "position", "contested"],
        },
      },
    },
    required: ["count", "positions"],
  },
  docLinks: (value) => [...new Set((value as PositionsResult).positions.map((p) => p.path))],
  handler: (vaultRoot, args, access) => vaultPositions(vaultRoot, args, access),
};

export const positionsTools: ToolDefinition[] = [assertToolDefinition, positionsToolDefinition];
```

(Note: `loadDocuments`'s `LoadedDoc` carries `path` + `frontmatter` — verify the exact field names in src/curation/vault-docs.ts when importing; adjust the two property accesses if they differ.)

- [ ] **Step 5.4: Run — expected PASS** — `npx vitest run test/tools/positions.test.ts`; `npm run build` clean.

- [ ] **Step 5.5: Commit**

```bash
git add src/tools/positions.ts test/tools/positions.test.ts
git commit -m "feat(tools): vault_positions — by-doc and by-principal queries, RBAC-filtered (U-5)"
```

---

## Task 6 (U-7): `vault_read` CONTESTED annotation

**Maps to:** R-11, R-2. **Depends on:** Tasks 1, 2, 3.

**Files:** Modify: `src/tools/read.ts` (VaultReadResult :105–133, vaultRead :135–275, outputSchema :805–898); Create: `test/tools/read-positions.test.ts`.

- [ ] **Step 6.1: Write the failing tests**

Create `test/tools/read-positions.test.ts` (reuse the ALICE/BOB/seedDoc pattern from `test/tools/positions.test.ts` — copy the constants; keep the file self-contained):

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultAssert } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const ALICE = { user: "alice", roleName: "writer", role: { read: ["*"], write: ["*"], promote: false, ratify: false } };
const BOB = { ...ALICE, user: "bob" };
const DOC = "pricing/retry-storms.md";

async function seedDoc(vault: string): Promise<void> {
  const r = await vaultWrite(vault, {
    path: DOC,
    body: "# Retry storms\n\nThe claim.\n",
    frontmatter: {
      title: "Retry storms",
      domain: "accumulation",
      collection: "pricing",
      status: "canonical",
      confidence: "high",
      created: "2026-08-01",
      provenance: "direct",
    },
    agent: "agent:seed",
  });
  if (!r.ok) throw r.error;
}

describe("vault_read contested_positions (U-7)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
    await seedDoc(vault);
  });
  afterEach(() => cleanupVault(vault));

  it("contested-unratified doc: CONTESTED flag, LD-11 order, open tension ids, low confidence (mandated)", async () => {
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
    await vaultAssert(vault, { path: DOC, stance: "dispute", confidence: "medium", agent: "b" }, BOB);
    const read = await vaultRead(vault, DOC, ALICE);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    const block = read.value.contested_positions;
    expect(block?.flag).toBe("CONTESTED");
    // high (pos-001) before medium (pos-002).
    expect(block?.positions.map((p) => p.id)).toEqual(["pos-001", "pos-002"]);
    expect(block?.open_tension_ids).toHaveLength(1);
    expect(block?.note).toContain("no consolidated view");
    expect(read.value.frontmatter.confidence).toBe("low"); // R-9 cap visible
  });

  it("legacy doc: no contested_positions key at all (mandated: byte-identical absence)", async () => {
    const read = await vaultRead(vault, DOC, ALICE);
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    expect("contested_positions" in read.value).toBe(false);
  });

  it("doc whose only dispute was superseded: no key", async () => {
    await vaultAssert(vault, { path: DOC, stance: "assert", confidence: "high", agent: "a" }, ALICE);
    await vaultAssert(vault, { path: DOC, stance: "dispute", confidence: "low", agent: "b" }, BOB);
    await vaultAssert(vault, { path: DOC, stance: "qualify", confidence: "low", agent: "b" }, BOB);
    const read = await vaultRead(vault, DOC, ALICE);
    if (!read.ok) throw read.error;
    expect("contested_positions" in read.value).toBe(false);
  });
});
```

- [ ] **Step 6.2: Run — expected FAIL** — `contested_positions` is undefined / TS property missing.

- [ ] **Step 6.3: Implement in read.ts**

1. Imports: add `{ comparePositions, isContested, unsuperseded }` from `../curation/positions.js` and `type Position` to the types import.
2. `VaultReadResult` (:105–133), after `contestedCount?: number;`:
   ```typescript
     // U-7 (LD-7): the positional contest block — distinct from `contested`
     // (tension annotations). Present ONLY on a contested doc with no
     // ratified org_position; absent otherwise (upstream_staleness's
     // absent-key discipline — no existence signal either way).
     contested_positions?: {
       flag: "CONTESTED";
       positions: Position[];
       open_tension_ids: string[];
       note: string;
     };
   ```
3. In `vaultRead`, after the `contestedFor` block (:251) and before the final `return ok({...})`, compute:
   ```typescript
     // U-7: positional contest block. Positional tensions are self-tensions on
     // THIS doc; the caller passed the canRead gate above, so their ids are
     // visible by construction — no per-tension visibility check (LD-15).
     let contestedPositions: VaultReadResult["contested_positions"];
     const posSet = parsed.value.frontmatter.positions;
     if (posSet != null && isContested(posSet) && parsed.value.frontmatter.org_position == null) {
       const tensionsRes = await listTensions(vaultRoot);
       const openIds = tensionsRes.ok
         ? tensionsRes.value
             .filter(
               (t) =>
                 t.kind === "positional" && !t.resolved && t.sourceA === resolved.value.relPath,
             )
             .map((t) => t.id)
             .filter((id): id is string => id !== undefined)
         : [];
       contestedPositions = {
         flag: "CONTESTED",
         positions: unsuperseded(posSet).slice().sort(comparePositions),
         open_tension_ids: openIds,
         note: "the org has no consolidated view on this claim",
       };
     }
   ```
   and spread into the result: `...(contestedPositions ? { contested_positions: contestedPositions } : {}),` (`listTensions` is already imported at read.ts:19).
4. outputSchema (:805–898): add an optional `contested_positions` property mirroring the shape (`flag` enum ["CONTESTED"], `positions` array of a position schema, `open_tension_ids` string array, `note` string) — do NOT add it to `required`. Extend the vault_read `description` with one clause: "a contested_positions block when principals hold conflicting live positions and no org position is ratified".

- [ ] **Step 6.4: Run — expected PASS** — `npx vitest run test/tools/read-positions.test.ts test/tools/read.test.ts test/tools/read-validity.test.ts` all green (full read suite untouched proves R-2).

- [ ] **Step 6.5: Commit**

```bash
git add src/tools/read.ts test/tools/read-positions.test.ts
git commit -m "feat(read): CONTESTED positional annotation on vault_read (U-7)"
```

---

## Task 7 (U-8): `vault_write` foreign-position guard

**Maps to:** R-12. **Depends on:** Tasks 1, 2.

**Files:** Modify: `src/tools/write.ts` (vaultWrite update path after validation :1049, and the propose-only preview :848–905); Modify: `test/tools/write.test.ts`.

- [ ] **Step 7.1: Write the failing tests** — append to `test/tools/write.test.ts` (reuse its existing harness/imports; add `vaultAssert` from `../../src/tools/positions.js` and `readProvenanceLog` if not present):

```typescript
describe("vault_write foreign-position guard (U-8)", () => {
  const ALICE = { user: "alice", roleName: "writer", role: { read: ["*"], write: ["*"], promote: false, ratify: false } };
  const BOB = { ...ALICE, user: "bob" };
  const DOC = "pricing/guarded.md";
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    const r = await vaultWrite(vault, {
      path: DOC,
      body: "# G\n\nx.\n",
      frontmatter: {
        title: "G", domain: "accumulation", collection: "pricing", status: "canonical",
        confidence: "high", created: "2026-08-01", provenance: "direct",
      },
      agent: "agent:seed",
    });
    if (!r.ok) throw r.error;
    const a = await vaultAssert(vault, { path: DOC, stance: "dispute", confidence: "medium", agent: "b" }, BOB);
    if (!a.ok) throw a.error; // bob holds pos-001
  });
  afterEach(() => cleanupVault(vault));

  it("alice dropping bob's position via vault_write is rejected + provenance logged (mandated)", async () => {
    const before = await vaultRead(vault, DOC);
    if (!before.ok) throw before.error;
    const r = await vaultWrite(vault, {
      path: DOC,
      body: "# G\n\nx.\n",
      frontmatter: { ...before.value.raw, positions: [] },
      agent: "agent:alice",
    }, ALICE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("pos-001");

    const after = await vaultRead(vault, DOC);
    expect(after.ok && after.value.frontmatter.positions).toHaveLength(1); // unchanged

    const log = await readProvenanceLog(vault);
    if (!log.ok) throw log.error;
    expect(log.value.some((e) => e.action === "rejected_foreign_position" && e.file === DOC)).toBe(true);
  });

  it("alice editing bob's statement is rejected", async () => {
    const before = await vaultRead(vault, DOC);
    if (!before.ok) throw before.error;
    const positions = (before.value.frontmatter.positions ?? []).map((p) => ({ ...p, statement: "reworded" }));
    const r = await vaultWrite(vault, { path: DOC, body: "# G\n\nx.\n", frontmatter: { positions }, agent: "a" }, ALICE);
    expect(r.ok).toBe(false);
  });

  it("a body-only update that does not touch positions lands, positions intact", async () => {
    const r = await vaultWrite(vault, {
      path: DOC, body: "# G\n\nnew body.\n",
      frontmatter: { title: "G" }, agent: "a",
    }, ALICE);
    expect(r.ok).toBe(true);
    const read = await vaultRead(vault, DOC);
    expect(read.ok && read.value.frontmatter.positions?.[0]?.principal).toBe("bob");
  });

  it("operator server (no access) bypasses the guard", async () => {
    const r = await vaultWrite(vault, {
      path: DOC, body: "# G\n\nx.\n",
      frontmatter: { positions: [] }, agent: "op",
    });
    expect(r.ok).toBe(true);
  });
});
```

(Note the merge semantics: on update, existing frontmatter merges UNDER the payload (write.ts:946–964), so passing `frontmatter: { positions: [...] }` replaces the array while preserving other fields — exactly the surface the guard defends.)

- [ ] **Step 7.2: Run — expected FAIL** — the drop/edit tests get `r.ok === true` (guard absent) and the positions are destroyed.

- [ ] **Step 7.3: Implement**

In `src/tools/write.ts`:
1. Import `{ foreignPositionViolation }` from `../curation/positions.js`.
2. Direct path — insert AFTER the merged validation gate (:1046–1049) and BEFORE `const stamped` (:1051), so it compares the VALIDATED typed positions (Date-normalized) against the on-disk typed set:
   ```typescript
     // R-12/LD-13: no principal rewrites another's positions through the
     // generic write path. Checked after validation so both sides are typed
     // Position[] (raw YAML dates already normalized). Operator servers
     // (no access) bypass, matching the tier/ratify gate conventions.
     if (access && isUpdate && oldFrontmatter && oldFrontmatter.positions != null) {
       const violation = foreignPositionViolation(
         oldFrontmatter.positions,
         frontmatter.positions,
         access.user,
       );
       if (violation) {
         await recordProvenance(vaultRoot, {
           tool: "vault_write",
           file: resolved.value.relPath,
           agent: agent.value,
           principal: access.user,
           ...(runId.value !== undefined ? { run_id: runId.value } : {}),
           action: "rejected_foreign_position",
           reason: violation,
         });
         return err(
           new Error(
             `vault_write: ${violation} — another principal's position entries can ` +
               `only be superseded by their own new position (vault_assert) or ` +
               `edited by their holder`,
           ),
         );
       }
     }
   ```
3. Propose-only preview (:848–905): inside the `if (onDisk.ok)` / `parsedExisting.ok` branch, capture `const existingPositions = parsedExisting.value.frontmatter.positions;`, and after `const preview = validateFrontmatter(previewRaw, ...)` (:876) add the same check against `preview.frontmatter.positions` — returning the same err (message prefixed `vault_write (stage preview):`) BEFORE `stageActionWithConflictCheck`, so a poisoned proposal dies at stage time (cheaper, honest; the authoritative check still runs at ratify dispatch through the direct path).

- [ ] **Step 7.4: Run — expected PASS** — `npx vitest run test/tools/write.test.ts test/tools/write-propose-only.test.ts test/tools/positions.test.ts` all green. The ratify replay keeps working because of the LD-13 carve-out (covered by the Task-2 unit test).

- [ ] **Step 7.5: Commit**

```bash
git add src/tools/write.ts test/tools/write.test.ts
git commit -m "feat(write): reject foreign-position mutation in vault_write (U-8)"
```

---

## Task 8 (U-9): Lint checks for positions

**Maps to:** R-10. **Depends on:** Tasks 1, 2.

**Files:** Modify: `src/curation/lint.ts` (LINT_CHECKS :47–62, checks init :251, doc loop :290); Modify: `test/curation/lint.test.ts`.

- [ ] **Step 8.1: Write the failing tests** — append to `test/curation/lint.test.ts` (it already imports `runLint`, `makeTempVault`; add `writeFileSync`/`join` if needed — both already imported at :1–3):

```typescript
describe("positionIntegrity (U-9)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => cleanupVault(vault));

  const doc = (positions: string, extra = "") => `---
title: P
domain: accumulation
collection: pricing
status: canonical
confidence: high
created: 2026-08-01
updated: 2026-08-01
updated_by: "agent:test"
provenance: direct
positions:
${positions}${extra}
---

Body.
`;

  const live = (id: string, principal: string, stance: string) => `  - id: ${id}
    principal: ${principal}
    stance: ${stance}
    confidence: medium
    created: 2026-08-01
`;

  it("flags dangling superseded_by, duplicate live per principal, contested drift, and a missing cap", async () => {
    writeFileSync(
      join(vault, "pricing", "bad-positions.md"),
      doc(
        `  - id: pos-001
    principal: alice
    stance: assert
    confidence: high
    created: 2026-08-01
    superseded_by: pos-999
${live("pos-002", "bob", "assert")}${live("pos-003", "bob", "dispute")}${live("pos-004", "bob", "assert")}`,
        "contested: false\n",
      ),
    );
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const details = report.value.checks.positionIntegrity
      .filter((f) => f.path === "pricing/bad-positions.md")
      .map((f) => f.detail)
      .join(" | ");
    expect(details).toContain("pos-999"); // (a) dangling
    expect(details).toContain("bob");     // (b) two live bob positions
    expect(details).toContain("contested"); // (c) drift: false vs derived true
    expect(details).toContain("confidence"); // (d) contested-unratified but confidence high
  });

  it("clean contested doc (capped, consistent) and legacy docs produce no findings", async () => {
    writeFileSync(
      join(vault, "pricing", "clean-contested.md"),
      doc(
        `${live("pos-001", "alice", "assert")}${live("pos-002", "bob", "dispute")}`,
        "contested: true\n",
      ).replace("confidence: high", "confidence: low"),
    );
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(
      report.value.checks.positionIntegrity.filter((f) => f.path === "pricing/clean-contested.md"),
    ).toEqual([]);
    // Legacy fixture docs (no positions) never appear.
    expect(report.value.checks.positionIntegrity.every((f) => f.path.includes("positions"))).toBe(true);
  });
});
```

- [ ] **Step 8.2: Run — expected FAIL** — TS: `checks.positionIntegrity` not a `LintCheckName`.

- [ ] **Step 8.3: Implement**

In `src/curation/lint.ts`:
1. Append `"positionIntegrity",` to `LINT_CHECKS` (:47–62, at the END, per the append-only comment).
2. Add `positionIntegrity: [],` to the `checks` init (:251–…).
3. Import `{ isContested, unsuperseded }` from `./positions.js`.
4. In the per-doc loop (:290, after check 6), add:
   ```typescript
     // 13. Position integrity (U-9, R-10). Advisory only — the schema layer
     // deliberately does not flag these (semantic, not type-shape).
     const positions = fm.positions;
     if (positions != null) {
       const ids = new Set(positions.map((p) => p.id));
       for (const p of positions) {
         if (p.superseded_by != null && !ids.has(p.superseded_by)) {
           checks.positionIntegrity.push({
             path: doc.path,
             detail: `position ${p.id} superseded_by dangling id ${p.superseded_by}`,
           });
         }
       }
       const liveByPrincipal = new Map<string, number>();
       for (const p of unsuperseded(positions)) {
         liveByPrincipal.set(p.principal, (liveByPrincipal.get(p.principal) ?? 0) + 1);
       }
       for (const [principal, n] of liveByPrincipal) {
         if (n > 1) {
           checks.positionIntegrity.push({
             path: doc.path,
             detail: `principal '${principal}' holds ${n} unsuperseded positions (max 1)`,
           });
         }
       }
       const derived = isContested(positions);
       if ((fm.contested ?? false) !== derived) {
         checks.positionIntegrity.push({
           path: doc.path,
           detail: `contested is ${String(fm.contested)} but the position set derives ${derived}`,
         });
       }
       if (derived && fm.org_position == null && fm.confidence !== "low") {
         checks.positionIntegrity.push({
           path: doc.path,
           detail: `contested without org position but confidence is '${fm.confidence}' (expected low)`,
         });
       }
     }
   ```

- [ ] **Step 8.4: Run — expected PASS** — `npx vitest run test/curation/lint.test.ts test/tools/curation.test.ts test/tools/lint-voice-wiring.test.ts` green (`LINT_CHECKS` propagates into vault_lint's schemas generically, src/tools/curation.ts:780–783).

- [ ] **Step 8.5: Commit**

```bash
git add src/curation/lint.ts test/curation/lint.test.ts
git commit -m "feat(lint): advisory positionIntegrity checks (U-9)"
```

---

## Task 9 (U-6): Wiring, comments, docs (last, small)

**Maps to:** R-6/R-13 surface documentation; exposure for all. **Depends on:** Tasks 4, 5, 6, 7.

- [ ] **Step 9.1:** `src/access/rbac.ts` `isProposeOnly` comment (:68–71): change "vault_write coerces; every other write tool denies" to "vault_write and vault_assert coerce into staged proposals; every other write tool denies." Grep to confirm no other copy of the old sentence survives: `rg -n "every other write tool denies" src/`.
- [ ] **Step 9.2:** `docs/architecture.md`: one paragraph in the concepts section: *"Positions (Slice 1): a claim doc is the unit of compilation; multiple authenticated principals hold attributed, graded, supersedable `positions[]` inside it. Conflicting live stances (assert vs dispute) derive `contested: true`, cap doc confidence at low until an org position is ratified (Slice 2), and auto-log a system-generated `positional` tension. `vault_assert` writes positions; `vault_positions` queries them; `vault_write` refuses to mutate another principal's entries. One process per vault still — principals take turns until the Slice-3 write lease."*
- [ ] **Step 9.3:** Registry check already asserted by the Task-4 test (`registeredToolNames()`). Run `npm run build && npm run lint` — clean. Fix any Biome findings (import order, template style) without behavior change.
- [ ] **Step 9.4: Commit**

```bash
git add src/access/rbac.ts docs/architecture.md
git commit -m "docs: positions concept + propose-only comment update (U-6)"
```

---

## Verification (Slice-1 done gate)

- [ ] `npm run build` — clean (also proves `STALE_TIER_LINT_COPY` totality and the LD-8 typing).
- [ ] `npm test` — full suite. **Known flake [DATA, memory]:** embedding/search tests can go red when MiniLM fails to load — re-run `npx vitest run --failed` (or the failed files) before diagnosing a regression.
- [ ] `npm run lint` — Biome (`biome check src test`) clean.
- [ ] Targeted sweep: `npx vitest run test/frontmatter/positions-schema.test.ts test/tools/serialize-positions.test.ts test/curation/positions.test.ts test/curation/tension.test.ts test/tools/positions.test.ts test/tools/read-positions.test.ts test/tools/write.test.ts test/curation/lint.test.ts`

Mandated-scenario acceptance map (every one must be green):

| Mandated scenario | Test |
|---|---|
| Propose-only principal asserting → staged | positions.test.ts "propose-only role: lands as a staged write" |
| Principal overwriting another's position → reject | write.test.ts "alice dropping bob's position…rejected" (+ impersonation reject in positions.test.ts) |
| Auto-logged positional tension on 2nd conflicting position | positions.test.ts "bob disputes → …one positional tension" |
| Compile/read over contested-unratified doc → CONTESTED + cap | read-positions.test.ts "contested-unratified doc: CONTESTED flag…low confidence" |
| Legacy doc with no positions → byte-identical unchanged | serialize-positions.test.ts test 3 + read-positions.test.ts "legacy doc: no contested_positions key" |
| Self-supersession of one's own position | curation/positions.test.ts "re-assert supersedes only the caller's…" + positions.test.ts "alice re-asserts" |

- [ ] Manual smoke: `npm run dev` against test/fixtures/sample-vault; restart with `--user alice --role writer`, `vault_assert` an assert; restart as bob, `vault_assert` a dispute (Slice 1's take-turns model); `vault_read` the doc — CONTESTED block, confidence low; `vault_lint` — no positionIntegrity findings.

**Follow-ups (do NOT build now):** Slice 2 = U-10 `vault_consolidate` + org_position + read case 1, U-11 downstream consumer confidence cap (advisory annotation), U-12 pos-000 legacy snapshot. Slice 3 = U-13 per-mutation write lease (needs its own design pass against src/lifecycle/lock.ts — do not start from the spec alone).
