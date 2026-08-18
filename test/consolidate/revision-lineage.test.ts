// Task 4 (6mf.4 R3, R10): Revision panel appends reader-lineage to from-doc
// on applied writes only. The panel itself stays pure; the appendReaderLineage
// dep is injected by the CLI. Tests here use stubs.

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type RevisionDeps,
  type RevisionOpts,
  revisionPanel,
} from "../../src/consolidate/revision.js";
import { encodeRevisionReader, parseLineageEntry } from "../../src/distill/reader-fingerprint.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { err, ok } from "../../src/frontmatter/types.js";

function tmpVault(): string {
  const root = join(
    tmpdir(),
    `daftari-rev-lineage-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
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

const ADMIT_OK: RevisionDeps["admit"] = async () => ({
  admit: true,
  gate: null,
  reason: "ok",
  impact: 0,
});

const ADMIT_REFUSE: RevisionDeps["admit"] = async () => ({
  admit: false,
  gate: "budget" as const,
  reason: "over budget",
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

const baseOpts: RevisionOpts = {
  vaultRoot: "",
  agent: "agent:curation-loop",
  panelSize: 2,
  budgetRemaining: 100,
  model: "claude-haiku-test",
};

describe("revisionPanel — appendReaderLineage (6mf.4 R3)", () => {
  it("survives with observes applied → appendReaderLineage called once with revision entry for panel model", async () => {
    const root = tmpVault();
    try {
      const appendCalls: Array<{ path: string; entry: string }> = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "survives", reason: "still" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
        appendReaderLineage: async (path, entry) => {
          appendCalls.push({ path, entry });
          return ok(undefined);
        },
      };

      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;

      expect(r.value.decision).toBe("survives");
      expect(r.value.observedCount).toBeGreaterThan(0);

      // appendReaderLineage must be called exactly ONCE on the from-doc
      expect(appendCalls).toHaveLength(1);
      expect(appendCalls[0]!.path).toBe("a.md");

      // The entry must be a "revision" lineage entry for the panel model
      const parsed = parseLineageEntry(appendCalls[0]!.entry);
      expect(parsed).not.toBeNull();
      expect(parsed!.op).toBe("revision");
      const expectedReader = encodeRevisionReader(baseOpts.model);
      expect(parsed!.reader).toBe(expectedReader);
    } finally {
      cleanup(root);
    }
  });

  it("gated → appendReaderLineage NOT called", async () => {
    const root = tmpVault();
    try {
      const appendCalls: string[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_REFUSE,
        llm: mockLlm([
          { verdict: "fails", reason: "no link" },
          { verdict: "fails", reason: "dead" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
        appendReaderLineage: async (path) => {
          appendCalls.push(path);
          return ok(undefined);
        },
      };

      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("gated");
      expect(appendCalls).toHaveLength(0);
    } finally {
      cleanup(root);
    }
  });

  it("tie → appendReaderLineage NOT called", async () => {
    const root = tmpVault();
    try {
      const appendCalls: string[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "fails", reason: "no" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
        appendReaderLineage: async (path) => {
          appendCalls.push(path);
          return ok(undefined);
        },
      };

      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root, panelSize: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("tie");
      expect(appendCalls).toHaveLength(0);
    } finally {
      cleanup(root);
    }
  });

  it("no-vote (all LLM calls error → 0 survives, 0 fails) → appendReaderLineage NOT called", async () => {
    // When all LLM calls error, survivesCount=0 and failsCount=0 → decision="no-vote"
    const root = tmpVault();
    try {
      const appendCalls: string[] = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: {
          complete: vi.fn(),
          completeJson: vi.fn(async () => err(new Error("llm unavailable"))),
          completeWithTools: vi.fn(),
        },
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
        appendReaderLineage: async (path) => {
          appendCalls.push(path);
          return ok(undefined);
        },
      };

      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      // All LLM errors → no-vote decision; no observedCount, no contestedCount
      expect(r.value.decision).toBe("no-vote");
      expect(r.value.observedCount).toBe(0);
      expect(r.value.contestedCount).toBe(0);
      expect(appendCalls).toHaveLength(0);
    } finally {
      cleanup(root);
    }
  });

  it("append failure lands in writeErrors, panel still returns ok", async () => {
    const root = tmpVault();
    try {
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "survives", reason: "ok" },
          { verdict: "survives", reason: "still" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
        appendReaderLineage: async () => err(new Error("lineage append failed")),
      };

      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      // Panel still returns ok (append failure is non-fatal)
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("survives");
      // The error should be captured in writeErrors
      const lineageError = r.value.writeErrors.find((e) => e.error.includes("lineage"));
      expect(lineageError).toBeDefined();
    } finally {
      cleanup(root);
    }
  });

  it("majority fails (contested) → appendReaderLineage called once on from-doc", async () => {
    const root = tmpVault();
    try {
      const appendCalls: Array<{ path: string; entry: string }> = [];
      const deps: RevisionDeps = {
        admit: ADMIT_OK,
        llm: mockLlm([
          { verdict: "fails", reason: "no link" },
          { verdict: "fails", reason: "dead" },
        ]),
        loadDoc: async (p) => ok({ path: p, content: `[content of ${p}]` }),
        observe: async () => ok({ ...dueEdge }),
        contest: async () => ok({ ...dueEdge }),
        recordRevisionTrace: async () => ok(undefined),
        appendReaderLineage: async (path, entry) => {
          appendCalls.push({ path, entry });
          return ok(undefined);
        },
      };

      const r = await revisionPanel(dueEdge, deps, { ...baseOpts, vaultRoot: root });
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(r.value.decision).toBe("fails");
      expect(r.value.contestedCount).toBeGreaterThan(0);

      // Lineage must be appended on the from-doc (contested path also applies writes)
      expect(appendCalls).toHaveLength(1);
      expect(appendCalls[0]!.path).toBe("a.md");
    } finally {
      cleanup(root);
    }
  });
});
