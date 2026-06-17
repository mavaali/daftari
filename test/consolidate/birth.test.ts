// Birth mode: an unprocessed doc → top-K embedding neighbors → LLM re-derives
// direction → edge_observe seeds k=0 candidates. Spec §4.0, brief item 1.
//
// Tests use a mocked LlmClient + a stubbed neighbor lookup so the unit covers
// the verdict-to-write logic without touching the embedding index or Anthropic.
// The CLI e2e wires the real components (chunk 5).

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type BirthDeps,
  type BirthOpts,
  birthOne,
  parseBirthVerdict,
} from "../../src/consolidate/birth.js";
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

function mockLlm(verdicts: Array<{ verdict: string; reason: string }>): LlmClient {
  let i = 0;
  return {
    complete: vi.fn(),
    completeJson: vi.fn(async () => {
      const v = verdicts[i++] ?? { verdict: "neither", reason: "default" };
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

const baseOpts: BirthOpts = {
  vaultRoot: "",
  agent: "agent:curation-loop",
  axis: "forward",
  budgetRemaining: 100,
  model: "claude-haiku-test",
};

describe("parseBirthVerdict", () => {
  it("accepts derives | depends | neither + reason", () => {
    expect(parseBirthVerdict({ verdict: "derives", reason: "A cites B" }).ok).toBe(true);
    expect(parseBirthVerdict({ verdict: "depends", reason: "B underlies A" }).ok).toBe(true);
    expect(parseBirthVerdict({ verdict: "neither", reason: "unrelated" }).ok).toBe(true);
  });

  it("rejects unknown verdicts (silent acceptance would poison the strength column)", () => {
    expect(parseBirthVerdict({ verdict: "maybe", reason: "x" }).ok).toBe(false);
    expect(parseBirthVerdict({ verdict: "DERIVES", reason: "x" }).ok).toBe(false);
    expect(parseBirthVerdict({ reason: "x" }).ok).toBe(false);
    expect(parseBirthVerdict(null).ok).toBe(false);
    expect(parseBirthVerdict("not json").ok).toBe(false);
  });

  it("requires a reason (silent verdict-only = no provenance trail for the contest case)", () => {
    expect(parseBirthVerdict({ verdict: "derives" }).ok).toBe(false);
    expect(parseBirthVerdict({ verdict: "derives", reason: "" }).ok).toBe(false);
  });
});

describe("birthOne — happy path", () => {
  it("derives → emits an edge_observe(doc → neighbor), neither → no observation", async () => {
    const root = tmpVault();
    try {
      const observed: Array<{ from: string; to: string }> = [];
      const deps: BirthDeps = {
        llm: mockLlm([
          { verdict: "derives", reason: "A cites B" },
          { verdict: "neither", reason: "unrelated" },
        ]),
        searchNeighbors: async () => ok(["b.md", "c.md"]),
        observe: async (input) => {
          observed.push({ from: input.fromPath, to: input.toPath });
          return ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "2026-06-16T00:00:00Z",
            lastRederived: "2026-06-16T00:00:00Z",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          });
        },
        recordBirthTrace: async () => ok(undefined),
      };
      const r = await birthOne({ relPath: "a.md", content: "claim A" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(observed).toEqual([{ from: "a.md", to: "b.md" }]);
      expect(r.value.verdicts.length).toBe(2);
      expect(r.value.llmCalls).toBe(2);
    } finally {
      cleanup(root);
    }
  });

  it("depends → emits an edge_observe(neighbor → doc), reversed direction", async () => {
    const root = tmpVault();
    try {
      const observed: Array<{ from: string; to: string }> = [];
      const deps: BirthDeps = {
        llm: mockLlm([{ verdict: "depends", reason: "B underlies A" }]),
        searchNeighbors: async () => ok(["b.md"]),
        observe: async (input) => {
          observed.push({ from: input.fromPath, to: input.toPath });
          return ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "2026-06-16T00:00:00Z",
            lastRederived: "2026-06-16T00:00:00Z",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          });
        },
        recordBirthTrace: async () => ok(undefined),
      };
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(r.ok).toBe(true);
      expect(observed).toEqual([{ from: "b.md", to: "a.md" }]);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — trace + state", () => {
  it("records ONE trace row per doc with the full top-K + verdicts (recall@K post-hoc evaluator input)", async () => {
    const root = tmpVault();
    try {
      const traceRows: unknown[] = [];
      const deps: BirthDeps = {
        llm: mockLlm([
          { verdict: "derives", reason: "r1" },
          { verdict: "neither", reason: "r2" },
          { verdict: "depends", reason: "r3" },
        ]),
        searchNeighbors: async () => ok(["n1.md", "n2.md", "n3.md"]),
        observe: async (input) =>
          ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "x",
            lastRederived: "x",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          }),
        recordBirthTrace: async (row) => {
          traceRows.push(row);
          return ok(undefined);
        },
      };
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
      const deps: BirthDeps = {
        llm: mockLlm([{ verdict: "neither", reason: "x" }]),
        searchNeighbors: async () => ok(["b.md"]),
        observe: async (input) =>
          ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "x",
            lastRederived: "x",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          }),
        recordBirthTrace: async () => ok(undefined),
      };
      const r1 = await birthOne({ relPath: "a.md", content: "v1" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      const r2 = await birthOne({ relPath: "a.md", content: "v2" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      if (!r1.ok || !r2.ok) throw new Error("expected ok");
      // Same content → same hash; edited content → different hash. This is what
      // consolidate-state.json keys on so an edited doc re-births.
      expect(r1.value.contentHash).toBeTypeOf("string");
      expect(r1.value.contentHash).not.toBe(r2.value.contentHash);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — budget", () => {
  it("stops mid-neighbors when budgetRemaining drops to 0", async () => {
    const root = tmpVault();
    try {
      const observed: Array<{ from: string; to: string }> = [];
      const llm = mockLlm([
        { verdict: "derives", reason: "r1" },
        { verdict: "derives", reason: "r2" },
        { verdict: "derives", reason: "r3" },
      ]);
      const deps: BirthDeps = {
        llm,
        searchNeighbors: async () => ok(["n1.md", "n2.md", "n3.md"]),
        observe: async (input) => {
          observed.push({ from: input.fromPath, to: input.toPath });
          return ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "x",
            lastRederived: "x",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          });
        },
        recordBirthTrace: async () => ok(undefined),
      };
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
        budgetRemaining: 2,
      });
      if (!r.ok) throw r.error;
      expect(r.value.llmCalls).toBe(2);
      expect(observed.length).toBe(2);
      // The trace still records the FULL top-K so a partial run is recoverable
      // (post-hoc recall@K evaluation must see all 20 candidates the embedding
      // returned, not just the ones we had budget to score).
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
      const observed: Array<{ from: string; to: string }> = [];
      const deps: BirthDeps = {
        llm: mockLlm([{ verdict: "derives", reason: "r" }]),
        // Search returns an aliased path; observe must see the canonical form.
        searchNeighbors: async () => ok(["./pricing/b.md"]),
        observe: async (input) => {
          observed.push({ from: input.fromPath, to: input.toPath });
          return ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "x",
            lastRederived: "x",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          });
        },
        recordBirthTrace: async () => ok(undefined),
      };
      await birthOne({ relPath: "./pricing/../pricing/a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      expect(observed).toEqual([{ from: "pricing/a.md", to: "pricing/b.md" }]);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — trace write failure surfaces (the recall@K evaluator's input must not silently disappear)", () => {
  it("trace write failure → outcome.traceWritten=false + traceError, observations still land", async () => {
    const root = tmpVault();
    try {
      const observed: Array<{ from: string; to: string }> = [];
      const deps: BirthDeps = {
        llm: mockLlm([{ verdict: "derives", reason: "r" }]),
        searchNeighbors: async () => ok(["b.md"]),
        observe: async (input) => {
          observed.push({ from: input.fromPath, to: input.toPath });
          return ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "x",
            lastRederived: "x",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          });
        },
        recordBirthTrace: async () => ({ ok: false, error: new Error("disk full") }),
      };
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      if (!r.ok) throw r.error;
      expect(r.value.traceWritten).toBe(false);
      expect(r.value.traceError).toContain("disk full");
      // Observation already landed — birth's work is done; trace failure is
      // a separate surface (CLI exit code, chunk 5).
      expect(observed).toEqual([{ from: "a.md", to: "b.md" }]);
    } finally {
      cleanup(root);
    }
  });
});

describe("birthOne — LLM failures", () => {
  it("a JSON-parse failure surfaces as a contest-class outcome (no observation, recorded in trace)", async () => {
    const root = tmpVault();
    try {
      const observed: Array<{ from: string; to: string }> = [];
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
      const deps: BirthDeps = {
        llm,
        searchNeighbors: async () => ok(["b.md"]),
        observe: async (input) => {
          observed.push({ from: input.fromPath, to: input.toPath });
          return ok({
            fromPath: input.fromPath,
            toPath: input.toPath,
            strength: 0,
            kSurvived: 0,
            firstObserved: "x",
            lastRederived: "x",
            status: "candidate",
            observations: 1,
            contestedAt: null,
            contestReason: null,
          });
        },
        recordBirthTrace: async (row) => {
          traceRows.push(row);
          return ok(undefined);
        },
      };
      const r = await birthOne({ relPath: "a.md", content: "x" }, deps, {
        ...baseOpts,
        vaultRoot: root,
      });
      // LLM failure does NOT fail the whole birth pass — degrades to "no observation
      // for this neighbor" and records the error in the trace. The kill condition
      // for systematic LLM failure is the exit code in the CLI, not this function.
      expect(r.ok).toBe(true);
      expect(observed).toEqual([]);
      expect(traceRows.length).toBe(1);
      const row = traceRows[0] as { verdicts: Array<{ error?: string }> };
      expect(row.verdicts[0].error).toContain("JSON parse");
    } finally {
      cleanup(root);
    }
  });
});

// Suppress the unused-import warning for the trace file path.
void readFileSync;
