// Tests for the Recall Bench adapter lifecycle (Task 4).
//
// HERMETIC block: the tmpdir teardown guard and the three reindex confound
// guards (assertCleanReindex) on hand-built ReindexResult objects — no MiniLM,
// no real reindex.
//
// INTEGRATION block (gated RB_INTEGRATION): full setup → ingest → finalize →
// queryDetail → teardown against a real index, plus idempotency. The LLM is
// stubbed; the search index is real.

import { describe, it, expect } from "vitest";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ok } from "../../../dist/frontmatter/types.js";
import type { ReindexResult } from "../../../dist/search/reindex.js";
import type {
  LlmClient,
  CompleteWithToolsOpts,
} from "../../../dist/eval/llm.js";
import { createDaftariAdapter, assertCleanReindex, isUnderTmpdir } from "./adapter.js";

const RUN = !!process.env.RB_INTEGRATION;

// A clean baseline ReindexResult: every confound guard passes.
function cleanResult(over: Partial<ReindexResult> = {}): ReindexResult {
  return {
    documentCount: 2,
    chunkCount: 2,
    vectorEnabled: true,
    skipped: [],
    invalidFrontmatter: [],
    indexedAt: "2026-01-01T00:00:00.000Z",
    embeddedCount: 2,
    cacheHits: 0,
    orphansRemoved: 0,
    ...over,
  };
}

describe("assertCleanReindex", () => {
  it("does not throw on a clean result", () => {
    expect(() => assertCleanReindex(cleanResult())).not.toThrow();
  });

  it("throws when a daily was indexed with coerced frontmatter", () => {
    const r = cleanResult({
      invalidFrontmatter: [{ path: "persona-a/day-0001.md", reason: "bad enum" }],
    });
    expect(() => assertCleanReindex(r)).toThrow(/COERCED frontmatter/);
    expect(() => assertCleanReindex(r)).toThrow(/persona-a\/day-0001\.md: bad enum/);
  });

  it("throws when a daily was not indexed at all", () => {
    const r = cleanResult({
      skipped: [{ path: "persona-a/day-0002.md", reason: "malformed YAML" }],
    });
    expect(() => assertCleanReindex(r)).toThrow(/NOT indexed/);
    expect(() => assertCleanReindex(r)).toThrow(/persona-a\/day-0002\.md: malformed YAML/);
  });

  it("throws when MiniLM vectors are disabled (BM25-only would confound)", () => {
    const r = cleanResult({ vectorEnabled: false });
    expect(() => assertCleanReindex(r)).toThrow(/MiniLM vectors disabled/);
  });
});

describe("isUnderTmpdir (teardown guard decision)", () => {
  it("accepts a path inside os.tmpdir()", () => {
    expect(isUnderTmpdir(resolve(tmpdir(), "rb-daftari-abc123"))).toBe(true);
  });

  it("accepts os.tmpdir() itself", () => {
    expect(isUnderTmpdir(tmpdir())).toBe(true);
  });

  it("rejects an absolute path outside tmpdir (would be a destructive rm)", () => {
    expect(isUnderTmpdir("/etc")).toBe(false);
    expect(isUnderTmpdir(resolve(tmpdir(), "..", "not-tmp"))).toBe(false);
  });

  it("rejects a tmpdir-prefix sibling (no partial-segment match)", () => {
    // e.g. /tmp-evil must not pass just because it starts with the /tmp string.
    expect(isUnderTmpdir(resolve(tmpdir()) + "-evil")).toBe(false);
  });
});

describe("teardown without setup", () => {
  it("is a safe no-op (nothing to remove)", async () => {
    const adapter = await createDaftariAdapter({ answererModel: "stub" });
    await expect(adapter.teardown()).resolves.toBeUndefined();
  });
});

// --- INTEGRATION ---

function makeStubLlm(): LlmClient {
  return {
    async complete() {
      return ok({ text: "stub", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" });
    },
    async completeJson() {
      return ok({
        text: "stub",
        parsed: {},
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn",
      });
    },
    async completeWithTools(opts: CompleteWithToolsOpts) {
      // Drive the REAL tool handler so retrieval comes from the genuine index.
      const output = await opts.toolHandler("vault_search", { query: opts.user });
      return ok({
        text: `Answer derived from search. [persona-a/day-0001.md]`,
        tool_calls: [
          { tool: "vault_search", input: { query: opts.user }, output, latency_ms: 1 },
        ],
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn",
      });
    },
  };
}

const META = (n: number, arc: string) => ({
  dayNumber: n,
  date: `2026-01-${String(n).padStart(2, "0")}`,
  personaId: "persona-a",
  activeArcs: [arc],
});

describe.skipIf(!RUN)("createDaftariAdapter (integration)", () => {
  it("setup → ingest 2 dailies → finalize → queryDetail returns answer + retrieval", async () => {
    const adapter = await createDaftariAdapter(
      { answererModel: "stub-model" },
      { llm: makeStubLlm() },
    );
    expect(adapter.name).toContain("daftari");

    await adapter.setup();
    await adapter.ingestDay(1, "The secret gemstone is sapphire.", META(1, "gemstones"));
    await adapter.ingestDay(2, "Lunch was ramen near the office.", META(2, "food"));
    await adapter.finalizeIngestion();

    const detail = await adapter.queryDetail("What is the secret gemstone?");
    expect(typeof detail.answer).toBe("string");
    expect(detail.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(detail.retrieval)).toBe(true);
    expect(detail.retrieval.some((r) => r.path === "persona-a/day-0001.md")).toBe(true);

    const answerStr = await adapter.query("What is the secret gemstone?");
    expect(typeof answerStr).toBe("string");

    await adapter.teardown();
  }, 180_000);

  it("is idempotent across multiple finalize calls and retains earlier dailies", async () => {
    const adapter = await createDaftariAdapter(
      { answererModel: "stub-model" },
      { llm: makeStubLlm() },
    );
    await adapter.setup();

    await adapter.ingestDay(1, "Day one fact: the codeword is sapphire.", META(1, "arc1"));
    await adapter.finalizeIngestion();

    await adapter.ingestDay(2, "Day two fact: the codeword is unrelated.", META(2, "arc2"));
    await adapter.finalizeIngestion(); // second finalize — must not throw

    const detail = await adapter.queryDetail("What is the codeword?");
    // day-0001 still present after the second cumulative reindex.
    expect(detail.retrieval.some((r) => r.path === "persona-a/day-0001.md")).toBe(true);

    await adapter.teardown();
  }, 180_000);

  it("setup creates a temp vault under os.tmpdir() and teardown removes it", async () => {
    const adapter = await createDaftariAdapter(
      { answererModel: "stub-model" },
      { llm: makeStubLlm() },
    );
    const vaultRoot = await adapter.setup();
    expect(resolve(vaultRoot).startsWith(resolve(tmpdir()))).toBe(true);

    // dir exists after setup
    const before = await stat(vaultRoot);
    expect(before.isDirectory()).toBe(true);

    await adapter.teardown();
    await expect(stat(vaultRoot)).rejects.toThrow();
  }, 60_000);
});
