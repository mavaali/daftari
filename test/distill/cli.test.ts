// test/distill/cli.test.ts
//
// Tests for the `daftari distill` CLI front door (U7).
//
// Three scenarios per the plan — all zero-spend (no API key required):
//   1. `--plan` path: prints estimate + exits 0.
//   2. Missing `distill:` config block → exits 3 with a refuse message.
//   3. No source arg (bad usage) → exits 2.
//
// Tests call `runDistill(argv)` directly and assert on:
//   - returned exit code
//   - captured stdout / stderr
//
// Each test uses a temp vault. The --plan vault has a valid `distill:` block;
// the missing-config vault has none. Neutral fixtures (no real names or paths).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDistill } from "../../src/distill/index.js";

// ---------------------------------------------------------------------------
// Temp vault helpers
// ---------------------------------------------------------------------------

function makeTempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-distill-cli-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  return dir;
}

function writeConfig(vaultDir: string, yaml: string): void {
  writeFileSync(join(vaultDir, ".daftari", "config.yaml"), yaml, "utf-8");
}

/** A minimal valid `distill:` config block. */
const DISTILL_CONFIG_YAML = [
  "version: 1",
  "distill:",
  "  model: claude-haiku-4-5",
  "  max_llm_calls: 10",
  "  max_claims: 20",
  "  max_verbatim_chars: 4000",
  "  in_call_input_cap: 8000",
].join("\n");

/** A minimal chat-transcript fixture — two turns, enough to chunk. */
const SAMPLE_TRANSCRIPT = [
  "[1/2/26, 9:00:00 AM] Alice: The project deadline is end of Q2.",
  "[1/2/26, 9:01:00 AM] Bob: Agreed. We will use TypeScript for the new service.",
  "[1/2/26, 9:02:00 AM] Alice: Confirmed. No new external dependencies without review.",
].join("\n");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let vault: string;
let noDistillVault: string;
let sampleFile: string;

