// Tests for the distill claim-extraction stage (U3).
//
// The LLM is MOCKED throughout — these tests assert on the engine's handling
// of responses (claim shape, claim_key determinism, budget exhaustion,
// maxClaims truncation, malformed-response resilience), not model quality.

import { describe, expect, it } from "vitest";
import { withCallBudget } from "../../src/consolidate/call-budget.js";
import type { NormalizedMessage } from "../../src/distill/adapters/types.js";
import { chunkMessages } from "../../src/distill/chunk.js";
import { extractClaims } from "../../src/distill/extract.js";
import type { CompleteJsonResult, LlmClient } from "../../src/eval/llm.js";
import type { CortexEvalError } from "../../src/eval/types.js";
import { err, ok, type Result } from "../../src/frontmatter/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(i: number, text: string): NormalizedMessage {
  return {
    ts: `2026-05-01T10:${String(i % 60).padStart(2, "0")}:00`,
    sender: i % 2 === 0 ? "Alice" : "Bob",
    type: "text",
    text,
    attachment: null,
  };
}

const TRANSCRIPT: NormalizedMessage[] = [
  msg(0, "let's use postgres for the new service"),
  msg(1, "agreed, postgres it is"),
  msg(2, "also the launch moves to June 3rd"),
  msg(3, "noted, June 3rd"),
];

const OPTS = { model: "test-model", maxClaims: 50, inCallInputCap: 16000 };

function jsonOk(
  parsed: unknown,
  meta?: { servedModel?: string; effectiveTemperature?: number; viaRetry?: boolean },
): Result<CompleteJsonResult, CortexEvalError> {
  return ok({
    text: JSON.stringify(parsed),
    input_tokens: 1,
    output_tokens: 1,
    stop_reason: "end_turn",
    parsed,
    ...meta,
  });
}

// A mock client whose completeJson returns the given parsed payloads in order,
// repeating the last one when calls exceed the list.
function mockLlm(payloads: unknown[]): LlmClient & { calls: number } {
  let calls = 0;
  const client = {
    get calls() {
      return calls;
    },
    complete: () => {
      throw new Error("not used");
    },
    completeWithTools: () => {
      throw new Error("not used");
    },
    completeJson: async () => {
      const payload = payloads[Math.min(calls, payloads.length - 1)];
      calls++;
      return jsonOk(payload);
    },
  };
  return client as unknown as LlmClient & { calls: number };
}

// ---------------------------------------------------------------------------
// Scenario 1: short transcript chunk → ≥1 claim with statement + claim_key
// ---------------------------------------------------------------------------

