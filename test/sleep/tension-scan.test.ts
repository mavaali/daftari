// Unit tests for the tension-scan dream. No network, no API keys: the LLM is
// a scripted stub of the LlmClient interface and neighbor retrieval is a
// stubbed map — the pass's budget, dedupe, ledger, and attribution logic is
// what's under test.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTension, listTensions } from "../../src/curation/tension.js";
import type { CompleteJsonResult, LlmClient } from "../../src/eval/llm.js";
import type { CortexEvalError } from "../../src/eval/types.js";
import { err, ok, type Result } from "../../src/frontmatter/types.js";
import {
  claimText,
  runTensionScan,
  type TensionScanDeps,
  type TensionScanOpts,
} from "../../src/sleep/tension-scan.js";
import { readTensionScanState } from "../../src/sleep/tension-scan-state.js";

const TODAY = new Date().toISOString().slice(0, 10);

let vault: string;

function writeDoc(relPath: string, body: string): void {
  const collection = relPath.split("/")[0] ?? "";
  mkdirSync(join(vault, collection), { recursive: true });
  writeFileSync(
    join(vault, relPath),
    `---\ntitle: "Doc ${relPath}"\ndomain: "accumulation"\ncollection: "${collection}"\n` +
      `status: "canonical"\nconfidence: "medium"\ncreated: "${TODAY}"\nupdated: "${TODAY}"\n` +
      `updated_by: "agent:test"\nprovenance: "direct"\nsuperseded_by: null\nttl_days: 120\n` +
      `sources: []\ntags: []\n---\n\n${body}\n`,
    "utf-8",
  );
}

// A scripted LlmClient: each completeJson call consumes the next entry.
// Entries are either a parsed verdict or an error. Running past the script
// fails the test loudly (a budget/dedupe leak would show up as extra calls).
type ScriptEntry = { parsed: unknown } | { error: CortexEvalError };

function stubLlm(script: ScriptEntry[]): { llm: LlmClient; calls: () => number } {
  let used = 0;
  const completeJson = async (): Promise<Result<CompleteJsonResult, CortexEvalError>> => {
    const entry = script[used];
    used++;
    if (entry === undefined) {
      return err({ kind: "runtime", message: "stub script exhausted — unexpected LLM call" });
    }
    if ("error" in entry) return err(entry.error);
    return ok({
      text: JSON.stringify(entry.parsed),
      input_tokens: 10,
      output_tokens: 5,
      stop_reason: "end_turn",
      parsed: entry.parsed,
    });
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("tension-scan must only use completeJson");
  };
  return {
    llm: {
      completeJson,
      complete: unexpected as unknown as LlmClient["complete"],
      completeWithTools: unexpected as unknown as LlmClient["completeWithTools"],
    },
    calls: () => used,
  };
}

// Neighbor stub: a static adjacency map. Unknown paths have no neighbors.
function stubSearch(map: Record<string, string[]>): TensionScanDeps["searchNeighbors"] {
  return async (path) => ok(map[path] ?? []);
}

function opts(overrides: Partial<TensionScanOpts> = {}): TensionScanOpts {
  return {
    vaultRoot: vault,
    agent: "agent:sleep-tension-scan",
    model: "stub-model",
    maxLlmCalls: 200,
    maxDocs: 50,
    ...overrides,
  };
}

