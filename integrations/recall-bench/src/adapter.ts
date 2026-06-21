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
import type { LlmClient } from "../../../dist/eval/llm.js";
import { parseConfig, type AdapterConfig } from "./config.js";
import { makeAnswerer, type RetrievalEntry, type ToolCallRecord } from "./answerer.js";
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

// The three runtime confound guards on a reindex result. Factored out as a pure
// function so the throw branches can be unit-tested on hand-built results
// without a real (MiniLM-loading) reindex. A coerced or dropped daily silently
// corrupts the baseline; BM25-only (vectors off) would too.
export function assertCleanReindex(r: ReindexResult): void {
  if (r.invalidFrontmatter.length > 0) {
    throw new Error(
      `recall-bench: ${r.invalidFrontmatter.length} daily(ies) indexed with COERCED frontmatter — baseline invalid: ` +
        r.invalidFrontmatter.map((f) => `${f.path}: ${f.reason}`).join("; "),
    );
  }
  if (r.skipped.length > 0) {
    throw new Error(
      `recall-bench: ${r.skipped.length} daily(ies) NOT indexed: ` +
        r.skipped.map((f) => `${f.path}: ${f.reason}`).join("; "),
    );
  }
  if (!r.vectorEnabled) {
    throw new Error(
      "recall-bench: MiniLM vectors disabled — BM25-only would confound the baseline. Aborting; re-run.",
    );
  }
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
      answer = makeAnswerer(vaultRoot, cfg, deps.llm);
      return vaultRoot;
    },

    async ingestDay(day: number, content: string, meta: DayMetadata): Promise<void> {
      if (vaultRoot === null) throw new Error("recall-bench: ingestDay before setup()");
      const daily = mapDay(day, content, meta);
      const abs = join(vaultRoot, daily.relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, daily.markdown, "utf8");
    },

    async finalizeIngestion(): Promise<void> {
      if (vaultRoot === null) throw new Error("recall-bench: finalizeIngestion before setup()");
      // reindex re-stages the WHOLE cumulative vault each call — idempotent by
      // design; calling finalize after each ingest batch is expected.
      const res = await reindexVault(vaultRoot);
      if (!res.ok) throw res.error;
      assertCleanReindex(res.value);
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
    },
  };
}
