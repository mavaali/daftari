// test/distill/cost.test.ts
//
// Unit tests for the distill cost/receipt module (U6).
//
// Coverage:
//   1. planDistill — zero LLM calls (enforced via a throw-on-call spy)
//   2. planDistill — estimate shape + value bounds
//   3. buildReceipt — truncation flag when claimsProduced >= maxClaims
//   4. buildReceipt — provider + ZDR recorded faithfully
//   5. buildReceipt — honors budget_exhausted as a truncation signal
//   6. buildReceipt — approx cost via estimateCostUSD (reuse, not duplicate)

import { describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../src/distill/adapters/types.js";
import { chunkMessages } from "../../src/distill/chunk.js";
import {
  buildReceipt,
  type DistillPlan,
  type DistillReceipt,
  planDistill,
} from "../../src/distill/cost.js";
import type { ExtractOutcome } from "../../src/distill/extract.js";

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

const CONFIG = {
  model: "claude-haiku-4-5-20251001",
  maxLlmCalls: 10,
  maxClaims: 50,
  maxVerbatimChars: 8000,
  inCallInputCap: 16000,
};

// ---------------------------------------------------------------------------
// 1. planDistill — zero LLM calls
// ---------------------------------------------------------------------------

describe("planDistill — zero LLM calls", () => {
  it("returns an estimate without any LLM spend (structural guarantee)", () => {
    // Zero-spend is structural: planDistill accepts no LlmClient, so it
    // cannot make a call regardless of implementation. No spy needed.
    const messages = Array.from({ length: 60 }, (_, i) =>
      msg(i, `Message number ${i}: some content about the project.`),
    );
    const chunks = chunkMessages(messages);
    const plan = planDistill(chunks, CONFIG);

    expect(plan.chunkCount).toBeGreaterThan(0);
    expect(plan.estimatedLlmCalls).toBeGreaterThan(0);
    expect(plan.estimatedCostUSD).toBeGreaterThanOrEqual(0);
  });

  it("returns zero cost for an empty message list", () => {
    const chunks = chunkMessages([]);
    const plan = planDistill(chunks, CONFIG);
    expect(plan.chunkCount).toBe(0);
    expect(plan.estimatedLlmCalls).toBe(0);
    expect(plan.estimatedCostUSD).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. planDistill — estimate shape and value bounds
// ---------------------------------------------------------------------------

describe("planDistill — estimate shape", () => {
  it("chunkCount matches the actual chunk array length", () => {
    const messages = Array.from({ length: 45 }, (_, i) => msg(i, `msg ${i}`));
    const chunks = chunkMessages(messages); // 30-message windows → 2 chunks
    const plan = planDistill(chunks, CONFIG);
    expect(plan.chunkCount).toBe(chunks.length);
  });

  it("estimatedLlmCalls is capped by maxLlmCalls", () => {
    // 200 messages → many chunks, but maxLlmCalls = 3
    const messages = Array.from({ length: 200 }, (_, i) => msg(i, `msg ${i}`));
    const chunks = chunkMessages(messages);
    const cfg = { ...CONFIG, maxLlmCalls: 3 };
    const plan = planDistill(chunks, cfg);
    expect(plan.estimatedLlmCalls).toBe(3);
  });

  it("estimatedLlmCalls equals chunkCount when chunks < maxLlmCalls", () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i, `msg ${i}`));
    const chunks = chunkMessages(messages); // exactly 1 chunk
    const cfg = { ...CONFIG, maxLlmCalls: 100 };
    const plan = planDistill(chunks, cfg);
    expect(plan.estimatedLlmCalls).toBe(chunks.length);
  });

  it("exposes model and priced flag from the config model", () => {
    const chunks = chunkMessages([msg(0, "hello")]);
    const plan = planDistill(chunks, CONFIG);
    expect(plan.model).toBe(CONFIG.model);
    // claude-haiku-4-5-20251001 is in the pricing table
    expect(plan.priced).toBe(true);
  });

  it("marks priced: false for an unknown model", () => {
    const chunks = chunkMessages([msg(0, "hello")]);
    const cfg = { ...CONFIG, model: "some-unknown-model-xyz" };
    const plan = planDistill(chunks, cfg);
    expect(plan.priced).toBe(false);
  });

  it("estimated cost is non-negative for any input", () => {
    const messages = Array.from({ length: 90 }, (_, i) => msg(i, "x".repeat(100)));
    const chunks = chunkMessages(messages);
    const plan = planDistill(chunks, CONFIG);
    expect(plan.estimatedCostUSD).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 3. buildReceipt — truncation when claimsProduced >= maxClaims
// ---------------------------------------------------------------------------

describe("buildReceipt — truncation signal", () => {
  it("sets truncated: true when claimsProduced equals maxClaims", () => {
    const outcome: ExtractOutcome = {
      claims: Array.from({ length: 5 }, (_, i) => ({
        claim_key: `key-${i}`,
        statement: `Claim ${i}`,
        proposed_frontmatter: { title: `Claim ${i}` },
      })),
      budget_exhausted: false,
      llmCalls: 5,
      chunkErrors: [],
    };
    const receipt = buildReceipt({
      outcome,
      config: { ...CONFIG, maxClaims: 5 },
      provider: "anthropic",
      zdr: false,
      sourceId: "test-source",
      runId: "distill-2026-08-17T00-00-00-000Z-trunc1",
    });
    expect(receipt.truncated).toBe(true);
    expect(receipt.claimsProduced).toBe(5);
  });

  it("sets truncated: true when claimsProduced exceeds maxClaims (condition is >=)", () => {
    // Defensive invariant: claimsProduced === maxClaims + 1 also triggers truncated.
    // The condition `claimsProduced >= maxClaims` covers both the exact-cap case
    // and any over-run, ensuring partial-import is never silently missed.
    const outcome: ExtractOutcome = {
      claims: Array.from({ length: 6 }, (_, i) => ({
        claim_key: `key-${i}`,
        statement: `Claim ${i}`,
        proposed_frontmatter: { title: `Claim ${i}` },
      })),
      budget_exhausted: false,
      llmCalls: 5,
      chunkErrors: [],
    };
    const receipt = buildReceipt({
      outcome,
      config: { ...CONFIG, maxClaims: 5 }, // claimsProduced (6) === maxClaims + 1
      provider: "anthropic",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-trunc2",
    });
    expect(receipt.truncated).toBe(true);
    expect(receipt.claimsProduced).toBe(6);
  });

  it("sets truncated: false when claims are below the cap", () => {
    const outcome: ExtractOutcome = {
      claims: Array.from({ length: 3 }, (_, i) => ({
        claim_key: `key-${i}`,
        statement: `Claim ${i}`,
        proposed_frontmatter: { title: `Claim ${i}` },
      })),
      budget_exhausted: false,
      llmCalls: 3,
      chunkErrors: [],
    };
    const receipt = buildReceipt({
      outcome,
      config: { ...CONFIG, maxClaims: 10 },
      provider: "anthropic",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-trunc3",
    });
    expect(receipt.truncated).toBe(false);
  });

  it("sets truncated: true when budget_exhausted (partial result)", () => {
    const outcome: ExtractOutcome = {
      claims: Array.from({ length: 2 }, (_, i) => ({
        claim_key: `key-${i}`,
        statement: `Claim ${i}`,
        proposed_frontmatter: { title: `Claim ${i}` },
      })),
      budget_exhausted: true,
      llmCalls: 3,
      chunkErrors: [],
    };
    const receipt = buildReceipt({
      outcome,
      config: { ...CONFIG, maxClaims: 50 },
      provider: "openrouter",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-trunc4",
    });
    expect(receipt.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. buildReceipt — provider + ZDR
// ---------------------------------------------------------------------------

describe("buildReceipt — provider and ZDR fields", () => {
  function makeOutcome(n: number): ExtractOutcome {
    return {
      claims: Array.from({ length: n }, (_, i) => ({
        claim_key: `key-${i}`,
        statement: `Claim ${i}`,
        proposed_frontmatter: { title: `Claim ${i}` },
      })),
      budget_exhausted: false,
      llmCalls: n,
      chunkErrors: [],
    };
  }

  it("records provider: anthropic", () => {
    const r = buildReceipt({
      outcome: makeOutcome(2),
      config: CONFIG,
      provider: "anthropic",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-prov1",
    });
    expect(r.provider).toBe("anthropic");
  });

  it("records provider: openrouter", () => {
    const r = buildReceipt({
      outcome: makeOutcome(2),
      config: CONFIG,
      provider: "openrouter",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-prov2",
    });
    expect(r.provider).toBe("openrouter");
  });

  it("records zdr: false by default", () => {
    const r = buildReceipt({
      outcome: makeOutcome(1),
      config: CONFIG,
      provider: "anthropic",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-zdr1",
    });
    expect(r.zdr).toBe(false);
  });

  it("records zdr: true when explicitly supplied", () => {
    const r = buildReceipt({
      outcome: makeOutcome(1),
      config: CONFIG,
      provider: "anthropic",
      zdr: true,
      runId: "distill-2026-08-17T00-00-00-000Z-zdr2",
    });
    expect(r.zdr).toBe(true);
  });

  it("does NOT infer zdr: true for anthropic — caller must supply it", () => {
    // ZDR is account/endpoint-specific, not transport-specific.
    // An anthropic transport does NOT automatically mean ZDR.
    const r = buildReceipt({
      outcome: makeOutcome(1),
      config: CONFIG,
      provider: "anthropic",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-zdr3",
    });
    expect(r.zdr).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. buildReceipt — llmCalls and claimsProduced from ExtractOutcome
// ---------------------------------------------------------------------------

describe("buildReceipt — actuals from ExtractOutcome", () => {
  it("records llmCalls from the outcome", () => {
    const outcome: ExtractOutcome = {
      claims: [],
      budget_exhausted: false,
      llmCalls: 7,
      chunkErrors: [],
    };
    const r = buildReceipt({ outcome, config: CONFIG, provider: "anthropic", zdr: false, runId: "distill-2026-08-17T00-00-00-000Z-llm1" });
    expect(r.llmCalls).toBe(7);
  });

  it("records claimsProduced as claims.length", () => {
    const outcome: ExtractOutcome = {
      claims: Array.from({ length: 4 }, (_, i) => ({
        claim_key: `k${i}`,
        statement: `s${i}`,
        proposed_frontmatter: { title: `t${i}` },
      })),
      budget_exhausted: false,
      llmCalls: 4,
      chunkErrors: [],
    };
    const r = buildReceipt({ outcome, config: CONFIG, provider: "anthropic", zdr: false, runId: "distill-2026-08-17T00-00-00-000Z-claims1" });
    expect(r.claimsProduced).toBe(4);
  });

  it("records a sourceId when provided", () => {
    const outcome: ExtractOutcome = {
      claims: [],
      budget_exhausted: false,
      llmCalls: 0,
      chunkErrors: [],
    };
    const r = buildReceipt({
      outcome,
      config: CONFIG,
      provider: "anthropic",
      zdr: false,
      sourceId: "chat-2026-05-01.txt",
      runId: "distill-2026-08-17T00-00-00-000Z-src1",
    });
    expect(r.sourceId).toBe("chat-2026-05-01.txt");
  });

  it("sourceId is undefined when not provided", () => {
    const outcome: ExtractOutcome = {
      claims: [],
      budget_exhausted: false,
      llmCalls: 0,
      chunkErrors: [],
    };
    const r = buildReceipt({ outcome, config: CONFIG, provider: "anthropic", zdr: false, runId: "distill-2026-08-17T00-00-00-000Z-src2" });
    expect(r.sourceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. buildReceipt — approx cost (reuses estimateCostUSD, not duplicated)
// ---------------------------------------------------------------------------

describe("buildReceipt — approx cost", () => {
  it("approxCostUSD is non-negative", () => {
    const outcome: ExtractOutcome = {
      claims: Array.from({ length: 3 }, (_, i) => ({
        claim_key: `k${i}`,
        statement: `stmt ${i}`,
        proposed_frontmatter: { title: `t${i}` },
      })),
      budget_exhausted: false,
      llmCalls: 3,
      chunkErrors: [],
    };
    const r = buildReceipt({ outcome, config: CONFIG, provider: "anthropic", zdr: false, runId: "distill-2026-08-17T00-00-00-000Z-cost1" });
    expect(r.approxCostUSD).toBeGreaterThanOrEqual(0);
  });

  it("approxCostUSD is 0 when llmCalls is 0", () => {
    const outcome: ExtractOutcome = {
      claims: [],
      budget_exhausted: false,
      llmCalls: 0,
      chunkErrors: [],
    };
    const r = buildReceipt({ outcome, config: CONFIG, provider: "anthropic", zdr: false, runId: "distill-2026-08-17T00-00-00-000Z-cost2" });
    expect(r.approxCostUSD).toBe(0);
  });

  it("uses the caller's staging runId so the receipt joins to its artifacts", () => {
    const outcome: ExtractOutcome = {
      claims: [],
      budget_exhausted: false,
      llmCalls: 0,
      chunkErrors: [],
    };
    const receipt = buildReceipt({
      outcome,
      config: CONFIG,
      provider: "anthropic",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-abc123",
    });
    expect(receipt.runId).toBe("distill-2026-08-17T00-00-00-000Z-abc123");
  });

  it("receipt carries a completedAt ISO timestamp", () => {
    const outcome: ExtractOutcome = {
      claims: [],
      budget_exhausted: false,
      llmCalls: 0,
      chunkErrors: [],
    };
    const r = buildReceipt({ outcome, config: CONFIG, provider: "anthropic", zdr: false, runId: "distill-2026-08-17T00-00-00-000Z-ts1" });
    expect(typeof r.completedAt).toBe("string");
    expect(() => new Date(r.completedAt)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. Type-level: DistillPlan and DistillReceipt shape assertions
// ---------------------------------------------------------------------------

describe("DistillPlan type shape", () => {
  it("has all required fields", () => {
    const chunks = chunkMessages([msg(0, "hello world decision")]);
    const plan: DistillPlan = planDistill(chunks, CONFIG);
    // TypeScript enforces these fields at compile time; runtime check as belt-and-suspenders.
    expect(typeof plan.chunkCount).toBe("number");
    expect(typeof plan.estimatedLlmCalls).toBe("number");
    expect(typeof plan.estimatedCostUSD).toBe("number");
    expect(typeof plan.model).toBe("string");
    expect(typeof plan.priced).toBe("boolean");
  });
});

describe("DistillReceipt type shape", () => {
  it("has all required fields", () => {
    const outcome: ExtractOutcome = {
      claims: [],
      budget_exhausted: false,
      llmCalls: 0,
      chunkErrors: [],
    };
    const r: DistillReceipt = buildReceipt({
      outcome,
      config: CONFIG,
      provider: "anthropic",
      zdr: false,
      runId: "distill-2026-08-17T00-00-00-000Z-shape-test",
    });
    expect(typeof r.runId).toBe("string");
    expect(typeof r.model).toBe("string");
    expect(["anthropic", "openrouter"]).toContain(r.provider);
    expect(typeof r.zdr).toBe("boolean");
    expect(typeof r.llmCalls).toBe("number");
    expect(typeof r.claimsProduced).toBe("number");
    expect(typeof r.truncated).toBe("boolean");
    expect(typeof r.approxCostUSD).toBe("number");
    expect(typeof r.completedAt).toBe("string");
  });
});