const CONFLICT = { parsed: { conflict: true, kind: "factual", reason: "regions disagree" } };
const NO_CONFLICT = { parsed: { conflict: false } };

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-tension-scan-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("runTensionScan — detection and attribution", () => {
  it("logs a conflict with kind and loggedBy attribution", async () => {
    writeDoc("ops/a.md", "Primary region is us-east-1.");
    writeDoc("ops/b.md", "Primary region is eu-west-2.");
    const { llm } = stubLlm([{ parsed: { conflict: true, kind: "temporal", reason: "moved" } }]);

    const r = await runTensionScan(opts(), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["ops/b.md"], "ops/b.md": ["ops/a.md"] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tensionsLogged).toBe(1);
    expect(r.value.pairsJudged).toBe(1); // the (b,a) rescan dedupes in-run

    const ledger = await listTensions(vault);
    expect(ledger.ok).toBe(true);
    if (!ledger.ok) return;
    expect(ledger.value).toHaveLength(1);
    const entry = ledger.value[0];
    expect(entry?.loggedBy).toBe("agent:sleep-tension-scan");
    expect(entry?.kind).toBe("temporal");
    expect(entry?.resolved).toBe(false);
    expect([entry?.sourceA, entry?.sourceB].sort()).toEqual(["ops/a.md", "ops/b.md"]);
  });

  it("uses the configured agent id for loggedBy", async () => {
    writeDoc("ops/a.md", "X.");
    writeDoc("ops/b.md", "Not X.");
    const { llm } = stubLlm([CONFLICT]);
    const r = await runTensionScan(opts({ agent: "agent:custom-scanner" }), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["ops/b.md"] }),
    });
    expect(r.ok).toBe(true);
    const ledger = await listTensions(vault);
    if (!ledger.ok) return;
    expect(ledger.value[0]?.loggedBy).toBe("agent:custom-scanner");
  });

  it("coerces an out-of-taxonomy kind on a conflict to factual", async () => {
    writeDoc("ops/a.md", "X.");
    writeDoc("ops/b.md", "Not X.");
    const { llm } = stubLlm([{ parsed: { conflict: true, kind: "vibes", reason: "" } }]);
    const r = await runTensionScan(opts(), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["ops/b.md"] }),
    });
    expect(r.ok).toBe(true);
    const ledger = await listTensions(vault);
    if (!ledger.ok) return;
    expect(ledger.value[0]?.kind).toBe("factual");
  });
});

describe("runTensionScan — conservative failure modes", () => {
  it("defaults an LLM error to no-conflict and continues the pass", async () => {
    writeDoc("ops/a.md", "A.");
    writeDoc("ops/b.md", "B.");
    writeDoc("ops/c.md", "C.");
    const { llm, calls } = stubLlm([
      { error: { kind: "llm", message: "JSON parse: garbage", retryable: false } },
      CONFLICT, // the pass must reach this second pair
    ]);
    const r = await runTensionScan(opts(), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["ops/b.md"], "ops/b.md": ["ops/c.md"] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parseFailures).toBe(1);
    expect(r.value.tensionsLogged).toBe(1); // only the (b,c) conflict
    expect(calls()).toBe(2);
    // The failed pair is NOT persisted as judged — a later pass may retry it.
    const state = readTensionScanState(vault);
    expect(state.judgedPairs).toHaveLength(1);
  });

  it("defaults an unparseable verdict shape to no-conflict", async () => {
    writeDoc("ops/a.md", "A.");
    writeDoc("ops/b.md", "B.");
    const { llm } = stubLlm([{ parsed: { verdict: "yes" } }]); // no boolean `conflict`
    const r = await runTensionScan(opts(), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["ops/b.md"] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.parseFailures).toBe(1);
    expect(r.value.tensionsLogged).toBe(0);
    const ledger = await listTensions(vault);
    if (!ledger.ok) return;
    expect(ledger.value).toHaveLength(0);
  });
});

