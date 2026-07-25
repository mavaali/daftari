import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type InterviewIo, runInterview } from "../../src/interview/index.js";

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

let vault: string;
let scratch: string;

function writeDoc(relPath: string, updated: string, ttl: number | null): void {
  const lines = [
    `title: "Doc ${relPath}"`,
    "domain: accumulation",
    `collection: ${relPath.split("/")[0] ?? ""}`,
    "status: canonical",
    "confidence: medium",
    `created: ${TODAY}`,
    `updated: ${updated}`,
    "updated_by: agent:test",
    "provenance: direct",
    "superseded_by: null",
    `ttl_days: ${ttl === null ? "null" : ttl}`,
    "sources: []",
    "tags: []",
    "questions_raised: []",
    "questions_answered: []",
  ];
  mkdirSync(join(vault, relPath.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(join(vault, relPath), `---\n${lines.join("\n")}\n---\n\nBody.\n`, "utf-8");
}

function writeTension(): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(
    join(vault, ".daftari", "tensions.md"),
    [
      "## 2026-07-01 — A vs B",
      "- **Id:** tension-001",
      "- **Kind:** factual",
      "- **Source A:** pricing/a.md says X.",
      "- **Source B:** pricing/b.md says Y.",
      "- **Status:** unresolved",
      "- **Logged by:** agent:test",
      "",
    ].join("\n"),
    "utf-8",
  );
}

// Scripted stand-in for the terminal: hands out the next canned line per
// ask, records everything written.
function scriptedIo(lines: (string | null)[]): { io: InterviewIo; output: () => string } {
  let i = 0;
  const out: string[] = [];
  return {
    io: {
      ask: async () => (i < lines.length ? (lines[i++] as string | null) : null),
      write: (text: string) => {
        out.push(text);
      },
      close: () => {},
    },
    output: () => out.join(""),
  };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-interview-cli-"));
  scratch = mkdtempSync(join(tmpdir(), "daftari-interview-out-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("runInterview — sheet mode", () => {
  it("writes the sheet and JSON to the given outputs", async () => {
    writeTension();
    writeDoc("pricing/stale.md", daysAgo(60), 30);

    const md = join(scratch, "sheet.md");
    const json = join(scratch, "sheet.json");
    const code = await runInterview(["--vault", vault, "--output", md, "--output-json", json]);
    expect(code).toBe(0);

    const sheet = readFileSync(md, "utf-8");
    expect(sheet).toContain("## q-001 — tension");
    expect(sheet).toContain("## q-002 — stale");

    const parsed = JSON.parse(readFileSync(json, "utf-8"));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].refs).toContain("tension-001");
  });

  it("rejects a non-positive --limit", async () => {
    const code = await runInterview(["--vault", vault, "--limit", "0"]);
    expect(code).toBe(2);
  });
});

describe("runInterview — ask mode", () => {
  it("records verbatim answers, skips empties, stops on q, and points at the court", async () => {
    writeTension();
    writeDoc("pricing/stale.md", daysAgo(60), 30);
    writeDoc("pricing/also-stale.md", daysAgo(50), 30);

    const { io, output } = scriptedIo([
      "Claim X is current; b.md predates the change.", // q-001 tension
      "", // q-002 stale — skipped
      "q", // q-003 — end session
    ]);
    const code = await runInterview(["ask", "--vault", vault, "--by", "human:tester"], io);
    expect(code).toBe(0);

    const relPath = `interviews/${TODAY}-interview.md`;
    expect(existsSync(join(vault, relPath))).toBe(true);
    const transcript = readFileSync(join(vault, relPath), "utf-8");
    expect(transcript).toContain("**A:** Claim X is current; b.md predates the change.");
    expect(transcript).not.toContain("q-002");

    expect(output()).toContain(
      `daftari court rule tension-001 --kind <kind> --references ${relPath}`,
    );
  });

  it("writes nothing when every question is skipped", async () => {
    writeTension();
    const { io, output } = scriptedIo([""]);
    const code = await runInterview(["ask", "--vault", vault], io);
    expect(code).toBe(0);
    expect(existsSync(join(vault, "interviews"))).toBe(false);
    expect(output()).toContain("No answers recorded");
  });

  it("rejects a bad --collection before asking a single question", async () => {
    writeTension();
    const { io, output } = scriptedIo(["should never be consumed"]);
    const code = await runInterview(["ask", "--vault", vault, "--collection", "../evil"], io);
    expect(code).toBe(2);
    expect(output()).toBe(""); // the session never started
    expect(existsSync(join(vault, "..", "evil"))).toBe(false);
  });

  it("says so when nothing is unclear", async () => {
    writeDoc("pricing/fine.md", TODAY, 365);
    const { io } = scriptedIo([]);
    const code = await runInterview(["ask", "--vault", vault], io);
    expect(code).toBe(0);
  });
});
