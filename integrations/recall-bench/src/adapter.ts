// Recall Bench MemorySystemAdapter for daftari (Task 4).
//
// Lifecycle: setup() spins up an ephemeral vault under os.tmpdir(); ingestDay()
// maps a benchmark day onto a daftari daily and writes it; finalizeIngestion()
// reindexes the cumulative vault (loading MiniLM) and ASSERTS the index is clean
// — any coerced/dropped daily or disabled vectors would silently corrupt the
// baseline, so finalize throws rather than running a confounded benchmark.
// query()/queryDetail() both delegate to a single runQuery() closure that
// swallows per-question errors so one bad question can't abort a long run.
// teardown() verifies the vault is under tmpdir BEFORE rm -rf.
//
// Factory contract (verified against the harness): the harness calls
// factory(config) with a SINGLE arg (sync or async). deps is a second, internal
// arg used by tests to inject a stub LlmClient; the harness never passes it.
// The returned object satisfies MemorySystemAdapter:
//   { name, setup, ingestDay, finalizeIngestion, query, teardown, queryDetail? }.
//
// Lifecycle methods MAY throw (per the bench adapter contract), unlike daftari's
// internal Result convention.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { reindexVault, type ReindexResult } from "../../../dist/search/reindex.js";
import { createAnthropicClient, type LlmClient } from "../../../dist/eval/llm.js";
import { createOpenRouterClient } from "../../../dist/eval/llm-openrouter.js";
import { runConsolidate } from "../../../dist/consolidate/index.js";
import { parseConfig, type AdapterConfig } from "./config.js";
import { makeAnswerer, type RetrievalEntry, type ToolCallRecord } from "./answerer.js";
import { makeCompiler } from "./compiler.js";
import { enableRealConsolidation } from "./consolidate-config.js";
import { EA_WIKI_MD } from "./wiki-schema.js";
import { mapDay } from "./corpus-map.js";
import type { DayMetadata } from "./types.js";

// What queryDetail returns (query() returns just the answer string).
export interface QueryDetail {
  answer: string;
  retrieval: RetrievalEntry[];
  toolCalls: ToolCallRecord[];
}

export interface DaftariAdapter {
  name: string;
  setup(): Promise<string>;
  ingestDay(day: number, content: string, meta: DayMetadata): Promise<void>;
  finalizeIngestion(): Promise<void>;
  query(question: string): Promise<string>;
  queryDetail(question: string): Promise<QueryDetail>;
  teardown(): Promise<void>;
}

export interface AdapterDeps {
  llm?: LlmClient;
  // Test seam: injected instead of the real runConsolidate so hermetic tests
  // can assert call shape without network/LLM spend.
  runConsolidateFn?: (argv: string[]) => Promise<number>;
}

// Projected total Stage-2 LLM calls for a consolidation pass over `noteCount`
// notes. Each birth item fans out to ~40 LLM calls per the consolidate help
// text ("each birth item fans out to ~40 LLM calls, so real calls ~= items x
// fan-out"). Used to log a projected-spend warning before the real pass runs.
export function projectedConsolidateCalls(noteCount: number): number {
  return noteCount * 40;
}

// True iff `path` resolves to a location inside os.tmpdir(). teardown() gates
// the rm -rf on this so a misconfigured/poisoned vaultRoot can never delete a
// directory outside the temp tree. Pure + exported so the decision is unit
// testable without provoking a real removal.
export function isUnderTmpdir(path: string): boolean {
  const root = resolve(tmpdir());
  const target = resolve(path);
  return target === root || target.startsWith(root + sep);
}

// Known wiki scaffolding files written by compile:write setup — these carry no
// daftari frontmatter by design and must not trigger the confound guard.
const WIKI_SCAFFOLDING = new Set(["WIKI.md", "index.md", "log.md"]);

// The three runtime confound guards on a reindex result. Factored out as a pure
// function so the throw branches can be unit-tested on hand-built results
// without a real (MiniLM-loading) reindex. A coerced or dropped daily silently
// corrupts the baseline; BM25-only (vectors off) would too.
//
// ignoreBasenames: basenames to exclude from invalidFrontmatter/skipped checks.
// Default is an empty set (raw mode — identical behavior to before this param).
export function assertCleanReindex(
  r: ReindexResult,
  ignoreBasenames: Set<string> = new Set(),
): void {
  const invalidFiltered = r.invalidFrontmatter.filter(
    (f) => !ignoreBasenames.has(f.path.split("/").pop() ?? f.path),
  );
  if (invalidFiltered.length > 0) {
    throw new Error(
      `recall-bench: ${invalidFiltered.length} daily(ies) indexed with COERCED frontmatter — baseline invalid: ` +
        invalidFiltered.map((f) => `${f.path}: ${f.reason}`).join("; "),
    );
  }
  const skippedFiltered = r.skipped.filter(
    (f) => !ignoreBasenames.has(f.path.split("/").pop() ?? f.path),
  );
  if (skippedFiltered.length > 0) {
    throw new Error(
      `recall-bench: ${skippedFiltered.length} daily(ies) NOT indexed: ` +
        skippedFiltered.map((f) => `${f.path}: ${f.reason}`).join("; "),
    );
  }
  if (!r.vectorEnabled) {
    throw new Error(
      "recall-bench: MiniLM vectors disabled — BM25-only would confound the baseline. Aborting; re-run.",
    );
  }
}

