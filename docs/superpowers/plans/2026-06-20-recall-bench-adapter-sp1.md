# Daftari ↔ Recall Bench Adapter (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript adapter that makes daftari satisfy Recall Bench's `MemorySystemAdapter`, and run daftari's as-is baseline on the EA-180d persona.

**Architecture:** A standalone ESM package at `integrations/recall-bench/` that imports daftari's already-built internals from `../../dist/**` (deep imports are allowed — `package.json` has no `exports` map). It runs daftari fully in-process: ingest writes daily markdown to a temp vault, `finalizeIngestion` calls `reindexVault`, and `query` runs an agent loop reusing `buildToolSurface` + `completeWithTools` (native Claude answerer, native MiniLM embeddings). No MCP server, no process lock, no ranking change.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, daftari internals (`src/eval`, `src/search`, `src/frontmatter`), Recall Bench (`/tmp/recall-review`, `MemorySystemAdapter` in `packages/recall-bench/src/types.ts`).

**Spec:** `docs/superpowers/specs/2026-06-20-daftari-recall-bench-adapter-design.md`

---

## Execution context

- Implement in a worktree off `spec/recall-bench-adapter` (NOT the `fix/security-…` branch). Create with: `git worktree add -b feat/recall-bench-adapter <path> spec/recall-bench-adapter`.
- Daftari must be built first so `../../dist/**` exists: from repo root run `npm run build`.
- `ANTHROPIC_API_KEY` must be set for any non-stubbed answerer run (tests stub it).

## File structure

```
integrations/recall-bench/
  package.json          # @daftari/recall-bench-adapter, type:module, build=tsc, test=vitest
  tsconfig.json         # NodeNext, rootDir src, outDir dist
  src/
    types.ts            # AdapterConfig; re-export of the upstream MemorySystemAdapter shape (structural)
    corpus-map.ts       # pure: (day, content, DayMetadata) -> { relPath, markdown }
    config.ts           # parseConfig(raw) -> Result<AdapterConfig, Error>
    answerer.ts         # makeAnswerer(vaultRoot, cfg) -> answer(q) -> { answer, retrieval, toolCalls }
    adapter.ts          # createDaftariAdapter(rawConfig) -> MemorySystemAdapter
    index.ts            # export { createDaftariAdapter }
    corpus-map.test.ts
    config.test.ts
    answerer.test.ts
    adapter.test.ts
  profiles/
    ea-180d-daftari.yaml
```

Responsibilities: `corpus-map` is the only place that knows daftari frontmatter; `answerer` is the only place that knows the eval tool-surface/LLM; `adapter` owns lifecycle + temp-vault safety; `config` is the only place that parses untrusted harness input. Each is independently testable.

---

### Task 0: Scaffold the package

**Files:**
- Create: `integrations/recall-bench/package.json`
- Create: `integrations/recall-bench/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@daftari/recall-bench-adapter",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5",
    "vitest": "^2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Verify daftari is built** — Run: `ls ../../dist/search/reindex.js ../../dist/eval/llm.js ../../dist/eval/tool-surface.js` (from `integrations/recall-bench/`). Expected: all three exist. If not, run `npm run build` at repo root.

- [ ] **Step 4: Commit**

```bash
git add integrations/recall-bench/package.json integrations/recall-bench/tsconfig.json
git commit -m "chore(recall-bench): scaffold adapter package"
```

---

### Task 1: `corpus-map` — benchmark day → daftari daily

**Files:**
- Create: `integrations/recall-bench/src/corpus-map.ts`
- Test: `integrations/recall-bench/src/corpus-map.test.ts`

Maps `(day, content, DayMetadata)` to a daftari daily. Uses **real** builtin frontmatter fields only (`src/frontmatter/types.ts` `BuiltinFrontmatter`): `collection` (= persona), `tags` (= activeArcs), `title`, `created`, `updated`. `dayNumber`/`date` ride as extension fields (harmless; not indexed). File path `<persona>/day-XXXX.md` so `collection` is also recoverable from the path segment (`reindex.ts:209`).

- [ ] **Step 1: Write the failing test**

Parse with **daftari's own parser** (`dist/frontmatter/parser.js`), not gray-matter — same parser daftari indexes with, no dependency ambiguity. Confirm `parseDocument`'s exact return shape first (Result-wrapped? field names `frontmatter`/`body`/`validation` vs `data`/`content`) and adjust the asserts.

**Why this is a correctness GATE, not a nicety (spec spike-finding 3):** the adapter writes dailies and calls `reindexVault`, which on bad frontmatter **silently coerces** invalid enums to fallbacks and indexes the coerced value while discarding validation (`reindex.ts:185-225`, `parser.ts:30-38`) — `vault_write`'s reject gate is NOT on this path. So if `corpus-map` emits anything outside the builtin sets, the run won't error; it'll corrupt the baseline invisibly. The test must therefore assert **zero validation/coercion issues** on the emitted doc.

```ts
import { describe, it, expect } from "vitest";
import { parseDocument } from "../../../dist/frontmatter/parser.js";
import { mapDay } from "./corpus-map.js";