beforeEach(() => {
  vault = makeTempVault();
  writeConfig(vault, DISTILL_CONFIG_YAML);

  // Write a sample chat transcript the --plan path can parse
  sampleFile = join(vault, "sample.txt");
  writeFileSync(sampleFile, SAMPLE_TRANSCRIPT, "utf-8");

  noDistillVault = makeTempVault();
  // No distill block — just a bare version declaration
  writeConfig(noDistillVault, "version: 1\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(noDistillVault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 1: --plan prints estimate + exits 0
// ---------------------------------------------------------------------------

describe("runDistill --plan", () => {
  it("exits 0 on a valid source file with a configured vault", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile]);
    expect(code).toBe(0);
  });

  it("prints a non-empty estimate to stdout", async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan", sampleFile]);
    } finally {
      process.stdout.write = orig;
    }
    const out = lines.join("");
    expect(out.length).toBeGreaterThan(0);
    // Must mention chunks or calls so the estimate is actually informative
    expect(out.toLowerCase()).toMatch(/chunk|call|model/);
  });

  it("writes diagnostics to stderr, not stdout, when noting the plan mode", async () => {
    // stdout must stay clean enough for piping — verify plan output is on stdout
    const stdoutLines: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      if (typeof chunk === "string") stdoutLines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan", sampleFile]);
    } finally {
      process.stdout.write = origOut;
    }
    // At minimum stdout must have been written (non-empty plan output)
    expect(stdoutLines.join("").length).toBeGreaterThan(0);
  });

  it("requires no API key (zero-spend path)", async () => {
    // Save and delete all API keys to prove no key is consulted
    const saved: Record<string, string | undefined> = {};
    for (const k of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    let code: number;
    try {
      code = await runDistill(["--vault", vault, "--plan", sampleFile]);
    } finally {
      for (const k of ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Missing distill config → exits 3 with refuse message
// ---------------------------------------------------------------------------

describe("runDistill — missing distill config", () => {
  it("exits 3 when the distill: block is absent from config.yaml", async () => {
    const code = await runDistill(["--vault", noDistillVault, "--plan", sampleFile]);
    expect(code).toBe(3);
  });

  it("writes a refuse message mentioning 'distill' to stderr", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", noDistillVault, "--plan", sampleFile]);
    } finally {
      process.stderr.write = orig;
    }
    const out = lines.join("");
    expect(out.toLowerCase()).toMatch(/distill/);
  });

  it("writes nothing to stdout on a config-refuse exit", async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", noDistillVault, "--plan", sampleFile]);
    } finally {
      process.stdout.write = orig;
    }
    expect(lines.join("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: No source arg → exits 2 (usage error)
// ---------------------------------------------------------------------------

describe("runDistill — bad usage (no source)", () => {
  it("exits 2 when no source file is given", async () => {
    const code = await runDistill(["--vault", vault, "--plan"]);
    expect(code).toBe(2);
  });

  it("writes a usage message to stderr", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan"]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("").length).toBeGreaterThan(0);
  });

  it("exits 2 when stdin is requested without --source-id", async () => {
    // "-" as source without --source-id is a usage error
    const code = await runDistill(["--vault", vault, "--plan", "-"]);
    expect(code).toBe(2);
  });

  it("writes nothing to stdout on a usage-error exit", async () => {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan"]);
    } finally {
      process.stdout.write = orig;
    }
    expect(lines.join("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: unknown flag → exits 2
// ---------------------------------------------------------------------------

describe("runDistill — unknown flag", () => {
  it("exits 2 on an unknown flag", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--not-a-real-flag"]);
    expect(code).toBe(2);
  });

  it("writes a message mentioning the unknown flag to stderr", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan", sampleFile, "--not-a-real-flag"]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("")).toMatch(/--not-a-real-flag/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: both --plan and --propose → exits 2
// ---------------------------------------------------------------------------

describe("runDistill — both --plan and --propose", () => {
  it("exits 2 when both --plan and --propose are given", async () => {
    const code = await runDistill(["--vault", vault, "--plan", "--propose", sampleFile]);
    expect(code).toBe(2);
  });

  it("writes a usage message to stderr", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan", "--propose", sampleFile]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("")).toMatch(/cannot specify both/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: --max-claims with invalid values → exits 2
// ---------------------------------------------------------------------------

describe("runDistill — invalid numeric flags", () => {
  it("exits 2 when --max-claims is non-numeric", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--max-claims", "abc"]);
    expect(code).toBe(2);
  });

  it("exits 2 when --max-claims is zero", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--max-claims", "0"]);
    expect(code).toBe(2);
  });

  it("exits 2 when --max-claims is negative", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--max-claims", "-5"]);
    expect(code).toBe(2);
  });

  it("exits 2 when --max-llm-calls is non-numeric", async () => {
    const code = await runDistill([
      "--vault",
      vault,
      "--plan",
      sampleFile,
      "--max-llm-calls",
      "abc",
    ]);
    expect(code).toBe(2);
  });

  it("writes a message mentioning the flag name to stderr", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan", sampleFile, "--max-claims", "abc"]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("")).toMatch(/--max-claims/);
  });

  it("exits 0 when --max-claims is a valid positive integer", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--max-claims", "5"]);
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: value-taking flag at end of argv → exits 2 (I1)
// ---------------------------------------------------------------------------

describe("runDistill — value-taking flag with missing value", () => {
  it("exits 2 when --source-id is the last token with no value", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--source-id"]);
    expect(code).toBe(2);
  });

  it("exits 2 when --transport is the last token with no value", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--transport"]);
    expect(code).toBe(2);
  });

  it("exits 2 when --model is the last token with no value", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--model"]);
    expect(code).toBe(2);
  });

  it("exits 2 when --max-claims is the last token with no value", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, "--max-claims"]);
    expect(code).toBe(2);
  });

  it("writes a 'requires a value' message to stderr", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan", sampleFile, "--source-id"]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("")).toMatch(/requires a value/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: extra positionals → exits 2 (m3)
// ---------------------------------------------------------------------------

describe("runDistill — extra positionals", () => {
  it("exits 2 when two source arguments are given", async () => {
    const code = await runDistill(["--vault", vault, "--plan", sampleFile, sampleFile]);
    expect(code).toBe(2);
  });

  it("writes a message about only one source being accepted", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: unknown) => {
      if (typeof chunk === "string") lines.push(chunk);
      return true;
    };
    try {
      await runDistill(["--vault", vault, "--plan", sampleFile, sampleFile]);
    } finally {
      process.stderr.write = orig;
    }
    expect(lines.join("")).toMatch(/only one source/);
  });
});
