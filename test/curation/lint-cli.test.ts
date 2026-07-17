import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLintCli } from "../../src/curation/lint-cli.js";

describe("daftari lint CLI", () => {
  let dir: string;
  let out: string[];
  const write = (s: string) => {
    out.push(s);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-lint-cli-"));
    out = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeVaultDoc(relPath: string, sources: string[] = []): void {
    const abs = join(dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      [
        "---",
        `title: "${relPath}"`,
        "domain: accumulation",
        "collection: cli",
        "status: canonical",
        "confidence: high",
        "created: 2026-01-01",
        "updated: 2026-06-01",
        "updated_by: human:mihir",
        "provenance: direct",
        `sources: [${sources.map((s) => JSON.stringify(s)).join(", ")}]`,
        "superseded_by: null",
        "ttl_days: null",
        "tags: []",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
  }

  it("exits 0 on a clean vault", async () => {
    writeVaultDoc("a.md");
    const code = await runLintCli(["--vault", dir], write);
    expect(code).toBe(0);
  });

  it("exits 1 when a tier 0 count meets its fail-on threshold", async () => {
    writeVaultDoc("citer.md", ["missing/gone.md"]);
    const code = await runLintCli(["--vault", dir], write);
    expect(code).toBe(1);
    expect(out.join("")).toContain("brokenSourceRefs");
  });

  it("a raised threshold lets the same vault pass", async () => {
    writeVaultDoc("citer.md", ["missing/gone.md"]);
    const code = await runLintCli(["--vault", dir, "--fail-on-broken-source-refs", "2"], write);
    expect(code).toBe(0);
  });

  it("advisory findings never gate: an orphan doc alone exits 0", async () => {
    // Two docs, neither linking the other: both are orphans, no tier 0 issue.
    writeVaultDoc("a.md");
    writeVaultDoc("b.md");
    const code = await runLintCli(["--vault", dir], write);
    expect(code).toBe(0);
  });

  it("--json emits the full machine-readable report", async () => {
    writeVaultDoc("citer.md", ["missing/gone.md"]);
    const code = await runLintCli(["--vault", dir, "--json"], write);
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.checks.brokenSourceRefs).toHaveLength(1);
    expect(parsed.reviewThroughput).toBeDefined();
  });

  it("exits 2 on a malformed threshold", async () => {
    const code = await runLintCli(["--vault", dir, "--fail-on-broken-source-refs", "lots"], write);
    expect(code).toBe(2);
  });

  it("--help prints usage and exits 0", async () => {
    const code = await runLintCli(["--help"], write);
    expect(code).toBe(0);
    expect(out.join("")).toContain("daftari lint");
  });
});
