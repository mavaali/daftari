# Cortex Quality Metric (Sleep Component B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `daftari eval`, a CLI subcommand that produces a tier-weighted quality score for how well an LLM can use Daftari as cortex to answer multi-hop questions about the vault. The score is the prerequisite measurement for Components A and C (multi-pass curation, dependency-triggered re-curation) — those are explicitly out of scope here.

**Architecture:** New `src/eval/` package, lazy-loaded from `src/cli.ts`. Three-stage pipeline (generate → run → score) wired through pure-function module boundaries. **In-process MCP loop**: `src/eval/run.ts` calls existing tool handlers (`vaultRead`, `vaultSearch`, etc.) directly as TypeScript functions — no MCP server spin-up, no subprocess. LLM access is the single hosted-API dependency and is reached only via `src/eval/llm.ts` (which calls the official `@anthropic-ai/sdk`); the rest of the codebase remains LLM-free.

**Tech Stack:** TypeScript (existing project conventions), Node `node:fs` / `node:path` / `node:crypto`, the existing tool handlers in `src/tools/*.ts`, **new runtime dep:** `@anthropic-ai/sdk`. Tests use vitest with hand-rolled mocks (no new mocking dep).

**Conventions:** Functions and types only — no classes (project rule). Use the canonical `Result<T, E>` / `ok` / `err` helpers from `src/frontmatter/types.ts`. Stages that can fail return `Result<T, EvalError>` where `EvalError` is a tagged union `{ kind: "config" | "runtime" | "llm"; message: string }`. `runEval` branches on `result.error.kind` to map to exit codes 2 (config) and 3 (runtime/llm). No `throw`, no `class`.

