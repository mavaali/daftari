# vault_canon — Belief Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `vault_canon`, a read-only MCP tool that computes settled vs. contested belief across holders over an emergent, depth-bounded topic — attributed, never auto-resolved.

**Architecture:** Read-time computation, nothing stored. Five focused modules — holder registry, topic engine, canon resolver, a canon orchestrator, and the MCP tool — composing existing daftari primitives (`computeValidity`, `listTensions`, `listEdges`, RBAC predicates, `vault_receipt`). One SQLite read transaction + a git ref pinned per call guarantee self-consistency.

**Tech Stack:** TypeScript (native ESM, `.js` import extensions), Vitest, Biome, `tsc`. Conventional Commits (`type(scope): desc`). Tools are plain JSON-Schema `ToolDefinition`s spread into `allTools` in `src/server.ts`; handlers return `Result<T, Error>`.

**Spec:** `2026-07-29-vault-canon-belief-layer-design.md`. **Deviations from spec, intentional:** (a) no `asof` refactor — `computeValidity` (`src/curation/validity.ts:64`) is already exported and callable; (b) holder aliases get a **new** one-to-many config key, because the existing `backfillIdentityMap` (`src/utils/config.ts:217`) is one-to-one and backfill-only.

**Reference signatures (verified @ origin/main 7b81ad7):**
- `computeValidity(input: {valid_from, valid_until}, at: string): ValidityReport | null` — `state: "in-window"|"expired"|"not-yet"|"unknown"`.
- `listTensions(vaultRoot, status?): Promise<Result<TensionEntry[], Error>>`; `TensionEntry {sourceA, claimA, sourceB, claimB, kind, id?, ...}`.
- `listEdges(vaultRoot, {fromPath?, toPath?, status?}, now?): Promise<Result<DerivesFromEdge[], Error>>`; edge `{fromPath, toPath, status, ...}`.
- `canRead(role, collection)`, `filterByReadPermission<T extends {collection}>(role, items)`, `readableCollections(role)`; `AccessContext {user, roleName, role: RoleConfig|null}`.
- `loadDocuments(vaultRoot): Promise<Result<LoadedDoc[], Error>>` (working-tree bulk loader, `src/curation/vault-docs.ts:30`).
- `loadConfig(vaultRoot): Result<DaftariConfig, Error>` (sync, mtime-cached).
- `Result<T,E> = {ok:true, value:T} | {ok:false, error:E}`.
- Tool handler: `(vaultRoot, args, access?) => Promise<Result<unknown, Error>>`; register by spreading a `ToolDefinition[]` into `allTools` (`src/server.ts:50-64`).

**Conventions every task follows:** temp vault via `mkdtempSync(join(tmpdir(),"daftari-canon-"))` in `beforeEach`, `rmSync(...,{recursive,force})` in `afterEach`; imports end in `.js`; tests under `test/` mirror `src/`; run one file with `npx vitest run <file>`; lint with `npx biome check src test`; commit conventional.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/utils/config.ts` (modify) | Add `holderAliases?: Record<string,string>` (alias → canonical id) to `DaftariConfig` + parse it |
| `src/holders/registry.ts` (create) | `resolveHolder(string) → canonicalId`; `HolderRegistry` built from config; `isRegistered(string)` |
| `src/holders/types.ts` (create) | `HolderId`, `HolderRegistry`, `GhostHolderWarning` |
| `src/canon/topic.ts` (create) | `topicEgoGraph(vaultRoot, seed, depth) → Result<string[]>` (depth-N over tension+derives_from) |
| `src/canon/resolve.ts` (create) | `resolveCanon(docs, holders, asOf, registry, tensions) → CanonResult` (settled/contested/flags) |
| `src/canon/types.ts` (create) | `CanonResult`, `SettledClaim`, `ContestedTrajectory`, `CanonFlags` |
| `src/canon/index.ts` (create) | `computeCanon(vaultRoot, args, access) → Result<CanonResult>` — pins git ref, single read txn, wires it all |
| `src/tools/canon.ts` (create) | `canonTools: ToolDefinition[]` — schema, handler, `summarize`, `docLinks` |
| `src/server.ts` (modify) | Spread `...canonTools` into `allTools` |
| `test/holders/registry.test.ts`, `test/canon/topic.test.ts`, `test/canon/resolve.test.ts`, `test/tools/canon.test.ts` (create) | Unit + integration tests |

---

## Task 1: Holder config + registry

**Files:**
- Modify: `src/utils/config.ts` (add `holderAliases` to `DaftariConfig` + its parser)
- Create: `src/holders/types.ts`, `src/holders/registry.ts`
- Test: `test/holders/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/holders/registry.test.ts
import { describe, it, expect } from "vitest";
import { buildRegistry, resolveHolder, isRegistered } from "../../src/holders/registry.js";