describe("runTensionScan — budgets", () => {
  it("short-circuits at max LLM calls and leaves unscanned docs for the next pass", async () => {
    writeDoc("ops/a.md", "A.");
    writeDoc("ops/b.md", "B.");
    writeDoc("ops/c.md", "C.");
    writeDoc("ops/d.md", "D.");
    const { llm, calls } = stubLlm([NO_CONFLICT, NO_CONFLICT, NO_CONFLICT]);
    const r = await runTensionScan(opts({ maxLlmCalls: 1 }), {
      llm,
      searchNeighbors: stubSearch({
        "ops/a.md": ["ops/b.md"],
        "ops/b.md": ["ops/c.md"],
        "ops/c.md": ["ops/d.md"],
      }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls()).toBe(1); // the hard requirement: never a second network call
    expect(r.value.pairsJudged).toBe(1);
    expect(r.value.budgetExhausted).toBe(true);
    // Only the fully-processed doc is marked scanned; the rest re-enter next pass.
    expect(r.value.docsScanned).toBe(1);
    const state = readTensionScanState(vault);
    expect(Object.keys(state.scanned)).toEqual(["ops/a.md"]);
  });

  it("caps candidates at maxDocs per pass", async () => {
    writeDoc("ops/a.md", "A.");
    writeDoc("ops/b.md", "B.");
    writeDoc("ops/c.md", "C.");
    const { llm } = stubLlm([NO_CONFLICT]);
    const r = await runTensionScan(opts({ maxDocs: 1 }), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["ops/b.md"] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.candidates).toBe(1);
    expect(r.value.docsScanned).toBe(1);
  });
});

describe("runTensionScan — dedupe", () => {
  it("never re-judges an unchanged pair across runs", async () => {
    writeDoc("ops/a.md", "A.");
    writeDoc("ops/b.md", "B.");
    writeDoc("ops/c.md", "C.");
    const search = stubSearch({
      "ops/a.md": ["ops/b.md"],
      "ops/b.md": ["ops/a.md"],
      "ops/c.md": ["ops/a.md"],
    });

    // Run 1 scans only a — judging (a,b) once.
    const run1 = stubLlm([NO_CONFLICT]);
    const r1 = await runTensionScan(opts({ maxDocs: 1 }), {
      llm: run1.llm,
      searchNeighbors: search,
    });
    expect(r1.ok).toBe(true);
    expect(run1.calls()).toBe(1);

    // Run 2 scans b and c. b resurfaces the unchanged (a,b) pair — skipped
    // without spend; c surfaces the new (a,c) pair — judged.
    const run2 = stubLlm([NO_CONFLICT]);
    const r2 = await runTensionScan(opts(), { llm: run2.llm, searchNeighbors: search });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(run2.calls()).toBe(1); // only (a,c)
    expect(r2.value.pairsSkippedJudged).toBe(1); // (a,b) deduped across runs
  });

  it("re-judges a pair when either side's content changes", async () => {
    writeDoc("ops/a.md", "A v1.");
    writeDoc("ops/b.md", "B.");
    const search = stubSearch({ "ops/a.md": ["ops/b.md"], "ops/b.md": ["ops/a.md"] });

    const run1 = stubLlm([NO_CONFLICT]);
    expect((await runTensionScan(opts(), { llm: run1.llm, searchNeighbors: search })).ok).toBe(
      true,
    );
    expect(run1.calls()).toBe(1);

    // Edit a — it re-enters the candidate queue and the pair hash changes.
    writeDoc("ops/a.md", "A v2, now contradicting B.");
    const run2 = stubLlm([CONFLICT]);
    const r2 = await runTensionScan(opts(), { llm: run2.llm, searchNeighbors: search });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.candidates).toBe(1); // only the changed doc
    expect(run2.calls()).toBe(1);
    expect(r2.value.tensionsLogged).toBe(1);
  });

  it("never re-logs an existing unresolved tension for the same pair", async () => {
    writeDoc("ops/a.md", "A.");
    writeDoc("ops/b.md", "B.");
    const pre = await addTension(vault, {
      title: "a vs b",
      sourceA: "ops/a.md",
      claimA: "A.",
      sourceB: "ops/b.md",
      claimB: "B.",
      kind: "factual",
      loggedBy: "human:mihir",
    });
    expect(pre.ok).toBe(true);

    const { llm, calls } = stubLlm([]);
    const r = await runTensionScan(opts(), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["ops/b.md"], "ops/b.md": ["ops/a.md"] }),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls()).toBe(0); // an open pair is not even judged
    expect(r.value.pairsSkippedExistingTension).toBe(1);
    expect(r.value.tensionsLogged).toBe(0);
    const ledger = await listTensions(vault);
    if (!ledger.ok) return;
    expect(ledger.value).toHaveLength(1); // still just the pre-existing entry
  });
});

describe("runTensionScan — RBAC", () => {
  it("skips pairs where a side is not readable and never logs them", async () => {
    writeDoc("ops/a.md", "A.");
    writeDoc("secret/b.md", "B.");
    writeDoc("ops/c.md", "C.");
    const { llm, calls } = stubLlm([CONFLICT]);
    const r = await runTensionScan(opts(), {
      llm,
      searchNeighbors: stubSearch({ "ops/a.md": ["secret/b.md", "ops/c.md"] }),
      sourceVisible: (p) => !p.startsWith("secret/"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.pairsSkippedAccess).toBe(1); // (a, secret/b) gated, unjudged
    expect(calls()).toBe(1); // only (a, c)
    const ledger = await listTensions(vault);
    if (!ledger.ok) return;
    expect(ledger.value).toHaveLength(1);
    expect(ledger.value[0]?.sourceB).toBe("ops/c.md");
  });
});

describe("claimText", () => {
  it("strips the provenance section and collapses whitespace", () => {
    expect(claimText("The claim.\n\nMore.\n\n## Provenance\n\nstore: row-1\n")).toBe(
      "The claim. More.",
    );
  });
});
