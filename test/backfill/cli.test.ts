import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBackfill } from "../../src/backfill/index.js";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { buildFrontmatterLessVault, cleanupVault } from "../helpers/frontmatter-less-vault.js";

describe("daftari backfill CLI", () => {
  let vault: string;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vault = buildFrontmatterLessVault();
    stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    cleanupVault(vault);
  });

  it("prints help and exits 0 on --help", async () => {
    const code = await runBackfill(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("daftari backfill"));
  });

  it("exits 1 when neither --plan nor --apply is given", async () => {
    const code = await runBackfill(["--vault", vault]);
    expect(code).toBe(1);
  });

  it("exits 1 when both --plan and --apply are given", async () => {
    const code = await runBackfill(["--plan", "--apply", "--vault", vault]);
    expect(code).toBe(1);
  });

  it("--plan writes a plan and summarizes", async () => {
    const code = await runBackfill(["--plan", "--vault", vault]);
    expect(code).toBe(0);
    const planText = readFileSync(join(vault, ".daftari", "backfill-plan.jsonl"), "utf-8");
    expect(planText.split("\n").filter(Boolean)).toHaveLength(4);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("Backfill plan written"));
  });

  it("rejects an explicitly empty --scope at parse time", async () => {
    const code = await runBackfill(["--plan", "--vault", vault, "--scope", ""]);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--scope cannot be empty"));
  });

  it("--apply requires --scope", async () => {
    await runBackfill(["--plan", "--vault", vault]);
    const code = await runBackfill(["--apply", "--vault", vault, "--yes"]);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("requires --scope"));
  });

  it("--apply --scope writes only that folder with --yes", async () => {
    await runBackfill(["--plan", "--vault", vault]);
    const code = await runBackfill(["--apply", "--scope", "notes", "--vault", vault, "--yes"]);
    expect(code).toBe(0);

    // notes/orphan.md now has frontmatter.
    const orphan = readFileSync(join(vault, "notes/orphan.md"), "utf-8");
    const parsed = parseDocument(orphan);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.frontmatter.title).toBe("Orphan Note");

    // specs untouched.
    const foo = readFileSync(join(vault, "specs/data-movement/foo.md"), "utf-8");
    expect(foo.startsWith("---")).toBe(false);
  });

  it("--agent overrides the acting identity", async () => {
    await runBackfill(["--plan", "--vault", vault, "--agent", "agent:curation-loop"]);
    await runBackfill([
      "--apply",
      "--scope",
      "notes",
      "--vault",
      vault,
      "--yes",
      "--agent",
      "agent:curation-loop",
    ]);
    const orphan = readFileSync(join(vault, "notes/orphan.md"), "utf-8");
    // updated_by reflects git author (Sam Rivers, unmapped), NOT the invoker —
    // the field is original authorship, the commit is the migrator's act.
    const parsed = parseDocument(orphan);
    if (parsed.ok) expect(parsed.value.frontmatter.updated_by).toBe("human:sam-rivers");
  });
});
