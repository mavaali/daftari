// Stage 2 wiring tests: --mode flag, env-var gating, ANTHROPIC_API_KEY check,
// Component A dispatch, exit-code hierarchy. The LlmClient is fully mocked via
// vi.mock so no real API call happens.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "../../src/frontmatter/types.js";

// Mock the LLM client surface BEFORE importing runConsolidate so the import
// graph sees the mock. The factory returns a client that always answers
// "survives" / "derives" depending on which mode is calling.
vi.mock("../../src/eval/llm.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/eval/llm.js")>("../../src/eval/llm.js");
  return {
    ...actual,
    createAnthropicClient: vi.fn(() => ({
      complete: vi.fn(),
      completeJson: vi.fn(async (opts: { user: string }) => {
        // Birth mode sends doc + neighbor; revision mode sends edge metadata.
        // We can distinguish by looking at the user body for the template
        // marker (revision uses [template:...]).
        const isRevision = /\[template:/.test(opts.user);
        // Birth now uses the foundational-ordering {related, premise} verdict
        // and asks in both orders. The neighbor is always b.md (search mock), so
        // always name the DOC (the non-b.md side) as premise: order 1 has the
        // doc as A → "A"; order 2 has the doc as B → "B". Both orders agree on
        // the same real-world premise → a deterministic directed edge.
        const docIsB = /DOC A \(path: b\.md\)/.test(opts.user);
        const verdict = isRevision
          ? { verdict: "survives", reason: "mock revision survives" }
          : { related: true, premise: docIsB ? "B" : "A", reason: "mock birth premise" };
        return ok({
          text: JSON.stringify(verdict),
          parsed: verdict,
          input_tokens: 200,
          output_tokens: 30,
          stop_reason: "end_turn",
        });
      }),
      completeWithTools: vi.fn(),
    })),
  };
});

// Also mock vault_search_related so birth's neighbor lookup is deterministic.
vi.mock("../../src/tools/search.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/tools/search.js")>(
    "../../src/tools/search.js",
  );
  return {
    ...actual,
    vaultSearchRelated: vi.fn(async () =>
      ok({ count: 1, hits: [{ path: "b.md", collection: "c", score: 0.9 }] }),
    ),
  };
});

const { runConsolidate } = await import("../../src/consolidate/index.js");
const { addTension } = await import("../../src/curation/tension.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-stage2-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  // Two trivial docs so loadDocuments has something to return.
  // Schema-valid frontmatter (updated + updated_by required) so makeAdmit reads
  // these as provenance-known. status:canonical + recent updated so computeDecay
  // stays silent (a draft older than 30d would read as stale/warn → invariants
  // gate, which is not what these dispatch/journal tests are exercising).
  const fm = (title: string) =>
    `---\ntitle: ${title}\ndomain: accumulation\ncollection: c\nstatus: canonical\nconfidence: high\ncreated: 2026-06-17\nupdated: 2026-06-17\nupdated_by: agent:test\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: []\n---\n# ${title}\n`;
  writeFileSync(join(dir, "a.md"), fm("A"));
  writeFileSync(join(dir, "b.md"), fm("B"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  return { out, restore: () => spy.mockRestore() };
}

describe("--mode flag validation", () => {
  it("default mode is 'scan' (Stage 1 behavior, no LLM)", async () => {
    const { out } = captureStdout();
    const code = await runConsolidate(["--vault", dir]);
    expect([0, 4]).toContain(code);
    expect(out.join("")).toMatch(/mode: scan/);
    // No Component A section in scan mode.
    expect(out.join("")).not.toMatch(/Component A/);
  });

  it("--mode=invalid → exit 2", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "lol"]);
    expect(code).toBe(2);
  });

  it("--max-births=abc → exit 2", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "birth", "--max-births", "abc"]);
    expect(code).toBe(2);
  });

  it("--max-panels=-1 → exit 2", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "revision", "--max-panels", "-1"]);
    expect(code).toBe(2);
  });
});

describe("ANTHROPIC_API_KEY gating", () => {
  it("--mode=birth without the env var → exit 2 with clear error (no SDK throw)", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    expect(code).toBe(2);
  });

  it("--mode=scan does NOT require ANTHROPIC_API_KEY", async () => {
    const code = await runConsolidate(["--vault", dir]);
    expect([0, 4]).toContain(code);
  });
});