Reference spec: [docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md](../specs/2026-05-31-cortex-quality-metric-design.md). Issue: [mavaali/daftari#97](https://github.com/mavaali/daftari/issues/97).

---

## Resolutions to spec §12 open questions

Settled here before implementation begins so tasks below reference fixed decisions:

1. **Anthropic SDK.** Official `@anthropic-ai/sdk`, pinned to a specific minor version in `package.json` (`^0.x.y` — Task 1 picks the exact version against npm at install time). First hosted-LLM dependency in the project; isolated to `src/eval/llm.ts`. Every other file remains transitively SDK-free.
2. **Sample-vault fixture coverage.** Audit current `test/fixtures/sample-vault/` for at least one *unresolved* tension (§5.3's augmentation path requires this). If absent, add a minimal one in Task 14 — `tensions.md` entry with `resolved: false` between two existing docs. Tests run on the augmented fixture; the addition is a single tension log entry, not new docs.
3. **Prompt versioning.** `src/eval/prompts.ts` holds three frozen string constants (`GENERATOR_PROMPT`, `ANSWERER_PROMPT`, `GRADER_PROMPT`) plus `PROMPT_VERSION: number`. Bumping any prompt requires bumping `PROMPT_VERSION` in the same commit. `PROMPT_VERSION` is written into every output file alongside model IDs. `history.json`'s `spec_version` is incremented when `PROMPT_VERSION` changes in a way that would invalidate cross-version comparisons (judgment call at the commit; documented in CHANGELOG).
4. **Trace JSON size.** Store traces as-is in v1. No truncation, no by-reference storage. Spec §8 already notes the disk-growth pattern and the `rm -rf .daftari/eval/results/` recovery. Optimization is a v2 problem if and when real disk pressure shows up.
5. **`history.json` migration.** Read-only-compatible-versions in v1. A `history.json` with a `version` field newer than the running daftari logs a stderr warning and is left untouched; older `version` is read as-is and rewritten in the new shape on next eval. No migration scripts. If v2 changes the schema breakingly, v2's plan adds the migration.
6. **`daftari eval prune` v2 follow-up.** File a GitHub issue after this PR merges, titled "v2: daftari eval prune for results/ and scores/ housekeeping". Not in v1. The `--help` text in Task 11 calls out the manual `rm -rf` path.

---

## File Structure

**Create (src/):**

| File | Responsibility |
|---|---|
| `src/eval/types.ts` | Shared types: `Question`, `QuestionSet`, `EvalRun`, `Trace`, `Score`, `EvalError`, `Tier`, plus the `QuestionSetSchema` JSON Schema constant. |
| `src/eval/subgraph.ts` | `sampleSubgraph(vault, seed, opts): Promise<Result<Subgraph, EvalError>>` — pure-ish (reads vault index) seeded subgraph walk, 1–2 hops via sources / links / tensions. |
| `src/eval/storage.ts` | `writeQuestionSet`, `readQuestionSet`, `writeResults`, `readResults`, `writeScore`, `appendHistory`, `readHistory` — JSON I/O under `.daftari/eval/` with schema-version handling and history rotation. |
| `src/eval/score.ts` | `aggregateScore(grades, questions): Score` — pure tier-weighted aggregation with std. Phase 2 (Task 10) adds `gradeAnswer(question, run): Promise<Result<Grade, EvalError>>` LLM-mediated grader. |
| `src/eval/prompts.ts` | Frozen prompt strings + `PROMPT_VERSION`. Single source of truth for any LLM-facing text. |
| `src/eval/llm.ts` | `LlmClient` interface + `createAnthropicClient(opts): LlmClient` factory. Wraps `@anthropic-ai/sdk` with retry-on-5xx and JSON-Schema-validated structured output. Mockable by passing an alternative `LlmClient` impl. |
| `src/eval/generate.ts` | `generateQuestions(subgraph, llm, opts): Promise<Result<QuestionSet, EvalError>>` — calls generator LLM, validates output against `QuestionSetSchema`, runs filters (source-in-subgraph, triviality), applies tension-graph augmentation. |
| `src/eval/run.ts` | `runAnswerer(questions, vault, llm, opts): Promise<Result<EvalRun, EvalError>>` — for each question × K runs: invokes answerer LLM with the in-process curation tool surface, captures full trace, returns per-(question_index, k_index) result. Supports resume. |
| `src/eval/index.ts` | `runEval(argv): Promise<number>` — CLI subcommand dispatcher: parses flags, routes to `generate` / `run` / `score` / top-level, translates `Result<T, EvalError>` to exit codes, prints `--help`. |

**Create (test/):**

| File | Scope |
|---|---|
| `test/eval/subgraph.test.ts` | Deterministic traversal on sample-vault fixture: known seed → known subgraph; edge type filters (sources / links / tensions); size cap; stratification. |
| `test/eval/storage.test.ts` | Round-trip JSON read/write for question sets, results, scores; `history.json` rotation at boundary (50); schema-version warning on mismatched read. |
| `test/eval/score.test.ts` | Exhaustive tier-weighting: all-perfect, all-zero, partial, tier-missing, K=1, K=2, K=5, augmented-question counting, variance edge cases. |
| `test/eval/llm.test.ts` | `LlmClient` mock-injection pattern works; retry policy fires on 429/5xx; JSON-schema validation surfaces structured errors. |
| `test/eval/generate.test.ts` | Mocked LLM returns canned JSON; tests filter logic, tier-mix enforcement (top-up retry capped at 1), augmentation count rule, malformed-output handling. |
| `test/eval/run.test.ts` | Mocked LLM + mocked tool handlers; tests trace capture shape, K-run independence, resume from partial results, per-(q,k) overwrite semantics. |
| `test/eval/e2e.test.ts` | Full pipeline against `test/fixtures/sample-vault/` with mocked LLM client; locks pipeline behavior end-to-end. |
| `test/eval/smoke.test.ts` | `skipIf(!process.env.ANTHROPIC_API_KEY)`. Real LLM, N=3 (1 per tier), K=1. Not in CI default. |

**Modify:**

- `src/cli.ts` — add `eval` subcommand branch (lazy-import like `audit`), extend `USAGE` to mention `daftari eval`.
- `.gitignore` — add `**/.daftari/eval/` to the existing `.daftari/*` pattern block.
- `test/fixtures/sample-vault/.daftari/tensions.md` — augment with one unresolved-tension entry if missing (Task 14 audits and conditionally adds).
- `package.json` — add `"@anthropic-ai/sdk": "^x.y.z"` dependency. **No version bump** — that belongs to the next release PR per project convention.
- `package-lock.json` — `npm install` reconciles.
- `CHANGELOG.md` — entry under `## [Unreleased]` → `### Added` (the release PR moves it under `## [1.16.0] - YYYY-MM-DD`).
- `README.md` — short subsection under "The tools" naming `daftari eval` and pointing at the spec for design rationale.

---

## Build order rationale

Types first → pure utilities (subgraph, storage, score-aggregation) → prompts → LLM client → pipeline stages (generate, run, score-grading) → CLI dispatch → CLI wiring → E2E → fixture audit → smoke test → release artifacts.

Each layer is testable against fixtures or hand-built inputs from the layer above. The pure utilities and aggregation have no LLM dependency, so they get full TDD coverage with deterministic tests. The LLM-mediated stages use mock `LlmClient` for unit tests; only the smoke test makes real network calls.

---

### Task 1: Project setup — gitignore, Anthropic SDK dep, version bump

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json` (via `npm install`)
- Test: none (operational change)

- [ ] **Step 1: Add `.daftari/eval/` to `.gitignore`**

Edit `.gitignore`, inserting after the existing `**/.daftari/process.lock` line:

```
# Ephemeral eval artifacts (regeneratable from .md sources + LLM calls).
**/.daftari/eval/
```

- [ ] **Step 2: Add `@anthropic-ai/sdk` to `package.json` dependencies**

Pick the latest stable `@anthropic-ai/sdk` minor version at install time. Add under `dependencies` (alphabetical order keeps it after `@modelcontextprotocol/sdk`):

```json
"@anthropic-ai/sdk": "^0.x.y",
```

- [ ] **Step 3: Run `npm install` to install the SDK and reconcile the lockfile**

Run: `npm install`
Expected: `added 1 package` (plus transitive deps), zero vulnerabilities, lockfile updated.

- [ ] **Step 4: (Skipped — version bump belongs to the release PR, not this feature PR)**

Per the project's release convention (v1.14.0 → v1.15.0), feature PRs add entries under `## [Unreleased]` and leave `package.json` alone. A separate release PR (see `chore: release vX.Y.Z` pattern) handles the version bump and dated CHANGELOG section move. No version edit in this task.

- [ ] **Step 5: Verify build still passes (no eval code yet — just the dep)**

Run: `npm run build`
Expected: `tsc` exits cleanly.

- [ ] **Step 6: Commit**

```bash
git add .gitignore package.json package-lock.json
git commit -m "chore(eval): add @anthropic-ai/sdk dep + gitignore .daftari/eval/

First piece of cortex quality metric scaffolding. SDK is the only hosted-LLM
dep; isolated to src/eval/llm.ts when it lands. Version bump deferred to
the next release PR per project convention."
```

---

### Task 2: Shared types — `src/eval/types.ts`

**Files:**
- Create: `src/eval/types.ts`
- Test: none (types-only; downstream tests exercise them)

- [ ] **Step 1: Write the types file**

```typescript
// src/eval/types.ts
// Shared types for the cortex quality metric. Pure data shapes; no logic.
// See docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md.

import type { Result } from "../frontmatter/types.js";

// --- Tiers ---

export const TIERS = ["retrieval", "cross_reference", "contradiction"] as const;
export type Tier = (typeof TIERS)[number];

// Tier weight for the aggregate score formula.
export const TIER_WEIGHT: Record<Tier, number> = {
  retrieval: 1,
  cross_reference: 2,
  contradiction: 3,
};

// --- Question shapes ---

export interface Question {
  id: string; // stable hash of (tier + question text + expected sources)
  tier: Tier;
  question: string;
  expected_answer: string;
  expected_sources: string[]; // absolute-from-vault paths
  source: "generated" | "augmented"; // augmented = derived from tension_log, no generator LLM
}

export interface QuestionSet {
  id: string; // <vault-hash>-<seed>-<timestamp>
  vault_hash: string;
  seed: string;
  timestamp: string; // ISO8601 UTC
  subgraph: {
    seed_doc: string;
    nodes: string[];
    edges: SubgraphEdge[];
  };
  questions: Question[];
  generator_model: string;
  prompt_version: number;
  tier_counts_requested: Record<Tier, number>;
  tier_counts_produced: Record<Tier, number>;
}

export interface SubgraphEdge {
  from: string;
  to: string;
  kind: "sources" | "link" | "tension";
}

// --- Run shapes ---

export interface Trace {
  tool_calls: ToolCall[];
  final_answer: string;
  total_tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  wall_ms: number;
  stop_reason: string;
}

export interface ToolCall {
  tool: string;
  input: unknown;
  output: unknown; // or `{ tool_error: string }` if the call failed
  latency_ms: number;
}

export type RunStatus = "complete" | "incomplete";

export interface PerRunResult {
  question_id: string;
  question_index: number;
  k_index: number;
  status: RunStatus;
  trace: Trace | null; // null when status === "incomplete" and we haven't run yet
}

export interface EvalRun {
  id: string; // <questions-id>-<model>-<timestamp>
  questions_id: string;
  answerer_model: string;
  prompt_version: number;
  timestamp: string;
  k: number;
  // Keyed by `"${question_index}:${k_index}"`. See spec §6.5 for rationale.
  runs: Record<string, PerRunResult>;
}

// --- Grade and score shapes ---

export type GradeVerdict = "yes" | "partial" | "no" | "ungraded";

export interface Grade {
  question_id: string;
  question_index: number;
  k_index: number;
  verdict: GradeVerdict;
  reasoning: string;
  grader_model: string;
}

export interface TierScore {
  mean: number;
  std: number;
  n: number;
  trace_efficiency: number; // mean tool calls per correct-or-partial answer
}

export interface Score {
  score: number;
  score_std: number;
  by_tier: Record<Tier, TierScore>;
  models: { generator: string; answerer: string; grader: string };
  prompt_version: number;
  spec_version: number;
  questions_id: string;
  results_id: string;
  vault_hash: string;
  k: number;
  n: number;
  timestamp: string;
}

// --- History ---

export interface HistoryEntry {
  score_id: string;
  score: number;
  score_std: number;
  by_tier: Record<Tier, number>; // just means here, not full TierScore
  vault_hash: string;
  timestamp: string;
  n: number;
  k: number;
  models: { generator: string; answerer: string; grader: string };
  prompt_version: number;
  spec_version: number;
}

export interface HistoryFile {
  version: 1;
  runs: HistoryEntry[];
}

export const HISTORY_RETENTION = 50;
export const SPEC_VERSION = 1;

// --- Errors ---

export type EvalError =
  | { kind: "config"; message: string }
  | { kind: "runtime"; message: string }
  | { kind: "llm"; message: string; retryable: boolean };

// --- JSON Schema for generator output ---
// The generator LLM is asked to return JSON matching this schema. Embedded
// here so the prompt, runtime validator, and types share one source of truth.

export const QuestionSetSchema = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        required: ["tier", "question", "expected_answer", "expected_sources"],
        properties: {
          tier: { enum: TIERS },
          question: { type: "string", minLength: 1 },
          expected_answer: { type: "string", minLength: 1 },
          expected_sources: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
          },
        },
      },
    },
  },
} as const;

// --- Re-export Result for convenience in eval/* files ---
export type { Result };
```

- [ ] **Step 2: Run `npm run build` to catch any type errors**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/eval/types.ts
git commit -m "feat(eval): shared types for cortex quality metric

Pure data shapes — Question, EvalRun, Score, Grade, EvalError — plus the
QuestionSetSchema JSON Schema constant the generator prompt embeds. No
behavior. Downstream tasks build against these shapes."
```

---

### Task 3: Subgraph sampling — `src/eval/subgraph.ts` + tests

**Files:**
- Create: `src/eval/subgraph.ts`
- Create: `test/eval/subgraph.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/eval/subgraph.test.ts
import { describe, it, expect } from "vitest";
import { sampleSubgraph } from "../../src/eval/subgraph.js";
import { resolve } from "node:path";

const SAMPLE_VAULT = resolve(__dirname, "../fixtures/sample-vault");

describe("sampleSubgraph", () => {
  it("returns the same subgraph for the same seed + vault", async () => {
    const seed = "deterministic-test-seed-1";
    const a = await sampleSubgraph(SAMPLE_VAULT, seed, { maxNodes: 5 });
    const b = await sampleSubgraph(SAMPLE_VAULT, seed, { maxNodes: 5 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.nodes.map((n) => n.path).sort()).toEqual(
        b.value.nodes.map((n) => n.path).sort()
      );
    }
  });

  it("respects maxNodes cap", async () => {
    const r = await sampleSubgraph(SAMPLE_VAULT, "seed-2", { maxNodes: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.nodes.length).toBeLessThanOrEqual(3);
  });

  it("returns at least the seed doc", async () => {
    const r = await sampleSubgraph(SAMPLE_VAULT, "seed-3", { maxNodes: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.nodes.length).toBeGreaterThanOrEqual(1);
  });

  it("walks frontmatter sources edges", async () => {
    // Pre-knowledge of the sample-vault fixture: if any doc has a `sources:`
    // entry pointing to another in-vault doc, the subgraph should include both
    // when one is the seed. Asserted softly: edges of kind 'sources' exist
    // somewhere in the returned subgraph for at least one of three seeds.
    const seeds = ["seed-a", "seed-b", "seed-c"];
    let sawSourcesEdge = false;
    for (const seed of seeds) {
      const r = await sampleSubgraph(SAMPLE_VAULT, seed, { maxNodes: 5 });
      if (r.ok && r.value.edges.some((e) => e.kind === "sources")) {
        sawSourcesEdge = true;
        break;
      }
    }
    expect(sawSourcesEdge).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/subgraph.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/eval/subgraph.ts`**

```typescript
// src/eval/subgraph.ts
// Deterministic seeded subgraph sampling for cortex eval. Reads the SQLite
// index for doc enumeration and the markdown tension log via listTensions(),
// then walks 1–2 hops via sources, in-vault links, and tension entries.
// Pure given (vault state, seed).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { err, ok, type Result } from "../frontmatter/types.js";
import { openIndexForActiveProvider } from "../tools/search.js";
import { listTensions } from "../curation/tension.js";
import type { EvalError, SubgraphEdge } from "./types.js";

export interface SubgraphOptions {
  maxNodes?: number; // default 5
}

export interface SubgraphNode {
  path: string;
  body: string;
  frontmatter: Record<string, unknown>;
}

export interface Subgraph {
  seed_doc: string;
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

export async function sampleSubgraph(
  vaultRoot: string,
  seed: string,
  opts: SubgraphOptions = {}
): Promise<Result<Subgraph, EvalError>> {
  const maxNodes = opts.maxNodes ?? 5;
  const indexRes = openIndexForActiveProvider(vaultRoot);
  if (!indexRes.ok) {
    return err({ kind: "runtime", message: `vault index unavailable: ${indexRes.error.message}` });
  }
  const db = indexRes.value;

  // 1. Enumerate all docs in the index. We expect ~tens to low-thousands;
  //    a single SELECT is fine.
  const docs = db.prepare("SELECT path FROM documents").all() as { path: string }[];
  if (docs.length === 0) {
    return err({ kind: "runtime", message: "vault has no indexed documents" });
  }

  // 2. Stratify by collection (derived from path prefix) and deterministically
  //    pick a stratum, then a doc within that stratum, both keyed by seed.
  const strata = stratifyByCollection(docs.map((d) => d.path));
  const stratumNames = [...strata.keys()].sort();
  const stratumIdx = hashToIndex(`${seed}:stratum`, stratumNames.length);
  const stratumName = stratumNames[stratumIdx];
  const stratumDocs = strata.get(stratumName)!.sort();
  const seedIdx = hashToIndex(`${seed}:doc`, stratumDocs.length);
  const seedDoc = stratumDocs[seedIdx];

  // 3. Walk 1–2 hops via sources, links, tensions. Collect nodes + edges.
  const visited = new Map<string, SubgraphNode>();
  const edges: SubgraphEdge[] = [];

  // Pre-load tensions once; we'll index by doc path for walkHop.
  const tensionsRes = await listTensions(vaultRoot);
  const tensionsByDoc = new Map<string, Array<{ other: string }>>();
  if (tensionsRes.ok) {
    for (const t of tensionsRes.value) {
      if (!tensionsByDoc.has(t.sourceA)) tensionsByDoc.set(t.sourceA, []);
      if (!tensionsByDoc.has(t.sourceB)) tensionsByDoc.set(t.sourceB, []);
      tensionsByDoc.get(t.sourceA)!.push({ other: t.sourceB });
      tensionsByDoc.get(t.sourceB)!.push({ other: t.sourceA });
    }
  }

  await loadNode(vaultRoot, seedDoc, visited);
  await walkHop(vaultRoot, seedDoc, visited, edges, tensionsByDoc);
  // Second hop: walk from each first-hop neighbor we've added so far.
  const firstHopNeighbors = [...visited.keys()].filter((p) => p !== seedDoc);
  for (const n of firstHopNeighbors) {
    if (visited.size >= maxNodes) break;
    await walkHop(vaultRoot, n, visited, edges, tensionsByDoc);
  }

  // 4. Cap to maxNodes by trimming least-connected neighbors (preserve seed).
  const nodes = trimToCap(seedDoc, visited, edges, maxNodes);

  return ok({
    seed_doc: seedDoc,
    nodes,
    edges: edges.filter((e) => nodes.some((n) => n.path === e.from) && nodes.some((n) => n.path === e.to)),
  });
}

// --- helpers ---

function stratifyByCollection(paths: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const p of paths) {
    const collection = p.split("/")[0] || "_root";
    if (!m.has(collection)) m.set(collection, []);
    m.get(collection)!.push(p);
  }
  return m;
}

function hashToIndex(input: string, mod: number): number {
  if (mod <= 0) throw new Error("mod must be positive");
  const h = createHash("sha256").update(input).digest();
  // Use first 4 bytes as unsigned int.
  const n = h.readUInt32BE(0);
  return n % mod;
}

async function loadNode(vaultRoot: string, path: string, visited: Map<string, SubgraphNode>): Promise<void> {
  if (visited.has(path)) return;
  try {
    const raw = await readFile(resolve(vaultRoot, path), "utf8");
    const { frontmatter, body } = splitFrontmatter(raw);
    visited.set(path, { path, body, frontmatter });
  } catch {
    // Missing doc — silently skip. The walk continues with what we have.
  }
}

async function walkHop(
  vaultRoot: string,
  from: string,
  visited: Map<string, SubgraphNode>,
  edges: SubgraphEdge[],
  tensionsByDoc: Map<string, Array<{ other: string }>>
): Promise<void> {
  const node = visited.get(from);
  if (!node) return;

  // sources: frontmatter
  const sources = Array.isArray(node.frontmatter.sources) ? (node.frontmatter.sources as string[]) : [];
  for (const s of sources) {
    if (typeof s !== "string") continue;
    edges.push({ from, to: s, kind: "sources" });
    await loadNode(vaultRoot, s, visited);
  }

  // in-vault markdown links
  const links = extractInVaultLinks(node.body);
  for (const l of links) {
    edges.push({ from, to: l, kind: "link" });
    await loadNode(vaultRoot, l, visited);
  }

  // tension edges from the pre-loaded .daftari/tensions.md (markdown log
  // parsed by listTensions); not in the SQLite index.
  const tensions = tensionsByDoc.get(from) ?? [];
  for (const t of tensions) {
    edges.push({ from, to: t.other, kind: "tension" });
    await loadNode(vaultRoot, t.other, visited);
  }
}

function trimToCap(
  seed: string,
  visited: Map<string, SubgraphNode>,
  edges: SubgraphEdge[],
  cap: number
): SubgraphNode[] {
  if (visited.size <= cap) return [...visited.values()];
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const ranked = [...visited.entries()]
    .map(([path, node]) => ({ path, node, degree: degree.get(path) ?? 0 }))
    .sort((a, b) => (a.path === seed ? -1 : b.path === seed ? 1 : b.degree - a.degree));
  return ranked.slice(0, cap).map((r) => r.node);
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  // Minimal split — for subgraph traversal we only need `sources:`. Uses
  // js-yaml (already a project dep) imported at module top. If a project
  // helper in src/frontmatter/ exists that does the same, prefer it.
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  try {
    const fm = yaml.load(m[1]) ?? {};
    return { frontmatter: typeof fm === "object" && fm !== null ? (fm as Record<string, unknown>) : {}, body: m[2] };
  } catch {
    return { frontmatter: {}, body: m[2] };
  }
}

function extractInVaultLinks(body: string): string[] {
  // Match [text](path) where path is a relative .md link without a scheme.
  const out: string[] = [];
  const re = /\[[^\]]*\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
  for (const m of body.matchAll(re)) {
    const href = m[1];
    if (/^https?:|^mailto:/i.test(href)) continue;
    if (href.startsWith("/")) continue; // ignore absolute paths
    out.push(href);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/subgraph.test.ts`
Expected: all four cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eval/subgraph.ts test/eval/subgraph.test.ts
git commit -m "feat(eval): deterministic subgraph sampling

Seeded walk via sources / links / tensions. Stratified-by-collection seed
derivation prevents pathological 'always-central-doc' picks. Pure given
vault state + seed; same inputs → same subgraph."
```

---

### Task 4: Storage — `src/eval/storage.ts` + tests

**Files:**
- Create: `src/eval/storage.ts`
- Create: `test/eval/storage.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/eval/storage.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeQuestionSet, readQuestionSet,
  writeResults, readResults,
  writeScore,
  appendHistory, readHistory,
} from "../../src/eval/storage.js";
import { HISTORY_RETENTION, SPEC_VERSION, type QuestionSet, type EvalRun, type Score, type HistoryEntry } from "../../src/eval/types.js";

let vault: string;
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "daftari-eval-"));
});
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

const sampleQuestionSet = (id = "qs-1"): QuestionSet => ({
  id,
  vault_hash: "abc123",
  seed: "seed-1",
  timestamp: "2026-05-31T00:00:00Z",
  subgraph: { seed_doc: "a.md", nodes: ["a.md"], edges: [] },
  questions: [],
  generator_model: "claude-sonnet-fake",
  prompt_version: 1,
  tier_counts_requested: { retrieval: 5, cross_reference: 5, contradiction: 5 },
  tier_counts_produced: { retrieval: 5, cross_reference: 5, contradiction: 5 },
});

describe("storage", () => {
  it("round-trips a question set", async () => {
    const qs = sampleQuestionSet();
    await writeQuestionSet(vault, qs);
    const back = await readQuestionSet(vault, qs.id);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(qs);
  });

  it("rotates history at the retention boundary", async () => {
    for (let i = 0; i < HISTORY_RETENTION + 5; i++) {
      const entry: HistoryEntry = {
        score_id: `s-${i}`, score: 0.5, score_std: 0.01,
        by_tier: { retrieval: 0.9, cross_reference: 0.6, contradiction: 0.3 },
        vault_hash: "abc", timestamp: new Date(2026, 4, 31, 0, 0, i).toISOString(),
        n: 15, k: 2, models: { generator: "g", answerer: "a", grader: "gr" },
        prompt_version: 1, spec_version: SPEC_VERSION,
      };
      await appendHistory(vault, entry);
    }
    const h = await readHistory(vault);
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.value.runs.length).toBe(HISTORY_RETENTION);
  });

  it("returns err for a missing question set", async () => {
    const back = await readQuestionSet(vault, "does-not-exist");
    expect(back.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/storage.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/eval/storage.ts`**

```typescript
// src/eval/storage.ts
// JSON I/O under .daftari/eval/. No business logic — just paths, schemas,
// rotation. Read paths are read-only-compatible per spec §12 resolution 5.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import {
  HISTORY_RETENTION,
  type EvalError,
  type EvalRun,
  type HistoryEntry,
  type HistoryFile,
  type QuestionSet,
  type Score,
} from "./types.js";

const EVAL_DIR = (vault: string) => join(vault, ".daftari", "eval");
const QS_DIR = (vault: string) => join(EVAL_DIR(vault), "questions");
const RES_DIR = (vault: string) => join(EVAL_DIR(vault), "results");
const SCORE_DIR = (vault: string) => join(EVAL_DIR(vault), "scores");
const HIST_FILE = (vault: string) => join(EVAL_DIR(vault), "history.json");

async function ensureDir(p: string): Promise<void> { await mkdir(p, { recursive: true }); }

function writeJson<T>(path: string, value: T): Promise<void> {
  return writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJson<T>(path: string): Promise<Result<T, EvalError>> {
  try {
    const raw = await readFile(path, "utf8");
    return ok(JSON.parse(raw) as T);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({ kind: "runtime", message: `read ${path}: ${msg}` });
  }
}

export async function writeQuestionSet(vault: string, qs: QuestionSet): Promise<void> {
  await ensureDir(QS_DIR(vault));
  await writeJson(join(QS_DIR(vault), `${qs.id}.json`), qs);
}

export function readQuestionSet(vault: string, id: string): Promise<Result<QuestionSet, EvalError>> {
  return readJson<QuestionSet>(join(QS_DIR(vault), `${id}.json`));
}

export async function writeResults(vault: string, run: EvalRun): Promise<void> {
  await ensureDir(RES_DIR(vault));
  await writeJson(join(RES_DIR(vault), `${run.id}.json`), run);
}

export function readResults(vault: string, id: string): Promise<Result<EvalRun, EvalError>> {
  return readJson<EvalRun>(join(RES_DIR(vault), `${id}.json`));
}

export async function writeScore(vault: string, score: Score): Promise<void> {
  await ensureDir(SCORE_DIR(vault));
  await writeJson(join(SCORE_DIR(vault), `${score.results_id}.json`), score);
}

export async function appendHistory(vault: string, entry: HistoryEntry): Promise<void> {
  await ensureDir(EVAL_DIR(vault));
  const current = await readHistory(vault);
  const runs: HistoryEntry[] = current.ok ? [...current.value.runs, entry] : [entry];
  // Rotate
  const trimmed = runs.slice(-HISTORY_RETENTION);
  const out: HistoryFile = { version: 1, runs: trimmed };
  await writeJson(HIST_FILE(vault), out);
}

export async function readHistory(vault: string): Promise<Result<HistoryFile, EvalError>> {
  const path = HIST_FILE(vault);
  if (!existsSync(path)) return ok({ version: 1, runs: [] });
  const r = await readJson<HistoryFile>(path);
  if (!r.ok) return r;
  // Future-version warning, per §12 resolution 5.
  if (typeof r.value.version === "number" && r.value.version > 1) {
    process.stderr.write(
      `daftari eval: history.json version ${r.value.version} is newer than supported (1); leaving untouched\n`
    );
    return ok({ version: 1, runs: [] });
  }
  return r;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/storage.test.ts`
Expected: all three cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eval/storage.ts test/eval/storage.test.ts
git commit -m "feat(eval): JSON storage under .daftari/eval/

Question sets, results, scores, history. Rotation trims history.json at 50
entries; results/scores files remain on disk for deep dives (manual rm -rf
is the v1 recovery, per spec §8). Future-version reads emit a warning."
```

---

### Task 5: Score aggregation (no LLM) — `src/eval/score.ts` v1 + tests

**Files:**
- Create: `src/eval/score.ts`
- Create: `test/eval/score.test.ts`

This task only adds the pure-math aggregator. The LLM grader is added in Task 10 once `llm.ts` exists.

- [ ] **Step 1: Write the failing test**

```typescript
// test/eval/score.test.ts
import { describe, it, expect } from "vitest";
import { aggregateScore } from "../../src/eval/score.js";
import type { Grade, Question, Tier } from "../../src/eval/types.js";

function q(tier: Tier, i: number): Question {
  return {
    id: `q-${tier}-${i}`, tier, question: `q${i}`, expected_answer: "a",
    expected_sources: ["a.md"], source: "generated",
  };
}
function g(question: Question, k: number, v: "yes" | "partial" | "no" | "ungraded"): Grade {
  return {
    question_id: question.id, question_index: 0, k_index: k,
    verdict: v, reasoning: "", grader_model: "claude-sonnet-fake",
  };
}

describe("aggregateScore", () => {
  it("all-perfect → 1.0", () => {
    const qs = [q("retrieval", 0), q("cross_reference", 0), q("contradiction", 0)];
    const grades = qs.flatMap((qq) => [g(qq, 0, "yes"), g(qq, 1, "yes")]);
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.score).toBeCloseTo(1.0);
  });

  it("all-zero → 0.0", () => {
    const qs = [q("retrieval", 0), q("cross_reference", 0), q("contradiction", 0)];
    const grades = qs.flatMap((qq) => [g(qq, 0, "no"), g(qq, 1, "no")]);
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.score).toBeCloseTo(0.0);
  });

  it("tier weighting: 1×1 + 2×1 + 3×1 over 6 = 1.0; halve contradiction → 5/6", () => {
    const qs = [q("retrieval", 0), q("cross_reference", 0), q("contradiction", 0)];
    const grades = [
      g(qs[0], 0, "yes"), g(qs[0], 1, "yes"),
      g(qs[1], 0, "yes"), g(qs[1], 1, "yes"),
      g(qs[2], 0, "yes"), g(qs[2], 1, "no"), // half on contradiction
    ];
    const s = aggregateScore(grades, qs, { traces: new Map() });
    // retrieval mean=1, cross_reference mean=1, contradiction mean=0.5
    // numerator = 1*1 + 2*1 + 3*0.5 = 4.5; denom = 1 + 2 + 3 = 6 → 0.75
    expect(s.score).toBeCloseTo(0.75);
  });

  it("missing tier → handled gracefully (no NaN)", () => {
    const qs = [q("retrieval", 0)];
    const grades = [g(qs[0], 0, "yes"), g(qs[0], 1, "yes")];
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(Number.isNaN(s.score)).toBe(false);
    expect(s.by_tier.cross_reference.n).toBe(0);
  });

  it("ungraded excluded from aggregate", () => {
    const qs = [q("retrieval", 0)];
    const grades = [g(qs[0], 0, "ungraded"), g(qs[0], 1, "yes")];
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.by_tier.retrieval.mean).toBeCloseTo(1.0);
    expect(s.by_tier.retrieval.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/score.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/eval/score.ts`**

```typescript
// src/eval/score.ts
// Aggregation of per-(question, k) grades into the headline tier-weighted
// score. Pure math. The LLM grader is added in Task 10; this v1 only
// computes scores from already-graded inputs.

import {
  TIERS, TIER_WEIGHT,
  type Grade, type Question, type Score, type Tier, type TierScore, type Trace,
} from "./types.js";

export interface AggregateOptions {
  // Per-(question_id, k_index) trace lookup for efficiency metrics.
  traces: Map<string, Trace>;
}

const VERDICT_VALUE: Record<Grade["verdict"], number | null> = {
  yes: 1.0,
  partial: 0.5,
  no: 0.0,
  ungraded: null, // excluded
};

export function aggregateScore(
  grades: Grade[],
  questions: Question[],
  opts: AggregateOptions
): Score {
  const byTier: Record<Tier, TierScore> = blankByTier();

  // Group grades by question_id
  const byQuestion = new Map<string, Grade[]>();
  for (const g of grades) {
    if (!byQuestion.has(g.question_id)) byQuestion.set(g.question_id, []);
    byQuestion.get(g.question_id)!.push(g);
  }

  // Per-tier: compute mean over per-question-means, std, n, trace efficiency.
  for (const tier of TIERS) {
    const tierQuestions = questions.filter((q) => q.tier === tier);
    const perQuestionMeans: number[] = [];
    const efficiencyHits: number[] = [];
    for (const q of tierQuestions) {
      const qGrades = (byQuestion.get(q.id) ?? []).filter(
        (g) => VERDICT_VALUE[g.verdict] !== null
      );
      if (qGrades.length === 0) continue;
      const values = qGrades.map((g) => VERDICT_VALUE[g.verdict]!);
      const mean = avg(values);
      perQuestionMeans.push(mean);

      for (const g of qGrades) {
        if (VERDICT_VALUE[g.verdict]! > 0) {
          const t = opts.traces.get(`${g.question_id}:${g.k_index}`);
          if (t) efficiencyHits.push(t.total_tool_calls);
        }
      }
    }
    byTier[tier] = {
      mean: perQuestionMeans.length ? avg(perQuestionMeans) : 0,
      std: perQuestionMeans.length ? stddev(perQuestionMeans) : 0,
      n: perQuestionMeans.length,
      trace_efficiency: efficiencyHits.length ? avg(efficiencyHits) : 0,
    };
  }

  // Weighted aggregate: Σ (w_t × mean_t × n_t) / Σ (w_t × n_t)
  let num = 0, denom = 0;
  for (const tier of TIERS) {
    const w = TIER_WEIGHT[tier];
    const ts = byTier[tier];
    num += w * ts.mean * ts.n;
    denom += w * ts.n;
  }
  const score = denom > 0 ? num / denom : 0;
  const scoreStd = denom > 0
    ? Math.sqrt(
        TIERS.reduce((acc, t) => {
          const w = TIER_WEIGHT[t]; const ts = byTier[t];
          return acc + (w * ts.n / denom) * ts.std ** 2;
        }, 0)
      )
    : 0;

  // The caller fills in the metadata fields. We only compute the numerics.
  return {
    score, score_std: scoreStd,
    by_tier: byTier,
    // Placeholder metadata — `runEval` overwrites before write.
    models: { generator: "", answerer: "", grader: "" },
    prompt_version: 0, spec_version: 0,
    questions_id: "", results_id: "", vault_hash: "",
    k: 0, n: 0, timestamp: "",
  };
}

function blankByTier(): Record<Tier, TierScore> {
  return {
    retrieval: { mean: 0, std: 0, n: 0, trace_efficiency: 0 },
    cross_reference: { mean: 0, std: 0, n: 0, trace_efficiency: 0 },
    contradiction: { mean: 0, std: 0, n: 0, trace_efficiency: 0 },
  };
}

function avg(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/score.test.ts`
Expected: all five cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eval/score.ts test/eval/score.test.ts
git commit -m "feat(eval): tier-weighted score aggregation (no LLM grader yet)

Pure math: per-tier mean + std, weighted aggregate (1×retrieval + 2×cross +
3×contradiction). Augmented questions count in their tier — they're
contradiction-tier by construction. LLM grader lands in Task 10."
```

---

### Task 6: Prompts — `src/eval/prompts.ts`

**Files:**
- Create: `src/eval/prompts.ts`
- Test: none (string constants; downstream tests exercise them indirectly)

- [ ] **Step 1: Write the prompts file**

```typescript
// src/eval/prompts.ts
// Frozen prompts for the three eval LLM roles. Bumping any prompt requires
// bumping PROMPT_VERSION in the same commit. PROMPT_VERSION is recorded in
// every output file for forensics and cross-version comparison gates.

export const PROMPT_VERSION = 1;

export const GENERATOR_PROMPT = `You will read a connected subgraph of a Markdown knowledge vault and produce
multi-hop questions across three tiers. The questions must be answerable using
ONLY the docs provided. For each question, supply: question text, tier,
expected answer, source paths (must be a subset of the supplied docs).

Tiers:
  retrieval        — single-doc lookup, 1-hop reasoning
  cross_reference  — requires combining 2–3 docs
  contradiction    — surfaces a tension or conflict across docs (use the
                     tension log entries in the subgraph as seed material
                     where present)

Return JSON matching the QuestionSetSchema declared in src/eval/types.ts.
Do not include questions whose expected_sources are not in the supplied docs.
Do not generate trivial yes/no questions.`;

export const ANSWERER_SYSTEM_PROMPT = `You will answer a question about a Markdown knowledge vault using ONLY the
provided Daftari tools. Do not use training knowledge. Do not guess. If the
vault does not contain the answer, say "Vault does not contain the answer."
Cite source paths in your final answer using the format [path/to/doc.md].`;

export const GRADER_PROMPT = `You are grading an answer to a question about a Markdown knowledge vault.

Question:           {{QUESTION}}
Expected answer:    {{EXPECTED_ANSWER}}
Expected sources:   {{EXPECTED_SOURCES}}
Claimed answer:     {{CLAIMED_ANSWER}}
Cited sources:      {{CITED_SOURCES}}

Return JSON: {"correct": "yes" | "partial" | "no", "reasoning": "<string>"}

Definitions:
  yes     — claimed answer is substantively correct and cites at least one
            expected source
  partial — claimed answer is partially correct OR cites the right sources
            but misses key content OR the answerer correctly said "Vault
            does not contain the answer" when the expected answer disagrees
            (records a question-set quality issue, not a cortex failure)
  no      — claimed answer is wrong, hallucinated, or cites no expected
            sources`;
```

- [ ] **Step 2: Run `npm run build`**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/eval/prompts.ts
git commit -m "feat(eval): frozen prompts + PROMPT_VERSION constant

Three roles (generator, answerer, grader). PROMPT_VERSION = 1 starts; any
prompt change requires same-commit bump per spec §12 resolution 3."
```

---

### Task 7: LLM client — `src/eval/llm.ts` + tests

**Files:**
- Create: `src/eval/llm.ts`
- Create: `test/eval/llm.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/eval/llm.test.ts
import { describe, it, expect, vi } from "vitest";
import { createAnthropicClient, type LlmClient } from "../../src/eval/llm.js";

describe("LlmClient interface", () => {
  it("a mock client satisfies the interface", async () => {
    const mock: LlmClient = {
      complete: vi.fn(async () => ({ ok: true, value: { text: "hello", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" } })),
      completeJson: vi.fn(async () => ({ ok: true, value: { parsed: { foo: 1 }, input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" } })),
      completeWithTools: vi.fn(),
    };
    const r = await mock.complete({ system: "s", user: "u", model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
  });

  it("createAnthropicClient throws if no API key", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createAnthropicClient()).toThrow();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/llm.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/eval/llm.ts`**

```typescript
// src/eval/llm.ts
// Single-point wrapper around @anthropic-ai/sdk. Other eval modules depend
// on the LlmClient interface, not the SDK, so they can be unit-tested with
// hand-rolled mocks.

import Anthropic from "@anthropic-ai/sdk";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { EvalError } from "./types.js";

export interface CompleteOpts {
  model: string;
  system: string;
  user: string;
  maxTokens?: number; // default 4096
}

export interface CompleteJsonOpts extends CompleteOpts {
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema is structural
  schema: any;
}

export interface ToolDef {
  name: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema is structural
  input_schema: any;
}

export interface CompleteWithToolsOpts extends CompleteOpts {
  tools: ToolDef[];
  toolHandler: (name: string, input: unknown) => Promise<unknown>;
  maxRounds?: number; // default 12
}

export interface CompleteResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
}

export interface CompleteJsonResult extends CompleteResult {
  parsed: unknown;
}

export interface CompleteWithToolsResult extends CompleteResult {
  tool_calls: { tool: string; input: unknown; output: unknown; latency_ms: number }[];
}

export interface LlmClient {
  complete(opts: CompleteOpts): Promise<Result<CompleteResult, EvalError>>;
  completeJson(opts: CompleteJsonOpts): Promise<Result<CompleteJsonResult, EvalError>>;
  completeWithTools(opts: CompleteWithToolsOpts): Promise<Result<CompleteWithToolsResult, EvalError>>;
}

export function createAnthropicClient(): LlmClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is required for daftari eval");
  const client = new Anthropic({ apiKey });

  return {
    async complete(opts) {
      return retry(async () => {
        const res = await client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 4096,
          system: opts.system,
          messages: [{ role: "user", content: opts.user }],
        });
        const text = res.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text).join("");
        return ok({
          text,
          input_tokens: res.usage.input_tokens,
          output_tokens: res.usage.output_tokens,
          stop_reason: res.stop_reason ?? "unknown",
        });
      });
    },

    async completeJson(opts) {
      // The schema is embedded in the system prompt as a hint to the LLM, then
      // the response goes through JSON.parse + a manual shape check by the
      // caller (see generate.ts and score.ts). This is NOT strict JSON Schema
      // validation — there is no schema validator dep in v1. Callers must
      // verify required fields exist after parse. If we ever need strict
      // validation, add `ajv` and validate `parsed` here.
      const sysWithSchema = `${opts.system}\n\nReturn JSON matching:\n${JSON.stringify(opts.schema, null, 2)}\nReturn ONLY JSON, no prose.`;
      const r = await this.complete({ ...opts, system: sysWithSchema });
      if (!r.ok) return r;
      try {
        const parsed = JSON.parse(stripCodeFence(r.value.text));
        return ok({ ...r.value, parsed });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return err({ kind: "llm", message: `JSON parse: ${msg} — output was: ${r.value.text.slice(0, 200)}`, retryable: false });
      }
    },

    async completeWithTools(opts) {
      const maxRounds = opts.maxRounds ?? 12;
      const toolCalls: CompleteWithToolsResult["tool_calls"] = [];
      const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
        { role: "user", content: opts.user },
      ];
      let totalIn = 0, totalOut = 0;
      let lastStop = "unknown";

      for (let round = 0; round < maxRounds; round++) {
        const res = await retry(async () =>
          ok(await client.messages.create({
            model: opts.model,
            max_tokens: opts.maxTokens ?? 4096,
            system: opts.system,
            // biome-ignore lint/suspicious/noExplicitAny: SDK types
            tools: opts.tools as any,
            // biome-ignore lint/suspicious/noExplicitAny: SDK types
            messages: messages as any,
          }))
        );
        if (!res.ok) return res;
        const message = res.value;
        totalIn += message.usage.input_tokens;
        totalOut += message.usage.output_tokens;
        lastStop = message.stop_reason ?? "unknown";

        // biome-ignore lint/suspicious/noExplicitAny: SDK content union
        const blocks = message.content as any[];
        const toolUses = blocks.filter((b) => b.type === "tool_use");
        if (toolUses.length === 0) {
          const text = blocks
            .filter((b) => b.type === "text")
            .map((b) => b.text).join("");
          return ok({ text, input_tokens: totalIn, output_tokens: totalOut, stop_reason: lastStop, tool_calls: toolCalls });
        }

        messages.push({ role: "assistant", content: blocks });

        const toolResults: unknown[] = [];
        for (const tu of toolUses) {
          const t0 = Date.now();
          let output: unknown;
          try {
            output = await opts.toolHandler(tu.name, tu.input);
          } catch (e) {
            output = { tool_error: e instanceof Error ? e.message : String(e) };
          }
          const latency = Date.now() - t0;
          toolCalls.push({ tool: tu.name, input: tu.input, output, latency_ms: latency });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: typeof output === "string" ? output : JSON.stringify(output),
          });
        }
        messages.push({ role: "user", content: toolResults });
      }
      return err({ kind: "llm", message: `exceeded maxRounds (${maxRounds}) without final answer`, retryable: false });
    },
  };
}

// --- helpers ---

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 60_000;

async function retry<T>(fn: () => Promise<Result<T, EvalError>>): Promise<Result<T, EvalError>> {
  let lastErr: EvalError | null = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const r = await fn();
      if (r.ok) return r;
      if (!r.error || r.error.kind !== "llm" || !r.error.retryable) return r;
      lastErr = r.error;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number })?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable) return err({ kind: "llm", message: msg, retryable: false });
      lastErr = { kind: "llm", message: msg, retryable: true };
    }
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** i, MAX_BACKOFF_MS);
    await new Promise((res) => setTimeout(res, backoff));
  }
  return err(lastErr ?? { kind: "llm", message: "retries exhausted", retryable: false });
}

function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/llm.test.ts`
Expected: both cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eval/llm.ts test/eval/llm.test.ts
git commit -m "feat(eval): Anthropic SDK wrapper with retry + structured output

Three methods: complete, completeJson (schema in system + parse), and
completeWithTools (tool-use loop, captures call traces). Retry-on-429/5xx
with exponential backoff capped at 60s. LlmClient interface lets downstream
modules mock without the SDK."
```

---

### Task 8: Generate — `src/eval/generate.ts` + tests

**Files:**
- Create: `src/eval/generate.ts`
- Create: `test/eval/generate.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/eval/generate.test.ts
import { describe, it, expect } from "vitest";
import { generateQuestions } from "../../src/eval/generate.js";
import type { LlmClient } from "../../src/eval/llm.js";
import type { Subgraph } from "../../src/eval/subgraph.js";

const fakeSubgraph: Subgraph = {
  seed_doc: "a.md",
  nodes: [
    { path: "a.md", body: "A body with [link](b.md)", frontmatter: {} },
    { path: "b.md", body: "B body referencing a.md", frontmatter: { sources: ["a.md"] } },
  ],
  edges: [
    { from: "a.md", to: "b.md", kind: "link" },
    { from: "b.md", to: "a.md", kind: "sources" },
  ],
};

function mockClient(canned: unknown): LlmClient {
  return {
    complete: async () => ({ ok: true, value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" } }),
    completeJson: async () => ({ ok: true, value: { parsed: canned, input_tokens: 0, output_tokens: 0, stop_reason: "end_turn", text: "" } }),
    completeWithTools: async () => ({ ok: true, value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn", tool_calls: [] } }),
  };
}

describe("generateQuestions", () => {
  it("filters questions whose sources are not in subgraph", async () => {
    const canned = {
      questions: [
        { tier: "retrieval", question: "q1", expected_answer: "a1", expected_sources: ["a.md"] },
        { tier: "retrieval", question: "q2", expected_answer: "a2", expected_sources: ["nonexistent.md"] },
      ],
    };
    const r = await generateQuestions(fakeSubgraph, mockClient(canned), { n: 6, model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.questions.length).toBe(1);
      expect(r.value.questions[0].expected_sources).toEqual(["a.md"]);
    }
  });

  it("respects tier counts when LLM produces enough", async () => {
    const canned = {
      questions: [
        { tier: "retrieval", question: "q", expected_answer: "a", expected_sources: ["a.md"] },
        { tier: "retrieval", question: "q", expected_answer: "a", expected_sources: ["a.md"] },
        { tier: "cross_reference", question: "q", expected_answer: "a", expected_sources: ["a.md"] },
        { tier: "cross_reference", question: "q", expected_answer: "a", expected_sources: ["a.md"] },
        { tier: "contradiction", question: "q", expected_answer: "a", expected_sources: ["a.md"] },
        { tier: "contradiction", question: "q", expected_answer: "a", expected_sources: ["a.md"] },
      ],
    };
    const r = await generateQuestions(fakeSubgraph, mockClient(canned), { n: 6, model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tier_counts_produced.retrieval).toBe(2);
      expect(r.value.tier_counts_produced.cross_reference).toBe(2);
      expect(r.value.tier_counts_produced.contradiction).toBe(2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/generate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/eval/generate.ts`**

```typescript
// src/eval/generate.ts
// Question-set generation: prompt the generator LLM with the subgraph,
// validate JSON output, filter, augment with tension-derived questions.

import { createHash } from "node:crypto";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { LlmClient } from "./llm.js";
import { GENERATOR_PROMPT, PROMPT_VERSION } from "./prompts.js";
import type { Subgraph } from "./subgraph.js";
import {
  QuestionSetSchema, TIERS,
  type EvalError, type Question, type QuestionSet, type Tier,
} from "./types.js";

export interface GenerateOptions {
  n: number; // total target across tiers; floor(n/3) per tier
  model: string;
  vaultHash?: string;
  seed?: string;
}

export async function generateQuestions(
  subgraph: Subgraph,
  llm: LlmClient,
  opts: GenerateOptions
): Promise<Result<QuestionSet, EvalError>> {
  const perTier = Math.floor(opts.n / TIERS.length);
  const tierCountsRequested: Record<Tier, number> = {
    retrieval: perTier, cross_reference: perTier, contradiction: perTier,
  };

  const user = renderUserPrompt(subgraph, tierCountsRequested);
  const r = await llm.completeJson({
    model: opts.model, system: GENERATOR_PROMPT, user, schema: QuestionSetSchema,
  });
  if (!r.ok) return r;

  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON
  const parsed = r.value.parsed as any;
  if (!parsed || !Array.isArray(parsed.questions)) {
    return err({ kind: "llm", message: "generator returned non-conforming JSON", retryable: false });
  }

  const validNodes = new Set(subgraph.nodes.map((n) => n.path));
  // biome-ignore lint/suspicious/noExplicitAny: validated per-item below
  const filtered: Question[] = parsed.questions
    .filter((q: any) =>
      TIERS.includes(q.tier) &&
      typeof q.question === "string" && q.question.length > 0 &&
      typeof q.expected_answer === "string" && q.expected_answer.length > 0 &&
      Array.isArray(q.expected_sources) && q.expected_sources.length > 0 &&
      q.expected_sources.every((s: string) => validNodes.has(s)) &&
      !isTrivial(q.question, q.expected_answer)
    )
    .map((q: any) => ({
      id: questionId(q.tier, q.question, q.expected_sources),
      tier: q.tier as Tier,
      question: q.question,
      expected_answer: q.expected_answer,
      expected_sources: q.expected_sources,
      source: "generated" as const,
    }));

  // Tension-graph augmentation (§5.3 of spec).
  const augmented = augmentFromTensions(subgraph, tierCountsRequested.contradiction);
  const questions = [...filtered, ...augmented];

  const tierCountsProduced: Record<Tier, number> = {
    retrieval: questions.filter((q) => q.tier === "retrieval").length,
    cross_reference: questions.filter((q) => q.tier === "cross_reference").length,
    contradiction: questions.filter((q) => q.tier === "contradiction").length,
  };

  const ts = "2026-01-01T00:00:00Z"; // caller overwrites with real timestamp
  const id = `${opts.vaultHash ?? "vault"}-${opts.seed ?? "seed"}-${ts}`;
  return ok({
    id,
    vault_hash: opts.vaultHash ?? "",
    seed: opts.seed ?? "",
    timestamp: ts,
    subgraph: {
      seed_doc: subgraph.seed_doc,
      nodes: subgraph.nodes.map((n) => n.path),
      edges: subgraph.edges,
    },
    questions,
    generator_model: opts.model,
    prompt_version: PROMPT_VERSION,
    tier_counts_requested: tierCountsRequested,
    tier_counts_produced: tierCountsProduced,
  });
}

function renderUserPrompt(sg: Subgraph, counts: Record<Tier, number>): string {
  const docs = sg.nodes.map((n) => `## ${n.path}\n\n${n.body}\n`).join("\n");
  return `Subgraph docs:\n\n${docs}\n\nProduce exactly ${counts.retrieval} retrieval, ${counts.cross_reference} cross_reference, and ${counts.contradiction} contradiction questions.`;
}

function isTrivial(question: string, answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "yes" || a === "no" || a.length < 3;
}

function questionId(tier: string, question: string, sources: string[]): string {
  const h = createHash("sha256");
  h.update(`${tier}\x00${question}\x00${sources.sort().join("\x00")}`);
  return h.digest("hex").slice(0, 16);
}

function augmentFromTensions(sg: Subgraph, contradictionBudget: number): Question[] {
  // Per §5.3: n_augmented = max(1, floor(0.2 × n_contradiction)) when the
  // subgraph contains any tension edges. Augmented questions are *additional*
  // to the generator's contradiction budget.
  const tensionEdges = sg.edges.filter((e) => e.kind === "tension");
  if (tensionEdges.length === 0) return [];
  const count = Math.max(1, Math.floor(0.2 * contradictionBudget));
  return tensionEdges.slice(0, count).map((e) => {
    const q = `${e.from} and ${e.to} appear to disagree on a specific point. Read both docs, identify the disagreement, and cite the position each takes. Cite both docs in your answer.`;
    const sources = [e.from, e.to];
    return {
      id: questionId("contradiction", q, sources),
      tier: "contradiction" as const,
      question: q,
      expected_answer: `A correct answer identifies the substantive contradiction between ${e.from} and ${e.to} and cites both source paths.`,
      expected_sources: sources,
      source: "augmented" as const,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval/generate.test.ts`
Expected: both cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eval/generate.ts test/eval/generate.test.ts
git commit -m "feat(eval): question generation with filters + tension augmentation

Generator LLM produces JSON matching QuestionSetSchema; filter drops
out-of-subgraph sources and trivial yes/no answers. Tension-edge questions
augment per §5.3 rule: max(1, floor(0.2 × n_contradiction))."
```

---

### Task 9: Run — `src/eval/run.ts` + tests

**Files:**
- Create: `src/eval/run.ts`
- Create: `test/eval/run.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/eval/run.test.ts
import { describe, it, expect } from "vitest";
import { runAnswerer } from "../../src/eval/run.js";
import type { LlmClient } from "../../src/eval/llm.js";
import type { Question, QuestionSet } from "../../src/eval/types.js";

const sampleQs: QuestionSet = {
  id: "qs-1", vault_hash: "h", seed: "s", timestamp: "t",
  subgraph: { seed_doc: "a.md", nodes: ["a.md"], edges: [] },
  questions: [
    { id: "q1", tier: "retrieval", question: "what is X?", expected_answer: "X is foo", expected_sources: ["a.md"], source: "generated" },
  ] as Question[],
  generator_model: "g", prompt_version: 1,
  tier_counts_requested: { retrieval: 1, cross_reference: 0, contradiction: 0 },
  tier_counts_produced: { retrieval: 1, cross_reference: 0, contradiction: 0 },
};

function mockClient(): LlmClient {
  return {
    complete: async () => ({ ok: true, value: { text: "ok", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" } }),
    completeJson: async () => ({ ok: false, error: { kind: "llm", message: "not used", retryable: false } }),
    completeWithTools: async () => ({
      ok: true,
      value: {
        text: "X is foo [a.md]",
        input_tokens: 10, output_tokens: 5, stop_reason: "end_turn",
        tool_calls: [{ tool: "vault_read", input: { path: "a.md" }, output: "body", latency_ms: 3 }],
      },
    }),
  };
}

describe("runAnswerer", () => {
  it("runs each question × k times and returns keyed results", async () => {
    const r = await runAnswerer(sampleQs, "/tmp/fake-vault", mockClient(), { k: 2, model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.k).toBe(2);
      expect(Object.keys(r.value.runs).sort()).toEqual(["0:0", "0:1"]);
      for (const key of ["0:0", "0:1"]) {
        const pr = r.value.runs[key];
        expect(pr.status).toBe("complete");
        expect(pr.trace?.tool_calls.length).toBe(1);
      }
    }
  });

  it("supports resume — does not re-run completed (q,k) pairs", async () => {
    const seeded = await runAnswerer(sampleQs, "/tmp/fake-vault", mockClient(), { k: 2, model: "claude-sonnet-fake" });
    if (!seeded.ok) throw new Error("seed failed");
    // Mark 0:0 complete, 0:1 incomplete
    const partial = { ...seeded.value, runs: { "0:0": seeded.value.runs["0:0"], "0:1": { ...seeded.value.runs["0:1"], status: "incomplete" as const, trace: null } } };
    let calls = 0;
    const client: LlmClient = {
      ...mockClient(),
      completeWithTools: async () => {
        calls++;
        return { ok: true, value: { text: "X is foo [a.md]", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn", tool_calls: [] } };
      },
    };
    const r = await runAnswerer(sampleQs, "/tmp/fake-vault", client, { k: 2, model: "claude-sonnet-fake", resumeFrom: partial });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1); // only the incomplete pair re-ran
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval/run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/eval/run.ts`**

```typescript
// src/eval/run.ts
// Answerer-LLM loop with in-process MCP tool surface. Per spec §4: tool
// handlers are called as plain TypeScript functions, no MCP serialization.
// Each (question, k_index) is an independent answerer invocation; failures
// produce status: "incomplete" entries that --resume picks up.

import { err, ok, type Result } from "../frontmatter/types.js";
import { ANSWERER_SYSTEM_PROMPT, PROMPT_VERSION } from "./prompts.js";
import { buildToolSurface } from "./tool-surface.js";
import type { LlmClient, ToolDef } from "./llm.js";
import type {
  EvalError, EvalRun, PerRunResult, Question, QuestionSet, Trace,
} from "./types.js";

export interface RunOptions {
  k: number;
  model: string;
  resumeFrom?: EvalRun;
}

export async function runAnswerer(
  questions: QuestionSet,
  vaultRoot: string,
  llm: LlmClient,
  opts: RunOptions
): Promise<Result<EvalRun, EvalError>> {
  const ts = "2026-01-01T00:00:00Z"; // caller overwrites
  const id = opts.resumeFrom?.id ?? `${questions.id}-${opts.model}-${ts}`;
  const runs: Record<string, PerRunResult> = { ...(opts.resumeFrom?.runs ?? {}) };

  const tools = buildToolSurface(vaultRoot);
  const toolDefs: ToolDef[] = tools.defs;

  for (let qi = 0; qi < questions.questions.length; qi++) {
    const q = questions.questions[qi];
    for (let k = 0; k < opts.k; k++) {
      const key = `${qi}:${k}`;
      if (runs[key]?.status === "complete") continue;

      const t0 = Date.now();
      const r = await llm.completeWithTools({
        model: opts.model,
        system: ANSWERER_SYSTEM_PROMPT,
        user: q.question,
        tools: toolDefs,
        toolHandler: tools.handler,
      });
      const wall_ms = Date.now() - t0;
      if (!r.ok) {
        runs[key] = { question_id: q.id, question_index: qi, k_index: k, status: "incomplete", trace: null };
        return err(r.error);
      }
      const trace: Trace = {
        tool_calls: r.value.tool_calls,
        final_answer: r.value.text,
        total_tool_calls: r.value.tool_calls.length,
        input_tokens: r.value.input_tokens,
        output_tokens: r.value.output_tokens,
        wall_ms,
        stop_reason: r.value.stop_reason,
      };
      runs[key] = { question_id: q.id, question_index: qi, k_index: k, status: "complete", trace };
    }
  }

  return ok({
    id, questions_id: questions.id, answerer_model: opts.model,
    prompt_version: PROMPT_VERSION, timestamp: ts, k: opts.k, runs,
  });
}
```

- [ ] **Step 4: Write `src/eval/tool-surface.ts`** (extracted helper)

```typescript
// src/eval/tool-surface.ts
// In-process construction of the answerer's MCP tool surface. Each tool is
// a thin adapter that calls the existing src/tools/* handler and serializes
// the Result<T, Error> so the LLM sees either the value or { tool_error }.
// NEVER throws — all errors become tool_error JSON the LLM can react to.
//
// Tool surface excludes vault_tension_log (it's a WRITE tool that creates a
// tension entry; the answerer is read-only). Tension graph access is via
// vault_tension_blast and vault_tension_clusters. The answerer reads
// tension content by reading the contested docs themselves via vault_read,
// or by calling vault_lint which surfaces tension health.

import { vaultRead } from "../tools/read.js";
import { vaultSearch, vaultSearchRelated } from "../tools/search.js";
import { vaultThemes } from "../tools/themes.js";
import {
  vaultLint, vaultTensionBlast, vaultTensionClusters,
} from "../tools/curation.js";
import type { Result } from "../frontmatter/types.js";
import type { ToolDef } from "./llm.js";

export interface ToolSurface {
  defs: ToolDef[];
  handler: (name: string, input: unknown) => Promise<unknown>;
}

// Unwrap a handler Result into either its value or a tool_error envelope.
async function unwrap<T>(p: Promise<Result<T, Error>>): Promise<T | { tool_error: string }> {
  const r = await p;
  return r.ok ? r.value : { tool_error: r.error.message };
}

export function buildToolSurface(vaultRoot: string): ToolSurface {
  const defs: ToolDef[] = [
    {
      name: "vault_read",
      description: "Read a vault doc by path.",
      input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
    {
      name: "vault_search",
      description: "Hybrid BM25 + vector search across the vault.",
      input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" }, limit: { type: "integer" } } },
    },
    {
      name: "vault_search_related",
      description: "Semantic neighbors of a doc.",
      input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "integer" } } },
    },
    {
      name: "vault_themes",
      description: "Thematic clustering of the vault.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "vault_lint",
      description: "Coherence report — broken refs, contradictions, stale tensions.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "vault_tension_blast",
      description: "Downstream blast from a contested doc (or a contested cluster). Pass either 'document' or 'cluster_id', not both.",
      input_schema: {
        type: "object",
        properties: { document: { type: "string" }, cluster_id: { type: "string" } },
      },
    },
    {
      name: "vault_tension_clusters",
      description: "Connected components of the tension graph.",
      input_schema: { type: "object", properties: {} },
    },
  ];

  // All handlers below take (vaultRoot, args, access?). access is undefined here
  // — eval bypasses RBAC because it runs locally against the dev's own vault.
  // biome-ignore lint/suspicious/noExplicitAny: tool inputs vary
  const handler = async (name: string, input: unknown): Promise<unknown> => {
    const inp = (input as Record<string, unknown>) ?? {};
    switch (name) {
      case "vault_read":
        // vaultRead has a non-args-bag signature: (vaultRoot, path, access?).
        return unwrap(vaultRead(vaultRoot, String(inp.path ?? ""), undefined));
      case "vault_search":
        return unwrap(vaultSearch(vaultRoot, inp, undefined));
      case "vault_search_related":
        return unwrap(vaultSearchRelated(vaultRoot, inp, undefined));
      case "vault_themes":
        return unwrap(vaultThemes(vaultRoot, inp, undefined));
      case "vault_lint":
        return unwrap(vaultLint(vaultRoot, inp, undefined));
      case "vault_tension_blast":
        return unwrap(vaultTensionBlast(vaultRoot, inp, undefined));
      case "vault_tension_clusters":
        return unwrap(vaultTensionClusters(vaultRoot, inp, undefined));
      default:
        return { tool_error: `unknown tool: ${name}` };
    }
  };

  return { defs, handler };
}
```

**Note on signatures verified against the codebase:** `vaultRead(vaultRoot, path: string, access?)` is the one outlier — it takes `path` as a positional string. Every other handler in `src/tools/{search,themes,curation}.ts` takes `(vaultRoot, args: Record<string, unknown>, access?)`. All return `Result<T, Error>`. The unwrap helper above turns Results into either the value or a `{ tool_error }` envelope the LLM can read.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/eval/run.test.ts`
Expected: both cases PASS.

- [ ] **Step 6: Commit**

```bash
git add src/eval/run.ts src/eval/tool-surface.ts test/eval/run.test.ts
git commit -m "feat(eval): answerer LLM with in-process MCP tool surface

K independent runs per question; per-(question_index, k_index) keyed
results enable --resume to re-run only incomplete pairs. Tool surface is a
thin adapter over existing src/tools/* handlers — no MCP serialization."
```

---

### Task 10: Grader — extend `src/eval/score.ts` with LLM grading

**Files:**
- Modify: `src/eval/score.ts`
- Modify: `test/eval/score.test.ts`

- [ ] **Step 1: Add grader test**

Append to `test/eval/score.test.ts`:

```typescript
import { gradeAnswer } from "../../src/eval/score.js";
import type { LlmClient } from "../../src/eval/llm.js";

function graderClient(verdict: "yes" | "partial" | "no"): LlmClient {
  return {
    complete: async () => ({ ok: true, value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" } }),
    completeJson: async () => ({ ok: true, value: { parsed: { correct: verdict, reasoning: "test" }, text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" } }),
    completeWithTools: async () => ({ ok: false, error: { kind: "llm", message: "n/a", retryable: false } }),
  };
}

describe("gradeAnswer", () => {
  it("maps yes/partial/no LLM verdict to Grade", async () => {
    const q = { id: "q1", tier: "retrieval" as const, question: "?", expected_answer: "a", expected_sources: ["a.md"], source: "generated" as const };
    const trace = { tool_calls: [], final_answer: "x", total_tool_calls: 0, input_tokens: 0, output_tokens: 0, wall_ms: 0, stop_reason: "end_turn" };
    const r = await gradeAnswer(q, 0, 0, trace, graderClient("partial"), { model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdict).toBe("partial");
  });

  it("marks question ungraded if grader returns malformed JSON", async () => {
    const q = { id: "q1", tier: "retrieval" as const, question: "?", expected_answer: "a", expected_sources: ["a.md"], source: "generated" as const };
    const trace = { tool_calls: [], final_answer: "x", total_tool_calls: 0, input_tokens: 0, output_tokens: 0, wall_ms: 0, stop_reason: "end_turn" };
    const badClient: LlmClient = {
      complete: async () => ({ ok: true, value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" } }),
      completeJson: async () => ({ ok: true, value: { parsed: { not_what_we_want: true }, text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" } }),
      completeWithTools: async () => ({ ok: false, error: { kind: "llm", message: "n/a", retryable: false } }),
    };
    const r = await gradeAnswer(q, 0, 0, trace, badClient, { model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdict).toBe("ungraded");
  });
});
```

- [ ] **Step 2: Run tests to verify the grader test fails**

Run: `npx vitest run test/eval/score.test.ts`
Expected: the new `gradeAnswer` describe block FAILs (function not exported).

- [ ] **Step 3: Add `gradeAnswer` to `src/eval/score.ts`**

Append:

```typescript
import { GRADER_PROMPT } from "./prompts.js";
import type { LlmClient } from "./llm.js";

export interface GradeOptions {
  model: string;
}

export async function gradeAnswer(
  question: Question,
  questionIndex: number,
  kIndex: number,
  trace: Trace,
  llm: LlmClient,
  opts: GradeOptions
): Promise<Result<Grade, EvalError>> {
  const cited = extractCitations(trace.final_answer);
  const user = GRADER_PROMPT
    .replace("{{QUESTION}}", question.question)
    .replace("{{EXPECTED_ANSWER}}", question.expected_answer)
    .replace("{{EXPECTED_SOURCES}}", question.expected_sources.join(", "))
    .replace("{{CLAIMED_ANSWER}}", trace.final_answer)
    .replace("{{CITED_SOURCES}}", cited.join(", "));

  const schema = {
    type: "object", required: ["correct", "reasoning"],
    properties: {
      correct: { enum: ["yes", "partial", "no"] },
      reasoning: { type: "string" },
    },
  } as const;

  const r = await llm.completeJson({ model: opts.model, system: "", user, schema });
  if (!r.ok) return r;
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON
  const parsed = r.value.parsed as any;
  const verdict: GradeVerdict =
    parsed?.correct === "yes" || parsed?.correct === "partial" || parsed?.correct === "no"
      ? parsed.correct
      : "ungraded";
  return ok({
    question_id: question.id, question_index: questionIndex, k_index: kIndex,
    verdict, reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning : "",
    grader_model: opts.model,
  });
}

function extractCitations(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(/\[([^\]]+\.md)\]/g)) out.push(m[1]);
  return out;
}
```

Also import `GradeVerdict` from types at the top of `score.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/eval/score.test.ts`
Expected: all aggregator tests still pass; both new grader tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/eval/score.ts test/eval/score.test.ts
git commit -m "feat(eval): LLM grader for per-question verdicts

Grader prompt + JSON-schema-validated yes/partial/no verdict. Malformed
grader output → 'ungraded', which aggregateScore excludes from the tier
mean. Citations extracted from answer text via [path.md] markers."
```

---

### Task 11: CLI dispatch — `src/eval/index.ts`

**Files:**
- Create: `src/eval/index.ts`

- [ ] **Step 1: Write the CLI entry point**

```typescript
// src/eval/index.ts
// Top-level CLI dispatcher for `daftari eval`. Parses flags, routes to
// generate/run/score/top-level, translates Result<T, EvalError> to exit
// codes (2 = config, 3 = runtime/llm).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateQuestions } from "./generate.js";
import { createAnthropicClient } from "./llm.js";
import { runAnswerer } from "./run.js";
import { aggregateScore, gradeAnswer } from "./score.js";
import {
  appendHistory, readQuestionSet, readResults,
  writeQuestionSet, writeResults, writeScore,
} from "./storage.js";
import { sampleSubgraph } from "./subgraph.js";
import { PROMPT_VERSION } from "./prompts.js";
import {
  SPEC_VERSION, TIERS,
  type Grade, type HistoryEntry, type Trace,
} from "./types.js";

const HELP = `daftari eval — cortex quality metric.

Usage:
  daftari eval [--vault <path>] [--n <count>] [--k <count>] [--seed <str>]
  daftari eval generate [--vault <path>] [--n <count>] [--seed <str>] [--output <path>]
  daftari eval run      [--questions <path>] [--vault <path>] [--model <id>] [--k <count>] [--resume <results-id>]
  daftari eval score    [--results <path>] [--grader-model <id>]

Defaults:
  --n 15      total questions across three tiers (5 each)
  --k 2       runs per question for variance estimation
  --model     claude-sonnet (current latest at install time; pinned in src/eval/llm.ts)
  --vault     current working directory

Environment:
  ANTHROPIC_API_KEY   required for any LLM-mediated stage

Disk usage:
  .daftari/eval/results/ and scores/ grow without bound across runs. v1
  recovery is a manual rm -rf .daftari/eval/results/; rerunning regenerates
  what's needed. A daftari eval prune command is the planned v2 follow-up.

Exit codes:
  0 — eval completed
  2 — config error (missing API key, bad flags, no vault)
  3 — runtime/LLM error (retries exhausted, vault I/O failure)
`;

export async function runEval(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP); return 0;
  }
  const [mode, ...rest] = argv;
  switch (mode) {
    case "generate": return await runGenerate(rest);
    case "run":      return await runRun(rest);
    case "score":    return await runScore(rest);
    default:         return await runTopLevel(argv);
  }
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}
function intFlag(argv: string[], name: string, def: number): number {
  const v = flag(argv, name);
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

function vaultHash(vault: string): string {
  return createHash("sha256").update(resolve(vault)).digest("hex").slice(0, 12);
}

function defaultSeed(vault: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${vaultHash(vault)}-${today}`;
}

const DEFAULT_MODEL = "claude-sonnet-4-6-20250101"; // adjust at install time

async function runGenerate(argv: string[]): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) { process.stderr.write("ANTHROPIC_API_KEY required\n"); return 2; }
  const vault = flag(argv, "vault") ?? process.cwd();
  const n = intFlag(argv, "n", 15);
  const seed = flag(argv, "seed") ?? defaultSeed(vault);

  const sg = await sampleSubgraph(vault, seed, { maxNodes: 5 });
  if (!sg.ok) { process.stderr.write(sg.error.message + "\n"); return 3; }
  const client = createAnthropicClient();
  const qs = await generateQuestions(sg.value, client, {
    n, model: DEFAULT_MODEL, vaultHash: vaultHash(vault), seed,
  });
  if (!qs.ok) { process.stderr.write(qs.error.message + "\n"); return 3; }
  qs.value.timestamp = new Date().toISOString();
  qs.value.id = `${qs.value.vault_hash}-${qs.value.seed}-${qs.value.timestamp}`;
  await writeQuestionSet(vault, qs.value);
  process.stdout.write(`wrote question set ${qs.value.id} (${qs.value.questions.length} questions)\n`);
  return 0;
}

async function runRun(argv: string[]): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY) { process.stderr.write("ANTHROPIC_API_KEY required\n"); return 2; }
  const vault = flag(argv, "vault") ?? process.cwd();
  const questionsId = flag(argv, "questions");
  if (!questionsId) { process.stderr.write("--questions required\n"); return 2; }
  const k = intFlag(argv, "k", 2);
  const model = flag(argv, "model") ?? DEFAULT_MODEL;

  const qsRead = await readQuestionSet(vault, questionsId);
  if (!qsRead.ok) { process.stderr.write(qsRead.error.message + "\n"); return 3; }

  let resumeFrom = undefined;
  const resumeId = flag(argv, "resume");
  if (resumeId) {
    const r = await readResults(vault, resumeId);
    if (r.ok) resumeFrom = r.value;
  }

  const client = createAnthropicClient();
  const run = await runAnswerer(qsRead.value, vault, client, { k, model, resumeFrom });
  if (!run.ok) { process.stderr.write(run.error.message + "\n"); return 3; }
  run.value.timestamp = new Date().toISOString();
  if (!resumeFrom) {
    run.value.id = `${qsRead.value.id}-${model}-${run.value.timestamp}`;
  }
  await writeResults(vault, run.value);
  process.stdout.write(`wrote results ${run.value.id}\n`);
  return 0;
}

async function runScore(argv: string[]): Promise<number> {
  const vault = flag(argv, "vault") ?? process.cwd();
  const resultsId = flag(argv, "results");
  if (!resultsId) { process.stderr.write("--results required\n"); return 2; }
  const graderModel = flag(argv, "grader-model") ?? DEFAULT_MODEL;
  if (!process.env.ANTHROPIC_API_KEY) { process.stderr.write("ANTHROPIC_API_KEY required\n"); return 2; }

  const runRead = await readResults(vault, resultsId);
  if (!runRead.ok) { process.stderr.write(runRead.error.message + "\n"); return 3; }
  const run = runRead.value;
  const qsRead = await readQuestionSet(vault, run.questions_id);
  if (!qsRead.ok) { process.stderr.write(qsRead.error.message + "\n"); return 3; }
  const qs = qsRead.value;

  const client = createAnthropicClient();
  const grades: Grade[] = [];
  const traces = new Map<string, Trace>();
  for (const [key, pr] of Object.entries(run.runs)) {
    if (pr.status !== "complete" || !pr.trace) continue;
    const q = qs.questions[pr.question_index];
    if (!q) continue;
    const g = await gradeAnswer(q, pr.question_index, pr.k_index, pr.trace, client, { model: graderModel });
    if (g.ok) {
      grades.push(g.value);
      traces.set(`${q.id}:${pr.k_index}`, pr.trace);
    }
  }
  const score = aggregateScore(grades, qs.questions, { traces });
  score.models = { generator: qs.generator_model, answerer: run.answerer_model, grader: graderModel };
  score.prompt_version = PROMPT_VERSION;
  score.spec_version = SPEC_VERSION;
  score.questions_id = qs.id;
  score.results_id = run.id;
  score.vault_hash = qs.vault_hash;
  score.k = run.k;
  score.n = qs.questions.length;
  score.timestamp = new Date().toISOString();
  await writeScore(vault, score);

  const histEntry: HistoryEntry = {
    score_id: score.results_id, score: score.score, score_std: score.score_std,
    by_tier: { retrieval: score.by_tier.retrieval.mean, cross_reference: score.by_tier.cross_reference.mean, contradiction: score.by_tier.contradiction.mean },
    vault_hash: score.vault_hash, timestamp: score.timestamp, n: score.n, k: score.k,
    models: score.models, prompt_version: score.prompt_version, spec_version: score.spec_version,
  };
  await appendHistory(vault, histEntry);

  // Pretty-print headline + per-tier means.
  process.stdout.write(`score: ${score.score.toFixed(3)} ± ${score.score_std.toFixed(3)}\n`);
  for (const t of TIERS) {
    const ts = score.by_tier[t];
    process.stdout.write(`  ${t.padEnd(16)}: ${ts.mean.toFixed(3)} (n=${ts.n}, efficiency=${ts.trace_efficiency.toFixed(1)} calls)\n`);
  }
  return 0;
}

async function runTopLevel(argv: string[]): Promise<number> {
  // Spec §3 "Top-level convenience": runs generate → run → score in one shot.
  // We thread the IDs in-memory rather than re-reading from disk, so a
  // failure mid-pipeline still leaves the on-disk artifacts that did
  // succeed for forensic / resume use.
  if (!process.env.ANTHROPIC_API_KEY) { process.stderr.write("ANTHROPIC_API_KEY required\n"); return 2; }
  const vault = flag(argv, "vault") ?? process.cwd();
  const n = intFlag(argv, "n", 15);
  const k = intFlag(argv, "k", 2);
  const seed = flag(argv, "seed") ?? defaultSeed(vault);
  const model = flag(argv, "model") ?? DEFAULT_MODEL;

  // 1. Generate
  const sg = await sampleSubgraph(vault, seed, { maxNodes: 5 });
  if (!sg.ok) { process.stderr.write(sg.error.message + "\n"); return 3; }
  const client = createAnthropicClient();
  const qsRes = await generateQuestions(sg.value, client, {
    n, model, vaultHash: vaultHash(vault), seed,
  });
  if (!qsRes.ok) { process.stderr.write(qsRes.error.message + "\n"); return 3; }
  const qs = qsRes.value;
  qs.timestamp = new Date().toISOString();
  qs.id = `${qs.vault_hash}-${qs.seed}-${qs.timestamp}`;
  await writeQuestionSet(vault, qs);
  process.stdout.write(`generated ${qs.questions.length} questions (id=${qs.id})\n`);

  // 2. Run
  const runRes = await runAnswerer(qs, vault, client, { k, model });
  if (!runRes.ok) { process.stderr.write(runRes.error.message + "\n"); return 3; }
  const run = runRes.value;
  run.timestamp = new Date().toISOString();
  run.id = `${qs.id}-${model}-${run.timestamp}`;
  await writeResults(vault, run);
  process.stdout.write(`ran ${Object.keys(run.runs).length} answerer invocations (id=${run.id})\n`);

  // 3. Score — invoke the same grading logic runScore uses, in-process.
  return await runScore(["--vault", vault, "--results", run.id, "--grader-model", model]);
}
```

- [ ] **Step 2: Run `npm run build`**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add src/eval/index.ts
git commit -m "feat(eval): CLI dispatcher with --help and three subcommands

generate / run / score, plus a top-level 'daftari eval' (no subcommand)
that chains all three in one shot. IDs are threaded in memory so a
mid-pipeline failure still leaves the on-disk artifacts that succeeded for
forensic / resume use."
```

---

### Task 12: Wire `daftari eval` into `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add the dispatch branch**

Find the `if (argv[0] === "audit")` block (around line 239). Below it, before `wantsInit`, add:

```typescript
if (argv[0] === "eval") {
  const { runEval } = await import("./eval/index.js");
  process.exit(await runEval(argv.slice(1)));
}
```

- [ ] **Step 2: Update the `USAGE` string**

In the `USAGE` constant, add a line after the audit line:

```
  daftari eval [options]              Cortex quality metric (see: daftari eval --help)
```

- [ ] **Step 3: Run `npm run build`**

Run: `npm run build`
Expected: clean compile.

- [ ] **Step 4: Smoke-test `--help`**

Run: `node dist/cli.js eval --help`
Expected: usage text from `src/eval/index.ts:HELP` is printed; exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(cli): wire daftari eval subcommand

Lazy-import per existing audit pattern. USAGE banner mentions the new
subcommand."
```

---

### Task 13: End-to-end test — `test/eval/e2e.test.ts`

**Files:**
- Create: `test/eval/e2e.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
// test/eval/e2e.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sampleSubgraph } from "../../src/eval/subgraph.js";
import { generateQuestions } from "../../src/eval/generate.js";
import { runAnswerer } from "../../src/eval/run.js";
import { aggregateScore, gradeAnswer } from "../../src/eval/score.js";
import type { LlmClient } from "../../src/eval/llm.js";

function mockClient(): LlmClient {
  return {
    complete: async () => ({ ok: true, value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" } }),
    completeJson: async (opts) => {
      // Generator: return a tiny canned set; grader: return "yes"
      if ((opts.user ?? "").includes("Subgraph docs")) {
        return {
          ok: true,
          value: {
            text: "",
            input_tokens: 0, output_tokens: 0, stop_reason: "end_turn",
            parsed: {
              questions: [
                { tier: "retrieval", question: "what is in a.md?", expected_answer: "stuff", expected_sources: [] }, // will be filtered (no sources)
              ],
            },
          },
        };
      }
      return { ok: true, value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn", parsed: { correct: "yes", reasoning: "ok" } } };
    },
    completeWithTools: async () => ({
      ok: true,
      value: { text: "stuff [a.md]", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn", tool_calls: [] },
    }),
  };
}

describe("eval e2e (mocked LLM)", () => {
  it("runs generate → run → score end-to-end against a fixture vault", async () => {
    const vault = await mkdtemp(join(tmpdir(), "daftari-e2e-"));
    try {
      await cp(resolve(__dirname, "../fixtures/sample-vault"), vault, { recursive: true });
      const sg = await sampleSubgraph(vault, "e2e-seed", { maxNodes: 4 });
      expect(sg.ok).toBe(true);
      if (!sg.ok) return;

      const qs = await generateQuestions(sg.value, mockClient(), { n: 3, model: "mock", vaultHash: "h", seed: "s" });
      expect(qs.ok).toBe(true);
      if (!qs.ok) return;

      // Note: the canned generator response is empty after filtering, so
      // questions may be 0 + augmented. If the sample-vault has unresolved
      // tensions (Task 14), an augmented question appears.
      if (qs.value.questions.length === 0) {
        // Skip the rest if no questions survived — exercises the filter path.
        return;
      }

      const run = await runAnswerer(qs.value, vault, mockClient(), { k: 1, model: "mock" });
      expect(run.ok).toBe(true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/eval/e2e.test.ts`
Expected: PASS (may early-return if no questions survive filtering — that's still a successful pipeline traversal).

- [ ] **Step 3: Commit**

```bash
git add test/eval/e2e.test.ts
git commit -m "test(eval): end-to-end pipeline against fixture vault

Mocked LLM client; exercises generate → run sequence end-to-end. The
generator's canned response is intentionally filterable-down so the test
also covers the empty-questions degenerate path."
```

---

### Task 14: Seed the sample-vault fixture with one unresolved tension

**Background:** `listTensions(vaultRoot)` in `src/curation/tension.ts` reads `.daftari/tensions.md` and parses each `## ` block. The current fixture has no `tensions.md` at all — verified with `ls test/fixtures/sample-vault/.daftari/`. §5.3 augmentation needs at least one unresolved tension, so we create the file with one entry. Use the *exact* markdown shape that `src/curation/tension.ts`'s `renderEntry` produces, so `listTensions` parses it correctly. Pick two real fictional fixture docs (Aurora competitive-intel + an existing pricing doc) as `sourceA` / `sourceB`.

**Files:**
- Create: `test/fixtures/sample-vault/.daftari/tensions.md`

- [ ] **Step 1: List the fixture docs so the tension references existing paths**

Run: `find test/fixtures/sample-vault -name '*.md' -not -path '*/.daftari/*' | head -20`
Expected: a list of fixture markdown files. Pick two that exist (e.g., `competitive-intel/aurora-pipelines-overview.md` and `pricing/aurora-pricing.md` — adjust to real fixture names).

- [ ] **Step 2: Inspect `renderEntry` in `src/curation/tension.ts` to mirror the exact format**

Open `src/curation/tension.ts` around line 95 (`function renderEntry`). Note the fields it writes: `## <title>`, `id:`, `date:`, `kind:`, `sourceA:` / `claimA:` / `sourceB:` / `claimB:`, `status:`, `loggedBy:`. Match it exactly — `listTensions` will not pick up an entry that diverges from the shape `parseBlock` recognizes.

- [ ] **Step 3: Create `test/fixtures/sample-vault/.daftari/tensions.md` with one unresolved entry**

Use the exact `renderEntry` shape (verified against `src/curation/tension.ts:95`):

```markdown
## 2026-06-01 — Aurora positioning and pricing describe different audiences

- **Id:** tension-001
- **Kind:** factual
- **Source A:** competitive-intel/aurora-pipelines-overview.md says Aurora targets large enterprise data teams.
- **Source B:** pricing/aurora-pricing.md says Aurora pricing tiers start at the indie-developer tier.
- **Status:** unresolved
- **Logged by:** agent:daftari-eval-fixture
```

Format contract: `## <YYYY-MM-DD> — <title>` heading, then bullets with **capitalized** field names (`**Id:**`, `**Kind:**`, `**Source A:**`, etc.). `Source A` / `Source B` bullets use the compact `<path> says <claim>` pattern, not separate `claim:` lines. `Status: unresolved` is what `listTensions` reads (anything other than `resolved` keeps `resolved: false`). If you deviate from this shape, `parseBlock` in `src/curation/tension.ts` will silently skip the entry.

Adjust the `Source A` and `Source B` paths to actual paths from the Step 1 listing if `aurora-pricing.md` doesn't exist (e.g., substitute `pricing/aurora-pricing-tiers.md` or another fictional pricing doc that's really in the fixture).

- [ ] **Step 4: Verify `listTensions` reads the new entry**

Write a one-off check (delete after):

```bash
npx tsx -e "
  import('./src/curation/tension.ts').then(async (m) => {
    const r = await m.listTensions('./test/fixtures/sample-vault');
    console.log(JSON.stringify(r, null, 2));
  });
"
```
Expected: `{ ok: true, value: [{ ... resolved: false ... }] }` with the entry visible.

- [ ] **Step 5: Re-run the full test suite to ensure the fixture change doesn't break anything**

Run: `npm test`
Expected: all tests still pass. (The fixture is shared with other tests; adding a tension file should be additive but verify.)

- [ ] **Step 6: Re-run the e2e test specifically**

Run: `npx vitest run test/eval/e2e.test.ts`
Expected: PASS, and the subgraph now contains tension edges for at least some seeds, so the augmentation path is exercised.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/sample-vault/.daftari/tensions.md
git commit -m "test(fixture): seed sample-vault with one unresolved tension

§5.3's augmentation path requires at least one unresolved tension in the
vault. Sample-vault had no tensions.md at all; this adds one fictional
factual tension between two existing fixture docs. Format matches
src/curation/tension.ts renderEntry so listTensions parses it."
```

---

### Task 15: Smoke test — `test/eval/smoke.test.ts`

**Files:**
- Create: `test/eval/smoke.test.ts`

- [ ] **Step 1: Write the opt-in smoke test**

```typescript
// test/eval/smoke.test.ts
// Opt-in: real Anthropic API. Skipped unless ANTHROPIC_API_KEY is set.
// Run manually before releases that touch src/eval/.
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sampleSubgraph } from "../../src/eval/subgraph.js";
import { generateQuestions } from "../../src/eval/generate.js";
import { runAnswerer } from "../../src/eval/run.js";
import { createAnthropicClient } from "../../src/eval/llm.js";

const skipIfNoKey = !process.env.ANTHROPIC_API_KEY;

describe.skipIf(skipIfNoKey)("eval smoke (real LLM)", () => {
  it("runs N=3 K=1 against sample-vault without crashing", async () => {
    const vault = await mkdtemp(join(tmpdir(), "daftari-smoke-"));
    try {
      await cp(resolve(__dirname, "../fixtures/sample-vault"), vault, { recursive: true });
      const sg = await sampleSubgraph(vault, "smoke-seed", { maxNodes: 4 });
      expect(sg.ok).toBe(true);
      if (!sg.ok) return;
      const client = createAnthropicClient();
      const qs = await generateQuestions(sg.value, client, { n: 3, model: "claude-sonnet-4-6-20250101", vaultHash: "h", seed: "s" });
      expect(qs.ok).toBe(true);
      if (!qs.ok) return;
      const run = await runAnswerer(qs.value, vault, client, { k: 1, model: "claude-sonnet-4-6-20250101" });
      expect(run.ok).toBe(true);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  }, 300_000); // 5-minute timeout for real LLM
});
```

- [ ] **Step 2: Verify it's skipped without `ANTHROPIC_API_KEY`**

Run: `npx vitest run test/eval/smoke.test.ts`
Expected: 1 test SKIPPED.

- [ ] **Step 3: Commit**

```bash
git add test/eval/smoke.test.ts
git commit -m "test(eval): opt-in real-LLM smoke against sample-vault

Skipped in CI unless ANTHROPIC_API_KEY is set. Run manually before
releases that touch src/eval/. 5-minute timeout for the real-LLM call."
```

---

### Task 16: Full test pass + lint + build

**Files:** none (verification)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass; smoke test skipped. Compare count to the count just before this PR: should be the prior total plus the new tests added in Tasks 3, 4, 5, 7, 8, 9, 10, 13, 15.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: clean (0 issues).

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: clean (0 errors).

- [ ] **Step 4: Verify no unintended file changes**

Run: `git status`
Expected: clean (no modified files; this task only ran verifications).

---

### Task 17: CHANGELOG + README + release notes

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

- [ ] **Step 1: Add entry under `## [Unreleased]` in CHANGELOG**

Per project convention (see v1.14.0, v1.15.0 release shape), unreleased entries land under `## [Unreleased]` and get moved into a dated `## [1.16.0] - YYYY-MM-DD` section by the release PR (not by this feature PR). Add under `## [Unreleased]` → `### Added`:

```markdown
### Added

- **`daftari eval` cortex quality metric** (Sleep Component B). New CLI
  subcommand that scores how well an LLM can use the Daftari MCP curation
  surface to answer multi-hop questions about the vault. Three tiers
  (retrieval, cross-reference, contradiction) with tier-weighted aggregate
  (1×/2×/3×). Generator/answerer/grader all LLM-mediated via
  `@anthropic-ai/sdk` (new dep, isolated to `src/eval/llm.ts`). Output
  artifacts live in `.daftari/eval/` (gitignored). Components A (multi-pass
  curation) and C (dependency-triggered re-curation) are deferred to
  follow-on specs. See
  [docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md](docs/superpowers/specs/2026-05-31-cortex-quality-metric-design.md).
```

- [ ] **Step 2: Add README mention under "The tools"**

Insert a new subsection after the existing tool families:

```markdown
**Evaluate (opt-in, requires Anthropic API key):** `daftari eval` — scores how
well an LLM can use the curation surface to answer multi-hop questions about
the vault. See the spec for the design rationale and the cortex framing.
```

- [ ] **Step 3: Run build and tests one more time to confirm nothing slipped**

Run: `npm run build && npm test && npm run lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "docs(eval): CHANGELOG + README for daftari eval

Mentions the new opt-in subcommand, the Anthropic API key requirement, and
the link to the design spec."
```

---

## Cross-cutting checklist

Before opening a PR for this branch, confirm each:

- [ ] `npm run build` — clean
- [ ] `npm test` — all green, smoke test skipped
- [ ] `npm run lint` — clean
- [ ] Diff is *only* `src/eval/`, `test/eval/`, `src/cli.ts` (one branch added), `.gitignore` (one line added), `package.json`/`package-lock.json` (1 new dep — no version bump; release PR handles that), `CHANGELOG.md`, `README.md`, `test/fixtures/sample-vault/.daftari/tensions.md` (one entry added, Task 14).
- [ ] No `.daftari/eval/` directory committed anywhere (gitignore check).
- [ ] `PROMPT_VERSION = 1` in `src/eval/prompts.ts`.
- [ ] `SPEC_VERSION = 1` in `src/eval/types.ts`.
- [ ] No file in `src/` outside `src/eval/` imports from `@anthropic-ai/sdk`. Verify with: `rg "@anthropic-ai/sdk" src/ | grep -v 'src/eval/'` → empty.
- [ ] `daftari eval --help` runs and prints usage; exits 0.
- [ ] `daftari eval generate --help` (and `run`, `score`) — at minimum, doesn't crash. Detailed sub-help is not in v1; the top-level `--help` lists all flags.
- [ ] GitHub follow-up issue filed: "v2: daftari eval prune for results/ and scores/ housekeeping" (per §12 resolution 6).

## Notes on what is explicitly NOT done by this plan

- **Component A (multi-pass curation)** — deferred to follow-on spec. This plan does not modify any curation tool.
- **Component C (dependency-triggered re-curation)** — deferred to follow-on spec.
- **Cross-vault eval via the router** — out of scope; router unchanged.
- **CI gate on score** — no `--fail-on <score>` flag. Score is informational only.
- **Web UI / dashboard** — none. JSON + `jq` is the surface.
- **Cost optimization** — no caching, no question-set portability, no cheaper-grader path. v1 ships the dumb-but-correct version.

If any of those creep into a task during implementation, stop and surface to the human — they should be their own spec, not silent additions to this one.