// Pick the LlmClient for the answerer. An injected client (deps.llm, used by
// tests) always wins; otherwise the transport axis decides — openrouter routes
// through OPENROUTER_API_KEY (the no-Anthropic-key escape hatch), anthropic uses
// the native SDK. Exported so the selection is unit-testable without a run.
export function resolveAnswererClient(cfg: AdapterConfig, deps: AdapterDeps): LlmClient {
  if (deps.llm) return deps.llm;
  return cfg.answererTransport === "openrouter"
    ? createOpenRouterClient()
    : createAnthropicClient();
}

export async function createDaftariAdapter(
  rawConfig: Record<string, unknown>,
  deps: AdapterDeps = {},
): Promise<DaftariAdapter> {
  const parsed = parseConfig(rawConfig);
  if (!parsed.ok) throw parsed.error;
  const cfg: AdapterConfig = parsed.value;

  let vaultRoot: string | null = null;
  let answer: ((q: string) => Promise<QueryDetail>) | null = null;
  let compiler: ReturnType<typeof makeCompiler> | null = null;
  let priorDayPaths: string[] = [];

  // Single source of truth for question handling. Both query() and queryDetail()
  // delegate here (NOT via this.queryDetail) so the error envelope is identical
  // and one bad question returns a sentinel instead of aborting the run.
  async function runQuery(question: string): Promise<QueryDetail> {
    if (answer === null) {
      throw new Error("recall-bench: query before setup() — no answerer initialized");
    }
    try {
      return await answer(question);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        answer: `[daftari_error: ${msg}]`,
        retrieval: [],
        toolCalls: [{ tool: "daftari_error", args: {}, resultPreview: msg.slice(0, 200) }],
      };
    }
  }

  return {
    name: `daftari (claude=${cfg.answererModel}, minilm)`,

    async setup(): Promise<string> {
      vaultRoot = await mkdtemp(join(tmpdir(), "rb-daftari-"));
      answer = makeAnswerer(vaultRoot, cfg, resolveAnswererClient(cfg, deps));
      if (cfg.compile !== "raw") {
        await writeFile(join(vaultRoot, "WIKI.md"), EA_WIKI_MD, "utf8");
        compiler = makeCompiler(vaultRoot, cfg, resolveAnswererClient(cfg, deps));
      }
      priorDayPaths = [];
      return vaultRoot;
    },

    async ingestDay(day: number, content: string, meta: DayMetadata): Promise<void> {
      if (vaultRoot === null) throw new Error("recall-bench: ingestDay before setup()");
      if (cfg.compile === "raw") {
        const daily = mapDay(day, content, meta);
        const abs = join(vaultRoot, daily.relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, daily.markdown, "utf8");
      } else {
        // Both "write" and "write+consolidate" use the per-day compiler.
        // The consolidation pass runs later in finalizeIngestion for write+consolidate.
        const r = await compiler!(day, content, meta, priorDayPaths);
        priorDayPaths = priorDayPaths.concat(r.notesWritten);
      }
    },

    async finalizeIngestion(): Promise<void> {
      if (vaultRoot === null) throw new Error("recall-bench: finalizeIngestion before setup()");
      // reindex re-stages the WHOLE cumulative vault each call — idempotent by
      // design; calling finalize after each ingest batch is expected.
      const res = await reindexVault(vaultRoot);
      if (!res.ok) throw res.error;
      assertCleanReindex(res.value, cfg.compile === "raw" ? new Set() : WIKI_SCAFFOLDING);

      if (cfg.compile === "write+consolidate") {
        // Enable real (non-shadow) consolidation in the tmpdir vault.
        enableRealConsolidation(vaultRoot);

        const projected = projectedConsolidateCalls(priorDayPaths.length);
        console.error(
          "recall-bench: projected consolidate LLM calls (cap " +
            cfg.maxLlmCalls +
            "): ~" +
            projected,
        );

        // Use injected fn (test seam) or the real runConsolidate.
        const consolidateFn = deps.runConsolidateFn ?? runConsolidate;
        const rc = await consolidateFn([
          "--vault",
          vaultRoot,
          "--mode",
          "both",
          "--max-llm-calls",
          String(cfg.maxLlmCalls),
          "--transport",
          "openrouter",
        ]);
        if (rc !== 0) {
          throw new Error(`recall-bench: consolidate exited with code ${rc}`);
        }

        // Re-index so consolidation's edge/tension writes are picked up.
        const res2 = await reindexVault(vaultRoot);
        if (!res2.ok) throw res2.error;
        assertCleanReindex(res2.value, WIKI_SCAFFOLDING);
      }
    },

    async query(question: string): Promise<string> {
      return (await runQuery(question)).answer;
    },

    async queryDetail(question: string): Promise<QueryDetail> {
      return runQuery(question);
    },

    async teardown(): Promise<void> {
      if (vaultRoot === null) return; // never set up → nothing to remove
      if (!isUnderTmpdir(vaultRoot)) {
        throw new Error(
          `recall-bench: refusing to rm a vault outside os.tmpdir(): ${resolve(vaultRoot)}`,
        );
      }
      await rm(resolve(vaultRoot), { recursive: true, force: true });
      vaultRoot = null;
      answer = null;
      compiler = null;
      priorDayPaths = [];
    },
  };
}
