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

function jsonOk(parsed: unknown): Result<CompleteJsonResult, CortexEvalError> {
  return ok({
    text: JSON.stringify(parsed),
    input_tokens: 1,
    output_tokens: 1,
    stop_reason: "end_turn",
    parsed,
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
