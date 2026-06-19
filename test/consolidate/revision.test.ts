// Revision mode: a due edge → panel of M votes (distinct (observer, axis)
// pairs) → each vote re-derives independently → emits edge_observe (survives)
// or edge_contest (fails). Spec §4.1, brief item 2.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseRevisionVerdict,
  type RevisionDeps,
  type RevisionOpts,
  revisionPanel,
} from "../../src/consolidate/revision.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";

function tmpVault(): string {
  const root = join(
    tmpdir(),
    `daftari-revision-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
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
      const v = verdicts[i++] ?? { verdict: "survives", reason: "default" };
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

const baseOpts: RevisionOpts = {
  vaultRoot: "",
  agent: "agent:curation-loop",
  panelSize: 2,
  budgetRemaining: 100,
  model: "claude-haiku-test",
};

// Default: the envelope always admits. Refusing tests pass their own `admit`.
const ADMIT_OK: RevisionDeps["admit"] = async () => ({
  admit: true,
  gate: null,
  reason: "ok",
  impact: 0,
});

const dueEdge = {
  fromPath: "a.md",
  toPath: "b.md",
  strength: 2.5,
  kSurvived: 3,
  firstObserved: "2026-04-01T00:00:00Z",
  lastRederived: "2026-05-01T00:00:00Z",
  status: "trigger-bearing" as const,
  observations: 3,
  contestedAt: null,
  contestReason: null,
};

describe("parseRevisionVerdict", () => {
  it("accepts survives | fails + reason", () => {
    expect(parseRevisionVerdict({ verdict: "survives", reason: "still derives" }).ok).toBe(true);
    expect(parseRevisionVerdict({ verdict: "fails", reason: "no link" }).ok).toBe(true);
  });
  it("rejects unknown verdicts (silent acceptance = poison)", () => {
    expect(parseRevisionVerdict({ verdict: "maybe", reason: "x" }).ok).toBe(false);
    expect(parseRevisionVerdict({ verdict: "depends", reason: "x" }).ok).toBe(false);
    expect(parseRevisionVerdict({ reason: "x" }).ok).toBe(false);
    expect(parseRevisionVerdict(null).ok).toBe(false);
  });
  it("requires a non-empty reason", () => {
    expect(parseRevisionVerdict({ verdict: "fails" }).ok).toBe(false);
    expect(parseRevisionVerdict({ verdict: "fails", reason: "" }).ok).toBe(false);
  });
});

describe("revisionPanel — majority decides, once", () => {
  it("M=2 both survive → 2 observes with DISTINCT store axes, 0 contests (k accrues)", async () => {
    const root = tmpVault();
    try {
      const observed: Array<{ axis?: string }> = [];
      const contests: unknown[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "survives", reason: "still" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async (input) => {
          observed.push({ axis: input.axis });
          return ok({ ...dueEdge });
        },
        contest: async (input) => {
          contests.push(input);
          return ok({ ...dueEdge });
        },
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("survives");
      expect(observed.length).toBe(2);
      // R1-F1: the store axes must be DISTINCT or the replay guard collapses the
      // panel to k+1 regardless of M (the whole panel mechanic).
      expect(new Set(observed.map((o) => o.axis)).size).toBe(2);
      expect(contests.length).toBe(0);
      expect(r.value.observedCount).toBe(2);
    } finally {
      cleanup(root);
    }
  });

  it("M=2 split (1 survive, 1 fail) is a TIE → no write, no revoke/reseed churn", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const contests: unknown[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "still ok" },
          { verdict: "fails", reason: "premise reformulated" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => {
          contests.push(1);
          return ok({ ...dueEdge });
        },
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("tie");
      expect(observed.length).toBe(0);
      expect(contests.length).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("majority fails (2 of 3) → ONE contest, no observe (lone dissent can't revoke)", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const contests: unknown[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "fails", reason: "no link" },
          { verdict: "survives", reason: "still" },
          { verdict: "fails", reason: "premise gone" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => {
          contests.push(1);
          return ok({ ...dueEdge });
        },
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 3 });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("fails");
      expect(contests.length).toBe(1); // exactly one, never per-vote
      expect(observed.length).toBe(0);
      expect(r.value.contestedCount).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("majority survives (2 of 3) → 2 observes, no contest from the lone fail", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const contests: unknown[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "fails", reason: "noise" },
          { verdict: "survives", reason: "still" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => {
          contests.push(1);
          return ok({ ...dueEdge });
        },
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 3 });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("survives");
      expect(observed.length).toBe(2);
      expect(contests.length).toBe(0);
    } finally {
      cleanup(root);
    }
  });
});

describe("revisionPanel — envelope admit (gate consulted once per panel decision)", () => {
  it("majority survives but admit refuses → decision 'gated', 0 observes", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const contests: unknown[] = [];
      const deps: RevisionDeps = {
        admit: async () => ({
          admit: false,
          gate: "budget" as const,
          reason: "trust-budget exhausted",
          impact: 0.05,
        }),
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "survives", reason: "still" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => {
          contests.push(1);
          return ok({ ...dueEdge });
        },
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("gated");
      expect(r.value.observedCount).toBe(0);
      expect(observed.length).toBe(0);
      expect(contests.length).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("majority fails but admit refuses → decision 'gated', 0 contests", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const contests: unknown[] = [];
      const deps: RevisionDeps = {
        admit: async () => ({
          admit: false,
          gate: "invariants" as const,
          reason: "provenance-required",
          impact: 0,
        }),
        llm: mockLlm([
          { verdict: "fails", reason: "no link" },
          { verdict: "survives", reason: "still" },
          { verdict: "fails", reason: "premise gone" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => {
          contests.push(1);
          return ok({ ...dueEdge });
        },
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 3 });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("gated");
      expect(r.value.contestedCount).toBe(0);
      expect(contests.length).toBe(0);
      expect(observed.length).toBe(0);
    } finally {
      cleanup(root);
    }
  });

  it("a throwing admit does NOT crash the panel: treated as a refusal → gated, no write", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const deps: RevisionDeps = {
        admit: async () => {
          throw new Error("makeAdmit fs error");
        },
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "survives", reason: "still" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("gated");
      expect(r.value.gate).toBe("invariants");
      expect(observed.length).toBe(0);
      // The panel completed; the trace landed.
      expect(r.value.traceWritten).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  it("tie does NOT consult admit (nothing to write)", async () => {
    const root = tmpVault();
    try {
      let admitCalls = 0;
      const deps: RevisionDeps = {
        admit: async () => {
          admitCalls++;
          return ADMIT_OK({ action: "edge-observe", fromPath: "", toPath: "" });
        },
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "fails", reason: "no" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("tie");
      expect(admitCalls).toBe(0);
    } finally {
      cleanup(root);
    }
  });
});

describe("revisionPanel — independence by axis (§11.3 replay-gap)", () => {
  it("M=2 votes use distinct prompt templates so the store counts them independent in one sitting", async () => {
    const root = tmpVault();
    try {
      const seenAxesInPrompt: string[] = [];
      // Capture which template was used by inspecting the system or user.
      // We do it through the LLM mock — the mock now records the user body's
      // template marker so we can prove distinctness.
      const llm: LlmClient = {
        complete: vi.fn(),
        completeJson: vi.fn(async (opts) => {
          // The user body's first line carries a `[template:NAME]` marker we
          // embed for this test (revision.ts uses the marker so the test
          // doesn't depend on the prose of the templates).
          const m = opts.user.match(/\[template:(\w+)\]/);
          if (m) seenAxesInPrompt.push(m[1]);
          return ok({
            text: '{"verdict":"survives","reason":"x"}',
            parsed: { verdict: "survives", reason: "x" },
            input_tokens: 10,
            output_tokens: 5,
            stop_reason: "end_turn",
          });
        }),
        completeWithTools: vi.fn(),
      };
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm,
        loadDoc: async (p) => ok({ path: p, content: `c-${p}` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 2 });
      if (!r.ok) throw r.error;
      expect(seenAxesInPrompt.length).toBe(2);
      expect(new Set(seenAxesInPrompt).size).toBe(2);
    } finally {
      cleanup(root);
    }
  });
});

describe("revisionPanel — budget + stop", () => {
  it("stops mid-panel when budgetRemaining hits 0", async () => {
    const root = tmpVault();
    try {
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "1" },
          { verdict: "survives", reason: "2" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `c-${p}` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, {
        ...baseOpts,
        vaultRoot: root,
        panelSize: 3,
        budgetRemaining: 1,
      });
      if (!r.ok) throw r.error;
      expect(r.value.votes.length).toBe(1);
      expect(r.value.llmCalls).toBe(1);
    } finally {
      cleanup(root);
    }
  });

  it("panel stops at M votes even with plenty of budget", async () => {
    const root = tmpVault();
    try {
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "1" },
          { verdict: "survives", reason: "2" },
          { verdict: "survives", reason: "3" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `c-${p}` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, {
        ...baseOpts,
        vaultRoot: root,
        panelSize: 2,
        budgetRemaining: 50,
      });
      if (!r.ok) throw r.error;
      expect(r.value.votes.length).toBe(2);
    } finally {
      cleanup(root);
    }
  });
});

describe("revisionPanel — trace", () => {
  it("records one trace row per edge with all M vote outcomes (decorrelation report input)", async () => {
    const root = tmpVault();
    try {
      const rows: unknown[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "1" },
          { verdict: "fails", reason: "2" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `c-${p}` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async (r) => {
          rows.push(r);
          return ok(undefined);
        },
      };
      await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      expect(rows.length).toBe(1);
      const row = rows[0] as {
        fromPath: string;
        toPath: string;
        votes: Array<{ axis: string; verdict: string }>;
      };
      expect(row.fromPath).toBe("a.md");
      expect(row.toPath).toBe("b.md");
      expect(row.votes.length).toBe(2);
      expect(row.votes.map((v) => v.verdict)).toEqual(["survives", "fails"]);
    } finally {
      cleanup(root);
    }
  });

  it("trace write failure surfaces in outcome.traceWritten / traceError, votes still land", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([{ verdict: "survives", reason: "x" }]),
        loadDoc: async (p) => ok({ path: p, content: `c-${p}` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ({ ok: false, error: new Error("disk full") }),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 1 });
      if (!r.ok) throw r.error;
      expect(r.value.traceWritten).toBe(false);
      expect(r.value.traceError).toContain("disk full");
      expect(observed.length).toBe(1);
    } finally {
      cleanup(root);
    }
  });
});

describe("revisionPanel — path canonicalization", () => {
  it("aliased edge paths canonicalize before loadDoc / observe / contest", async () => {
    const root = tmpVault();
    try {
      const loaded: string[] = [];
      const observed: Array<{ from: string; to: string }> = [];
      const aliased = {
        ...dueEdge,
        fromPath: "./pricing/../pricing/a.md",
        toPath: "research/./b.md",
      };
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([{ verdict: "survives", reason: "x" }]),
        loadDoc: async (p) => {
          loaded.push(p);
          return ok({ path: p, content: `c-${p}` });
        },
        observe: async (input) => {
          observed.push({ from: input.fromPath, to: input.toPath });
          return ok({ ...dueEdge });
        },
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      await revisionPanel(aliased, deps, { ...baseOpts, vaultRoot: root, panelSize: 1 });
      expect(loaded).toEqual(["pricing/a.md", "research/b.md"]);
      expect(observed).toEqual([{ from: "pricing/a.md", to: "research/b.md" }]);
    } finally {
      cleanup(root);
    }
  });
});

describe("revisionPanel — write failure post-vote (observe/contest disk error)", () => {
  it("vote is recorded once + observe-failure tracked in writeErrors (not duplicated into votes)", async () => {
    const root = tmpVault();
    try {
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([{ verdict: "survives", reason: "ok" }]),
        loadDoc: async (p) => ok({ path: p, content: `c-${p}` }),
        observe: async () => ({ ok: false, error: new Error("edges.jsonl disk full") }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 1 });
      if (!r.ok) throw r.error;
      // ONE vote entry (the success vote — the LLM said survives, that stands).
      expect(r.value.votes.length).toBe(1);
      expect(r.value.observedCount).toBe(0);
      // The downstream-write failure surfaces in writeErrors, not as a phantom
      // second vote entry with the same axis.
      expect(r.value.writeErrors.length).toBe(1);
      expect(r.value.writeErrors[0].error).toContain("disk full");
    } finally {
      cleanup(root);
    }
  });
});

describe("revisionPanel — LLM failures", () => {
  it("a JSON-parse failure on one vote skips it but does not abort the panel", async () => {
    const root = tmpVault();
    try {
      const observed: unknown[] = [];
      const llm: LlmClient = {
        complete: vi.fn(),
        completeJson: vi
          .fn()
          .mockResolvedValueOnce({
            ok: false,
            error: { kind: "llm" as const, message: "JSON parse error", retryable: false },
          })
          .mockResolvedValueOnce({
            ok: true,
            value: {
              text: '{"verdict":"survives","reason":"ok"}',
              parsed: { verdict: "survives", reason: "ok" },
              input_tokens: 10,
              output_tokens: 5,
              stop_reason: "end_turn",
            },
          }),
        completeWithTools: vi.fn(),
      };
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm,
        loadDoc: async (p) => ok({ path: p, content: `c-${p}` }),
        observe: async () => {
          observed.push(1);
          return ok({ ...dueEdge });
        },
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
      };
      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 2 });
      if (!r.ok) throw r.error;
      expect(observed.length).toBe(1);
      expect(r.value.votes.length).toBe(2); // both attempts recorded, one errored
      const errored = r.value.votes.filter((v) => "error" in v);
      expect(errored.length).toBe(1);
    } finally {
      cleanup(root);
    }
  });
});
