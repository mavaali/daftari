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
import { stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ok } from "../../../dist/frontmatter/types.js";
import type { ReindexResult } from "../../../dist/search/reindex.js";
import type {
  LlmClient,
  CompleteWithToolsOpts,
} from "../../../dist/eval/llm.js";
import {
  createDaftariAdapter,
  assertCleanReindex,
  isUnderTmpdir,
  resolveAnswererClient,
} from "./adapter.js";
import { parseConfig } from "./config.js";

const RUN = !!process.env.RB_INTEGRATION;

// A no-op LlmClient stub — enough to assert identity selection without network.
const stubLlm = {
  completeWithTools: async () => ok({ text: "", tool_calls: [] }),
} as unknown as LlmClient;

function cfgWith(over: Record<string, unknown>) {
  const r = parseConfig({ answererModel: "x", ...over });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("resolveAnswererClient", () => {
  it("returns an injected client verbatim, ignoring transport", () => {
    const cfg = cfgWith({ answererTransport: "openrouter" });
    expect(resolveAnswererClient(cfg, { llm: stubLlm })).toBe(stubLlm);
  });

  it("builds an openrouter client (completeWithTools present) when the key is set", () => {
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    try {
      const client = resolveAnswererClient(cfgWith({ answererTransport: "openrouter" }), {});
      expect(typeof client.completeWithTools).toBe("function");
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it("throws a clear error for the openrouter transport with no key", () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => resolveAnswererClient(cfgWith({ answererTransport: "openrouter" }), {})).toThrow(
        /OPENROUTER_API_KEY/,
      );
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });
});

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

// --- compile axis tests ---

// A stub LlmClient for the COMPILER that:
//   - records all calls made to it (day number embedded in user message)
//   - on each call, emits a single vault_write tool call for a deterministic path
//   - captures the user message so tests can assert priorDayPaths growth
//
// The stub drives completeWithTools synchronously: it inspects the user prompt,
// derives a path from the day number, and returns a vault_write tool_call record.
// We DO NOT call the real toolHandler (no vault I/O needed for hermetic tests) —
// the adapter only needs the returned tool_calls list to populate notesWritten.
// The compiler's notesWritten logic reads tool_calls from the LLM response, NOT
// from real vault writes, so this is sufficient for priorDayPaths-growth assertions.
function makeCompilerStubLlm(): {
  llm: LlmClient;
  calls: Array<{ userMessage: string; returnedPath: string }>;
} {
  const calls: Array<{ userMessage: string; returnedPath: string }> = [];

  const llm: LlmClient = {
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
      // Extract day number from "## Day N —" in the user message.
      const match = opts.user.match(/## Day (\d+)/);
      const dayNum = match ? match[1] : "0";
      const returnedPath = `topics/day-${dayNum.padStart(4, "0")}-topic.md`;

      calls.push({ userMessage: opts.user, returnedPath });

      // Return a vault_write tool call with the deterministic path.
      // output must NOT contain tool_error so the compiler includes it in notesWritten.
      return ok({
        text: "done",
        tool_calls: [
          {
            tool: "vault_write" as const,
            input: { path: returnedPath, content: `# Day ${dayNum}` },
            output: { ok: true },
            latency_ms: 1,
          },
        ],
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn" as const,
      });
    },
  };

  return { llm, calls };
}

describe("compile axis — hermetic (no MiniLM)", () => {
  it("compile:write — setup writes WIKI.md into the vault with EA page types", async () => {
    const { llm } = makeCompilerStubLlm();
    const adapter = await createDaftariAdapter(
      { answererModel: "stub-model", compile: "write" },
      { llm },
    );
    const vaultRoot = await adapter.setup();

    const wikiPath = join(vaultRoot, "WIKI.md");
    const wikiContent = await readFile(wikiPath, "utf8");

    expect(wikiContent).toContain("topics/");
    expect(wikiContent).toContain("decisions/");
    expect(wikiContent).toContain("entities/");
    expect(wikiContent).toContain("tasks/");
    expect(wikiContent).toContain("tensions/");

    await adapter.teardown();
  });

  it("compile:write — compiler invoked once per day, priorDayPaths grows across days", async () => {
    const { llm, calls } = makeCompilerStubLlm();
    const adapter = await createDaftariAdapter(
      { answererModel: "stub-model", compile: "write" },
      { llm },
    );
    await adapter.setup();

    const META1 = { dayNumber: 1, date: "2026-01-01", personaId: "persona-a", activeArcs: ["arc1"] };
    const META2 = { dayNumber: 2, date: "2026-01-02", personaId: "persona-a", activeArcs: ["arc1"] };

    await adapter.ingestDay(1, "Day one content.", META1);
    await adapter.ingestDay(2, "Day two content.", META2);

    // Compiler was called exactly once per day.
    expect(calls.length).toBe(2);

    // Day 1 call: no prior paths yet — user message should say "No prior-day pages exist yet."
    expect(calls[0].userMessage).toContain("No prior-day pages exist yet");

    // Day 2 call: priorDayPaths must include the path written on day 1.
    const day1Path = calls[0].returnedPath; // e.g. "topics/day-0001-topic.md"
    expect(calls[1].userMessage).toContain(day1Path);

    await adapter.teardown();
  });

  it("compile:write+consolidate — ingestDay throws Phase 2 error immediately", async () => {
    const { llm } = makeCompilerStubLlm();
    const adapter = await createDaftariAdapter(
      { answererModel: "stub-model", compile: "write+consolidate" },
      { llm },
    );
    await adapter.setup();

    const META1 = { dayNumber: 1, date: "2026-01-01", personaId: "persona-a", activeArcs: ["arc1"] };
    await expect(adapter.ingestDay(1, "content", META1)).rejects.toThrow(/Phase 2/);

    await adapter.teardown();
  });

  it("compile:raw — existing raw behavior is unchanged (no compiler invoked)", async () => {
    const { llm, calls } = makeCompilerStubLlm();
    // compile defaults to "raw"; pass llm as the answerer stub only
    const adapter = await createDaftariAdapter(
      { answererModel: "stub-model" },
      { llm },
    );
    const vaultRoot = await adapter.setup();

    // WIKI.md should NOT exist for raw mode
    const wikiPath = join(vaultRoot, "WIKI.md");
    await expect(stat(wikiPath)).rejects.toThrow();

    const META1 = { dayNumber: 1, date: "2026-01-01", personaId: "persona-a", activeArcs: ["arc1"] };
    await adapter.ingestDay(1, "Day one content.", META1);

    // Compiler LLM (completeWithTools for authoring) must NOT have been called
    expect(calls.length).toBe(0);

    await adapter.teardown();
  });
});