describe("extractClaims — basic extraction", () => {
  it("yields claims with non-empty statement, claim_key, and proposed_frontmatter", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 4);
    const llm = mockLlm([
      {
        claims: [
          { statement: "Use postgres for the new service" },
          { statement: "Launch moves to June 3rd" },
        ],
      },
    ]);

    const out = await extractClaims(chunks, llm, OPTS);

    expect(out.budget_exhausted).toBe(false);
    expect(out.claims.length).toBeGreaterThanOrEqual(1);
    for (const c of out.claims) {
      expect(c.statement.trim().length).toBeGreaterThan(0);
      expect(c.claim_key.length).toBeGreaterThan(0);
      expect(c.proposed_frontmatter.title.trim().length).toBeGreaterThan(0);
    }
  });

  it("skips malformed claim entries without throwing", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 4);
    const llm = mockLlm([
      { claims: [{ statement: "Good claim" }, { statement: "" }, { nope: true }, 42] },
    ]);

    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].statement).toBe("Good claim");
  });

  it("records a chunk error and continues when a response is not the expected shape", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 2); // 2 chunks
    const llm = mockLlm(["not an object", { claims: [{ statement: "Second chunk claim" }] }]);

    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
    expect(out.chunkErrors).toHaveLength(1);
    expect(out.budget_exhausted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: determinism — same input + same LLM output ⇒ same claim_keys
// ---------------------------------------------------------------------------

describe("extractClaims — claim_key determinism", () => {
  it("produces identical claim_keys across two runs on identical input", async () => {
    const payload = [
      {
        claims: [
          { statement: "Use postgres for the new service" },
          { statement: "Launch moves to June 3rd" },
        ],
      },
    ];
    const chunks1 = chunkMessages(TRANSCRIPT, 4);
    const chunks2 = chunkMessages(TRANSCRIPT, 4);

    const run1 = await extractClaims(chunks1, mockLlm(payload), OPTS);
    const run2 = await extractClaims(chunks2, mockLlm(payload), OPTS);

    expect(run1.claims.map((c) => c.claim_key)).toEqual(run2.claims.map((c) => c.claim_key));
  });

  it("gives distinct claims distinct keys, not ordinals", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 4);
    const llm = mockLlm([
      { claims: [{ statement: "Alpha decision" }, { statement: "Beta decision" }] },
    ]);
    const out = await extractClaims(chunks, llm, OPTS);
    const keys = out.claims.map((c) => c.claim_key);
    expect(new Set(keys).size).toBe(keys.length);
    // keys derive from anchor + statement slug, not array position
    expect(keys[0]).toContain("alpha-decision");
    expect(keys[1]).toContain("beta-decision");
  });

  it("dedupes identical statements within a run (same key kept once)", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 4);
    const llm = mockLlm([{ claims: [{ statement: "Same claim" }, { statement: "Same claim" }] }]);
    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: budget exhausted mid-run → partial claims + marker, no throw
// ---------------------------------------------------------------------------

describe("extractClaims — budget exhaustion", () => {
  it("returns partial claims plus budget_exhausted: true when withCallBudget cuts off", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 1); // 4 chunks → 4 wanted calls
    const raw = mockLlm([{ claims: [{ statement: "One claim per chunk" }] }]);
    const llm = withCallBudget(raw, 2); // only 2 calls allowed

    const out = await extractClaims(chunks, llm, OPTS);

    expect(out.budget_exhausted).toBe(true);
    // One claim per completed chunk — distinct anchors keep the keys distinct.
    expect(out.claims).toHaveLength(2);
    expect(raw.calls).toBe(2); // no network attempts past the budget
  });

  it("does not flag budget_exhausted on a non-budget LLM error", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 4);
    const llm = {
      complete: () => {
        throw new Error("not used");
      },
      completeWithTools: () => {
        throw new Error("not used");
      },
      completeJson: async () =>
        err<CortexEvalError>({ kind: "llm", message: "boom", retryable: false }),
    } as unknown as LlmClient;

    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.budget_exhausted).toBe(false);
    expect(out.claims).toEqual([]);
    expect(out.chunkErrors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Per-claim run metadata threading (6mf.6)
// ---------------------------------------------------------------------------

describe("extractClaims — per-claim run metadata", () => {
  // A mock client whose completeJson returns the given (parsed, meta) pairs in
  // order — lets a test give different chunks different run metadata.
  function mockLlmWithMeta(
    entries: Array<{
      parsed: unknown;
      meta?: { servedModel?: string; effectiveTemperature?: number; viaRetry?: boolean };
    }>,
  ): LlmClient {
    let calls = 0;
    return {
      complete: () => {
        throw new Error("not used");
      },
      completeWithTools: () => {
        throw new Error("not used");
      },
      completeJson: async () => {
        const e = entries[Math.min(calls, entries.length - 1)];
        calls++;
        return jsonOk(e.parsed, e.meta);
      },
    } as unknown as LlmClient;
  }

  it("attaches the producing call's run metadata to each claim", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 4); // single chunk
    const llm = mockLlmWithMeta([
      {
        parsed: { claims: [{ statement: "Use postgres for the new service" }] },
        meta: { servedModel: "claude-served-1", effectiveTemperature: 0, viaRetry: false },
      },
    ]);

    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
    const rm = out.claims[0].run_meta;
    expect(rm).toBeDefined();
    if (!rm) return;
    expect(rm.servedModel).toBe("claude-served-1");
    expect(rm.effectiveTemperature).toBe(0);
    expect(rm.viaRetry).toBe(false);
    // requestedModel + run knobs are the run's config values, stamped per claim.
    expect(rm.requestedModel).toBe(OPTS.model);
    expect(rm.chunkWindow).toBe(chunks[0].endIndex - chunks[0].startIndex + 1);
    expect(rm.inputCap).toBe(OPTS.inCallInputCap);
  });

  it("carries viaRetry:true through to the claims of a retried chunk", async () => {
    // Two chunks: first chunk's call was salvaged via retry (temp bumped to
    // 0.2), second was a clean first-try. The claims must carry their own
    // chunk's metadata, not a single run-wide value.
    const chunks = chunkMessages(TRANSCRIPT, 2); // 2 chunks
    const llm = mockLlmWithMeta([
      {
        parsed: { claims: [{ statement: "Retried chunk claim" }] },
        meta: { servedModel: "served-retry", effectiveTemperature: 0.2, viaRetry: true },
      },
      {
        parsed: { claims: [{ statement: "Clean chunk claim" }] },
        meta: { servedModel: "served-clean", effectiveTemperature: 0, viaRetry: false },
      },
    ]);

    const out = await extractClaims(chunks, llm, OPTS);
    const byStatement = new Map(out.claims.map((c) => [c.statement, c.run_meta]));
    const retried = byStatement.get("Retried chunk claim");
    const clean = byStatement.get("Clean chunk claim");
    expect(retried?.viaRetry).toBe(true);
    expect(retried?.effectiveTemperature).toBe(0.2);
    expect(clean?.viaRetry).toBe(false);
    expect(clean?.effectiveTemperature).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: maxClaims truncation
// ---------------------------------------------------------------------------

describe("extractClaims — maxClaims", () => {
  it("truncates to maxClaims and stops calling the LLM once reached", async () => {
    const chunks = chunkMessages(TRANSCRIPT, 1); // 4 chunks
    const llm = mockLlm([
      { claims: [{ statement: "c1" }, { statement: "c2" }, { statement: "c3" }] },
    ]);

    const out = await extractClaims(chunks, llm, { ...OPTS, maxClaims: 4 });

    expect(out.claims).toHaveLength(4);
    expect(llm.calls).toBe(2); // third and fourth chunks never dispatched
  });
});

// ---------------------------------------------------------------------------
// Defect 2: titleOf — word-boundary truncation, no ellipsis
// ---------------------------------------------------------------------------

describe("extractClaims — title word-boundary truncation (Defect 2)", () => {
  it("returns the full statement as title when it is <= 80 chars", async () => {
    const statement = "A".repeat(80);
    const chunks = chunkMessages([msg(0, "irrelevant")], 1);
    const llm = mockLlm([{ claims: [{ statement }] }]);
    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].proposed_frontmatter.title).toBe(statement);
  });

  it("truncates a >80-char statement to <= 80 chars with NO trailing ellipsis", async () => {
    // 90-char statement, all one word — hard-cut at 80 expected.
    const statement = "A".repeat(90);
    const chunks = chunkMessages([msg(0, "irrelevant")], 1);
    const llm = mockLlm([{ claims: [{ statement }] }]);
    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
    const title = out.claims[0].proposed_frontmatter.title;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).not.toContain("…");
    expect(title).not.toContain("...");
  });

  it("truncates at a word boundary, not mid-word, when possible", async () => {
    // Build a statement where the 80th char is mid-word.
    // "word1 word2 " repeated so that position 80 falls inside a word.
    // "Hello world " is 12 chars. 6 repetitions = 72 chars, then we add
    // enough to push past 80 with a partial word.
    const stmt = "Hello world ".repeat(6) + "overflow_extra_word"; // 72 + 19 = 91 chars
    const chunks = chunkMessages([msg(0, "irrelevant")], 1);
    const llm = mockLlm([{ claims: [{ statement: stmt }] }]);
    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
    const title = out.claims[0].proposed_frontmatter.title;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title).not.toContain("…");
    expect(title).not.toContain("...");
    // The title must end on a complete word (no partial word at the end).
    // Since we truncate at a word boundary, the last char should not be
    // mid-word — the truncated result should equal the statement up to the
    // last space at or before position 80, trimmed.
    expect(title.endsWith(" ")).toBe(false);
    // Confirm: the character immediately after the title in the original
    // statement is either end-of-string or a space (i.e. we broke on a boundary).
    const charAfter = stmt[title.length];
    expect(charAfter === undefined || charAfter === " ").toBe(true);
  });

  it("hard-cuts at TITLE_MAX when the first word exceeds 80 chars (no empty title)", async () => {
    const statement = "X".repeat(100); // single 100-char "word"
    const chunks = chunkMessages([msg(0, "irrelevant")], 1);
    const llm = mockLlm([{ claims: [{ statement }] }]);
    const out = await extractClaims(chunks, llm, OPTS);
    expect(out.claims).toHaveLength(1);
    const title = out.claims[0].proposed_frontmatter.title;
    expect(title.length).toBe(80);
    expect(title).not.toContain("…");
    expect(title.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Input cap
// ---------------------------------------------------------------------------

describe("extractClaims — inCallInputCap", () => {
  it("bounds the per-call source material fed to the LLM", async () => {
    const long = "x".repeat(50_000);
    const chunks = chunkMessages([msg(0, long)], 1);
    let seenUser = "";
    const llm = {
      complete: () => {
        throw new Error("not used");
      },
      completeWithTools: () => {
        throw new Error("not used");
      },
      completeJson: async (opts: { user: string }) => {
        seenUser = opts.user;
        return jsonOk({ claims: [{ statement: "capped" }] });
      },
    } as unknown as LlmClient;

    await extractClaims(chunks, llm, { ...OPTS, inCallInputCap: 1000 });
    // The cap bounds the SOURCE MATERIAL (the transcript after the framing
    // header), per the config's inCallInputCap semantics.
    const transcript = seenUser.slice(seenUser.indexOf("\n\n") + 2);
    expect(transcript.length).toBeLessThanOrEqual(1000);
    expect(transcript.length).toBeGreaterThan(0);
  });
});