describe("Stage 2 dispatch — birth", () => {
  it("--mode=birth runs the loop, advances birthProcessed, writes a trace, reports counts", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    // Shadow_mode on so no real edge writes hit the store during the test.
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");

    const { out } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    expect([0, 4]).toContain(code);
    const text = out.join("");
    expect(text).toMatch(/Component A \(birth\)/);
    expect(text).toMatch(/births_processed: [12]/);
    expect(text).toMatch(/llm_calls: \d+/);
    expect(text).toMatch(/shadow_mode: true/);

    // The trace landed.
    expect(existsSync(join(dir, ".daftari", "birth-trace.jsonl"))).toBe(true);
    // birthProcessed advanced in state.
    const stateRaw = readFileSync(join(dir, ".daftari", "consolidate-state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as { birthProcessed: Record<string, string> };
    expect(Object.keys(state.birthProcessed).length).toBeGreaterThan(0);
    // Shadow mode: no real edges in .daftari/edges.jsonl.
    expect(existsSync(join(dir, ".daftari", "edges.jsonl"))).toBe(false);
    // Stage 3 Task 7: the CLI's makeAdmit journals every envelope decision to
    // shadow-actions.jsonl (regardless of shadow mode). The two clean docs admit
    // a directed edge, so at least one admitted row lands.
    expect(existsSync(join(dir, ".daftari", "shadow-actions.jsonl"))).toBe(true);
    const journal = readFileSync(join(dir, ".daftari", "shadow-actions.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { decision?: string });
    expect(journal.some((r) => r.decision === "admitted")).toBe(true);
  });
});

describe("Stage 3 — envelope gating end-to-end (birth)", () => {
  it("an unresolved tension on an endpoint → reports gated >=1, no edge observed, a gated row journaled", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");
    // The birth edge for a.md's neighbor is the directed pair a.md ← b.md (the
    // search mock returns b.md). Seed an unresolved tension on b.md so the
    // envelope refuses on invariants (tension-respect).
    const t = await addTension(dir, {
      title: "b is contested",
      kind: "factual",
      sourceA: "b.md",
      claimA: "x",
      sourceB: "a.md",
      claimB: "y",
      loggedBy: "human:test",
    });
    expect(t.ok).toBe(true);

    const { out } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    expect([0, 4]).toContain(code);
    const text = out.join("");
    expect(text).toMatch(/gated: [1-9]/);

    const journal = readFileSync(join(dir, ".daftari", "shadow-actions.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { decision?: string; gate?: string });
    // At least one gated decision was journaled; none admitted (the only edge
    // candidate touches the contested endpoint).
    expect(journal.some((r) => r.decision === "gated" && r.gate === "invariants")).toBe(true);
    expect(journal.some((r) => r.decision === "admitted")).toBe(false);
    // No real edge store write under shadow mode either.
    expect(existsSync(join(dir, ".daftari", "edges.jsonl"))).toBe(false);
  });

  it("a clean edge yields an admitted decision row", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");

    const { restore } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    restore();
    expect([0, 4]).toContain(code);

    const journal = readFileSync(join(dir, ".daftari", "shadow-actions.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { decision?: string });
    expect(journal.some((r) => r.decision === "admitted")).toBe(true);
  });
});

describe("Stage 2 dispatch — --max-births cap", () => {
  it("caps the number of docs processed in birth mode", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");
    // Add more docs so the cap matters.
    for (let i = 0; i < 5; i++) {
      const fm = `---\ntitle: D${i}\ndomain: accumulation\ncollection: c\nstatus: draft\nconfidence: medium\ncreated: 2026-05-01\nupdated: 2026-06-17\nupdated_by: agent:test\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: []\n---\n# D${i}\n`;
      writeFileSync(join(dir, `d${i}.md`), fm);
    }

    const { out } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth", "--max-births", "2"]);
    expect([0, 4]).toContain(code);
    const text = out.join("");
    // Exactly the cap (2 of the 7 docs queued; queue order is birth-slice FIFO).
    expect(text).toMatch(/births_processed: 2/);
  });
});

describe("--report=decorrelation", () => {
  it("missing --fixture → exit 2 with clear error", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const code = await runConsolidate(["--report", "decorrelation"]);
    expect(code).toBe(2);
  });

  it("missing ANTHROPIC_API_KEY → exit 2", async () => {
    const code = await runConsolidate([
      "--report",
      "decorrelation",
      "--fixture",
      join(dir, "no-fixture.json"),
    ]);
    expect(code).toBe(2);
  });

  it("unknown --report value → exit 2", async () => {
    const code = await runConsolidate(["--report", "lol"]);
    expect(code).toBe(2);
  });

  it("happy path: foundational prompt recovers direction → PASS (accuracy gate), exit 0", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const edges = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i + 1}`,
      fromPath: `from-${i + 1}.md`,
      toPath: `to-${i + 1}.md`,
      fromContent: `from-content-e${i + 1}`,
      toContent: `to-content`,
      truth: "derives",
    }));
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({ version: 1, edges }));

    const llmMod = await import("../../src/eval/llm.js");
    vi.mocked(llmMod.createAnthropicClient).mockImplementation(() => ({
      complete: vi.fn(),
      completeJson: vi.fn(async (opts: { user: string }) => {
        // The report runs BOTH orders; answer consistently — always name the `to`
        // doc as premise (truth=derives ⇒ to is premise). DOC A is the `to` doc in
        // one order and the `from` doc in the other.
        const docAisTo = /DOC A \(path: to-\d+\.md\)/.test(opts.user);
        const parsed = { related: true, premise: docAisTo ? "A" : "B", reason: "derives" };
        return ok({
          text: JSON.stringify(parsed),
          parsed,
          input_tokens: 10,
          output_tokens: 5,
          stop_reason: "end_turn",
        });
      }),
      completeWithTools: vi.fn(),
    }));

    const { out } = captureStdout();
    const code = await runConsolidate(["--report", "decorrelation", "--fixture", fixturePath]);
    expect(out.join("")).toContain("PASS");
    expect(code).toBe(0);
  });

  it("kill condition: all axes always wrong the same way → FAIL, exit 6", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const edges = [
      {
        id: "e1",
        fromPath: "a.md",
        toPath: "b.md",
        fromContent: "x",
        toContent: "y",
        truth: "derives",
      },
      {
        id: "e2",
        fromPath: "c.md",
        toPath: "d.md",
        fromContent: "x",
        toContent: "y",
        truth: "derives",
      },
    ];
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(fixturePath, JSON.stringify({ version: 1, edges }));

    const llmMod = await import("../../src/eval/llm.js");
    vi.mocked(llmMod.createAnthropicClient).mockImplementation(() => ({
      complete: vi.fn(),
      completeJson: vi.fn(async () => {
        // Always related:false → "neither" on derives-truth edges → accuracy 0.
        const parsed = { related: false, premise: null, reason: "always wrong" };
        return ok({
          text: JSON.stringify(parsed),
          parsed,
          input_tokens: 10,
          output_tokens: 5,
          stop_reason: "end_turn",
        });
      }),
      completeWithTools: vi.fn(),
    }));

    const { out } = captureStdout();
    const code = await runConsolidate(["--report", "decorrelation", "--fixture", fixturePath]);
    expect(out.join("")).toContain("FAIL");
    expect(code).toBe(6);
  });
});

describe("Stage 2 — trace failure → exit 5", () => {
  it("if the trace cannot be written (read-only .daftari), exit code is 5", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");
    // Make .daftari read-only AFTER seeding config but BEFORE the run. The
    // shadow-actions.jsonl write hits ENOENT/EACCES; birth-trace also fails.
    // We chmod the dir to 0o555 (r-x).
    const dotDaf = join(dir, ".daftari");
    const fsMod = await import("node:fs");
    fsMod.chmodSync(dotDaf, 0o555);
    try {
      const { out } = captureStdout();
      const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
      // Exit 5 (trace failure) dominates 0 / 4.
      expect(code).toBe(5);
      void out;
    } finally {
      // Restore perms so afterEach can rmSync.
      fsMod.chmodSync(dotDaf, 0o755);
    }
  });
});