const meta = { dayNumber: 53, date: "2026-03-21", personaId: "executive-assistant", activeArcs: ["condor", "hiring"] };

describe("mapDay", () => {
  it("writes a daily with real builtin frontmatter and ZERO coercions", () => {
    const { relPath, markdown } = mapDay(53, "Condor deal sized at $4M.", meta);
    expect(relPath).toBe("executive-assistant/day-0053.md");
    const parsed = parseDocument(markdown); // confirm shape: Result<{ frontmatter, body, validation }>
    const p = (parsed as any).ok ? (parsed as any).value : parsed;
    const fm = p.frontmatter ?? p.data;
    expect(fm.collection).toBe("executive-assistant");
    expect(fm.tags).toEqual(["condor", "hiring"]);
    expect(fm.created).toBe("2026-03-21");
    expect(fm.dayNumber).toBe(53);
    // CORRECTNESS GATE: corpus-map must emit nothing that reindex would silently coerce.
    expect(p.validation ?? []).toHaveLength(0);
  });

  it("zero-pads day to 4 digits", () => {
    expect(mapDay(7, "x", meta).relPath).toBe("executive-assistant/day-0007.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/corpus-map.test.ts`
Expected: FAIL — `mapDay` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { DayMetadata } from "./types.js";

export interface DaftariDaily {
  relPath: string;
  markdown: string;
}

function yamlScalar(v: string | number): string {
  return typeof v === "number" ? String(v) : JSON.stringify(v);
}

export function mapDay(day: number, content: string, meta: DayMetadata): DaftariDaily {
  const id = String(day).padStart(4, "0");
  const tags = meta.activeArcs.map((a) => `  - ${yamlScalar(a)}`).join("\n");
  const fm = [
    "---",
    `title: ${yamlScalar(`Day ${day}`)}`,
    `collection: ${yamlScalar(meta.personaId)}`,
    `created: ${yamlScalar(meta.date)}`,
    `updated: ${yamlScalar(meta.date)}`,
    `dayNumber: ${day}`,
    `date: ${yamlScalar(meta.date)}`,
    `tags:\n${tags}`,
    "---",
    "",
  ].join("\n");
  return { relPath: `${meta.personaId}/day-${id}.md`, markdown: `${fm}${content}\n` };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `npx vitest run src/corpus-map.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/src/corpus-map.ts integrations/recall-bench/src/corpus-map.test.ts integrations/recall-bench/src/types.ts
git commit -m "feat(recall-bench): corpus-map day->daftari daily"
```

---

### Task 2: `config` — parse harness config

**Files:**
- Create: `integrations/recall-bench/src/config.ts`
- Modify: `integrations/recall-bench/src/types.ts` (add `AdapterConfig`)
- Test: `integrations/recall-bench/src/config.test.ts`

Parses the profile's `harness.config` into a typed `AdapterConfig` with daftari's `Result<T,E>` convention. Fields: `answererModel` (string, required), `maxSearchResults` (number, default 15), `agentMaxIterations` (number, default 6 → mapped to `maxRounds`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies defaults", () => {
    const r = parseConfig({ answererModel: "claude-opus-4-8" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.maxSearchResults).toBe(15);
      expect(r.value.agentMaxIterations).toBe(6);
    }
  });
  it("errors when answererModel is missing", () => {
    const r = parseConfig({});
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test** — Run: `npx vitest run src/config.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { ok, err, type Result } from "../../../dist/frontmatter/types.js";

export interface AdapterConfig {
  answererModel: string;
  maxSearchResults: number;
  agentMaxIterations: number;
}

export function parseConfig(raw: Record<string, unknown>): Result<AdapterConfig, Error> {
  const m = raw.answererModel;
  if (typeof m !== "string" || m.length === 0) {
    return err(new Error("recall-bench adapter: harness.config.answererModel (string) is required"));
  }
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return ok({
    answererModel: m,
    maxSearchResults: num(raw.maxSearchResults, 15),
    agentMaxIterations: num(raw.agentMaxIterations, 6),
  });
}
```

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/src/config.ts integrations/recall-bench/src/config.test.ts integrations/recall-bench/src/types.ts
git commit -m "feat(recall-bench): config parsing with defaults"
```

---

### Task 3: `answerer` — agent loop over the daftari tool surface

**Files:**
- Create: `integrations/recall-bench/src/answerer.ts`
- Test: `integrations/recall-bench/src/answerer.test.ts`

Reuses `buildToolSurface(vaultRoot)` (defs + handler; handler already returns `{tool_error}` envelopes, never throws) and `completeWithTools`. Returns `{ answer, retrieval, toolCalls }`. **Retrieval extraction:** union all `vault_search` hits across `tool_calls` (skip `{tool_error}` outputs), dedup by path keeping max score. **toolCalls:** map each `tool_calls` entry to `{ tool, args, resultPreview }` (≤200 chars). Injects the `LlmClient` for testability (default = `createAnthropicClient()`).

> **Test classification (corrected):** the LLM is stubbed, but this test calls real `reindexVault`, which loads the MiniLM embedding model. It is therefore an **integration test requiring the model cached** — NOT hermetic. Gate it (e.g. `describe.skipIf(!process.env.RB_INTEGRATION)`), warm the model once before running, and on a red result re-check against the known MiniLM CI-load flake (`reference_ci_embedding_model_flake`) before treating it as a regression. Only `corpus-map.test.ts` and `config.test.ts` are truly hermetic.
>
> **No-flatten constraint (spec spike-finding 2):** the answerer must pass `buildToolSurface`'s structured tool output through **unmodified** — do NOT post-process hits or inline structured fields (`decay`, `superseded_by`) into the prose `snippet`/prompt. The spike's `⚠ STALE`-in-prompt hallucination was caused by the *adapter* flattening a structured field; `extractRetrieval` only *reads* `{path,score,snippet}` and never rewrites what the LLM sees, so keep it that way.

- [ ] **Step 1: Write the failing test (stub LLM, real tool surface — integration)**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../../dist/frontmatter/types.js";
import { reindexVault } from "../../../dist/search/reindex.js";
import { makeAnswerer } from "./answerer.js";

// Stub LlmClient: round 1 calls vault_search, round 2 answers from the hit.
function stubLlm(searchedOut: { hits: unknown[] }) {
  return {
    completeWithTools: async (opts: any) => {
      await opts.toolHandler("vault_search", { query: "rate limit" });
      return ok({
        text: "The rate limit is 1000rps.",
        input_tokens: 1, output_tokens: 1, stop_reason: "end_turn",
        tool_calls: [{ tool: "vault_search", input: { query: "rate limit" }, output: searchedOut, latency_ms: 1 }],
      });
    },
    complete: async () => ok({ text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" }),
    completeJson: async () => ok({ text: "", parsed: {}, input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" }),
  };
}

describe("makeAnswerer", () => {
  it("returns answer + dedup'd retrieval from vault_search tool calls", async () => {
    const vault = mkdtempSync(join(tmpdir(), "rb-ans-"));
    mkdirSync(join(vault, "ea"), { recursive: true });
    writeFileSync(join(vault, "ea", "day-0001.md"), "---\ntitle: d1\ncollection: ea\n---\nRate limit is 1000rps.\n");
    await reindexVault(vault);
    const out = { hits: [{ path: "ea/day-0001.md", score: 0.9, snippet: "Rate limit is 1000rps." }] };
    const answer = makeAnswerer(vault, { answererModel: "x", maxSearchResults: 15, agentMaxIterations: 6 }, stubLlm(out) as any);
    const res = await answer("what is the rate limit?");
    expect(res.answer).toContain("1000rps");
    expect(res.retrieval).toEqual([{ path: "ea/day-0001.md", score: 0.9, snippet: "Rate limit is 1000rps." }]);
    expect(res.toolCalls[0].tool).toBe("vault_search");
    rmSync(vault, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test** — Expected: FAIL (`makeAnswerer` missing).

- [ ] **Step 3: Implement**

```ts
import { buildToolSurface } from "../../../dist/eval/tool-surface.js";
import { createAnthropicClient, type LlmClient } from "../../../dist/eval/llm.js";
import { ANSWERER_SYSTEM_PROMPT } from "../../../dist/eval/prompts.js";
import type { AdapterConfig } from "./config.js";

export interface RetrievalEntry { path: string; score: number; snippet: string; }
export interface AnswerResult {
  answer: string;
  retrieval: RetrievalEntry[];
  toolCalls: { tool: string; args: Record<string, unknown>; resultPreview: string }[];
}

function extractRetrieval(toolCalls: { tool: string; output: unknown }[]): RetrievalEntry[] {
  const byPath = new Map<string, RetrievalEntry>();
  for (const c of toolCalls) {
    if (c.tool !== "vault_search") continue;
    const out = c.output as { hits?: { path: string; score: number; snippet: string }[]; tool_error?: string };
    if (out?.tool_error || !out?.hits) continue;
    for (const h of out.hits) {
      const prev = byPath.get(h.path);
      if (!prev || h.score > prev.score) byPath.set(h.path, { path: h.path, score: h.score, snippet: h.snippet });
    }
  }
  return [...byPath.values()];
}

export function makeAnswerer(vaultRoot: string, cfg: AdapterConfig, llm: LlmClient = createAnthropicClient()) {
  const surface = buildToolSurface(vaultRoot);
  return async function answer(question: string): Promise<AnswerResult> {
    const res = await llm.completeWithTools({
      model: cfg.answererModel,
      system: ANSWERER_SYSTEM_PROMPT,
      user: question,
      tools: surface.defs,
      toolHandler: surface.handler,
      maxRounds: cfg.agentMaxIterations,
    });
    if (!res.ok) throw res.error;
    return {
      answer: res.value.text,
      retrieval: extractRetrieval(res.value.tool_calls),
      toolCalls: res.value.tool_calls.map((c) => ({
        tool: c.tool,
        args: (c.input ?? {}) as Record<string, unknown>,
        resultPreview: JSON.stringify(c.output).slice(0, 200),
      })),
    };
  };
}
```

- [ ] **Step 4: Run test** — Expected: PASS. (Confirms real `buildToolSurface` + `reindexVault` integrate; LLM is stubbed.)

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/src/answerer.ts integrations/recall-bench/src/answerer.test.ts
git commit -m "feat(recall-bench): answerer agent loop + retrieval extraction"
```

---

### Task 4: `adapter` — lifecycle + safety guards

**Files:**
- Create: `integrations/recall-bench/src/adapter.ts`
- Test: `integrations/recall-bench/src/adapter.test.ts`

Implements `MemorySystemAdapter`. `setup` mkdtemps a vault under `os.tmpdir()`; `ingestDay` writes via `mapDay`; `finalizeIngestion` calls `reindexVault` and **throws if `vectorEnabled` is false** (confound guard) — records the value too; `query`/`queryDetail` delegate to the answerer, with a per-query try/catch returning a `daftari_error`-marked sentinel; `teardown` asserts the path is under `os.tmpdir()` before `rm -rf`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createDaftariAdapter } from "./adapter.js";

const meta = (d: number) => ({ dayNumber: d, date: `2026-01-${String(d).padStart(2, "0")}`, personaId: "ea", activeArcs: [] });

describe("createDaftariAdapter", () => {
  it("ingests, indexes, answers, and the temp vault is under tmpdir", async () => {
    const a = createDaftariAdapter({ answererModel: "x" }, { llm: stubLlmThatAnswers() });
    await a.setup();
    await a.ingestDay(1, "Launch date is March 3.", meta(1));
    await a.ingestDay(2, "Budget approved at $2M.", meta(2));
    await a.finalizeIngestion();
    const detail = await a.queryDetail!("what is the budget?");
    expect(detail.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.retrieval)).toBe(true);
    await a.teardown();
  });

  it("finalizeIngestion is idempotent — second call covers BOTH days", async () => {
    // Use a stub whose toolHandler runs a real vault_search and echoes hits into the
    // answer, so we can prove day-1 is still retrievable after the second finalize.
    const a = createDaftariAdapter({ answererModel: "x" }, { llm: stubLlmThatSearches() });
    await a.setup();
    await a.ingestDay(1, "Alpha fact: launch is March 3.", meta(1));
    await a.finalizeIngestion();
    await a.ingestDay(2, "Bravo fact: budget is $2M.", meta(2));
    await a.finalizeIngestion(); // must extend, not reset
    const d = await a.queryDetail!("launch date");
    // day-1 content must still be retrievable after re-index (proves no reset/loss)
    expect(d.retrieval.some((r: any) => r.path.endsWith("day-0001.md"))).toBe(true);
    await a.teardown();
  });
});
```

> Define `stubLlmThatAnswers()` to call `vault_search` once then return a fixed answer (reuse the Task 3 stub shape). The point of these tests is lifecycle + guards, not LLM behaviour.

- [ ] **Step 2: Run test** — Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { reindexVault } from "../../../dist/search/reindex.js";
import { mapDay } from "./corpus-map.js";
import { parseConfig } from "./config.js";
import { makeAnswerer } from "./answerer.js";
import type { LlmClient } from "../../../dist/eval/llm.js";

interface DayMetadata { dayNumber: number; date: string; personaId: string; activeArcs: string[]; }

export function createDaftariAdapter(rawConfig: Record<string, unknown>, deps: { llm?: LlmClient } = {}) {
  const parsed = parseConfig(rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg = parsed.value;

  let vaultRoot = "";
  let answer: ((q: string) => Promise<{ answer: string; retrieval: unknown[]; toolCalls: unknown[] }>) | null = null;
  let lastVectorEnabled = false;

  // Local closure used by both query() and queryDetail() — avoids `this` binding.
  async function runQuery(question: string) {
    try {
      const r = await answer!(question);
      return { answer: r.answer, retrieval: r.retrieval as any[], toolCalls: r.toolCalls as any[] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { answer: `[daftari_error: ${msg}]`, retrieval: [], toolCalls: [{ tool: "daftari_error", args: {}, resultPreview: msg.slice(0, 200) }] };
    }
  }

  return {
    name: `daftari (claude=${cfg.answererModel}, minilm)`,

    async setup() {
      vaultRoot = await mkdtemp(join(tmpdir(), "daftari-recall-"));
      answer = makeAnswerer(vaultRoot, cfg, deps.llm);
    },

    async ingestDay(day: number, content: string, meta: DayMetadata) {
      const { relPath, markdown } = mapDay(day, content, meta);
      const abs = join(vaultRoot, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, markdown, "utf8");
    },

    async finalizeIngestion() {
      const r = await reindexVault(vaultRoot);
      if (!r.ok) throw r.error;
      lastVectorEnabled = r.value.vectorEnabled;
      if (!lastVectorEnabled) {
        throw new Error("recall-bench: MiniLM vectors disabled (vectorEnabled=false) — BM25-only would confound the baseline. Aborting; re-run.");
      }
    },

    // Both call the local `answer!()` closure directly (NOT `this.queryDetail`) so
    // method binding can never break if the harness detaches a method reference.
    async query(question: string): Promise<string> {
      return (await runQuery(question)).answer;
    },

    async queryDetail(question: string) {
      return runQuery(question);
    },

    async teardown() {
      if (vaultRoot && resolve(vaultRoot).startsWith(resolve(tmpdir()))) {
        await rm(vaultRoot, { recursive: true, force: true });
      }
      vaultRoot = "";
    },
  };
}
```

- [ ] **Step 4: Run test** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/src/adapter.ts integrations/recall-bench/src/adapter.test.ts
git commit -m "feat(recall-bench): adapter lifecycle + tmpdir + vector-fallback guards"
```

---

### Task 5: `index.ts` factory export + build to dist

**Files:**
- Create: `integrations/recall-bench/src/index.ts`

- [ ] **Step 1: Implement**

```ts
export { createDaftariAdapter } from "./adapter.js";
```

The harness profile references `harness.factory: createDaftariAdapter`. **Contract confirmed against the bench loader (`packages/recall-bench/src/cli.ts:902-924`):** the loader resolves the named export, requires it be a `function`, and calls `await Promise.resolve(factory(cfg))` where `cfg = profile.harness.config ?? {}` — i.e. **exactly one argument (the config), sync or async**, and the return must pass a structural `isMemorySystemAdapter` check (`name`, `setup`, `ingestDay`, `finalizeIngestion`, `query`, `teardown` all present; `queryDetail` not required). `createDaftariAdapter(rawConfig, deps = {})` is fine — the harness passes only `cfg`, so `deps` defaults to `{}`. No arity change needed.

- [ ] **Step 2: Build the package**

Run: `npx tsc -p integrations/recall-bench/tsconfig.json`
Expected: `integrations/recall-bench/dist/index.js` exists, no errors.

- [ ] **Step 3: Run all adapter tests** — Run: `npx vitest run integrations/recall-bench/src` — Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add integrations/recall-bench/src/index.ts
git commit -m "feat(recall-bench): export createDaftariAdapter factory"
```

---

### Task 6: Profile + smoke run

**Files:**
- Create: `integrations/recall-bench/profiles/ea-180d-daftari.yaml`

- [ ] **Step 1: Write the profile** (model after `/tmp/recall-review/packages/recall-bench/profiles/ea-180d-openclaw.yaml`; key changes below)

```yaml
persona: { id: executive-assistant, dir: <path to>/personas/executive-assistant, arcs: arcs-180d.yaml }
env: { file: <path to>/.env }   # ANTHROPIC_API_KEY (answerer) + AZURE_OPENAI_* (judges)
models:
  judge: azure:gpt-5.4-mini
  appellateJudge: azure:gpt-5.4
harness:
  adapter: <abs path>/integrations/recall-bench/dist/index.js
  factory: createDaftariAdapter
  config:
    answererModel: claude-opus-4-8
    maxSearchResults: 15
    agentMaxIterations: 6
run:
  ranges: { start: 6, end: 30, step: 12 }   # SMOKE: 3 checkpoints
  seed: 42
  sample: 10
  judgeMemoryWindow: 1
  groupsEnabled: false
```

- [ ] **Step 2: Run the smoke** — From the recall repo: `recall-bench run --profile <...>/ea-180d-daftari.yaml --json-out bench-results/drafts/daftari-smoke/result.json`. Expected: completes end-to-end; `result.json` written; non-zero question count; no `daftari_error` sentinels in `failures.jsonl`.

- [ ] **Step 3: Verify the supersession category is exercised (DoD-critical).** Confirm `failures.jsonl`/`result.json` contain `contradiction-resolution` questions evaluated at a checkpoint past their revision day. If the smoke's short range/sample misses them, note it and rely on the full run; if the full run could also miss them, pin those QAs in (extend `sample` or add a targeted range).

- [ ] **Step 4: Commit the profile**

```bash
git add integrations/recall-bench/profiles/ea-180d-daftari.yaml
git commit -m "feat(recall-bench): EA daftari profile + smoke config"
```

---

### Task 7: Full baseline run + results note

**Files:**
- Create: `docs/superpowers/results/2026-06-XX-recall-bench-baseline.md`

- [ ] **Step 1: Switch the profile to the full run** — `ranges: { start: 6, end: 180, step: 6 }`, `sample: 50`, appellate on. Run with `--json-out bench-results/drafts/daftari-ea-180d/result.json` and `--resume` on its `progress.jsonl` if interrupted (~1–3 hrs).

- [ ] **Step 2: Write the results note** — daftari baseline composite + per-checkpoint degradation curve + `contradiction-resolution` failure analysis (does daftari return stale revisions? quote `failures.jsonl` retrieval entries). **State the cross-system comparability caveat** (Claude+MiniLM vs published gpt-5.4+OpenAI-emb): clean claims are the within-daftari picture + failure modes; cross-system numbers are directional only. **Also state explicitly (spec spike-finding 1): this is daftari's FIRST retrieval-only evaluation — `daftari eval` is the cortex answer-quality metric (LLM-judged over a generated subgraph), with no recall@k/nDCG over a labeled query→doc set; do not let a reader assume the eval already existed.**

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/results/2026-06-XX-recall-bench-baseline.md
git commit -m "docs(recall-bench): SP1 baseline results note"
```

---

## Definition of done (mirrors the spec)

- [ ] `integrations/recall-bench/` builds; `createDaftariAdapter` satisfies `MemorySystemAdapter` (incl. `name`); `npx vitest run integrations/recall-bench/src` green.
- [ ] Smoke run completes end-to-end against Recall Bench.
- [ ] Full EA-180d baseline produces `result.json` + failure logs.
- [ ] **`contradiction-resolution` QAs confirmed evaluated at ≥1 checkpoint after their revision day** — else the headline analysis has no data.
- [ ] Results note written with the cross-system comparability caveat stated.

## Notes / gotchas

- **Deep imports** from `../../dist/**` require a prior root `npm run build`; if daftari source changes, rebuild before re-running the adapter.
- **`gray-matter` vs daftari parser** in tests: use whichever the repo already provides; do not add a dep.
- **Recall Bench factory arity** (Task 5 Step 1) is the one unverified upstream contract — confirm against the bench's adapter loader before the smoke run.
- **No ranking change** anywhere in SP1 — `src/search/hybrid.ts` is untouched. Supersession ranking is SP2.