describe("holder registry", () => {
  const reg = buildRegistry({ "mavaali-v1": "agent:mavaali", "mavaali": "agent:mavaali" });

  it("maps many historical strings to one canonical holder", () => {
    expect(resolveHolder(reg, "mavaali-v1")).toBe("agent:mavaali");
    expect(resolveHolder(reg, "mavaali")).toBe("agent:mavaali");
  });

  it("passes through an unknown string as its own holder id", () => {
    expect(resolveHolder(reg, "human:bob")).toBe("human:bob");
  });

  it("flags unregistered strings so a rename cannot forge a ghost holder", () => {
    expect(isRegistered(reg, "mavaali-v1")).toBe(true);
    expect(isRegistered(reg, "human:bob")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/holders/registry.test.ts`
Expected: FAIL — cannot find module `../../src/holders/registry.js`.

- [ ] **Step 3: Write the types**

```ts
// src/holders/types.ts
export type HolderId = string; // e.g. "agent:mavaali", "human:mihir"

export interface HolderRegistry {
  /** alias string → canonical holder id */
  aliases: Map<string, HolderId>;
}

export interface GhostHolderWarning {
  count: number;
  strings: string[]; // unregistered identity strings encountered
}
```

- [ ] **Step 4: Write the minimal implementation**

```ts
// src/holders/registry.ts
import type { HolderId, HolderRegistry } from "./types.js";

/** Build a registry from config's holderAliases (alias → canonical id). */
export function buildRegistry(holderAliases: Record<string, string> = {}): HolderRegistry {
  return { aliases: new Map(Object.entries(holderAliases)) };
}

/** Canonical holder for a stamped identity string. Unknown strings are their own holder. */
export function resolveHolder(reg: HolderRegistry, identity: string): HolderId {
  return reg.aliases.get(identity) ?? identity;
}

/** True iff the string is an explicitly registered alias (not a passthrough). */
export function isRegistered(reg: HolderRegistry, identity: string): boolean {
  return reg.aliases.has(identity);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/holders/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire `holderAliases` into config**

In `src/utils/config.ts`, add to the `DaftariConfig` interface: `holderAliases: Record<string, string>;` and, in the config parser, read an optional YAML block `holders.aliases` into it, defaulting to `{}` in `emptyConfig()`. Follow the exact parse/default pattern already used for `backfillIdentityMap` (`src/utils/config.ts:217`).

- [ ] **Step 7: Run full suite + lint**

Run: `npm test && npx biome check src test`
Expected: PASS, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add src/holders test/holders src/utils/config.ts
git commit -m "feat(canon): holder registry with one-to-many aliases (belief layer)"
```

---

## Task 2: Topic engine (depth-N ego-graph)

**Files:**
- Create: `src/canon/topic.ts`
- Test: `test/canon/topic.test.ts`

Design: from a `seed` doc path, collect neighbors reachable within `depth` hops over the **union** of tension edges (`sourceA`/`sourceB` pairs from `listTensions`) and `derives_from` edges (`listEdges`, both directions). Default `depth = 2`. Return the set of doc paths (including the seed).

- [ ] **Step 1: Write the failing test**

```ts
// test/canon/topic.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTension } from "../../src/curation/tension.js";
import { topicEgoGraph } from "../../src/canon/topic.js";

describe("topicEgoGraph", () => {
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "daftari-canon-")); });
  afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

  it("includes seed + direct tension neighbor, excludes depth-3 nodes", async () => {
    // A—B tension, B—C tension, C—D tension. Seed A, depth 2 ⇒ {A,B,C}, not D.
    await addTension(vault, { title: "t1", kind: "factual", sourceA: "A.md", claimA: "p", sourceB: "B.md", claimB: "¬p", loggedBy: "test" });
    await addTension(vault, { title: "t2", kind: "factual", sourceA: "B.md", claimA: "p", sourceB: "C.md", claimB: "¬p", loggedBy: "test" });
    await addTension(vault, { title: "t3", kind: "factual", sourceA: "C.md", claimA: "p", sourceB: "D.md", claimB: "¬p", loggedBy: "test" });

    const res = await topicEgoGraph(vault, "A.md", 2);
    expect(res.ok).toBe(true);
    const set = res.ok ? new Set(res.value) : new Set();
    expect(set).toEqual(new Set(["A.md", "B.md", "C.md"]));
    expect(set.has("D.md")).toBe(false);
  });
});
```

> Confirm `addTension`'s exact argument object against `src/curation/tension.ts:154` before running; adjust field names if the signature differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/canon/topic.test.ts`
Expected: FAIL — module `../../src/canon/topic.js` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/canon/topic.ts
import { listTensions } from "../curation/tension.js";
import { listEdges } from "../curation/edges.js";
import type { Result } from "../frontmatter/types.js";

/** Adjacency over the union of tension pairs and derives_from edges (undirected). */
async function buildAdjacency(vaultRoot: string): Promise<Result<Map<string, Set<string>>, Error>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  const tensions = await listTensions(vaultRoot); // all statuses: a resolved tension is still a topic link
  if (!tensions.ok) return tensions;
  for (const t of tensions.value) link(t.sourceA, t.sourceB);

  const edges = await listEdges(vaultRoot, {});
  if (!edges.ok) return edges;
  for (const e of edges.value) link(e.fromPath, e.toPath);

  return { ok: true, value: adj };
}

/** Doc paths within `depth` hops of `seed` over tension+derives_from. Includes the seed. */
export async function topicEgoGraph(
  vaultRoot: string,
  seed: string,
  depth = 2,
): Promise<Result<string[], Error>> {
  const adjRes = await buildAdjacency(vaultRoot);
  if (!adjRes.ok) return adjRes;
  const adj = adjRes.value;

  const visited = new Set<string>([seed]);
  let frontier: string[] = [seed];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const nbr of adj.get(node) ?? []) {
        if (!visited.has(nbr)) { visited.add(nbr); next.push(nbr); }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return { ok: true, value: [...visited] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/canon/topic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canon/topic.ts test/canon/topic.test.ts
git commit -m "feat(canon): depth-N topic ego-graph over tension+derives_from"
```

---

## Task 3: Canon resolver (settled vs contested + flags)

**Files:**
- Create: `src/canon/types.ts`, `src/canon/resolve.ts`
- Test: `test/canon/resolve.test.ts`

Design: given already-loaded docs (path, holder-string, `valid_from`, `valid_until`, `updated`, `collection`), the holder-set, `asOf`, the registry, and the topic's tensions — (1) keep currently-valid docs (`computeValidity(... , asOf).state === "in-window"`, treating a `null` report as always-valid), (2) group by `resolveHolder`, (3) a tension between two surviving in-scope docs ⇒ contested trajectory (sorted by `valid_from`), else settled. Emit `ghost_holder_warning` for unregistered holder strings. `partial_visibility`/`unindexed` are set by the orchestrator (Task 4), which knows RBAC + index state; the resolver accepts them as inputs to fold into flags.

- [ ] **Step 1: Write the failing test**

```ts
// test/canon/resolve.test.ts
import { describe, it, expect } from "vitest";
import { buildRegistry } from "../../src/holders/registry.js";
import { resolveCanon } from "../../src/canon/resolve.js";
import type { CanonDoc } from "../../src/canon/types.js";

const reg = buildRegistry({});
const doc = (p: string, holder: string, from: string | null, until: string | null): CanonDoc =>
  ({ path: p, holder, valid_from: from, valid_until: until, updated: from ?? "2026-01-01", collection: "x" });

describe("resolveCanon", () => {
  it("returns settled when currently-valid docs share no tension", () => {
    const docs = [doc("A.md", "human:alice", "2026-01-01", null), doc("B.md", "human:bob", "2026-01-01", null)];
    const r = resolveCanon(docs, ["human:alice", "human:bob"], "2026-07-01", reg, []);
    expect(r.contested).toHaveLength(0);
    expect(r.settled.length).toBeGreaterThan(0);
  });

  it("returns a contested trajectory (sorted by valid_from) when a tension links two valid docs", () => {
    const docs = [doc("A.md", "human:alice", "2026-06-01", null), doc("B.md", "human:bob", "2026-01-01", null)];
    const tensions = [{ sourceA: "A.md", sourceB: "B.md" } as any];
    const r = resolveCanon(docs, ["human:alice", "human:bob"], "2026-07-01", reg, tensions);
    expect(r.settled).toHaveLength(0);
    expect(r.contested).toHaveLength(1);
    expect(r.contested[0].trajectory.map(t => t.path)).toEqual(["B.md", "A.md"]); // earlier valid_from first
  });

  it("excludes fossils (expired valid_until) from canon", () => {
    const docs = [doc("A.md", "human:alice", "2026-01-01", "2026-03-01")]; // expired before asOf
    const r = resolveCanon(docs, ["human:alice"], "2026-07-01", reg, []);
    expect(r.settled).toHaveLength(0);
    expect(r.contested).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/canon/resolve.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the types**

```ts
// src/canon/types.ts
export interface CanonDoc {
  path: string;
  holder: string;         // stamped identity string (pre-resolution)
  valid_from: string | null;
  valid_until: string | null;
  updated: string;        // server-stamped record clock
  collection: string;
}

export interface SettledClaim { holder: string; citations: string[]; }

export interface TrajectoryNode { holder: string; path: string; valid_from: string | null; updated: string; }
export interface ContestedTrajectory { trajectory: TrajectoryNode[]; hint_ordering: "by_valid_from"; }

export interface CanonFlags {
  graph_completeness: "curated";
  partial_visibility: boolean;
  hidden_tension_count: number;
  unindexed: boolean;
  unindexed_paths: string[];
  ghost_holder_warning?: { count: number; strings: string[] };
}

export interface CanonResult {
  settled: SettledClaim[];
  contested: ContestedTrajectory[];
  flags: CanonFlags;
}
```

- [ ] **Step 4: Write the implementation**

```ts
// src/canon/resolve.ts
import { computeValidity } from "../curation/validity.js";
import { resolveHolder, isRegistered } from "../holders/registry.js";
import type { HolderRegistry } from "../holders/types.js";
import type { CanonDoc, CanonResult, ContestedTrajectory } from "./types.js";

interface TensionPair { sourceA: string; sourceB: string; }

/** A doc is in canon if it has no validity window, or is in-window at asOf. */
function currentlyValid(doc: CanonDoc, asOf: string): boolean {
  const report = computeValidity({ valid_from: doc.valid_from, valid_until: doc.valid_until }, asOf);
  return report === null || report.state === "in-window";
}

export function resolveCanon(
  docs: CanonDoc[],
  holders: string[],           // canonical holder ids in scope
  asOf: string,
  registry: HolderRegistry,
  tensions: TensionPair[],
  hidden = { partial_visibility: false, hidden_tension_count: 0 },
  unindexed: string[] = [],
): CanonResult {
  const holderSet = new Set(holders);
  const inScope = docs.filter(
    (d) => currentlyValid(d, asOf) && holderSet.has(resolveHolder(registry, d.holder)),
  );
  const byPath = new Map(inScope.map((d) => [d.path, d]));

  // Ghost-holder detection over the in-scope docs.
  const ghostStrings = [...new Set(inScope.map((d) => d.holder).filter((s) => !isRegistered(registry, s) && registry.aliases.size > 0))];

  // Contested = any tension whose BOTH sides are in-scope docs.
  const contested: ContestedTrajectory[] = [];
  const contestedPaths = new Set<string>();
  for (const t of tensions) {
    const a = byPath.get(t.sourceA);
    const b = byPath.get(t.sourceB);
    if (!a || !b) continue;
    const nodes = [a, b]
      .map((d) => ({ holder: resolveHolder(registry, d.holder), path: d.path, valid_from: d.valid_from, updated: d.updated }))
      .sort((x, y) => (x.valid_from ?? "").localeCompare(y.valid_from ?? ""));
    contested.push({ trajectory: nodes, hint_ordering: "by_valid_from" });
    contestedPaths.add(a.path);
    contestedPaths.add(b.path);
  }

  const settled = inScope
    .filter((d) => !contestedPaths.has(d.path))
    .map((d) => ({ holder: resolveHolder(registry, d.holder), citations: [d.path] }));

  return {
    settled,
    contested,
    flags: {
      graph_completeness: "curated",
      partial_visibility: hidden.partial_visibility,
      hidden_tension_count: hidden.hidden_tension_count,
      unindexed: unindexed.length > 0,
      unindexed_paths: unindexed,
      ...(ghostStrings.length > 0 ? { ghost_holder_warning: { count: ghostStrings.length, strings: ghostStrings } } : {}),
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/canon/resolve.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/canon/types.ts src/canon/resolve.ts test/canon/resolve.test.ts
git commit -m "feat(canon): resolver — settled vs contested trajectory, fossils excluded"
```

---

## Task 4: Canon orchestrator (RBAC, pinned ref, single read txn, unindexed + partial_visibility)

**Files:**
- Create: `src/canon/index.ts`
- Test: covered by the Task 5 integration test (this module is exercised end-to-end there)

Design: `computeCanon(vaultRoot, {seed, holders?, asOf?, depth?}, access?)`:
1. Pin `asOf` to now if absent; capture the git HEAD ref once (for the receipt anchor) via the existing helper used by `vault_receipt`.
2. `topicEgoGraph(vaultRoot, seed, depth)` → candidate paths.
3. **Reads use the working tree via a single `loadDocuments(vaultRoot)` call** (`src/curation/vault-docs.ts:30`), filtered to the candidate paths. This resolves the C3 self-consistency requirement without a manual SQLite transaction: `loadDocuments` is one pass over the tree, and the git HEAD captured once in step 1 anchors the receipt to a fixed commit. (Rationale for working-tree over index-db: `CanonDoc.updated`/`valid_*` come straight from frontmatter, no index-freshness dependency, and no open `IndexDb` handle to manage. If a later version must read committed-only state, switch to `openIndexDb` (`src/storage/index-db.ts:431`) and keep all queries on that one handle — but that is out of scope for v1.)
4. RBAC: drop docs whose `collection` fails `canRead(access?.role, collection)`. Compute `partial_visibility` = there exists a tension touching an in-topic visible doc whose *other* side is a doc the caller cannot read; `hidden_tension_count` = how many. (The both-sides rule already hides such tensions from `listTensions` under RBAC; count them by comparing the RBAC-unfiltered topic tension set to the visible one.)
5. `unindexed` = in-topic docs with **no** tension edge and **no** derives_from edge (never consolidated).
6. Default `holders` = all canonical holders present among visible docs; else the caller's set (map each through `resolveHolder`).
7. Call `resolveCanon(...)`; attach a `vault_receipt` over all cited paths (reuse the receipt module) into the returned value.

> Keep this module thin — it wires and RBAC-gates; all resolution logic lives in `resolve.ts`. Confirm the git-HEAD helper and the receipt entry function by reading `src/tools/receipt.ts` before implementing.

- [ ] **Step 1: Write a failing unit test for the RBAC blind-spot flag.** In `test/canon/orchestrator.test.ts`, build a vault where a tension links a readable doc and a doc in a collection the role cannot read; assert the result is `settled` (the tension is hidden) BUT `flags.partial_visibility === true` and `flags.hidden_tension_count === 1`. This is the one place canon must not silently assert false consensus — test it directly, not only through Task 5.
- [ ] **Step 2:** Run `npx vitest run test/canon/orchestrator.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Write `computeCanon` per the design above, returning `Result<CanonResult & { receipt: ... }, Error>`.
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Run `npx biome check src test` — fix lint.
- [ ] **Step 6:** Commit: `git commit -m "feat(canon): orchestrator — RBAC gate, pinned ref, working-tree snapshot"`

---

## Task 5: MCP tool `vault_canon` + registration + integration test

**Files:**
- Create: `src/tools/canon.ts`
- Modify: `src/server.ts` (spread `...canonTools` into `allTools`, `src/server.ts:50-64`)
- Test: `test/tools/canon.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// test/tools/canon.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonTools } from "../../src/tools/canon.js";
import { addTension } from "../../src/curation/tension.js";

const tool = canonTools.find((t) => t.name === "vault_canon")!;

describe("vault_canon tool", () => {
  let vault: string;
  beforeEach(() => { vault = mkdtempSync(join(tmpdir(), "daftari-canon-")); mkdirSync(join(vault, "x")); });
  afterEach(() => { rmSync(vault, { recursive: true, force: true }); });

  it("reports contested when two holders' valid docs are tensioned", async () => {
    writeFileSync(join(vault, "x/a.md"), "---\nvalid_from: 2026-06-01\nupdated: 2026-06-01\nupdated_by: human:alice\ncollection: x\n---\nP");
    writeFileSync(join(vault, "x/b.md"), "---\nvalid_from: 2026-01-01\nupdated: 2026-01-01\nupdated_by: human:bob\ncollection: x\n---\nnot P");
    await addTension(vault, { title: "t", kind: "factual", sourceA: "x/a.md", claimA: "P", sourceB: "x/b.md", claimB: "¬P", loggedBy: "test" });

    const res = await tool.handler(vault, { seed: "x/a.md", as_of: "2026-07-01" });
    expect(res.ok).toBe(true);
    const v = res.ok ? (res.value as any) : null;
    expect(v.contested).toHaveLength(1);
    expect(v.flags.graph_completeness).toBe("curated");
  });
});
```

> Confirm the exact frontmatter loader tolerates this shape; if the tool reads via the index, the test must build the index first (call the same indexing helper the other tool tests use — check `test/tools/receipt.test.ts` for the setup).

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/tools/canon.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write the tool**

```ts
// src/tools/canon.ts
import type { ToolDefinition } from "./read.js";
import { computeCanon } from "../canon/index.js";

export const canonTools: ToolDefinition[] = [
  {
    name: "vault_canon",
    title: "Compute shared belief (canon)",
    description:
      "Compute settled vs. contested belief across holders over an emergent, depth-bounded topic. " +
      "Attributed, never auto-resolved. 'settled' means no contradiction has been recorded (graph_completeness: curated), not that none exists.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", description: "Seed document path; the topic is its depth-N ego-graph." },
        holders: { type: "array", items: { type: "string" }, description: "Canonical holder ids; default = all readable holders (shared canon)." },
        as_of: { type: "string", description: "YYYY-MM-DD; default now." },
        depth: { type: "number", minimum: 1, maximum: 4, description: "Topic radius in hops (default 2)." },
      },
      required: ["seed"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        settled: { type: "array" }, contested: { type: "array" }, flags: { type: "object" }, receipt: { type: "object" },
      },
      required: ["settled", "contested", "flags"],
      additionalProperties: true,
    },
    annotations: { readOnlyHint: true },
    summarize: (v: unknown) => {
      const r = v as { settled: unknown[]; contested: unknown[]; flags: { partial_visibility: boolean } };
      return `canon: ${r.settled.length} settled, ${r.contested.length} contested${r.flags.partial_visibility ? " (partial visibility)" : ""}`;
    },
    handler: (vaultRoot, args, access) =>
      computeCanon(
        vaultRoot,
        {
          seed: String(args.seed),
          holders: Array.isArray(args.holders) ? (args.holders as string[]) : undefined,
          asOf: typeof args.as_of === "string" ? args.as_of : undefined,
          depth: typeof args.depth === "number" ? args.depth : undefined,
        },
        access,
      ),
  },
];
```

- [ ] **Step 4: Register in `src/server.ts`** — import `canonTools` and add `...canonTools` to the `allTools` array (`src/server.ts:50-64`).

- [ ] **Step 5: Run to verify pass** — `npx vitest run test/tools/canon.test.ts` → PASS.

- [ ] **Step 6: Full suite + lint + build** — `npm test && npx biome check src test && npm run build` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/tools/canon.ts src/server.ts test/tools/canon.test.ts
git commit -m "feat(canon): vault_canon MCP tool + registration (belief layer v1)"
```

---

## Task 6: Docs + CHANGELOG

- [ ] Add a `vault_canon` entry to `CHANGELOG.md` (match the existing top-of-file style).
- [ ] Add a short section to the tool docs / README tool list if one exists (grep for where `vault_receipt` is documented and mirror it).
- [ ] Commit: `git commit -m "docs(canon): document vault_canon and the belief layer"`

---

## Definition of Done
- `npm test`, `npx biome check src test`, `npm run build` all green.
- `vault_canon` appears in `tools/list`, returns settled/contested + flags + receipt, RBAC-gated.
- Fossils excluded; contested returns a valid_from-sorted trajectory; `partial_visibility` set when a tension is ACL-hidden; `unindexed` set for never-consolidated docs; `ghost_holder_warning` on unregistered identity strings.
- No auto-resolution anywhere; resolution still only via `vault_tension_resolve`.

## Open confirmations for the implementer (resolve before/at first touch)
1. Exact `addTension` argument shape (`src/curation/tension.ts:154`).
2. ~~Working-tree vs index-db read path~~ — **RESOLVED in Task 4 step 3: working tree via a single `loadDocuments` call** for v1.
3. The git-HEAD-pin + `vault_receipt` entry function names (read `src/tools/receipt.ts`).
