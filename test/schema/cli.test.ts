import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSchema } from "../../src/schema/index.js";
import { buildVault, cleanupVault } from "./helpers.js";

// process.stdout.write's overloaded signature makes vi.spyOn's captured call
// arguments awkward to narrow; every write in this module is a plain string,
// so stringify defensively rather than fight the mock's inferred type.
function writes(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

const CONFIG_WITH_EXTENSIONS = [
  "version: 1",
  "schema_extensions:",
  "  priority:",
  "    type: enum",
  "    enum: [low, medium, high]",
  "",
].join("\n");

describe("daftari schema CLI", () => {
  let vault: string | undefined;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    if (vault) cleanupVault(vault);
  });

  it("prints help and exits 0 on --help", async () => {
    const code = await runSchema(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("daftari schema"));
  });

  it("exits 1 with no arguments", async () => {
    const code = await runSchema([]);
    expect(code).toBe(1);
  });

  it("exits 1 on an unknown subcommand", async () => {
    const code = await runSchema(["bogus"]);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unknown subcommand"));
  });

  it("infer reports occurrence counts as text", async () => {
    vault = buildVault([
      { path: "notes/a.md", body: "---\ntitle: A\npriority: high\n---\nbody\n" },
      { path: "notes/b.md", body: "---\ntitle: B\npriority: high\n---\nbody\n" },
    ]);
    const code = await runSchema(["infer", "--vault", vault]);
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("priority"));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("2/2 docs"));
  });

  it("infer --json emits a parseable report", async () => {
    vault = buildVault([{ path: "notes/a.md", body: "---\ntitle: A\n---\nbody\n" }]);
    const code = await runSchema(["infer", "--vault", vault, "--json"]);
    expect(code).toBe(0);
    const call = writes(stdout).find((s) => s.includes("totalDocs"));
    expect(call).toBeDefined();
    const parsed = JSON.parse(call!);
    expect(parsed.totalDocs).toBe(1);
    expect(parsed.fields.some((f: { field: string }) => f.field === "title")).toBe(true);
  });

  it("infer honors --scope", async () => {
    vault = buildVault([
      { path: "notes/a.md", body: "---\ntitle: A\n---\nbody\n" },
      { path: "other/b.md", body: "---\ntitle: B\nextra: 1\n---\nbody\n" },
    ]);
    const code = await runSchema(["infer", "--vault", vault, "--scope", "notes"]);
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.not.stringContaining("extra"));
  });

  it("rejects an explicitly empty --scope", async () => {
    vault = buildVault([{ path: "notes/a.md", body: "---\ntitle: A\n---\nbody\n" }]);
    const code = await runSchema(["infer", "--vault", vault, "--scope", ""]);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--scope cannot be empty"));
  });

  it("diff reports undeclared keys and declared-enum drift", async () => {
    vault = buildVault(
      [
        { path: "notes/a.md", body: "---\ntitle: A\npriority: urgent\nstate: open\n---\nbody\n" },
        { path: "notes/b.md", body: "---\ntitle: B\npriority: high\nstate: open\n---\nbody\n" },
      ],
      CONFIG_WITH_EXTENSIONS,
    );
    const code = await runSchema(["diff", "--vault", vault]);
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("state"));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("priority"));
  });

  it("diff --min-occurrences filters undeclared keys", async () => {
    vault = buildVault(
      [{ path: "notes/a.md", body: "---\ntitle: A\nowner: alice\n---\nbody\n" }],
      CONFIG_WITH_EXTENSIONS,
    );
    const defaultCode = await runSchema(["diff", "--vault", vault, "--json"]);
    expect(defaultCode).toBe(0);
    const defaultCall = writes(stdout).find((s) => s.includes("undeclared"));
    const defaultReport = JSON.parse(defaultCall!);
    expect(
      defaultReport.undeclared.find((u: { field: string }) => u.field === "owner"),
    ).toBeUndefined();

    stdout.mockClear();
    const loweredCode = await runSchema([
      "diff",
      "--vault",
      vault,
      "--json",
      "--min-occurrences",
      "1",
    ]);
    expect(loweredCode).toBe(0);
    const loweredCall = writes(stdout).find((s) => s.includes("undeclared"));
    const loweredReport = JSON.parse(loweredCall!);
    expect(
      loweredReport.undeclared.find((u: { field: string }) => u.field === "owner"),
    ).toBeDefined();
  });

  it("rejects a non-numeric --min-occurrences", async () => {
    vault = buildVault([{ path: "notes/a.md", body: "---\ntitle: A\n---\nbody\n" }]);
    const code = await runSchema(["diff", "--vault", vault, "--min-occurrences", "abc"]);
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--min-occurrences"));
  });

  it("diff exits 2 when config.yaml is malformed", async () => {
    vault = buildVault(
      [{ path: "notes/a.md", body: "---\ntitle: A\n---\nbody\n" }],
      "version: 1\n  bad indent: [oops\n",
    );
    const code = await runSchema(["diff", "--vault", vault]);
    expect(code).toBe(2);
  });
});
