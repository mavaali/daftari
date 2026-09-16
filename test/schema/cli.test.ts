import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSchema } from "../../src/schema/index.js";

describe("daftari schema CLI", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-schema-cli-"));
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      [
        "version: 1",
        "schema_extensions:",
        "  team:",
        "    type: string",
        "  retired:",
        "    type: boolean",
        "",
      ].join("\n"),
    );
    writeFileSync(join(vault, "notes", "a.md"), "---\nteam: platform\nstate: active\n---\n# A\n");
    writeFileSync(join(vault, "notes", "b.md"), "---\nteam: data\nstate: paused\n---\n# B\n");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(vault, { recursive: true, force: true });
  });

  it("prints deterministic inference JSON without creating vault state", async () => {
    const before = readFileSync(join(vault, "notes", "a.md"), "utf-8");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runSchema(["infer", "--vault", vault, "--scope", "notes", "--json"]);

    expect(code).toBe(0);
    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
    expect(output).toMatchObject({
      mode: "infer",
      scope: "notes",
      filesScanned: 2,
      documentsAnalyzed: 2,
      scanIssues: [],
    });
    expect(output.fields.find((field: { field: string }) => field.field === "team")).toMatchObject({
      occurrences: 2,
      types: ["string"],
      examples: ["data", "platform"],
    });
    expect(readFileSync(join(vault, "notes", "a.md"), "utf-8")).toBe(before);
    expect(existsSync(join(vault, ".daftari", "index.db"))).toBe(false);
  });

  it("prints declared-schema drift JSON with an explicit candidate threshold", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runSchema(["diff", "--vault", vault, "--json", "--min-occurrences", "2"]);

    expect(code).toBe(0);
    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
    expect(output).toMatchObject({
      mode: "diff",
      minOccurrences: 2,
      undeclared: [{ field: "state", occurrences: 2 }],
      unusedExtensions: [{ field: "retired", type: "boolean", required: false }],
      nearMisses: [{ field: "state", suggestedField: "status", distance: 2 }],
    });
    expect(output).not.toHaveProperty("documentCount");
  });

  it("renders an operator-readable inference report by default", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    expect(await runSchema(["infer", "--vault", vault])).toBe(0);

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("# Frontmatter schema inference");
    expect(output).toContain("| `team` | 2 | 100.0% | string | 2 | no |");
    expect(output).toContain("- skipped documents: 0");
  });

  it("classifies unsafe scope and malformed thresholds as usage errors", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runSchema(["infer", "--vault", vault, "--scope", "../outside"])).toBe(2);
    expect(await runSchema(["diff", "--vault", vault, "--min-occurrences", "0"])).toBe(2);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join(" ")).toContain(
      "scope escapes vault root",
    );
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join(" ")).toContain(
      "--min-occurrences must be a positive integer",
    );
  });

  it("names an explicitly empty --scope in the usage diagnostic", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runSchema(["infer", "--vault", vault, "--scope="])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--scope cannot be empty"));
  });

  it("keeps infer available before config repair but makes diff fail loud", async () => {
    writeFileSync(join(vault, ".daftari", "config.yaml"), "schema_extensions: [broken\n");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runSchema(["infer", "--vault", vault, "--json"])).toBe(0);
    stdout.mockClear();
    expect(await runSchema(["diff", "--vault", vault, "--json"])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("malformed config"));
  });

  it("fails loud when the vault or explicit scope directory does not exist", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const missingVault = join(vault, "missing-vault");

    expect(await runSchema(["infer", "--vault", missingVault, "--json"])).toBe(3);
    expect(await runSchema(["diff", "--vault", missingVault, "--json"])).toBe(3);
    expect(await runSchema(["infer", "--vault", vault, "--scope", "mistyped"])).toBe(3);
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join(" ");
    expect(output).toContain("vault root is not a directory");
    expect(output).toContain("scope is not a directory");
  });

  it("renders recursive aliases and non-finite YAML safely in JSON and Markdown", async () => {
    writeFileSync(
      join(vault, "notes", "cyclic.md"),
      "---\nloop: &loop\n  - *loop\nnan: .nan\npos_inf: .inf\n---\n# Cyclic\n",
    );
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    expect(await runSchema(["infer", "--vault", vault, "--json"])).toBe(0);
    const json = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
    expect(json.fields.find((field: { field: string }) => field.field === "loop").examples).toEqual(
      [["[Circular]"]],
    );
    expect(json.fields.find((field: { field: string }) => field.field === "nan").examples).toEqual([
      "NaN",
    ]);

    stdout.mockClear();
    expect(await runSchema(["infer", "--vault", vault])).toBe(0);
    const markdown = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(markdown).toContain("[Circular]");
    expect(markdown).toContain("Infinity");
  });
});
