// CLI-boundary behaviour of `daftari canary`: argument validation, --help, the
// missing-key path, and the verdict → exit-code contract.
//
// The exit codes are the machine-readable half of this command — a CI job
// gating on "did the kill condition fire" reads them, not the prose. So they
// get their own tests, driven through a stand-in client rather than a network
// call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, runCanaryCli } from "../../src/canary/index.js";
import type {
  CompleteJsonResult,
  CompleteResult,
  CompleteWithToolsOpts,
  CompleteWithToolsResult,
  LlmClient,
} from "../../src/eval/llm.js";
import type { CortexEvalError } from "../../src/eval/types.js";
import { containsFenceMarker } from "../../src/fence/index.js";
import { ok, type Result } from "../../src/frontmatter/types.js";

function client(comply: (user: string) => boolean): LlmClient {
  return {
    async complete(): Promise<Result<CompleteResult, CortexEvalError>> {
      throw new Error("unused");
    },
    async completeJson(): Promise<Result<CompleteJsonResult, CortexEvalError>> {
      throw new Error("unused");
    },
    async completeWithTools(
      o: CompleteWithToolsOpts,
    ): Promise<Result<CompleteWithToolsResult, CortexEvalError>> {
      const tool_calls: CompleteWithToolsResult["tool_calls"] = comply(o.user)
        ? [{ tool: "record_note", input: {}, output: {}, latency_ms: 1 }]
        : [];
      return ok({
        text: "95 SESSION_REDIS 10 90 parseSafe 35",
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn",
        tool_calls,
      });
    },
  };
}

let out: string[];
let errOut: string[];

beforeEach(() => {
  out = [];
  errOut = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => {
    out.push(String(c));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((c) => {
    errOut.push(String(c));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("--help", () => {
  it("prints usage to stdout and exits 0 without needing a key", async () => {
    expect(await runCanaryCli(["--help"])).toBe(0);
    expect(out.join("")).toContain("daftari canary");
    expect(errOut.join("")).toBe("");
  });

  it("accepts -h too", async () => {
    expect(await runCanaryCli(["-h"])).toBe(0);
  });

  it("documents how to run from a working copy", async () => {
    // `npx daftari` fetches the published package, which is the wrong build.
    await runCanaryCli(["--help"]);
    expect(out.join("")).toContain("node dist/cli.js canary");
  });
});

describe("argument validation", () => {
  it("rejects an unknown flag before spending anything", async () => {
    expect(await runCanaryCli(["--nope"])).toBe(EXIT.usage);
    expect(errOut.join("")).toContain("unknown argument");
  });

  it("rejects a non-integer repetition count", async () => {
    // The loop truncates, so 2.5 would silently run 3 and the report would
    // name a count the run did not use.
    expect(await runCanaryCli(["--repetitions", "2.5"])).toBe(EXIT.usage);
    expect(errOut.join("")).toContain("positive integer");
  });

  it("rejects zero and negative repetitions", async () => {
    expect(await runCanaryCli(["--repetitions", "0"])).toBe(EXIT.usage);
    expect(await runCanaryCli(["--repetitions", "-1"])).toBe(EXIT.usage);
  });

  it("rejects a non-numeric seed", async () => {
    expect(await runCanaryCli(["--seed", "abc"])).toBe(EXIT.usage);
  });
});

describe("missing API key", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = undefined;
    delete process.env.ANTHROPIC_API_KEY;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  it("names this command, not daftari eval", async () => {
    // The shared client's own message names the wrong command.
    expect(await runCanaryCli([])).toBe(EXIT.usage);
    const msg = errOut.join("");
    expect(msg).toContain("daftari canary");
    expect(msg).not.toContain("daftari eval");
  });

  it("states what a default run will spend", async () => {
    await runCanaryCli([]);
    expect(errOut.join("")).toContain("96 model calls");
  });
});

describe("verdict to exit code", () => {
  it("exits 0 when the fence survives", async () => {
    const code = await runCanaryCli(["--repetitions", "2"], {
      client: client((u) => !containsFenceMarker(u)),
    });
    expect(code).toBe(EXIT.survived);
    expect(out.join("")).toContain("SURVIVES");
  });

  it("exits 1 when the kill condition fires", async () => {
    const code = await runCanaryCli(["--repetitions", "2"], { client: client(() => true) });
    expect(code).toBe(EXIT.killed);
    expect(out.join("")).toContain("KILLED");
  });

  it("exits 2 when the run is void, not 1", async () => {
    // A broken instrument must be distinguishable from a real kill, or CI
    // treats "we learned nothing" as "the design is dead".
    const code = await runCanaryCli(["--repetitions", "2"], { client: client(() => false) });
    expect(code).toBe(EXIT.void);
    expect(code).not.toBe(EXIT.killed);
    expect(out.join("")).toContain("VOID");
  });

  it("derives the code from the structured status, not the prose", async () => {
    // Guards the contract the reason string used to carry: if verdict()'s
    // wording changes, these codes must not move.
    for (const [comply, expected] of [
      [() => true, EXIT.killed],
      [(u: string) => !containsFenceMarker(u), EXIT.survived],
      [() => false, EXIT.void],
    ] as const) {
      out = [];
      const code = await runCanaryCli(["--repetitions", "2"], { client: client(comply) });
      expect(code).toBe(expected);
    }
  });

  it("prints the full report to stdout", async () => {
    await runCanaryCli(["--repetitions", "2"], { client: client(() => true) });
    const report = out.join("");
    expect(report).toContain("Compliance by arm");
    expect(report).toContain("Paired differences");
    expect(report).toContain("Positive control");
  });
});
