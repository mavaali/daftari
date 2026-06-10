// test/audit/semantic.test.ts
import { describe, expect, it, vi } from "vitest";
import { runSemanticCheck } from "../../src/audit/semantic.js";
import type { DescribesEdge, DocSnapshot, RepoSnapshot } from "../../src/audit/types.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";

function doc(relPath: string, absPath: string): DocSnapshot {
  return {
    relPath,
    absPath,
    mtime: "2026-01-01T00:00:00.000Z",
    mtimeSource: "git",
    headings: new Set(),
    links: [],
    describes: [],
  };
}

function docsRepo(name: string, docs: DocSnapshot[]): RepoSnapshot {
  return {
    config: { name, path: `/${name}`, docsGlob: "**/*.md", urls: [], type: "docs" },
    docs: new Map(docs.map((d) => [d.relPath, d])),
  };
}
function codeRepo(name: string, docs: DocSnapshot[]): RepoSnapshot {
  return {
    config: { name, path: `/${name}`, docsGlob: "**/*", urls: [], type: "code" },
    docs: new Map(docs.map((d) => [d.relPath, d])),
  };
}

const edge = (over: Partial<DescribesEdge> = {}): DescribesEdge => ({
  sourceRepo: "docs",
  sourcePath: "a.md",
  targetRepo: "svc",
  targetPath: "src/login.ts",
  symbol: null,
  raw: "svc:src/login.ts",
  ...over,
});

// A readText stub mapping absPath -> content; unknown paths read as unreadable.
const fakeReader = (byPath: Record<string, string>) => async (absPath: string) => {
  const text = byPath[absPath];
  if (text === undefined) {
    return { ok: false as const, error: { reason: "unreadable" as const, message: "no file" } };
  }
  return ok({ text, bytes: text.length });
};

// Minimal LlmClient: only completeJson is exercised here.
const mockLlm = (parsed: unknown): LlmClient =>
  ({
    completeJson: vi.fn(async () =>
      ok({ text: "", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn", parsed }),
    ),
  }) as unknown as LlmClient;

const SNAPS = () => [
  docsRepo("docs", [doc("a.md", "/docs/a.md")]),
  codeRepo("svc", [doc("src/login.ts", "/svc/src/login.ts")]),
];

describe("runSemanticCheck", () => {
  it("returns the LLM verdict and contradictions for a resolvable edge", async () => {
    const llm = mockLlm({
      verdict: "drifted",
      contradictions: ["doc says email+password, code takes a token"],
    });
    const findings = await runSemanticCheck([edge()], SNAPS(), {
      llm,
      model: "claude-x",
      readText: fakeReader({
        "/docs/a.md": "# Auth\ncalls validateCredentials(email, password)",
        "/svc/src/login.ts": "export function login(token: string) {}",
      }),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: { repo: "docs", path: "a.md" },
      target: { repo: "svc", path: "src/login.ts" },
      verdict: "drifted",
      contradictions: ["doc says email+password, code takes a token"],
    });
  });

  it("skips a binary/oversized code target without calling the LLM", async () => {
    const llm = mockLlm({ verdict: "coherent", contradictions: [] });
    const readText = vi.fn(async (absPath: string) => {
      if (absPath === "/svc/src/login.ts") {
        return { ok: false as const, error: { reason: "binary" as const, message: "NUL" } };
      }
      return ok({ text: "doc", bytes: 3 });
    });
    const findings = await runSemanticCheck([edge()], SNAPS(), { llm, model: "m", readText });
    expect(findings[0]?.verdict).toBe("skipped");
    expect(findings[0]?.reason).toContain("binary");
    expect(llm.completeJson).not.toHaveBeenCalled();
  });

  it("produces no finding when the target file does not exist in the repo", async () => {
    const llm = mockLlm({ verdict: "coherent", contradictions: [] });
    const findings = await runSemanticCheck([edge({ targetPath: "src/gone.ts" })], SNAPS(), {
      llm,
      model: "m",
      readText: fakeReader({ "/docs/a.md": "doc" }),
    });
    expect(findings).toEqual([]);
    expect(llm.completeJson).not.toHaveBeenCalled();
  });

  it("caps the number of LLM calls and reports how many edges were dropped", async () => {
    const snaps = [
      docsRepo("docs", [doc("a.md", "/docs/a.md")]),
      codeRepo("svc", [
        doc("src/1.ts", "/svc/src/1.ts"),
        doc("src/2.ts", "/svc/src/2.ts"),
        doc("src/3.ts", "/svc/src/3.ts"),
      ]),
    ];
    const edges = [
      edge({ targetPath: "src/1.ts" }),
      edge({ targetPath: "src/2.ts" }),
      edge({ targetPath: "src/3.ts" }),
    ];
    const llm = mockLlm({ verdict: "coherent", contradictions: [] });
    const onCap = vi.fn();
    const findings = await runSemanticCheck(edges, snaps, {
      llm,
      model: "m",
      maxSemantic: 2,
      onCap,
      readText: fakeReader({
        "/docs/a.md": "doc",
        "/svc/src/1.ts": "a",
        "/svc/src/2.ts": "b",
        "/svc/src/3.ts": "c",
      }),
    });
    expect(findings).toHaveLength(2);
    expect(llm.completeJson).toHaveBeenCalledTimes(2);
    expect(onCap).toHaveBeenCalledWith(1);
  });

  it("skips (does not crash) when the LLM returns an unparseable verdict", async () => {
    const llm = mockLlm({ not: "a verdict" });
    const findings = await runSemanticCheck([edge()], SNAPS(), {
      llm,
      model: "m",
      readText: fakeReader({ "/docs/a.md": "doc", "/svc/src/login.ts": "code" }),
    });
    expect(findings[0]?.verdict).toBe("skipped");
    expect(findings[0]?.reason).toContain("verdict");
  });
});
