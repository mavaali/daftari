// Birth mode: an unprocessed doc → top-K embedding neighbors → foundational-
// ordering elicitation in BOTH orders per neighbor → edge_observe seeds k=0
// candidates; agreement is a directed edge, an explicit symmetric or an
// order-disagreement is a canonical-sorted pending edge + an interpretive
// tension. Spec §4.0 + §3.1/§3.3 (option c). Brief item 1.
//
// Tests use a mocked LlmClient + stubbed neighbor lookup/content so the unit
// covers reconcile-and-write without touching the embedding index or Anthropic.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type BirthDeps,
  type BirthOpts,
  birthOne,
  reconcileDirection,
} from "../../src/consolidate/birth.js";
import type { DerivationVerdict } from "../../src/consolidate/derivation-prompt.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";

function tmpVault(): string {
  const root = join(
    tmpdir(),
    `daftari-birth-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".daftari"), { recursive: true });
  return root;
}

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

// Per-neighbor verdict pairs in real-world terms (order1: A=doc,B=neighbor;
// order2: A=neighbor,B=doc).
const V = {
  docPremise: (reason = "doc founds neighbor"): DerivationVerdict[] => [
    { related: true, premise: "A", reason },
    { related: true, premise: "B", reason },
  ],
  neighborPremise: (reason = "neighbor founds doc"): DerivationVerdict[] => [
    { related: true, premise: "B", reason },
    { related: true, premise: "A", reason },
  ],
  symmetric: (reason = "mutual"): DerivationVerdict[] => [
    { related: true, premise: "symmetric", reason },
    { related: true, premise: "symmetric", reason },
  ],
  contested: (reason = "order-dependent"): DerivationVerdict[] => [
    { related: true, premise: "A", reason }, // order1 → doc
    { related: true, premise: "A", reason }, // order2 → neighbor
  ],
  unrelated: (reason = "no dependency"): DerivationVerdict[] => [
    { related: false, premise: null, reason },
    { related: false, premise: null, reason },
  ],
};

// LLM mock: consumes a flat queue of verdicts (2 per neighbor, both orders),
// records each call's opts so tests can assert temperature / prompt body.
function mockLlm(verdicts: DerivationVerdict[], calls?: unknown[]): LlmClient {
  let i = 0;
  return {
    complete: vi.fn(),
    completeJson: vi.fn(async (opts) => {
      calls?.push(opts);
      const v = verdicts[i++] ?? { related: false, premise: null, reason: "default" };
      return ok({
        text: JSON.stringify(v),
        parsed: v,
        input_tokens: 100,
        output_tokens: 20,
        stop_reason: "end_turn",
      });
    }),
    completeWithTools: vi.fn(),
  };
}

function stubEdge(from: string, to: string) {
  return {
    fromPath: from,
    toPath: to,
    strength: 0,
    kSurvived: 0,
    firstObserved: "2026-06-16T00:00:00Z",
    lastRederived: "2026-06-16T00:00:00Z",
    status: "candidate" as const,
    directionVerdict: "directed" as const,
    observations: 1,
    contestedAt: null,
    contestReason: null,
  };
}

interface Harness {
  deps: BirthDeps;
  observed: Array<{ from: string; to: string; premiseVote?: string }>;
  tensions: Array<{ title: string; kind: string; loggedBy: string }>;
  traceRows: unknown[];
  admitCalls: Array<{ action: string; fromPath: string; toPath: string }>;
}

// Default: the envelope always admits. Refusing tests override `admit`.
const ADMIT_OK: BirthDeps["admit"] = async () => ({
  admit: true,
  gate: null,
  reason: "ok",
  impact: 0,
});

function makeDeps(overrides: Partial<BirthDeps>): Harness {
  const observed: Harness["observed"] = [];
  const tensions: Harness["tensions"] = [];
  const traceRows: unknown[] = [];
  const admitCalls: Harness["admitCalls"] = [];
  const deps: BirthDeps = {
    llm: overrides.llm as LlmClient,
    searchNeighbors: overrides.searchNeighbors ?? (async () => ok(["b.md"])),
    loadNeighborContent: overrides.loadNeighborContent ?? (async () => ok("neighbor content body")),
    admit:
      overrides.admit ??
      (async (a) => {
        admitCalls.push({ action: a.action, fromPath: a.fromPath, toPath: a.toPath });
        return ADMIT_OK(a);
      }),
    observe:
      overrides.observe ??
      (async (input) => {
        observed.push({ from: input.fromPath, to: input.toPath, premiseVote: input.premiseVote });
        return ok(stubEdge(input.fromPath, input.toPath));
      }),
    recordTension:
      overrides.recordTension ??
      // biome-ignore lint/suspicious/noExplicitAny: structural test capture
      (async (t: any) => {
        tensions.push({ title: t.title, kind: t.kind, loggedBy: t.loggedBy });
        return ok(undefined);
      }),
    recordBirthTrace:
      overrides.recordBirthTrace ??
      (async (row) => {
        traceRows.push(row);
        return ok(undefined);
      }),
  };
  return { deps, observed, tensions, traceRows, admitCalls };
}

const baseOpts: BirthOpts = {
  vaultRoot: "",
  agent: "agent:curation-loop",
  axis: "forward",
  budgetRemaining: 100,
  model: "claude-haiku-test",
};

describe("reconcileDirection", () => {
  it("agreement on doc-premise ⇒ directed(doc)", () => {
    const [a, b] = V.docPremise();
    expect(reconcileDirection(a, b)).toEqual({ kind: "directed", premise: "doc" });
  });
  it("agreement on neighbor-premise ⇒ directed(neighbor)", () => {
    const [a, b] = V.neighborPremise();
    expect(reconcileDirection(a, b)).toEqual({ kind: "directed", premise: "neighbor" });
  });
  it("explicit symmetric ⇒ symmetric(mutual)", () => {
    const [a, b] = V.symmetric();
    expect(reconcileDirection(a, b)).toEqual({ kind: "symmetric", contested: false });
  });
  it("order-disagreement ⇒ symmetric(contested)", () => {
    const [a, b] = V.contested();
    expect(reconcileDirection(a, b)).toEqual({ kind: "symmetric", contested: true });
  });
  it("either order unrelated ⇒ unrelated", () => {
    expect(reconcileDirection(V.unrelated()[0], V.docPremise()[1])).toEqual({ kind: "unrelated" });
    expect(reconcileDirection(V.docPremise()[0], V.unrelated()[1])).toEqual({ kind: "unrelated" });
  });
});

describe("birthOne — directed", () => {
  it("doc-premise → observe(from=neighbor, to=doc) with premiseVote 'to'", async () => {
    const root = tmpVault();
    try {
      const { deps, observed } = makeDeps({ llm: mockLlm(V.docPremise()) });
      const r = await birthOne({ relPath: "a.md", content: "claim A" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(observed).toEqual([{ from: "b.md", to: "a.md", premiseVote: "to" }]);
      expect(r.value.llmCalls).toBe(2);
    } finally {
      cleanup(root);
    }
  });

  it("neighbor-premise → observe(from=doc, to=neighbor) with premiseVote 'to'", async () => {
    const root = tmpVault();
    try {
      const { deps, observed } = makeDeps({ llm: mockLlm(V.neighborPremise()) });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([{ from: "a.md", to: "b.md", premiseVote: "to" }]);
    } finally {
      cleanup(root);
    }
  });

  it("unrelated → no observation, no tension", async () => {
    const root = tmpVault();
    try {
      const { deps, observed, tensions } = makeDeps({ llm: mockLlm(V.unrelated()) });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([]);
      expect(tensions).toEqual([]);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — symmetric / contested → pending edge + tension", () => {
  it("explicit symmetric → canonical-sorted observe(premiseVote 'symmetric') + interpretive tension", async () => {
    const root = tmpVault();
    try {
      const { deps, observed, tensions } = makeDeps({
        llm: mockLlm(V.symmetric()),
        searchNeighbors: async () => ok(["z.md"]), // canonical sort: a.md < z.md
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([{ from: "a.md", to: "z.md", premiseVote: "symmetric" }]);
      expect(tensions).toHaveLength(1);
      expect(tensions[0]?.kind).toBe("interpretive");
      expect(tensions[0]?.loggedBy).toBe("agent:curation-loop");
      expect(tensions[0]?.title).toContain("mutual");
    } finally {
      cleanup(root);
    }
  });

  it("order-contested → canonical-sorted pending edge + contested tension", async () => {
    const root = tmpVault();
    try {
      const { deps, observed, tensions } = makeDeps({
        llm: mockLlm(V.contested()),
        searchNeighbors: async () => ok(["z.md"]),
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([{ from: "a.md", to: "z.md", premiseVote: "symmetric" }]);
      expect(tensions[0]?.title).toContain("contested");
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — envelope admit (gate consulted once per neighbor)", () => {
  it("refused admit on a symmetric outcome → no observe, no tension, gated verdict + gatedCount", async () => {
    const root = tmpVault();
    try {
      const { deps, observed, tensions } = makeDeps({
        llm: mockLlm(V.symmetric()),
        searchNeighbors: async () => ok(["z.md"]),
        admit: async () => ({
          admit: false,
          gate: "budget" as const,
          reason: "trust-budget exhausted",
          impact: 0.05,
        }),
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      // Refused: zero observations, NO tension, and the outcome is counted gated.
      expect(observed).toEqual([]);
      expect(tensions).toEqual([]);
      expect(r.value.observations).toEqual([]);
      expect(r.value.gatedCount).toBeGreaterThan(0);
      const gated = r.value.verdicts.filter(
        (v): v is Extract<typeof v, { gated?: boolean }> => "gated" in v && v.gated === true,
      );
      expect(gated.length).toBe(1);
      expect(gated[0].gate).toBe("budget");
    } finally {
      cleanup(root);
    }
  });

  it("refused admit on a directed outcome → no observe, gated verdict", async () => {
    const root = tmpVault();
    try {
      const { deps, observed } = makeDeps({
        llm: mockLlm(V.docPremise()),
        admit: async () => ({
          admit: false,
          gate: "invariants" as const,
          reason: "provenance-required",
          impact: 0,
        }),
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(observed).toEqual([]);
      expect(r.value.gatedCount).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("a throwing admit does NOT crash the pass: treated as a refusal, gated, no observe", async () => {
    const root = tmpVault();
    try {
      const { deps, observed } = makeDeps({
        llm: mockLlm(V.docPremise()),
        admit: async () => {
          throw new Error("makeAdmit network error");
        },
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(observed).toEqual([]);
      expect(r.value.gatedCount).toBe(1);
      // Fail-closed: a throw is a refusal on the invariants gate.
      const gated = r.value.verdicts.filter(
        (v): v is Extract<typeof v, { gated?: boolean }> => "gated" in v && v.gated === true,
      );
      expect(gated[0].gate).toBe("invariants");
      // The trace still landed (the pass completed).
      expect(r.value.traceWritten).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("admit is consulted once per neighbor edge-action (before observe)", async () => {
    const root = tmpVault();
    try {
      const { deps, admitCalls } = makeDeps({ llm: mockLlm(V.docPremise()) });
      await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(admitCalls).toEqual([{ action: "edge-observe", fromPath: "b.md", toPath: "a.md" }]);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — prompt contract", () => {
  it("loads neighbor content as DOC B and pins temperature 0 on both calls", async () => {
    const root = tmpVault();
    try {
      const calls: Array<{ user: string; temperature?: number }> = [];
      const { deps } = makeDeps({
        llm: mockLlm(V.docPremise(), calls),
        loadNeighborContent: async () => ok("NEIGHBOR_CONTENT_MARKER"),
      });
      await birthOne({ relPath: "a.md", content: "DOC_CONTENT_MARKER" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(calls).toHaveLength(2);
      for (const c of calls) {
        expect(c.temperature).toBe(0);
        // both docs' content present in every prompt (both orders)
        expect(c.user).toContain("NEIGHBOR_CONTENT_MARKER");
        expect(c.user).toContain("DOC_CONTENT_MARKER");
      }
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — trace + state", () => {
  it("records ONE trace row per doc with the full top-K + a verdict per neighbor", async () => {
    const root = tmpVault();
    try {
      const { deps, traceRows } = makeDeps({
        llm: mockLlm([...V.docPremise(), ...V.unrelated(), ...V.neighborPremise()]),
        searchNeighbors: async () => ok(["n1.md", "n2.md", "n3.md"]),
      });
      await birthOne({ relPath: "a.md", content: "x" }, deps, { ...baseOpts, vaultRoot: root });
      expect(traceRows.length).toBe(1);
      const row = traceRows[0] as { docPath: string; topK: string[]; verdicts: unknown[] };
      expect(row.docPath).toBe("a.md");
      expect(row.topK).toEqual(["n1.md", "n2.md", "n3.md"]);
      expect(row.verdicts.length).toBe(3);
    } finally {
      cleanup(root);
    }
  });

  it("returns the content hash so the caller can advance birth-processed state", async () => {
    const root = tmpVault();
    try {
      const { deps } = makeDeps({ llm: mockLlm(V.unrelated()) });
      const r1 = await birthOne({ relPath: "a.md", content: "v1" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      const { deps: deps2 } = makeDeps({ llm: mockLlm(V.unrelated()) });
      const r2 = await birthOne({ relPath: "a.md", content: "v2" }, deps2, {
        ...baseOpts,
        vaultRoot: root,
      });
      if (!r1.ok || !r2.ok) throw new Error("expected ok");
      expect(r1.value.contentHash).toBeTypeOf("string");
      expect(r1.value.contentHash).not.toBe(r2.value.contentHash);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — budget (2 calls per neighbor)", () => {
  it("stops mid-neighbors when the next pair won't fit the budget", async () => {
    const root = tmpVault();
    try {
      const { deps, observed } = makeDeps({
        llm: mockLlm([...V.docPremise(), ...V.docPremise(), ...V.docPremise()]),
        searchNeighbors: async () => ok(["n1.md", "n2.md", "n3.md"]),
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
        budgetRemaining: 2, // exactly one neighbor's pair
      });
      if (!r.ok) throw r.error;
      expect(r.value.llmCalls).toBe(2);
      expect(observed.length).toBe(1);
      // The trace still records the FULL top-K so a partial run is recoverable.
      expect(r.value.neighbors.length).toBe(3);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — path canonicalization", () => {
  it("canonicalizes neighbor + doc paths at the boundary (memory: canonicalize-path-keys)", async () => {
    const root = tmpVault();
    try {
      const { deps, observed } = makeDeps({
        llm: mockLlm(V.neighborPremise()),
        searchNeighbors: async () => ok(["./pricing/b.md"]),
      });
      await birthOne({ relPath: "./pricing/../pricing/a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(observed).toEqual([{ from: "pricing/a.md", to: "pricing/b.md", premiseVote: "to" }]);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — degraded paths", () => {
  it("trace write failure → traceWritten=false + traceError, observations still land", async () => {
    const root = tmpVault();
    try {
      const { deps, observed } = makeDeps({
        llm: mockLlm(V.neighborPremise()),
        recordBirthTrace: async () => ({ ok: false, error: new Error("disk full") }),
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      if (!r.ok) throw r.error;
      expect(r.value.traceWritten).toBe(false);
      expect(r.value.traceError).toContain("disk full");
      expect(observed).toEqual([{ from: "a.md", to: "b.md", premiseVote: "to" }]);
    } finally {
      cleanup(root);
    }
  });

  it("an order-1 LLM failure → no observation for that neighbor, recorded in trace", async () => {
    const root = tmpVault();
    try {
      const traceRows: unknown[] = [];
      const llm: LlmClient = {
        complete: vi.fn(),
        completeJson: vi.fn(async () => ({
          ok: false,
          error: {
            kind: "llm" as const,
            message: "JSON parse: unexpected token",
            retryable: false,
          },
        })),
        completeWithTools: vi.fn(),
      };
      const { deps, observed } = makeDeps({
        llm,
        recordBirthTrace: async (row) => {
          traceRows.push(row);
          return ok(undefined);
        },
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([]);
      const row = traceRows[0] as { verdicts: Array<{ error?: string }> };
      expect(row.verdicts[0]?.error).toContain("JSON parse");
    } finally {
      cleanup(root);
    }
  });

  it("a neighbor-content load failure → skip the neighbor + trace, no observation", async () => {
    const root = tmpVault();
    try {
      const traceRows: unknown[] = [];
      const { deps, observed } = makeDeps({
        llm: mockLlm(V.docPremise()),
        loadNeighborContent: async () => ({ ok: false, error: new Error("missing doc") }),
        recordBirthTrace: async (row) => {
          traceRows.push(row);
          return ok(undefined);
        },
      });
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([]);
      expect(r.value.llmCalls).toBe(0); // never reached the LLM
      const row = traceRows[0] as { verdicts: Array<{ error?: string }> };
      expect(row.verdicts[0]?.error).toContain("load failed");
    } finally {
      cleanup(root);
    }
  });
});
